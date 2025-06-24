// common/api-key.js - Environment-based API key verification

// Determine which implementation to use
const useMockApiKey = process.env.USE_MOCK_DB === 'true' || process.env.USE_MOCK_API_KEY === 'true';
const isLocalDev = process.env.NODE_ENV === 'development' || process.env.LOCAL_DEV === 'true';

let apiKeyImplementation;

if (useMockApiKey) {
  console.log('🔧 Using mock API key verification');
  apiKeyImplementation = require('./api-key-mock');
} else if (isLocalDev && process.env.DYNAMODB_ENDPOINT) {
  console.log('🐳 Using local DynamoDB for API key verification');
  apiKeyImplementation = require('./api-key-local');
} else {
  console.log('☁️  Using AWS DynamoDB for API key verification');
  apiKeyImplementation = require('./api-key-aws');
}

// Export all functions from the selected implementation
module.exports = apiKeyImplementation;
