const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { DynamoDB } = require('aws-sdk');
const { validateEmail, normalizeAddress } = require('../common/utils');

const dynamoDB = new DynamoDB.DocumentClient();

/**
 * Creates a Stripe checkout session for premium subscription
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
    const body = JSON.parse(event.body);
    const { email, walletAddress } = body;

    // Validate inputs
    if (!email || !validateEmail(email)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Invalid email',
          message: 'Please provide a valid email address'
        })
      };
    }

    if (!walletAddress) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing wallet address',
          message: 'Wallet address is required'
        })
      };
    }

    const normalizedWallet = normalizeAddress(walletAddress);

    // Check if user exists in DynamoDB
    const userParams = {
      TableName: process.env.USERS_TABLE,
      FilterExpression: 'email = :email OR walletAddress = :wallet',
      ExpressionAttributeValues: {
        ':email': email.toLowerCase(),
        ':wallet': normalizedWallet
      }
    };

    const userResult = await dynamoDB.scan(userParams).promise();
    const existingUser = userResult.Items.length > 0 ? userResult.Items[0] : null;

    // If user already has premium, don't create a new subscription
    if (existingUser && existingUser.tier === 'premium') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Already subscribed',
          message: 'You already have an active premium subscription'
        })
      };
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // Monthly subscription price
          quantity: 1
        }
      ],
      mode: 'subscription',
      success_url: process.env.STRIPE_SUCCESS_URL,
      cancel_url: process.env.STRIPE_CANCEL_URL,
      client_reference_id: normalizedWallet,
      customer_email: email.toLowerCase(),
      metadata: {
        walletAddress: normalizedWallet
      }
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        sessionUrl: session.url
      })
    };
  } catch (error) {
    console.error('Error creating checkout session:', error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};
