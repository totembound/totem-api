// Mock database functions for local testing
const mockUsers = new Map();
const mockTransactions = new Map();

// Initialize with test data
mockUsers.set('test_12345', {
  userId: 'test-user-123',
  email: 'test@example.com',
  apiKey: 'test_12345',
  tier: 'free',
  walletAddress: '0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199',
  dailyRequestCount: 0,
  totalTransactionCount: 0,
  lastRequestDate: new Date().toISOString().split('T')[0],
  createdAt: new Date().toISOString(),
  isActive: true
});
mockUsers.set('premium_67890', {
  userId: 'premium-user-456',
  email: 'premium@example.com',
  apiKey: 'premium_67890',
  tier: 'premium',
  walletAddress: '0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199',
  dailyRequestCount: 0,
  totalTransactionCount: 0,
  lastRequestDate: new Date().toISOString().split('T')[0],
  createdAt: new Date().toISOString(),
  isActive: true
});

/**
 * Mock: Get user by API key
 */
exports.getUserByApiKey = async (apiKey) => {
  console.log(`[MOCK] Looking up user by API key: ${apiKey}`);
  return mockUsers.get(apiKey) || null;
};

/**
 * Mock: Check daily limit
 */
exports.checkDailyLimit = async (userId, tier) => {
  console.log(`[MOCK] Checking daily limit for user: ${userId}, tier: ${tier}`);
  
  const tierQuotas = { free: 50, premium: 1000 };
  const dailyLimit = tierQuotas[tier] || tierQuotas.free;
  
  // Find user by userId
  let currentUsage = 0;
  for (const user of mockUsers.values()) {
    if (user.userId === userId) {
      currentUsage = user.dailyRequestCount || 0;
      break;
    }
  }
  
  const remaining = Math.max(0, dailyLimit - currentUsage);
  
  return {
    currentUsage,
    dailyLimit,
    remaining,
    exceeded: currentUsage >= dailyLimit
  };
};

/**
 * Mock: Increment usage and transactions
 */
exports.incrementUsageAndTransactions = async (userId, transactionInfo = {}) => {
  console.log(`[MOCK] Incrementing usage for user: ${userId}`);
  
  // Find and update user
  for (const [apiKey, user] of mockUsers.entries()) {
    if (user.userId === userId) {
      const today = new Date().toISOString().split('T')[0];
      
      // Reset daily count if new day
      if (user.lastRequestDate !== today) {
        user.dailyRequestCount = 0;
        user.lastRequestDate = today;
      }
      
      user.dailyRequestCount = (user.dailyRequestCount || 0) + 1;
      user.totalTransactionCount = (user.totalTransactionCount || 0) + 1;
      user.lastTransactionAt = new Date().toISOString();
      
      mockUsers.set(apiKey, user);
      
      return {
        dailyRequestCount: user.dailyRequestCount,
        totalTransactionCount: user.totalTransactionCount,
        lastRequestDate: user.lastRequestDate
      };
    }
  }
  
  throw new Error(`User not found: ${userId}`);
};

/**
 * Mock: Log transaction to DynamoDB
 */
exports.logDetailedTransaction = async (transactionData) => {
  const txId = transactionData.txHash || `mock_tx_${Date.now()}`;
  console.log(`[MOCK] Logging transaction: ${txId}`);
  
  const transaction = {
    ...transactionData,
    txId,
    createdAt: new Date().toISOString(),
    yearMonth: new Date().toISOString().substring(0, 7),
    date: new Date().toISOString().substring(0, 10)
  };
  
  mockTransactions.set(txId, transaction);
  
  // Log summary for debugging
  console.log(`[MOCK] Transaction logged:`, {
    txId,
    userId: transaction.userId,
    contractType: transaction.contractType,
    functionName: transaction.functionName
  });
  
  return transaction;
};

/**
 * Mock: Get user transactions by month
 */
exports.getUserTransactionsByMonth = async (userId, yearMonth) => {
  console.log(`[MOCK] Getting transactions for user ${userId} in ${yearMonth}`);
  
  const userTransactions = [];
  for (const tx of mockTransactions.values()) {
    if (tx.userId === userId && tx.yearMonth === yearMonth) {
      userTransactions.push(tx);
    }
  }
  
  return userTransactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

// Export current state for debugging
exports.getMockState = () => ({
  users: Array.from(mockUsers.values()),
  transactions: Array.from(mockTransactions.values())
});
