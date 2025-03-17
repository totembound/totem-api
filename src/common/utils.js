/**
 * Common utility functions used across multiple Lambda functions
 */

/**
 * Validates an email address format
 * @param {string} email - Email to validate
 * @returns {boolean} - True if valid email format
 */
exports.validateEmail = email => {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(String(email).toLowerCase());
};

/**
 * Normalizes an Ethereum address to lowercase
 * @param {string} address - Ethereum address
 * @returns {string} - Normalized address
 */
exports.normalizeAddress = address => String(address).toLowerCase();

/**
 * Generates a random API key with prefix
 * @param {string} prefix - Prefix for the API key (free_ or premium_)
 * @returns {string} - Generated API key
 */
exports.generateApiKey = (prefix = 'free_') => {
  const randomBytes = require('crypto').randomBytes(16);
  const key = randomBytes.toString('hex');
  return `${prefix}${key}`;
};

/**
 * Formats a response with CORS headers
 * @param {number} statusCode - HTTP status code
 * @param {object} body - Response body
 * @param {string} corsOrigin - CORS origin
 * @returns {object} - Formatted response
 */
exports.formatResponse = (statusCode, body, corsOrigin = '*') => ({
  statusCode,
  headers: {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  },
  body: JSON.stringify(body)
});

/**
 * Validates request parameters
 * @param {object} params - Parameters to validate
 * @param {array} required - Required parameter names
 * @returns {object|null} - Error object or null if valid
 */
exports.validateParams = (params, required) => {
  for (const param of required) {
    if (!params[param]) {
      return {
        error: `Missing parameter: ${param}`,
        statusCode: 400
      };
    }
  }
  return null;
};

/**
 * Parses an API Gateway event
 * @param {object} event - API Gateway event
 * @returns {object} - Parsed body and query parameters
 */
exports.parseEvent = event => {
  let body = {};
  let queryParams = {};

  // Parse body if present
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      console.warn('Failed to parse event body');
    }
  }

  // Parse query parameters if present
  if (event.queryStringParameters) {
    queryParams = event.queryStringParameters;
  }

  return { body, queryParams };
};

/**
 * Gets current timestamp in seconds
 * @returns {number} - Current timestamp
 */
exports.currentTimestamp = () => Math.floor(Date.now() / 1000);

/**
 * Delays execution for specified milliseconds
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} - Promise that resolves after delay
 */
exports.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
