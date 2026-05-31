/**
 * DynamoDB Client
 *
 * Handles both local development (DynamoDB Local) and production (AWS DynamoDB).
 * Automatically detects environment and configures accordingly.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

// ============================================
// Configuration
// ============================================

const isLocal = process.env.IS_LOCAL === 'true' || process.env.NODE_ENV === 'development';

const clientConfig = isLocal
  ? {
    endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'local',
      secretAccessKey: 'local',
    },
  }
  : {
    region: process.env.AWS_REGION || 'us-east-1',
  };

// Create DynamoDB client
const ddbClient = new DynamoDBClient(clientConfig);

// Create document client with marshalling options
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
});

// ============================================
// Table Names
// ============================================

const TABLES = {
  USERS: process.env.DYNAMODB_USERS_TABLE || 'TotemBound-Users',
  TOTEMS: process.env.DYNAMODB_TOTEMS_TABLE || 'TotemBound-Totems',
  SHOP: process.env.DYNAMODB_SHOP_TABLE || 'TotemBound-Shop',
  TRANSACTIONS: process.env.DYNAMODB_TRANSACTIONS_TABLE || 'TotemBound-Transactions',
  ACHIEVEMENT_PROGRESS: process.env.DYNAMODB_ACHIEVEMENTS_TABLE || 'TotemBound-AchievementProgress',
  CHALLENGE_PROGRESS: process.env.DYNAMODB_CHALLENGES_TABLE || 'TotemBound-ChallengeProgress',
  EXPEDITION_STATE: process.env.DYNAMODB_EXPEDITIONS_TABLE || 'TotemBound-ExpeditionState',
  REWARD_STATE: process.env.DYNAMODB_REWARDS_TABLE || 'TotemBound-RewardState',
  REWARDS_CLAIMS: process.env.DYNAMODB_REWARDS_CLAIMS_TABLE || 'TotemBound-RewardsClaims',
};

// ============================================
// Key Helpers
// ============================================

const KEY_PREFIX = {
  USER: 'USER#',
  TOTEM: 'TOTEM#',
  CHALLENGE: 'CHALLENGE#',
  EXPEDITION: 'EXPEDITION#',
  ACHIEVEMENT: 'ACHIEVEMENT#',
};

const userPK = (userId) => `${KEY_PREFIX.USER}${userId}`;
const totemSK = (totemId) => `${KEY_PREFIX.TOTEM}${totemId}`;
const challengeSK = (challengeId) => `${KEY_PREFIX.CHALLENGE}${challengeId}`;
const expeditionSK = (expeditionId) => `${KEY_PREFIX.EXPEDITION}${expeditionId}`;
const achievementSK = (achievementId) => `${KEY_PREFIX.ACHIEVEMENT}${achievementId}`;

// ============================================
// CRUD Operations
// ============================================

/**
 * Get a single item by key
 */
async function getItem(tableName, key) {
  const command = new GetCommand({
    TableName: tableName,
    Key: key,
  });

  const response = await docClient.send(command);
  return response.Item || null;
}

/**
 * Put (create/replace) an item
 */
async function putItem(tableName, item) {
  const command = new PutCommand({
    TableName: tableName,
    Item: {
      ...item,
      updatedAt: new Date().toISOString(),
    },
  });

  await docClient.send(command);
  return item;
}

/**
 * Update specific attributes of an item
 *
 * Supports nested paths like 'cooldowns.feed' or 'stats.happiness'
 */
async function updateItem(tableName, key, updates) {
  // Build update expression
  const updateExpressionParts = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};

  Object.entries(updates).forEach(([field, value], index) => {
    const valueKey = `:value${index}`;

    // Handle nested paths (e.g., 'cooldowns.feed' -> '#cooldowns.#feed')
    if (field.includes('.')) {
      const parts = field.split('.');
      const nameParts = parts.map((part, partIndex) => {
        const nameKey = `#field${index}_${partIndex}`;
        expressionAttributeNames[nameKey] = part;
        return nameKey;
      });
      updateExpressionParts.push(`${nameParts.join('.')} = ${valueKey}`);
    }
    else {
      const nameKey = `#field${index}`;
      updateExpressionParts.push(`${nameKey} = ${valueKey}`);
      expressionAttributeNames[nameKey] = field;
    }

    expressionAttributeValues[valueKey] = value;
  });

  // Always update updatedAt
  updateExpressionParts.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();

  const command = new UpdateCommand({
    TableName: tableName,
    Key: key,
    UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW',
  });

  const response = await docClient.send(command);
  return response.Attributes;
}

