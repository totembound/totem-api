const { createUserWithApiKey, updateUserApiKey } = require('../common/api-key');
const { sendPremiumEmail, sendDowngradeEmail } = require('../common/email');
const { getUserByEmail, getUserByStripeCustomerId, updateUser } = require('../common/db');
const { getParameter } = require('../common/params');

// Handle Stripe webhook events for Premium tier subscription
exports.handler = async (event, context) => {
  try {
    // Stripe webhook signature verification
    const stripeSignature = event.headers['Stripe-Signature'];
    let stripeEvent;

    const stripeSecretKey = await getParameter(process.env.STRIPE_SECRET_KEY_PARAM);
    const stripeWebhookSecret = await getParameter(process.env.STRIPE_WEBHOOK_SECRET_PARAM);
    const stripe = require('stripe')(stripeSecretKey);

    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        stripeSignature,
        stripeWebhookSecret
      );
    } catch (err) {
      console.error('Stripe signature verification failed:', err);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid signature' })
      };
    }

    // Process the event based on type
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        return await handleCheckoutComplete(stripeEvent.data.object);

      case 'customer.subscription.deleted':
        return await handleSubscriptionDeleted(stripeEvent.data.object);

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
        return {
          statusCode: 200,
          body: JSON.stringify({ received: true })
        };
    }
  }
  catch (error) {
    console.error('Error processing webhook:', error);

    // More specific error handling
    if (error.type === 'StripeCardError') {
      // Handle card errors
    }
    else if (error.type === 'StripeInvalidRequestError') {
      // Handle invalid parameters
    }
    else if (error.type === 'StripeAPIError') {
      // Handle API errors
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};

// Create premium API key after successful checkout
async function handleCheckoutComplete(session) {
  // Get customer metadata from session
  const email = session.customer_email;
  const walletAddress = session.metadata.walletAddress;

  if (!email || !walletAddress) {
    console.error('Missing email or wallet address in checkout session');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing customer data' })
    };
  }

  // Check if user already exists
  const existingUser = await getUserByEmail(email);

  if (existingUser) {
    // If user exists, update to premium tier
    if (existingUser.tier === 'premium') {
      // Already premium, nothing to do
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'User already has premium access' })
      };
    }

    // Update API key to premium tier using helper
    const updatedUser = await updateUserApiKey(existingUser.userId, 'premium');

    // Update Stripe customer ID
    await updateUser(existingUser.userId, {
      stripeCustomerId: session.customer
    });

    // Send upgrade email
    await sendPremiumEmail(email, updatedUser.apiKey, true);
  }
  else {
    // Create new premium user with API key
    try {
      const user = await createUserWithApiKey(email, walletAddress, 'premium');

      // Add Stripe customer ID
      await updateUser(user.userId, {
        stripeCustomerId: session.customer
      });

      // Send welcome email
      await sendPremiumEmail(email, user.apiKey, false);
    }
    catch (error) {
      console.error('Error creating premium user:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to create premium user', message: error.message })
      };
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
}

// Handle subscription cancellation
async function handleSubscriptionDeleted(subscription) {
  // Find user by Stripe customer ID
  const user = await getUserByStripeCustomerId(subscription.customer);

  if (!user) {
    console.error('User not found for Stripe customer:', subscription.customer);
    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'User not found' })
    };
  }

  // Deactivate premium API key
  await apigateway
    .updateApiKey({
      apiKey: user.apiKeyId,
      patchOperations: [
        {
          op: 'replace',
          path: '/enabled',
          value: 'false'
        }
      ]
    })
    .promise();

  // Downgrade user to free tier using helper
  const updatedUser = await updateUserApiKey(user.userId, 'free');

  // Send downgrade email
  await sendDowngradeEmail(user.email, updatedUser.apiKey);

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
}
