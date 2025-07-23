const { createUserWithApiKey } = require('../common/api-key');
const { sendWelcomeEmail } = require('../common/email');
const { validateEmail, normalizeAddress, formatResponse, validateParams } = require('../common/utils');
const { getUserByEmail, getUserByWallet } = require('../common/db');
const TurnstileVerification = require('../common/turnstile-verification');
const { getClientIP } = require('../common/client-utils');

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

    const { email, walletAddress, tier = 'free', turnstileToken } = body;

    // Validate Turnstile token for free tier
    if (tier.toLowerCase() === 'free') {
      if (!turnstileToken) {
        return formatResponse(400, { 
          error: 'Missing verification', 
          message: 'Security verification is required',
          field: 'turnstile',
          action: 'retry'
        }, process.env.CORS_ORIGIN);
      }

      // Verify turnstile token with CloudFlare
      const turnstileVerification = new TurnstileVerification();
      const clientIP = getClientIP(event);
      const verificationResult = await turnstileVerification.verifyToken(turnstileToken, clientIP);
      
      if (!verificationResult.success) {
        console.warn('Turnstile verification failed:', { 
          ip: clientIP, 
          errorCodes: verificationResult.errorCodes 
        });
        
        return formatResponse(400, {
          error: 'Verification failed',
          message: verificationResult.message,
          codes: verificationResult.errorCodes,
          field: 'turnstile',
          action: 'retry'
        }, process.env.CORS_ORIGIN);
      }
      
      // Log successful verification
      console.log('Turnstile verification successful:', { 
        ip: clientIP,
        email: email
      });
    }

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
          error: 'Account already exists',
          message: 'An account with these credentials already exists.',
          action: 'signin',
          keyExists: true
        },
        process.env.CORS_ORIGIN
      );
    }

    // For Free tier, create and send API key immediately
    const clientIP = getClientIP(event);
    const user = await createUserWithApiKey(normalizedEmail, normalizedWallet, 'free', clientIP);

    // Log successful user account creation
    console.log('User account created successfully:', {
      email: normalizedEmail,
      walletAddress: normalizedWallet,
      tier: 'free',
      clientIP: clientIP
    });

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