/**
 * Raw UpdateCommand passthrough — for conditional updates, atomic ADD,
 * string-set operations, and other expressions the simple updateItem helper
 * does not support.
 *
 * Caller supplies a fully-formed params object (UpdateExpression,
 * ConditionExpression, ExpressionAttributeNames/Values, ReturnValues, etc.).
 *
 * Throws on failure. Caller should catch ConditionalCheckFailedException
 * for idempotency cases.
 */
async function rawUpdate(tableName, key, params) {
  const command = new UpdateCommand({
    TableName: tableName,
    Key: key,
    ...params,
  });
  return docClient.send(command);
}

/**
 * Delete an item
 */
async function deleteItem(tableName, key) {
  const command = new DeleteCommand({
    TableName: tableName,
    Key: key,
  });

  await docClient.send(command);
}

/**
 * Query items by partition key
 */
async function queryItems(tableName, pkName, pkValue, options = {}) {
  const {
    skPrefix,
    indexName,
    limit,
    scanIndexForward = true,
    filterExpression,
    filterValues,
    filterNames,
  } = options;

  let keyConditionExpression = '#pk = :pk';
  const expressionAttributeNames = { '#pk': pkName };
  const expressionAttributeValues = { ':pk': pkValue };

  if (skPrefix) {
    keyConditionExpression += ' AND begins_with(#sk, :skPrefix)';
    expressionAttributeNames['#sk'] = 'sk';
    expressionAttributeValues[':skPrefix'] = skPrefix;
  }

  const command = new QueryCommand({
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeNames: { ...expressionAttributeNames, ...filterNames },
    ExpressionAttributeValues: {
      ...expressionAttributeValues,
      ...filterValues,
    },
    FilterExpression: filterExpression,
    Limit: limit,
    ScanIndexForward: scanIndexForward,
  });

  const response = await docClient.send(command);
  return response.Items || [];
}

/**
 * Transactional write (for atomic operations)
 */
async function transactWrite(transactItems) {
  const command = new TransactWriteCommand({
    TransactItems: transactItems,
  });

  await docClient.send(command);
}

// ============================================
// User Operations
// ============================================

async function getUserByEmail(email) {
  const items = await queryItems(TABLES.USERS, 'email', email, {
    indexName: 'email-index',
    limit: 1,
  });
  return items[0] || null;
}

async function getUserByProviderId(provider, providerId) {
  try {
    // provider-index GSI: oauthProvider (HASH) + oauthProviderId (RANGE)
    // Both are key attributes, so both go in KeyConditionExpression
    const command = new QueryCommand({
      TableName: TABLES.USERS,
      IndexName: 'provider-index',
      KeyConditionExpression: '#provider = :provider AND #pid = :pid',
      ExpressionAttributeNames: {
        '#provider': 'oauthProvider',
        '#pid': 'oauthProviderId',
      },
      ExpressionAttributeValues: {
        ':provider': provider,
        ':pid': providerId,
      },
      Limit: 1,
    });
    const response = await docClient.send(command);
    return (response.Items && response.Items[0]) || null;
  }
  catch (err) {
    // GSI may not exist yet in local dev
    console.warn('[DB] provider-index GSI query failed, falling back to scan:', err.message);
    return null;
  }
}

async function getUser(userId) {
  return getItem(TABLES.USERS, {
    pk: userPK(userId),
    sk: 'PROFILE',
  });
}

