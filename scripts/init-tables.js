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
  } catch (error) {
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

  // Check existing tables
  let existingTables = [];
  try {
    existingTables = await listTables();
    console.log('Existing tables:', existingTables.length > 0 ? existingTables.join(', ') : 'none');
    console.log('');
  } catch (error) {
    console.error('❌ Cannot connect to DynamoDB Local:', error.message);
    console.error('');
    console.error('Make sure Docker services are running:');
    console.error('  cd docker && docker compose up -d');
    console.error('');
    process.exit(1);
  }

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
    } catch (error) {
      if (error.code === 'ResourceInUseException') {
        console.log(`✓ ${tableName} (already exists)`);
      } else {
        console.error(`✗ ${tableName}: ${error.message}`);
      }
    }
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
