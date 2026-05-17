#!/usr/bin/env node

/**
 * TotemBound DynamoDB Table Initialization
 *
 * Creates all required tables for local development.
 * Uses native fetch for Node v24 compatibility.
 *
 * Run: node scripts/init-tables.js
 */

require('dotenv').config({ path: '.env.local' });

// ============================================
// Configuration
// ============================================

const ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';

// ============================================
// Table Definitions
// ============================================

const tables = [
  {
    TableName: 'TotemBound-Users',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'oauthProvider', AttributeType: 'S' },
      { AttributeName: 'oauthProviderId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'email-index',
        KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'provider-index',
        KeySchema: [
          { AttributeName: 'oauthProvider', KeyType: 'HASH' },
          { AttributeName: 'oauthProviderId', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'TotemBound-Totems',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'TotemBound-ChallengeProgress',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'TotemBound-ExpeditionState',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'TotemBound-RewardState',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'TotemBound-AchievementProgress',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'TotemBound-RewardsClaims',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'TotemBound-Transactions',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'ts', AttributeType: 'S' },
      { AttributeName: 'type', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'user-ts-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'ts', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'type-ts-index',
        KeySchema: [
          { AttributeName: 'type', KeyType: 'HASH' },
          { AttributeName: 'ts', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: 'TotemBound-Shop',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'originalOwnerId', AttributeType: 'S' },
      { AttributeName: 'listedAt', AttributeType: 'S' },
      { AttributeName: 'speciesId', AttributeType: 'N' },
      { AttributeName: 'rarityId', AttributeType: 'N' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'seller-index',
        KeySchema: [
          { AttributeName: 'originalOwnerId', KeyType: 'HASH' },
          { AttributeName: 'listedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'species-index',
        KeySchema: [
          { AttributeName: 'speciesId', KeyType: 'HASH' },
          { AttributeName: 'listedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'rarity-index',
        KeySchema: [
          { AttributeName: 'rarityId', KeyType: 'HASH' },
          { AttributeName: 'listedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
];

// ============================================
// DynamoDB API Functions using fetch
// ============================================

// Generate AWS4 signature headers for DynamoDB Local
function getAuthHeaders() {
  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  return {
    'X-Amz-Date': amzDate,
    'Authorization': `AWS4-HMAC-SHA256 Credential=local/${dateStamp}/us-east-1/dynamodb/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=${'0'.repeat(64)}`,
  };
}

async function dynamoRequest(target, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': `DynamoDB_20120810.${target}`,
        ...getAuthHeaders(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data.message || data.Message || 'Unknown error');
      error.code = data.__type?.split('#')[1] || 'UnknownError';
      throw error;
    }

    return data;
  }
  catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

async function listTables() {
  const result = await dynamoRequest('ListTables', {});
  return result.TableNames || [];
}

async function waitForDynamo(maxAttempts = 30, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await dynamoRequest('ListTables', {});
      if (attempt > 1) console.log(`✓ DynamoDB ready after ${attempt} attempts`);
      return;
    }
    catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`DynamoDB not reachable at ${ENDPOINT} after ${maxAttempts}s: ${error.message}`);
      }
      if (attempt === 1) process.stdout.write('⏳ Waiting for DynamoDB to become ready');
      process.stdout.write('.');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function createTable(definition) {
  return dynamoRequest('CreateTable', definition);
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('');
  console.log('🗄️  TotemBound DynamoDB Table Initialization');
  console.log('=============================================');
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log('');

  // Wait for DynamoDB to finish starting up (docker-compose up -d returns before the
  // container is actually accepting requests). Retries for up to 30s.
  try {
    await waitForDynamo();
    if (process.stdout.write('')) console.log(''); // newline after dots if we printed any
  }
  catch (error) {
    console.error('');
    console.error(`❌ ${error.message}`);
    console.error('');
    console.error('Make sure Docker services are running:');
    console.error('  cd docker && docker compose up -d');
    console.error('');
    process.exit(1);
  }

  // Check existing tables
  const existingTables = await listTables();
  console.log('Existing tables:', existingTables.length > 0 ? existingTables.join(', ') : 'none');
  console.log('');

  // Create tables
  for (const tableDefinition of tables) {
    const tableName = tableDefinition.TableName;

    if (existingTables.includes(tableName)) {
      console.log(`✓ ${tableName} (already exists)`);
      continue;
    }

    try {
      await createTable(tableDefinition);
      console.log(`✓ ${tableName} (created)`);
    }
    catch (error) {
      if (error.code === 'ResourceInUseException') {
        console.log(`✓ ${tableName} (already exists)`);
      }
      else {
        console.error(`✗ ${tableName}: ${error.message}`);
      }
    }
  }

  // ============================================
  // Seed Dev Test User (matches cognito-client.js test credentials)
  // ============================================

  const TEST_USER_ID = 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const TEST_USER_EMAIL = 'testplayer1@example.com';
  const TEST_USER_NAME = 'TestPlayer1';
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Check if test user already exists
  let userExists = false;
  try {
    const result = await dynamoRequest('GetItem', {
      TableName: 'TotemBound-Users',
      Key: { pk: { S: `USER#${TEST_USER_ID}` }, sk: { S: 'PROFILE' } },
    });
    userExists = !!result.Item;
  }
  catch (e) { /* table may be empty */ }

  if (userExists) {
    console.log(`✓ Dev test user already seeded (${TEST_USER_EMAIL})`);
  }
  else {
    console.log('');
    console.log('🌱 Seeding dev test user...');

    const lootId = `lot_seed-uncommon-box-001`;
    const txnId = `txn_seed-signup-bonus-001`;

    // 1. User profile record (2000 Essence, 0 Gems — same as runtime signup)
    await dynamoRequest('PutItem', {
      TableName: 'TotemBound-Users',
      Item: {
        pk: { S: `USER#${TEST_USER_ID}` },
        sk: { S: 'PROFILE' },
        id: { S: TEST_USER_ID },
        email: { S: TEST_USER_EMAIL },
        displayName: { S: TEST_USER_NAME },
        tier: { S: 'free' },
        role: { S: 'user' },
        currencies: { M: {
          essence: { N: '2000' },
          gems: { N: '0' },
        }},
        stats: { M: {
          totalTotems: { N: '0' },
          totalChallengesCompleted: { N: '0' },
          loginStreak: { N: '0' },
          lastLoginDate: { S: today },
        }},
        settings: { M: {
          notifications: { BOOL: true },
          darkMode: { S: 'dark' },
        }},
        createdAt: { S: now },
        updatedAt: { S: now },
      },
    });
    console.log(`  ✓ User profile (${TEST_USER_EMAIL}, 2000 Essence)`);

    // 2. Uncommon Totem Box loot item (unclaimed — matches runtime grantLootItem() exactly)
    await dynamoRequest('PutItem', {
      TableName: 'TotemBound-RewardState',
      Item: {
        pk: { S: `USER#${TEST_USER_ID}` },
        sk: { S: `LOOT#${lootId}` },
        id: { S: lootId },
        userId: { S: TEST_USER_ID },
        boxId: { S: 'uncommon_totem_box' },
        source: { S: 'signup' },
        status: { S: 'unclaimed' },
        grantedAt: { S: now },
        claimedAt: { NULL: true },
        claimResult: { NULL: true },
      },
    });
    console.log('  ✓ Uncommon Totem Box (unclaimed loot)');

    // 3. Signup bonus transaction log (matches runtime logTransaction() exactly)
    const shortId = 'seed01';
    await dynamoRequest('PutItem', {
      TableName: 'TotemBound-Transactions',
      Item: {
        pk: { S: `TXN#${now}#${shortId}` },
        sk: { S: `USER#${TEST_USER_ID}` },
        id: { S: txnId },
        userId: { S: TEST_USER_ID },
        type: { S: 'reward_signup' },
        currency: { S: 'essence' },
        amount: { N: '2000' },
        balanceBefore: { N: '0' },
        balanceAfter: { N: '2000' },
        ts: { S: now },
        refType: { S: 'reward' },
        refName: { S: 'Welcome Bonus' },
      },
    });
    console.log('  ✓ Signup bonus transaction (2000 Essence)');

    // 4. No achievements on signup — they fire when loot box is claimed (onTotemAcquired)
    console.log('  ℹ  No achievements seeded (fire on first totem claim, not signup)');

    console.log(`  ✅ Dev test user ready! Login: ${TEST_USER_EMAIL} / TestPassword123!`);
  }

  // ============================================
  // Seed Admin Test User
  // ============================================

  const ADMIN_USER_ID = 'usr_d4e5f6a7-b8c9-0123-defa-234567890123';
  const ADMIN_USER_EMAIL = 'admin@example.com';
  const ADMIN_USER_NAME = 'AdminUser';

  let adminExists = false;
  try {
    const result = await dynamoRequest('GetItem', {
      TableName: 'TotemBound-Users',
      Key: { pk: { S: `USER#${ADMIN_USER_ID}` }, sk: { S: 'PROFILE' } },
    });
    adminExists = !!result.Item;
  }
  catch (e) { /* table may be empty */ }

  if (adminExists) {
    console.log(`✓ Admin test user already seeded (${ADMIN_USER_EMAIL})`);
  }
  else {
    console.log('');
    console.log('🌱 Seeding admin test user...');

    await dynamoRequest('PutItem', {
      TableName: 'TotemBound-Users',
      Item: {
        pk: { S: `USER#${ADMIN_USER_ID}` },
        sk: { S: 'PROFILE' },
        id: { S: ADMIN_USER_ID },
        email: { S: ADMIN_USER_EMAIL },
        displayName: { S: ADMIN_USER_NAME },
        tier: { S: 'free' },
        role: { S: 'admin' },
        currencies: { M: {
          essence: { N: '99999' },
          gems: { N: '9999' },
        }},
        stats: { M: {
          totalTotems: { N: '0' },
          totalChallengesCompleted: { N: '0' },
          loginStreak: { N: '0' },
          lastLoginDate: { S: today },
        }},
        settings: { M: {
          notifications: { BOOL: true },
          darkMode: { S: 'dark' },
        }},
        createdAt: { S: now },
        updatedAt: { S: now },
      },
    });

    console.log(`  ✅ Admin test user ready! Login: ${ADMIN_USER_EMAIL} / AdminPass123!`);
  }

  console.log('');
  console.log('✅ Tables initialized!');
  console.log('');
  console.log('View tables at: http://localhost:8001');
  console.log('');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