async function createUser(userData) {
  const item = {
    pk: userPK(userData.id),
    sk: 'PROFILE',
    ...userData,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return putItem(TABLES.USERS, item);
}

async function updateUser(userId, updates) {
  return updateItem(TABLES.USERS, {
    pk: userPK(userId),
    sk: 'PROFILE',
  }, updates);
}

// ============================================
// Balance Operations
// ============================================

/**
 * Log a transaction to dedicated Transactions table
 * PK: TXN#timestamp#shortId, SK: USER#userId
 * GSIs:
 *   - user-ts-index: PK=userId, SK=ts (user history)
 *   - type-ts-index: PK=type, SK=ts (analytics)
 */
async function logTransaction(userId, { type, currency, amount, balanceBefore, balanceAfter, ref, refType, refName, unitPrice, quantity }) {
  const now = new Date();
  const shortId = Math.random().toString(36).substring(2, 8);
  const txnId = `txn_${shortId}${Math.random().toString(36).substring(2, 6)}`;

  const item = {
    pk: `TXN#${now.toISOString()}#${shortId}`,
    sk: `USER#${userId}`,
    id: txnId,
    userId,              // denormalized for GSI
    type,                // action_feed, store_purchase, etc.
    currency,            // 'essence' or 'gems'
    amount,              // negative = debit, positive = credit
    balanceBefore,
    balanceAfter,
    ts: now.toISOString(),
    // Optional fields for store transactions
    ...(refType && { refType }),
    ...(ref && { refId: ref }),
    ...(refName && { refName }),
    ...(unitPrice && { unitPrice }),
    ...(quantity && { quantity }),
  };

  await putItem(TABLES.TRANSACTIONS, item);
  return item;
}

/**
 * Get transactions by type for analytics (requires GSI: type-ts-index)
 * @param {string} type - Transaction type (action_train, store_purchase, etc.)
 * @param {object} options - { startTime, endTime, limit }
 */
async function getTransactionsByType(type, options = {}) {
  const { startTime, endTime, limit = 100 } = options;

  let keyCondition = '#type = :type';
  const exprNames = { '#type': 'type' };
  const exprValues = { ':type': type };

  if (startTime && endTime) {
    keyCondition += ' AND ts BETWEEN :start AND :end';
    exprValues[':start'] = startTime;
    exprValues[':end'] = endTime;
  }
  else if (startTime) {
    keyCondition += ' AND ts >= :start';
    exprValues[':start'] = startTime;
  }

  const command = new QueryCommand({
    TableName: TABLES.TRANSACTIONS,
    IndexName: 'type-ts-index',
    KeyConditionExpression: keyCondition,
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues,
    Limit: limit,
    ScanIndexForward: false, // Most recent first
  });

  try {
    const response = await docClient.send(command);
    return response.Items || [];
  }
  catch (err) {
    // GSI may not exist in local dev
    console.warn('Analytics GSI not available:', err.message);
    return [];
  }
}

/**
 * Get transaction analytics summary
 */
async function getTransactionAnalytics(type, startTime, endTime) {
  const txns = await getTransactionsByType(type, { startTime, endTime, limit: 1000 });

  return {
    type,
    period: { start: startTime, end: endTime },
    count: txns.length,
    totalAmount: txns.reduce((sum, t) => sum + t.amount, 0),
    uniqueUsers: [...new Set(txns.map(t => t.userId))].length,
  };
}

/**
 * Check if user has enough balance and deduct if so (ATOMIC)
 * Uses DynamoDB conditional update to prevent race conditions
 * Returns { success, newBalance, error }
 */
async function deductEssence(userId, amount, { type = 'action', ref = null, refType = null, refName = null } = {}) {
  try {
    const command = new UpdateCommand({
      TableName: TABLES.USERS,
      Key: { pk: userPK(userId), sk: 'PROFILE' },
      UpdateExpression: 'SET currencies.essence = currencies.essence - :amount, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk) AND currencies.essence >= :amount',
      ExpressionAttributeValues: {
        ':amount': amount,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    });

    const response = await docClient.send(command);
    const newBalance = response.Attributes?.currencies?.essence || 0;
    const balanceBefore = newBalance + amount; // Calculate what it was before

    // Log transaction
    await logTransaction(userId, {
      type,
      currency: 'essence',
      amount: -amount,
      balanceBefore,
      balanceAfter: newBalance,
      ref,
      refType,
      refName,
    });

    return { success: true, newBalance, deducted: amount };
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Either user doesn't exist or insufficient balance
      const user = await getUser(userId);
      if (!user) {
        return { success: false, error: 'User not found' };
      }
      const available = user.currencies?.essence || 0;
      return {
        success: false,
        error: 'Insufficient Essence',
        required: amount,
        available,
      };
    }
    throw err;
  }
}

/**
 * Add Essence to user balance (ATOMIC)
 * Uses DynamoDB atomic increment to prevent race conditions
 */
async function addEssence(userId, amount, { type = 'reward', ref = null, refType = null, refName = null } = {}) {
  try {
    const command = new UpdateCommand({
      TableName: TABLES.USERS,
      Key: { pk: userPK(userId), sk: 'PROFILE' },
      UpdateExpression: 'SET currencies.essence = if_not_exists(currencies.essence, :zero) + :amount, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':amount': amount,
        ':zero': 0,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    });

    const response = await docClient.send(command);
    const newBalance = response.Attributes?.currencies?.essence || 0;
    const balanceBefore = newBalance - amount; // Calculate what it was before

    // Log transaction
    await logTransaction(userId, {
      type,
      currency: 'essence',
      amount: amount,
      balanceBefore,
      balanceAfter: newBalance,
      ref,
      refType,
      refName,
    });

    return { success: true, newBalance, added: amount };
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { success: false, error: 'User not found' };
    }
    throw err;
  }
}

