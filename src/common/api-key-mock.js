// common/api-key-mock.js - Mock API key verification for local testing

const mockApiKeys = new Map();

// Initialize with test data
mockApiKeys.set('test_12345', {
  userId: 'test-user-123',
  email: 'test@example.com',
  apiKey: 'test_12345',
  tier: 'free',
  walletAddress: '0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199',
  isActive: true,
  createdAt: new Date().toISOString()
});
mockApiKeys.set('premium_67890', {
  userId: 'premium-user-456',
  email: 'premium@example.com',
  apiKey: 'premium_67890',
  tier: 'premium',
  walletAddress: '0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199',
  isActive: true,
  createdAt: new Date().toISOString()
});

/**
 * Mock: Verify API key
 * @param {string} apiKey - API key to verify
 * @returns {Promise<object|null>} - User object or null
 */
exports.verifyApiKey = async (apiKey) => {
  console.log(`[MOCK] Verifying API key: ${apiKey}`);
  
  const user = mockApiKeys.get(apiKey);
  if (!user) {
    console.log(`[MOCK] API key not found: ${apiKey}`);
    return null;
  }
  
  if (!user.isActive) {
    console.log(`[MOCK] API key inactive: ${apiKey}`);
    return null;
  }
  
  console.log(`[MOCK] API key verified for user: ${user.email} (${user.tier})`);
  return user;
};

/**
 * Mock: Get user by API key (alias for verifyApiKey)
 */
exports.getUserByApiKey = exports.verifyApiKey;

/**
 * Mock: Create new API key
 */
exports.createApiKey = async (userEmail, tier = 'free') => {
  const userId = `user_${Date.now()}`;
  const apiKey = `ak_${tier}_${Math.random().toString(36).substr(2, 9)}`;
  
  const user = {
    userId,
    email: userEmail,
    apiKey,
    tier,
    walletAddress: `0x${Math.random().toString(16).substr(2, 40)}`,
    isActive: true,
    createdAt: new Date().toISOString()
  };
  
  mockApiKeys.set(apiKey, user);
  console.log(`[MOCK] Created API key: ${apiKey} for ${userEmail}`);
  
  return user;
};

/**
 * Get all mock API keys for debugging
 */
exports.getMockApiKeys = () => Array.from(mockApiKeys.values());
