const { v4: uuidv4 } = require('uuid');
const {
  APIGatewayClient,
  CreateApiKeyCommand,
  CreateUsagePlanKeyCommand,
  UpdateApiKeyCommand,
  GetUsagePlansCommand,
  GetUsagePlanKeysCommand,
  GetUsageCommand
} = require('@aws-sdk/client-api-gateway');
const { getUserByEmail, getUserByWallet, createUser, updateUser, getUserById, getUserByApiKey } = require('./db');
const { normalizeAddress, generateApiKey } = require('./utils');

// Initialize API Gateway client
const apiGatewayClient = new APIGatewayClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Create a new API key in API Gateway
 * @param {string} email - User email
 * @param {string} walletAddress - Ethereum wallet address
 * @param {string} tier - Tier (free or premium)
 * @returns {Promise<object>} - Created API key details
 */
exports.createApiKey = async (email, walletAddress, tier = 'free') => {
  // Determine which usage plan to use based on tier
  const usagePlanId =
    tier.toLowerCase() === 'premium'
      ? process.env.PREMIUM_TIER_USAGE_PLAN_ID
      : process.env.FREE_TIER_USAGE_PLAN_ID;

  // Prefix determines tier (free_ or premium_)
  const prefix = tier.toLowerCase() === 'premium' ? 'premium_' : 'free_';
  const keyName = `${prefix}${uuidv4().substring(0, 8)}`;

  // Create key in API Gateway
  const createKeyParams = {
    name: `${email}-${keyName}`,
    description: `API key for ${email} (${walletAddress})`,
    enabled: true,
    value: generateApiKey(prefix)
  };

  const createKeyCommand = new CreateApiKeyCommand(createKeyParams);
  const keyResult = await apiGatewayClient.send(createKeyCommand);

  // Associate key with usage plan
  const usagePlanParams = {
    keyId: keyResult.id,
    keyType: 'API_KEY',
    usagePlanId: usagePlanId
  };

  const createUsagePlanKeyCommand = new CreateUsagePlanKeyCommand(usagePlanParams);
  await apiGatewayClient.send(createUsagePlanKeyCommand);

  return {
    apiKeyId: keyResult.id,
    apiKey: keyResult.value,
    tier
  };
};

/**
 * Create a new user with an API key
 * @param {string} email - User email
 * @param {string} walletAddress - Ethereum wallet address
 * @param {string} tier - Tier (free or premium)
 * @returns {Promise<object>} - Created user with API key
 */
exports.createUserWithApiKey = async (email, walletAddress, tier = 'free') => {
  // Normalize inputs
  const normalizedEmail = email.toLowerCase();
  const normalizedWallet = normalizeAddress(walletAddress);

  // Check if user already exists
  const existingByEmail = await getUserByEmail(normalizedEmail);
  const existingByWallet = await getUserByWallet(normalizedWallet);

  if (existingByEmail || existingByWallet) {
    throw new Error('User already exists with this email or wallet address');
  }

  // Create API key
  const { apiKeyId, apiKey } = await exports.createApiKey(normalizedEmail, normalizedWallet, tier);

  // Create user in database
  const user = await createUser({
    userId: uuidv4(),
    email: normalizedEmail,
    walletAddress: normalizedWallet,
    apiKeyId,
    apiKey,
    tier,
    transactionCount: 0
  });

  return {
    ...user,
    apiKey // Include API key in response for sending to user
  };
};

/**
 * Update user's API key (e.g. when upgrading tiers)
 * @param {string} userId - User ID
 * @param {string} tier - New tier (free or premium)
 * @returns {Promise<object>} - Updated user with new API key
 */
exports.updateUserApiKey = async (userId, tier) => {
  // Get existing user
  const user = await getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  // Deactivate old API key
  if (user.apiKeyId) {
    try {
      const updateCommand = new UpdateApiKeyCommand({
        apiKey: user.apiKeyId,
        patchOperations: [
          {
            op: 'replace',
            path: '/enabled',
            value: 'false'
          }
        ]
      });
      await apiGatewayClient.send(updateCommand);
    }
    catch (error) {
      console.warn('Failed to deactivate old API key:', error);
      // Continue anyway - creating a new key is more important
    }
  }

  // Create new API key
  const { apiKeyId, apiKey } = await exports.createApiKey(user.email, user.walletAddress, tier);

  // Update user in database
  const updatedUser = await updateUser(userId, {
    apiKeyId,
    apiKey,
    tier
  });

  return {
    ...updatedUser,
    apiKey // Include API key in response for sending to user
  };
};

/**
 * Verify if an API key is valid and return its associated user
 * @param {string} apiKey - API key to verify
 * @returns {Promise<object|null>} - User object if valid, null otherwise
 */
exports.verifyApiKey = async apiKey => {
  if (!apiKey) return null;

  try {
    // Get user by API key
    const user = await getUserByApiKey(apiKey);
    if (!user || !user.isActive) return null;

    return user;
  }
  catch (error) {
    console.error('Error verifying API key:', error);
    return null;
  }
};

/**
 * Get API key quota usage
 * @param {string} apiKeyId - API Gateway key ID
 * @returns {Promise<object>} - Usage data
 */
exports.getApiKeyUsage = async apiKeyId => {
  try {
    // Get usage data from API Gateway
    const getUsagePlansCommand = new GetUsagePlansCommand();
    const usagePlans = await apiGatewayClient.send(getUsagePlansCommand);

    // Find the usage plan for this key
    let usagePlanId;
    for (const plan of usagePlans.items) {
      const getUsagePlanKeysCommand = new GetUsagePlanKeysCommand({
        usagePlanId: plan.id,
        limit: 100
      });
      const keys = await apiGatewayClient.send(getUsagePlanKeysCommand);

      if (keys.items.some(k => k.id === apiKeyId)) {
        usagePlanId = plan.id;
        break;
      }
    }

    if (!usagePlanId) {
      return { error: 'No usage plan found for this API key' };
    }

    // Get usage data for current month
    const startDate = new Date();
    startDate.setDate(1); // First day of current month

    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1, 0); // Last day of current month

    const getUsageCommand = new GetUsageCommand({
      usagePlanId,
      keyId: apiKeyId,
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0]
    });
    const usage = await apiGatewayClient.send(getUsageCommand);

    return {
      usagePlanId,
      keyId: apiKeyId,
      usage: usage.items
    };
  }
  catch (error) {
    console.error('Error getting API key usage:', error);
    return { error: error.message };
  }
};