/**
 * Add Runes to user balance (ATOMIC)
 * Increments rune counts on the user currencies record.
 * @param {string} userId
 * @param {{ lesser?: number, greater?: number, ancient?: number }} runes
 */
async function addRunes(userId, runes, { type = 'reward', ref = null } = {}) {
  const lesser = runes.lesser || 0;
  const greater = runes.greater || 0;
  const ancient = runes.ancient || 0;

  // Skip if no runes earned
  if (lesser === 0 && greater === 0 && ancient === 0) {
    return { success: true, newBalances: { lesser: 0, greater: 0, ancient: 0 } };
  }

  // 'greater' is a DynamoDB reserved word — must use ExpressionAttributeNames
  const exprNames = {
    '#runes': 'runes',
    '#lesser': 'lesser',
    '#greater': 'greater',
    '#ancient': 'ancient',
  };

  try {
    const command = new UpdateCommand({
      TableName: TABLES.USERS,
      Key: { pk: userPK(userId), sk: 'PROFILE' },
      UpdateExpression: 'SET currencies.#runes.#lesser = if_not_exists(currencies.#runes.#lesser, :zero) + :lesser, currencies.#runes.#greater = if_not_exists(currencies.#runes.#greater, :zero) + :greater, currencies.#runes.#ancient = if_not_exists(currencies.#runes.#ancient, :zero) + :ancient, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: {
        ':lesser': lesser,
        ':greater': greater,
        ':ancient': ancient,
        ':zero': 0,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    });

    const response = await docClient.send(command);
    const newBalances = response.Attributes?.currencies?.runes || { lesser: 0, greater: 0, ancient: 0 };

    await logRuneTransaction(userId, { lesser, greater, ancient }, newBalances, type, ref);

    return { success: true, newBalances };
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { success: false, error: 'User not found' };
    }
    // If currencies.runes path doesn't exist yet, initialize it first
    if (err.name === 'ValidationException' && err.message?.includes('document path')) {
      const initCommand = new UpdateCommand({
        TableName: TABLES.USERS,
        Key: { pk: userPK(userId), sk: 'PROFILE' },
        UpdateExpression: 'SET currencies.#runes = :runes, updatedAt = :now',
        ExpressionAttributeNames: { '#runes': 'runes' },
        ExpressionAttributeValues: {
          ':runes': { lesser, greater, ancient },
          ':now': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      });
      const response = await docClient.send(initCommand);
      const newBalances = response.Attributes?.currencies?.runes || { lesser: 0, greater: 0, ancient: 0 };

      await logRuneTransaction(userId, { lesser, greater, ancient }, newBalances, type, ref);

      return { success: true, newBalances };
    }
    throw err;
  }
}

/**
 * Log individual rune transactions (one per rune type that was awarded)
 */
