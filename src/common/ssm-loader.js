/**
 * SSM Parameter Store Lazy Loader
 *
 * Resolves secrets from SSM Parameter Store in Lambda environments.
 * Falls back to direct env vars for local development.
 *
 * Usage:
 *   const secret = await getSecret('STRIPE_SECRET_KEY');
 *   // 1. Returns process.env.STRIPE_SECRET_KEY if set (local dev)
 *   // 2. Otherwise loads from SSM using process.env.STRIPE_SECRET_KEY_PARAM
 *   // 3. Caches in process.env for subsequent Lambda invocations
 */

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

let ssmClient = null;

function getSSMClient() {
  if (!ssmClient) {
    ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return ssmClient;
}

/**
 * Get a secret value, checking direct env var first, then SSM.
 * @param {string} envKey - The env var name (e.g., 'STRIPE_SECRET_KEY')
 * @returns {Promise<string|null>} The secret value or null
 */
async function getSecret(envKey) {
  // 1. Direct env var (local dev or already cached)
  const direct = process.env[envKey];
  if (direct && direct !== '' && !direct.startsWith('whsec_your_') && !direct.startsWith('sk_test_your_')) {
    return direct;
  }

  // 2. Load from SSM using the _PARAM env var
  const paramName = process.env[`${envKey}_PARAM`];
  if (!paramName) {
    return direct || null; // Return placeholder or null
  }

  try {
    const client = getSSMClient();
    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    });
    const response = await client.send(command);
    const value = response.Parameter?.Value;

    if (value) {
      // Cache in process.env for subsequent invocations within same Lambda container
      process.env[envKey] = value;
      return value;
    }
  }
  catch (err) {
    console.error(`[SSM] Failed to load ${envKey} from ${paramName}:`, err.message);
  }

  return direct || null;
}

module.exports = { getSecret };
