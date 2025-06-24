// Determine which database implementation to use
const isLocalDev = process.env.NODE_ENV === 'development' || process.env.LOCAL_DEV === 'true';
const useMockDb = process.env.USE_MOCK_DB === 'true';

let dbImplementation;

if (useMockDb) {
  console.log('🔧 Using mock database for local development');
  dbImplementation = require('./db-mock');
} else if (isLocalDev && process.env.DYNAMODB_ENDPOINT) {
  console.log('🐳 Using local DynamoDB');
  dbImplementation = require('./db-local');
} else {
  console.log('☁️  Using AWS DynamoDB');
  dbImplementation = require('./db-aws');
}

// Export all functions from the selected implementation
module.exports = dbImplementation;