async function logRuneTransaction(userId, runesAdded, newBalances, type, ref) {
  const runeTypes = ['lesser', 'greater', 'ancient'];
  for (const runeType of runeTypes) {
    const amount = runesAdded[runeType] || 0;
    if (amount > 0) {
      await logTransaction(userId, {
        type,
        currency: `rune_${runeType}`,
        amount,
        balanceBefore: (newBalances[runeType] || 0) - amount,
        balanceAfter: newBalances[runeType] || 0,
        ref,
      });
    }
  }
}

/**
 * Get user's current Essence balance
 */
async function getEssenceBalance(userId) {
  const user = await getUser(userId);
  return user?.currencies?.essence || 0;
}

/**
 * Add Gems to user balance (ATOMIC)
 * Uses DynamoDB atomic increment to prevent race conditions
 */
async function addGems(userId, amount, { type = 'purchase', ref = null, refType = null, refName = null } = {}) {
  try {
    const command = new UpdateCommand({
      TableName: TABLES.USERS,
      Key: { pk: userPK(userId), sk: 'PROFILE' },
      UpdateExpression: 'SET currencies.gems = if_not_exists(currencies.gems, :zero) + :amount, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':amount': amount,
        ':zero': 0,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    });

    const response = await docClient.send(command);
    const newBalance = response.Attributes?.currencies?.gems || 0;
    const balanceBefore = newBalance - amount; // Calculate what it was before

    // Log transaction
    await logTransaction(userId, {
      type,
      currency: 'gems',
      amount: amount,
      balanceBefore,
      balanceAfter: newBalance,
      ref,
      refType,
      refName,
    });

    return { success: true, newBalance, added: amount };
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { success: false, error: 'User not found' };
    }
    throw err;
  }
}

/**
 * Deduct Gems from user balance (ATOMIC)
 * Uses DynamoDB conditional update to prevent race conditions and double-spend
 */
async function deductGems(userId, amount, { type = 'purchase', ref = null, refType = null, refName = null } = {}) {
  try {
    const command = new UpdateCommand({
      TableName: TABLES.USERS,
      Key: { pk: userPK(userId), sk: 'PROFILE' },
      UpdateExpression: 'SET currencies.gems = currencies.gems - :amount, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk) AND currencies.gems >= :amount',
      ExpressionAttributeValues: {
        ':amount': amount,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    });

    const response = await docClient.send(command);
    const newBalance = response.Attributes?.currencies?.gems || 0;
    const balanceBefore = newBalance + amount; // Calculate what it was before

    // Log transaction
    await logTransaction(userId, {
      type,
      currency: 'gems',
      amount: -amount,
      balanceBefore,
      balanceAfter: newBalance,
      ref,
      refType,
      refName,
    });

    return { success: true, newBalance, deducted: amount };
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Either user doesn't exist or insufficient balance
      const user = await getUser(userId);
      if (!user) {
        return { success: false, error: 'User not found' };
      }
      const available = user.currencies?.gems || 0;
      return {
        success: false,
        error: 'Insufficient Gems',
        required: amount,
        available,
      };
    }
    throw err;
  }
}

/**
 * Get user's current Gems balance
 */
async function getGemsBalance(userId) {
  const user = await getUser(userId);
  return user?.currencies?.gems || 0;
}

/**
 * Get user's transaction history (uses user-ts-index GSI)
 */
async function getTransactionHistory(userId, limit = 50) {
  const command = new QueryCommand({
    TableName: TABLES.TRANSACTIONS,
    IndexName: 'user-ts-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
    Limit: limit,
    ScanIndexForward: false, // Most recent first
  });

  try {
    const response = await docClient.send(command);
    return response.Items || [];
  }
  catch (err) {
    console.warn('Transaction history query failed:', err.message);
    return [];
  }
}

/**
 * Get count of bundle purchases today for a specific bundle
 * Used to enforce dailyLimit on special offers/bundles
 */
async function getBundlePurchasesToday(userId, bundleId) {
  // Use UTC midnight for consistent daily limit across timezones
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Get recent transactions and filter for today's bundle purchases
  const transactions = await getTransactionHistory(userId, 100);

  const todayPurchases = transactions.filter(txn => {
    if (txn.type !== 'purchase_bundle') return false;
    // Transaction stores ref as 'refId' field
    if (txn.refId !== bundleId) return false;
    const txnDate = new Date(txn.ts);
    const txnDateUTC = new Date(Date.UTC(txnDate.getUTCFullYear(), txnDate.getUTCMonth(), txnDate.getUTCDate()));
    return txnDateUTC.getTime() === todayUTC.getTime();
  });

  return todayPurchases.length;
}

