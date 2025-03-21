const { createUserWithApiKey } = require('../common/api-key');
const { sendWelcomeEmail } = require('../common/email');
const { validateEmail, normalizeAddress, formatResponse, validateParams } = require('../common/utils');
const { getUserByEmail, getUserByWallet } = require('../common/db');

/**
 * Handles user signup and API key creation
 */
exports.handler = async (event, context) => {
  // Set up CORS headers
  const headers = {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'CORS preflight response' })
    };
  }

  try {
    // Parse request body
    let body;
    try {
      body = JSON.parse(event.body);
    }
    catch (parseError) {
      // Handle malformed JSON specifically
      return formatResponse(
        400,
        {
          error: 'Invalid request format',
          message: 'Request body must be valid JSON'
        },
        process.env.CORS_ORIGIN
      );
    }

    const { email, walletAddress, tier = 'free' } = body;

    // Validate inputs
    const validationError = validateParams({ email, walletAddress }, ['email', 'walletAddress']);
    if (validationError) {
      return formatResponse(
        validationError.statusCode,
        {
          error: validationError.error,
          message: validationError.error
        },
        process.env.CORS_ORIGIN
      );
    }

    if (!validateEmail(email)) {
      return formatResponse(
        400,
        {
          error: 'Invalid email',
          message: 'Please provide a valid email address'
        },
        process.env.CORS_ORIGIN
      );
    }

    // Normalize inputs
    const normalizedEmail = email.toLowerCase();
    const normalizedWallet = normalizeAddress(walletAddress);

    // Check if user already exists
    const existingUserEmail = await getUserByEmail(normalizedEmail);
    const existingUserWallet = await getUserByWallet(normalizedWallet);

    if (existingUserEmail || existingUserWallet) {
      return formatResponse(
        409,
        {
          error: 'User exists',
          message: 'An API key is already associated with this email or wallet address',
          keyExists: true
        },
        process.env.CORS_ORIGIN
      );
    }

    if (tier.toLowerCase() === 'premium') {
      // For Premium tier, redirect to payment flow
      return formatResponse(
        200,
        {
          message: 'Redirect to payment flow',
          redirectUrl: `${process.env.PAYMENT_URL}?email=${encodeURIComponent(normalizedEmail)}&wallet=${encodeURIComponent(normalizedWallet)}`
        },
        process.env.CORS_ORIGIN
      );
    }
    else {
      // For Free tier, create and send API key immediately
      const user = await createUserWithApiKey(normalizedEmail, normalizedWallet, 'free');

      // Send welcome email with API key
      await sendWelcomeEmail(normalizedEmail, user.apiKey);

      // Return success response
      return formatResponse(
        200,
        {
          message: 'API key created successfully',
          apiKey: user.apiKey
        },
        process.env.CORS_ORIGIN
      );
    }
  }
  catch (error) {
    console.error('Error processing signup:', error);

    return formatResponse(
      500,
      {
        error: 'Internal server error',
        message: error.message
      },
      process.env.CORS_ORIGIN
    );
  }
};
