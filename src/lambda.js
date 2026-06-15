/**
 * TotemBound Lambda Handler
 *
 * Wraps the Express app for AWS Lambda execution via API Gateway.
 * API Gateway sends all requests to this single Lambda via {proxy+} integration.
 * Express handles the routing internally, same as local development.
 *
 * CORS preflight (OPTIONS) is handled by API Gateway MOCK integration
 * and never reaches this Lambda.
 */

const serverless = require('serverless-http');
const { app, finalize } = require('./app');

// Finalize the app (add error/404 handlers last)
finalize();

module.exports.handler = serverless(app);
