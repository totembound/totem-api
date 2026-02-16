#!/usr/bin/env node
/**
 * Add Analytics GSI to TotemBound-Users table
 *
 * GSI: type-ts-index
 *   PK: type (transaction type: train, feed, treat, purchase, etc.)
 *   SK: ts (timestamp)
 *
 * Enables analytics queries like:
 *   - All train actions in the last 24 hours
 *   - Total Essence spent on treats this week
 *   - Purchase revenue by time period
 *
 * Usage:
 *   node scripts/add-analytics-gsi.js [--local]
 */

const { DynamoDBClient, UpdateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');

const isLocal = process.argv.includes('--local') || process.env.IS_LOCAL === 'true';

const clientConfig = isLocal
  ? {
      endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
      region: 'us-east-1',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }
  : {
      region: process.env.AWS_REGION || 'us-east-1',
    };

const client = new DynamoDBClient(clientConfig);
const TABLE_NAME = process.env.DYNAMODB_USERS_TABLE || 'TotemBound-Users';
const GSI_NAME = 'type-ts-index';

async function checkGSIExists() {
  const command = new DescribeTableCommand({ TableName: TABLE_NAME });
  const response = await client.send(command);

  const gsis = response.Table?.GlobalSecondaryIndexes || [];
  return gsis.some(gsi => gsi.IndexName === GSI_NAME);
}

async function addGSI() {
  console.log(`Adding GSI '${GSI_NAME}' to table '${TABLE_NAME}'...`);
  console.log(`Environment: ${isLocal ? 'LOCAL' : 'AWS'}`);

  // Check if GSI already exists
  const exists = await checkGSIExists();
  if (exists) {
    console.log(`GSI '${GSI_NAME}' already exists. Skipping.`);
    return;
  }

  const command = new UpdateTableCommand({
    TableName: TABLE_NAME,
    AttributeDefinitions: [
      { AttributeName: 'type', AttributeType: 'S' },
      { AttributeName: 'ts', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexUpdates: [
      {
        Create: {
          IndexName: GSI_NAME,
          KeySchema: [
            { AttributeName: 'type', KeyType: 'HASH' },
            { AttributeName: 'ts', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
          // For local DynamoDB, provisioned throughput is required
          ...(isLocal && {
            ProvisionedThroughput: {
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
          }),
        },
      },
    ],
  });

  try {
    await client.send(command);
    console.log(`GSI '${GSI_NAME}' created successfully!`);
    console.log('\nThis GSI enables analytics queries:');
    console.log('  - getTransactionsByType("train", { startTime, endTime })');
    console.log('  - getTransactionAnalytics("feed", startTime, endTime)');
  } catch (error) {
    if (error.name === 'ValidationException' && error.message.includes('already exists')) {
      console.log(`GSI '${GSI_NAME}' already exists.`);
    } else {
      throw error;
    }
  }
}

addGSI().catch(err => {
  console.error('Error adding GSI:', err.message);
  process.exit(1);
});