// ============================================
// Totem Operations
// ============================================

async function getUserTotems(userId) {
  return queryItems(TABLES.TOTEMS, 'pk', userPK(userId), {
    skPrefix: KEY_PREFIX.TOTEM,
  });
}

async function getTotem(userId, totemId) {
  return getItem(TABLES.TOTEMS, {
    pk: userPK(userId),
    sk: totemSK(totemId),
  });
}

async function createTotem(totemData) {
  const item = {
    pk: userPK(totemData.userId),
    sk: totemSK(totemData.id),
    ...totemData,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return putItem(TABLES.TOTEMS, item);
}

async function updateTotem(userId, totemId, updates) {
  return updateItem(TABLES.TOTEMS, {
    pk: userPK(userId),
    sk: totemSK(totemId),
  }, updates);
}

// ============================================
// Challenge Progress Operations
// ============================================

async function getChallengeProgress(userId, challengeId) {
  return getItem(TABLES.CHALLENGE_PROGRESS, {
    pk: userPK(userId),
    sk: challengeSK(challengeId),
  });
}

async function getAllChallengeProgress(userId) {
  return queryItems(TABLES.CHALLENGE_PROGRESS, 'pk', userPK(userId), {
    skPrefix: KEY_PREFIX.CHALLENGE,
  });
}

async function updateChallengeProgress(userId, challengeId, updates) {
  const key = {
    pk: userPK(userId),
    sk: challengeSK(challengeId),
  };

  // Check if exists first
  const existing = await getItem(TABLES.CHALLENGE_PROGRESS, key);

  if (existing) {
    return updateItem(TABLES.CHALLENGE_PROGRESS, key, updates);
  }
  else {
    return putItem(TABLES.CHALLENGE_PROGRESS, {
      ...key,
      userId,
      challengeId,
      ...updates,
      createdAt: new Date().toISOString(),
    });
  }
}

// ============================================
// Stripe Lookup
// ============================================

/**
 * Cursor encode/decode for opaque pagination tokens.
 *
 * DynamoDB returns LastEvaluatedKey as an object; we base64-encode the JSON so
 * clients treat the cursor as opaque (lets us change the underlying key shape
 * without breaking API consumers).
 */
function encodeCursor(lastEvaluatedKey) {
  if (!lastEvaluatedKey) return null;
  return Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
}

function decodeCursor(cursor) {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  }
  catch {
    return undefined;
  }
}

/**
 * List users (admin) — single page with cursor pagination.
 *
 * Returns one page of profile records, filtered by optional search.
 *
 * NOTE: With a FilterExpression, DynamoDB scans up to `limit` rows then filters,
 * so a page may return fewer items than `limit` while still having a `nextCursor`.
 * Treat `nextCursor` (not item count) as the "more available" signal. A
 * `displayNameLower-index` GSI is a future improvement; scan is acceptable until
 * ~5K users.
 *
 * @param {object} options - { limit, cursor, search }
 * @returns {Promise<{ items: Array, nextCursor: string|null }>}
 */
async function listUsers({ limit = 50, cursor, search } = {}) {
  const params = {
    TableName: TABLES.USERS,
    FilterExpression: 'sk = :profile',
    ExpressionAttributeValues: { ':profile': 'PROFILE' },
    Limit: limit,
  };

  if (search) {
    params.FilterExpression += ' AND (contains(email, :search) OR contains(displayName, :search))';
    params.ExpressionAttributeValues[':search'] = search.toLowerCase();
  }

  const exclusiveStartKey = decodeCursor(cursor);
  if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

  const response = await docClient.send(new ScanCommand(params));
  return {
    items: response.Items || [],
    nextCursor: encodeCursor(response.LastEvaluatedKey),
  };
}

