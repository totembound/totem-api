const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');

// Initialize DynamoDB client
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const documentClient = DynamoDBDocumentClient.from(client);

/**
 * Get a user by ID
 * @param {string} userId - User ID
 * @returns {Promise<object|null>} - User object or null
 */
exports.getUserById = async userId => {
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId }
  };

  const result = await documentClient.send(new GetCommand(params));
  return result.Item || null;
};

/**
 * Get a user by email
 * @param {string} email - User email
 * @returns {Promise<object|null>} - User object or null
 */
exports.getUserByEmail = async email => {
  const params = {
    TableName: process.env.USERS_TABLE,
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': email.toLowerCase()
    }
  };

  const result = await documentClient.send(new QueryCommand(params));
  return result.Items.length > 0 ? result.Items[0] : null;
};

/**
 * Get a user by wallet address
 * @param {string} walletAddress - Ethereum wallet address
 * @returns {Promise<object|null>} - User object or null
 */
exports.getUserByWallet = async walletAddress => {
  const params = {
    TableName: process.env.USERS_TABLE,
    IndexName: 'wallet-index',
    KeyConditionExpression: 'walletAddress = :wallet',
    ExpressionAttributeValues: {
      ':wallet': walletAddress.toLowerCase()
    }
  };

  const result = await documentClient.send(new QueryCommand(params));
  return result.Items.length > 0 ? result.Items[0] : null;
};

/**
 * Get a user by API key
 * @param {string} apiKey - User's API key
 * @returns {Promise<object|null>} - User object or null
 */
exports.getUserByApiKey = async apiKey => {
  const params = {
    TableName: process.env.USERS_TABLE,
    IndexName: 'apikey-index',
    KeyConditionExpression: 'apiKey = :apiKey',
    ExpressionAttributeValues: {
      ':apiKey': apiKey
    }
  };

  const result = await documentClient.send(new QueryCommand(params));
  return result.Items.length > 0 ? result.Items[0] : null;
};

/**
 * Get a user by Stripe customer ID
 * @param {string} customerId - Stripe customer ID
 * @returns {Promise<object|null>} - User object or null
 */
exports.getUserByStripeCustomerId = async customerId => {
  const params = {
    TableName: process.env.USERS_TABLE,
    FilterExpression: 'stripeCustomerId = :customerId',
    ExpressionAttributeValues: {
      ':customerId': customerId
    }
  };

  const result = await documentClient.send(new ScanCommand(params));
  return result.Items.length > 0 ? result.Items[0] : null;
};

/**
 * Create a new user
 * @param {object} user - User object
 * @returns {Promise<object>} - Created user
 */
exports.createUser = async user => {
  const params = {
    TableName: process.env.USERS_TABLE,
    Item: {
      ...user,
      createdAt: new Date().toISOString(),
      isActive: true
    }
  };

  await documentClient.send(new PutCommand(params));
  return params.Item;
};

/**
 * Update a user
 * @param {string} userId - User ID
 * @param {object} updates - Fields to update
 * @returns {Promise<object>} - Updated user
 */
exports.updateUser = async (userId, updates) => {
  // Build update expression dynamically
  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};

  Object.entries(updates).forEach(([key, value]) => {
    updateExpressions.push(`#${key} = :${key}`);
    expressionAttributeNames[`#${key}`] = key;
    expressionAttributeValues[`:${key}`] = value;
  });

  // Add updatedAt timestamp
  updateExpressions.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();

  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  };

  const result = await documentClient.send(new UpdateCommand(params));
  return result.Attributes;
};

/**
 * Increment daily usage and total transaction count atomically
 * @param {string} userId - User ID
 * @param {object} transactionInfo - Optional transaction details for logging
 * @returns {Promise<object>} - Updated usage info
 */
exports.incrementUsageAndTransactions = async (userId, transactionInfo = {}) => {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  
  try {
    // Atomic update: increment both daily usage AND total transaction count
    const params = {
      TableName: process.env.USERS_TABLE,
      Key: { userId },
      UpdateExpression: `
        SET dailyRequestCount = if_not_exists(dailyRequestCount, :zero) + :one,
            totalTransactionCount = if_not_exists(totalTransactionCount, :zero) + :one,
            lastRequestDate = :today,
            lastTransactionAt = :now,
            updatedAt = :now
      `,
      ConditionExpression: 'lastRequestDate = :today OR attribute_not_exists(lastRequestDate)',
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':today': today,
        ':now': now
      },
      ReturnValues: 'UPDATED_NEW'
    };

    const result = await documentClient.send(new UpdateCommand(params));
    return {
      dailyRequestCount: result.Attributes.dailyRequestCount,
      totalTransactionCount: result.Attributes.totalTransactionCount,
      lastRequestDate: result.Attributes.lastRequestDate
    };
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      // New day - reset daily counter but keep total count
      const resetParams = {
        TableName: process.env.USERS_TABLE,
        Key: { userId },
        UpdateExpression: `
          SET dailyRequestCount = :one,
              totalTransactionCount = if_not_exists(totalTransactionCount, :zero) + :one,
              lastRequestDate = :today,
              lastTransactionAt = :now,
              updatedAt = :now
        `,
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':today': today,
          ':now': now
        },
        ReturnValues: 'UPDATED_NEW'
      };

      const result = await documentClient.send(new UpdateCommand(resetParams));
      return {
        dailyRequestCount: result.Attributes.dailyRequestCount,
        totalTransactionCount: result.Attributes.totalTransactionCount,
        lastRequestDate: result.Attributes.lastRequestDate
      };
    }
    throw error;
  }
};

/**
 * Get current daily usage for a user
 * @param {string} userId - User ID
 * @returns {Promise<number>} - Daily request count
 */
exports.getDailyUsage = async (userId) => {
  const today = new Date().toISOString().split('T')[0];
  
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
    ProjectionExpression: 'dailyRequestCount, lastRequestDate'
  };

  const result = await documentClient.send(new GetCommand(params));
  
  if (!result.Item || result.Item.lastRequestDate !== today) {
    return 0; // No requests today or different day
  }
  
  return result.Item.dailyRequestCount || 0;
};

/**
 * Check if user has exceeded daily limit
 * @param {string} userId - User ID
 * @param {string} tier - User tier (free/premium)
 * @returns {Promise<object>} - Usage status
 */
exports.checkDailyLimit = async (userId, tier) => {
  const tierQuotas = {
    free: 50,      // Match your CloudFormation
    premium: 1000  // Match your CloudFormation
  };
  
  const dailyLimit = tierQuotas[tier] || tierQuotas.free;
  const currentUsage = await exports.getDailyUsage(userId);
  const remaining = Math.max(0, dailyLimit - currentUsage);
  
  return {
    currentUsage,
    dailyLimit,
    remaining,
    exceeded: currentUsage >= dailyLimit
  };
};

/**
 * Optional: Log detailed transaction to transactions table (only if you need audit trail)
 * Use this ONLY if you need detailed transaction history for compliance/debugging
 * @param {object} transaction - Transaction details
 * @returns {Promise<object>} - Created transaction record
 */
exports.logDetailedTransaction = async (transaction) => {
  // Only use this if you need detailed audit trail
  // Most apps don't need this level of detail
  const params = {
    TableName: process.env.TRANSACTIONS_TABLE || 'totembound-transactions',
    Item: {
      txId: transaction.txHash || `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId: transaction.userId,
      txHash: transaction.txHash,
      contractType: transaction.contractType,
      functionName: transaction.functionName,
      gasUsed: transaction.gasUsed,
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60) // 90 days TTL
    }
  };

  await documentClient.send(new PutCommand(params));
  return params.Item;
};
