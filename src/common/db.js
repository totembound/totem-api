const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');

// Initialize DynamoDB client
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const documentClient = DynamoDBDocumentClient.from(client);

/**
 * Get a user by email
 * @param {string} email - User email
 * @returns {Promise<object|null>} - User object or null
 */
exports.getUserByEmail = async email => {
  const params = {
    TableName: process.env.USERS_TABLE,
    FilterExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': email.toLowerCase()
    }
  };

  const result = await documentClient.send(new ScanCommand(params));
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
    FilterExpression: 'walletAddress = :wallet',
    ExpressionAttributeValues: {
      ':wallet': walletAddress.toLowerCase()
    }
  };

  const result = await documentClient.send(new ScanCommand(params));
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
    FilterExpression: 'apiKey = :apiKey',
    ExpressionAttributeValues: {
      ':apiKey': apiKey
    }
  };

  const result = await documentClient.send(new ScanCommand(params));
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
 * Log a transaction in the transactions history table
 * @param {object} transaction - Transaction details
 * @returns {Promise<object>} - Created transaction record
 */
exports.logTransaction = async transaction => {
  const params = {
    TableName: process.env.TRANSACTIONS_TABLE || 'totembound-transactions',
    Item: {
      ...transaction,
      timestamp: new Date().toISOString()
    }
  };

  await documentClient.send(new PutCommand(params));
  return params.Item;
};

/**
 * Increment a user's transaction count
 * @param {string} userId - User ID
 * @returns {Promise<number>} - New transaction count
 */
exports.incrementTransactionCount = async userId => {
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
    UpdateExpression: 'SET transactionCount = if_not_exists(transactionCount, :zero) + :one',
    ExpressionAttributeValues: {
      ':zero': 0,
      ':one': 1
    },
    ReturnValues: 'UPDATED_NEW'
  };

  const result = await documentClient.send(new UpdateCommand(params));
  return result.Attributes.transactionCount;
};

/**
 * Get transaction count for a user in current time period
 * @param {string} userId - User ID
 * @param {number} periodStart - Period start timestamp (seconds)
 * @returns {Promise<number>} - Transaction count
 */
exports.getTransactionCountInPeriod = async (userId, periodStart) => {
  const params = {
    TableName: process.env.TRANSACTIONS_TABLE || 'totembound-transactions',
    FilterExpression: 'userId = :userId AND #ts >= :periodStart',
    ExpressionAttributeNames: {
      '#ts': 'timestamp'
    },
    ExpressionAttributeValues: {
      ':userId': userId,
      ':periodStart': new Date(periodStart * 1000).toISOString()
    }
  };

  const result = await documentClient.send(new ScanCommand(params));
  return result.Items.length;
};
