/**
 * Local development server for Lambda functions
 * Allows testing functions locally with Express
 */

const express = require('express');
const morgan = require('morgan');
const helmet = require('helmet');
const path = require('path');
const dotenv = require('dotenv');
const chalk = require('chalk');

// Load environment variables
dotenv.config({ path: '.env.local' });

// Get function name from command line args
const functionName = process.argv[2];
if (!functionName) {
  console.error(chalk.red('Error: Function name is required'));
  console.log(chalk.cyan('Usage: node scripts/local-dev.js [function-name]'));
  console.log(chalk.cyan('Available functions: relay, signup, premium, checkout'));
  process.exit(1);
}

// Check if function is valid
const validFunctions = ['relay', 'signup', 'premium', 'checkout'];
if (!validFunctions.includes(functionName)) {
  console.error(chalk.red(`Error: Invalid function name: ${functionName}`));
  console.log(chalk.cyan(`Available functions: ${validFunctions.join(', ')}`));
  process.exit(1);
}

// Load function-specific environment variables
const envPath = path.join(__dirname, '..', 'src', functionName, '.env');
if (require('fs').existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(chalk.green(`Loaded environment variables from ${envPath}`));
} else {
  console.log(chalk.yellow(`Warning: No .env file found for ${functionName}`));
}

// Set up Express app
const app = express();
app.use(helmet());
app.use(express.json());
app.use(morgan('dev'));

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, X-Api-Key, Authorization'
  );
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  // Add preflight caching headers to reduce OPTIONS requests
  // Cache preflight requests for 24 hours (86400 seconds)
  res.header('Access-Control-Max-Age', '86400');

  // Handle OPTIONS requests immediately
  if (req.method === 'OPTIONS') {
    // Add some cache headers to make browsers cache the response
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Expires', new Date(Date.now() + 86400000).toUTCString());
    return res.sendStatus(204); // No content needed for OPTIONS
  }

  next();
});

// Load the Lambda handler
let lambdaHandler;
try {
  const functionPath = path.join(__dirname, '..', 'src', functionName, 'index.js');
  lambdaHandler = require(functionPath).handler;
  console.log(chalk.green(`Loaded Lambda handler from ${functionPath}`));
} catch (error) {
  console.error(chalk.red(`Error loading Lambda handler: ${error.message}`));
  process.exit(1);
}

// Function to convert Express request to API Gateway event
function createEvent(req) {
  return {
    httpMethod: req.method,
    path: req.path,
    pathParameters: req.params,
    queryStringParameters: req.query,
    headers: req.headers,
    body: JSON.stringify(req.body),
    isBase64Encoded: false
  };
}

// Function to convert Lambda response to Express response
function sendResponse(res, lambdaResponse) {
  // Set status code
  res.status(lambdaResponse.statusCode);

  // Set headers
  if (lambdaResponse.headers) {
    Object.entries(lambdaResponse.headers).forEach(([key, value]) => {
      res.header(key, value);
    });
  }

  // Send body
  if (lambdaResponse.body) {
    try {
      const bodyObj = JSON.parse(lambdaResponse.body);
      res.json(bodyObj);
    } catch (error) {
      res.send(lambdaResponse.body);
    }
  } else {
    res.end();
  }
}

// Define routes based on function type
switch (functionName) {
  case 'relay':
    // Main relay endpoint
    app.post('/relay', async (req, res) => {
      try {
        const event = createEvent(req);
        const result = await lambdaHandler(event);
        sendResponse(res, result);
      } catch (error) {
        console.error(chalk.red(`Error in relay handler: ${error.message}`));
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
      }
    });
    // Health check endpoint
    app.get('/health', async (req, res) => {
      try {
        const event = createEvent(req);
        const result = await lambdaHandler(event);
        sendResponse(res, result);
      } catch (error) {
        console.error(chalk.red(`Error in health handler: ${error.message}`));
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
      }
    });
    break;

  case 'signup':
    app.post('/signup', async (req, res) => {
      try {
        const event = createEvent(req);
        const result = await lambdaHandler(event);
        sendResponse(res, result);
      } catch (error) {
        console.error(chalk.red(`Error in signup handler: ${error.message}`));
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
      }
    });
    break;

  case 'premium':
    app.post('/webhook', async (req, res) => {
      try {
        const event = createEvent(req);
        const result = await lambdaHandler(event);
        sendResponse(res, result);
      } catch (error) {
        console.error(chalk.red(`Error in premium webhook handler: ${error.message}`));
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
      }
    });
    break;

  case 'checkout':
    app.post('/create-checkout', async (req, res) => {
      try {
        const event = createEvent(req);
        const result = await lambdaHandler(event);
        sendResponse(res, result);
      } catch (error) {
        console.error(chalk.red(`Error in checkout handler: ${error.message}`));
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
      }
    });
    break;
}

// Set up port and start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(
    chalk.bold.green(`\n🚀 Local ${functionName} server running at http://localhost:${PORT}\n`)
  );

  // Display available endpoints
  console.log(chalk.cyan('Available endpoints:'));
  switch (functionName) {
    case 'relay':
      console.log(`  POST http://localhost:${PORT}/v1/relay      - Relay transactions`);
      console.log(`  GET  http://localhost:${PORT}/v1/health     - Health check`);
      break;
    case 'signup':
      console.log(`  POST http://localhost:${PORT}/v1/signup     - Create API key`);
      break;
    case 'premium':
      console.log(`  POST http://localhost:${PORT}/v1/webhook    - Stripe webhook handler`);
      break;
    case 'checkout':
      console.log(`  POST http://localhost:${PORT}/v1/create-checkout - Create checkout session`);
      break;
  }

  console.log(chalk.yellow('\nPress Ctrl+C to stop the server\n'));
});
