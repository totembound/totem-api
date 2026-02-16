/**
 * IoT Registration Handler
 *
 * POST /v1/iot/register
 * Called by the frontend after obtaining a Cognito Identity Pool identity.
 * Stores the identityId mapping and attaches the IoT browser policy.
 *
 * GET /v1/iot/config
 * Returns IoT connection config (endpoint, region, Identity Pool ID).
 */

const { getUser, updateUser } = require('../common/db-client');

/**
 * POST /v1/iot/register
 *
 * Registers the user's Cognito Identity Pool identityId for IoT push.
 * Also attaches the IoT browser policy to the identity (required for IoT Core access).
 *
 * Body: { identityId: "us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
 */
async function registerIoT(user, body) {
  const { identityId } = body || {};

  if (!identityId || typeof identityId !== 'string') {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'identityId is required' },
    };
  }

  // Validate identityId format: region:uuid
  const identityIdRegex = /^[\w-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!identityIdRegex.test(identityId)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid identityId format' },
    };
  }

  const userId = user.userId;

  // Store identityId in user record
  await updateUser(userId, { iotIdentityId: identityId });

  // Attach IoT policy to the identity (non-blocking, idempotent)
  const policyName = process.env.IOT_BROWSER_POLICY_NAME;
  if (policyName && process.env.IS_LOCAL !== 'true') {
    try {
      const { IoTClient, AttachPolicyCommand } = require('@aws-sdk/client-iot');
      const iotClient = new IoTClient({ region: process.env.AWS_REGION || 'us-east-1' });
      await iotClient.send(new AttachPolicyCommand({
        policyName,
        target: identityId,
      }));
      console.log(`[IoT] Attached policy ${policyName} to identity ${identityId}`);
    }
    catch (err) {
      // ResourceAlreadyExistsException is expected if already attached
      if (err.name !== 'ResourceAlreadyExistsException') {
        console.error('[IoT] Failed to attach policy:', err.message);
      }
    }
  }

  return {
    success: true,
    data: {
      registered: true,
      topic: `user/${identityId}/commands`,
    },
  };
}

/**
 * GET /v1/iot/config
 *
 * Returns the IoT connection configuration.
 * Frontend needs this to initialize the MQTT connection.
 */
async function getIoTConfig(user) {
  const userId = user.userId;

  // Check if user has already registered
  let identityId = null;
  try {
    const userRecord = await getUser(userId);
    identityId = userRecord?.iotIdentityId || null;
  }
  catch (err) {
    console.warn('[IoT] Failed to get user record:', err.message);
  }

  return {
    success: true,
    data: {
      endpoint: process.env.IOT_ENDPOINT || null,
      region: process.env.AWS_REGION || 'us-east-1',
      identityPoolId: process.env.IOT_IDENTITY_POOL_ID || null,
      userPoolId: process.env.COGNITO_USER_POOL_ID || null,
      userPoolClientId: process.env.COGNITO_CLIENT_ID || null,
      registered: !!identityId,
      topic: identityId ? `user/${identityId}/commands` : null,
    },
  };
}

module.exports = {
  registerIoT,
  getIoTConfig,
};