/**
 * Walk every page of listUsers — only used by /v1/admin/stats for aggregate
 * counts. Inherently expensive at scale (full-table scan); slated for
 * replacement by counter rows in a future PR (P2 of the scaling plan).
 *
 * A `maxItems` safety cap bounds the walk so a runaway table can't hang the
 * stats endpoint; hitting it logs a warning (aggregate counts are then a
 * lower-bound and the migration to counter rows is overdue).
 */
async function scanAllUsers({ search, maxItems = 20000 } = {}) {
  const items = [];
  let cursor;
  do {
    const page = await listUsers({ limit: 100, cursor, search });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (items.length >= maxItems) {
      console.warn(
        `[db-client] scanAllUsers hit the ${maxItems}-user safety cap — aggregate `
        + 'stats are truncated. Migrate /admin/stats to counter rows (scaling plan P2).',
      );
      break;
    }
  } while (cursor);
  return items;
}

/**
 * Count all totems (admin stats)
 */
async function countTotems() {
  let count = 0;
  let lastKey = undefined;

  do {
    const params = {
      TableName: TABLES.TOTEMS,
      Select: 'COUNT',
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;
    const response = await docClient.send(new ScanCommand(params));
    count += response.Count || 0;
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

/**
 * List transactions (admin) — single page with cursor pagination.
 *
 * Requires `userId` or `type` to pick a partition key. Either uses the
 * `user-ts-index` GSI (when userId is set) or the `type-ts-index` GSI (when
 * type is set). Optional FilterExpression layers narrow further by the other
 * field and/or `currency`.
 *
 * @param {object} options - { limit, cursor, userId, type, currency, startTime, endTime }
 * @returns {Promise<{ items: Array, nextCursor: string|null }>}
 */
async function listAllTransactions({ limit = 50, cursor, userId, type, currency, startTime, endTime } = {}) {
  if (!userId && !type) {
    throw new Error('listAllTransactions requires userId or type');
  }

  const exclusiveStartKey = decodeCursor(cursor);
  let params;

  if (userId) {
    // user-ts-index GSI: PK=userId, SK=ts
    let keyCondition = 'userId = :userId';
    const exprValues = { ':userId': userId };

    if (startTime && endTime) {
      keyCondition += ' AND ts BETWEEN :start AND :end';
      exprValues[':start'] = startTime;
      exprValues[':end'] = endTime;
    }
    else if (startTime) {
      keyCondition += ' AND ts >= :start';
      exprValues[':start'] = startTime;
    }

    params = {
      TableName: TABLES.TRANSACTIONS,
      IndexName: 'user-ts-index',
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: exprValues,
      Limit: limit,
      ScanIndexForward: false,
    };

    // Layer additional filters (type, currency) — these are FilterExpression
    // (post-fetch), acceptable since the GSI already narrowed by user.
    const filters = [];
    if (type) {
      params.ExpressionAttributeNames = { '#type': 'type' };
      filters.push('#type = :type');
      params.ExpressionAttributeValues[':type'] = type;
    }
    if (currency) {
      filters.push('currency = :currency');
      params.ExpressionAttributeValues[':currency'] = currency;
    }
    if (filters.length) params.FilterExpression = filters.join(' AND ');
  }
  else {
    // type-ts-index GSI: PK=type, SK=ts
    let keyCondition = '#type = :type';
    const exprNames = { '#type': 'type' };
    const exprValues = { ':type': type };

    if (startTime && endTime) {
      keyCondition += ' AND ts BETWEEN :start AND :end';
      exprValues[':start'] = startTime;
      exprValues[':end'] = endTime;
    }
    else if (startTime) {
      keyCondition += ' AND ts >= :start';
      exprValues[':start'] = startTime;
    }

    params = {
      TableName: TABLES.TRANSACTIONS,
      IndexName: 'type-ts-index',
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      Limit: limit,
      ScanIndexForward: false,
    };

    if (currency) {
      params.FilterExpression = 'currency = :currency';
      params.ExpressionAttributeValues[':currency'] = currency;
    }
  }

  if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

  // Fast path: no FilterExpression — one Query, return the natural page.
  if (!params.FilterExpression) {
    params.Limit = limit;
    const response = await docClient.send(new QueryCommand(params));
    return {
      items: response.Items || [],
      nextCursor: encodeCursor(response.LastEvaluatedKey),
    };
  }

  // Filter-aware path: a FilterExpression (e.g. type narrowing the userId GSI,
  // or currency filter) is applied AFTER DynamoDB reads each page. A single
  // Query with `Limit: N` would return between 0 and N matches — useless UX for
  // selective filters. So we iterate, accumulating matches across Query pages
  // until we have at least `limit` matches OR we exhaust data OR we hit a
  // safety cap on rows scanned (prevents runaway cost on very selective filters).
  const MAX_SCAN = Math.max(limit * 10, 200);
  const PER_ITER = Math.max(limit, 25);
  const collected = [];
  let lastKey = exclusiveStartKey;
  let scanned = 0;

  do {
    const iterParams = { ...params, Limit: Math.min(PER_ITER, MAX_SCAN - scanned) };
    if (lastKey) iterParams.ExclusiveStartKey = lastKey;
    else delete iterParams.ExclusiveStartKey;

    const response = await docClient.send(new QueryCommand(iterParams));
    collected.push(...(response.Items || []));
    scanned += response.ScannedCount || (response.Items || []).length;
    lastKey = response.LastEvaluatedKey;
  } while (collected.length < limit && lastKey && scanned < MAX_SCAN);

  return {
    items: collected,
    nextCursor: encodeCursor(lastKey),
  };
}

/**
 * Recent transactions across all users/types — only used by /v1/admin/stats.
 * Pure Scan with optional time window; expensive, slated for replacement by
 * counter rows / time-bucketed aggregates in a future PR (P2).
 */
async function scanRecentTransactions({ limit = 500, startTime, endTime } = {}) {
  const allItems = [];
  let lastKey;
  let remaining = limit;

  do {
    const params = {
      TableName: TABLES.TRANSACTIONS,
      Limit: Math.min(remaining, 100),
    };

    if (startTime || endTime) {
      const filters = [];
      const exprValues = {};
      if (startTime) {
        filters.push('ts >= :start');
        exprValues[':start'] = startTime;
      }
      if (endTime) {
        filters.push('ts <= :end');
        exprValues[':end'] = endTime;
      }
      params.FilterExpression = filters.join(' AND ');
      params.ExpressionAttributeValues = exprValues;
    }

    if (lastKey) params.ExclusiveStartKey = lastKey;

    const response = await docClient.send(new ScanCommand(params));
    allItems.push(...(response.Items || []));
    remaining -= (response.Items || []).length;
    lastKey = response.LastEvaluatedKey;
  } while (lastKey && remaining > 0);

  allItems.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return allItems.slice(0, limit);
}

async function getUserByStripeCustomerId(stripeCustomerId) {
  const command = new ScanCommand({
    TableName: TABLES.USERS,
    FilterExpression: 'stripeCustomerId = :cid',
    ExpressionAttributeValues: { ':cid': stripeCustomerId },
    Limit: 100,
  });

  const response = await docClient.send(command);
  return (response.Items || [])[0] || null;
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Clients
  ddbClient,
  docClient,

  // Tables
  TABLES,

  // Key helpers
  KEY_PREFIX,
  userPK,
  totemSK,
  challengeSK,
  expeditionSK,
  achievementSK,

  // Generic operations
  getItem,
  putItem,
  updateItem,
  rawUpdate,
  deleteItem,
  queryItems,
  transactWrite,

  // User operations
  getUserByEmail,
  getUserByProviderId,
  getUserByStripeCustomerId,
  getUser,
  createUser,
  updateUser,

  // Balance operations
  logTransaction,
  deductEssence,
  addEssence,
  getEssenceBalance,
  addGems,
  deductGems,
  addRunes,
  getGemsBalance,
  getTransactionHistory,
  getBundlePurchasesToday,

  // Analytics
  getTransactionsByType,
  getTransactionAnalytics,

  // Totem operations
  getUserTotems,
  getTotem,
  createTotem,
  updateTotem,

  // Challenge operations
  getChallengeProgress,
  getAllChallengeProgress,
  updateChallengeProgress,

  // Admin operations
  listUsers,
  scanAllUsers,
  countTotems,
  listAllTransactions,
  scanRecentTransactions,
  encodeCursor,
  decodeCursor,
};
