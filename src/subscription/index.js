const { getUserByApiKey } = require('../common/db');
const { getParameter } = require('../common/params');

exports.handler = async (event, context) => {
  // Set up CORS headers
  const headers = {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
    'Access-Control-Allow-Methods': 'POST,GET,DELETE,OPTIONS'
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
    const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];

    if (!apiKey) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: 'Forbidden',
          message: 'Invalid API key'
        })
      };
    }

    if (event.resource === '/subscription/portal' && event.httpMethod === 'GET') {
      return await handleBillingPortal(apiKey, headers);
    }

    switch (event.httpMethod) {
      case 'GET':
        return await handleGetSubscriptionStatus(apiKey, headers);

      case 'DELETE':
        return await handleCancelSubscription(apiKey, headers);

      default:
        console.log(`Unhandled event method: ${event.httpMethod}`);
        return {
          statusCode: 405,
          headers,
          body: JSON.stringify({
            error: 'Method not allowed',
            message: `${event.httpMethod} is not supported for this endpoint`
          })
        };
    }
  }
  catch (error) {
    console.error('Error processing subscription:', error);

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

async function handleGetSubscriptionStatus(apiKey, headers) {
  const user = await getUserByApiKey(apiKey);
  if (!user || !user.isActive) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({
        error: 'No subscription found'
      })
    };
  }

  let renewalDate = null;
  let canceled = false;
  // get subscription status for renewal date, etc.
  if (user.stripeCustomerId) {
    const stripeSecretKey = await getParameter(process.env.STRIPE_SECRET_KEY_PARAM);
    const stripe = require('stripe')(stripeSecretKey);

    // Get subscription info from Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'active',
      limit: 1
    });

    // TODO test
    console.log(subscriptions);

    if (subscriptions.data.length > 0) {
      renewalDate = new Date(subscriptions.data[0].current_period_end * 1000).toISOString();
      canceled = subscriptions.data[0].cancel_at_period_end;
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      tier: user.tier,
      memberSince: user.createdAt,
      renewalDate,
      canceled
    })
  };
}

async function handleCancelSubscription(apiKey, headers) {
  const user = await getUserByApiKey(apiKey);

  if (!user || !user.isActive) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({
        error: 'Unauthorized'
      })
    };
  }

  // Check if user has an active subscription
  if (!user.stripeCustomerId) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({
        error: 'No active subscription found'
      })
    };
  }

  try {
    // Get Stripe API key
    const stripeSecretKey = await getParameter(process.env.STRIPE_SECRET_KEY_PARAM);
    const stripe = require('stripe')(stripeSecretKey);

    // Get customer's active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: 'No active subscription found'
        })
      };
    }

    const subscription = subscriptions.data[0];

    // Check if subscription is already set to cancel
    if (subscription.cancel_at_period_end) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Subscription is already scheduled to cancel',
          currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
          canceled: true
        })
      };
    }

    // Cancel the subscription at period end
    await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true
    });

    console.log(
      `Subscription ${subscription.id} for user ${user.userId} scheduled to cancel at period end`
    );

    // Return success with period end date
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Subscription will be canceled at the end of the billing period',
        currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
        canceled: true
      })
    };
  }
  catch (error) {
    console.error('Error canceling subscription:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to cancel subscription',
        message: error.message
      })
    };
  }
}

async function handleBillingPortal(apiKey, headers) {
  const user = await getUserByApiKey(apiKey);

  if (!user || !user.isActive || !user.stripeCustomerId) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({
        error: 'No active subscription found'
      })
    };
  }

  // Create a billing portal session
  const stripeSecretKey = await getParameter(process.env.STRIPE_SECRET_KEY_PARAM);
  const stripe = require('stripe')(stripeSecretKey);

  // Get the return URL from environment or use a default
  const returnUrl = process.env.PORTAL_RETURN_URL || 'https://totembound.com/account/settings';

  // Create the portal session
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: returnUrl
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      portalUrl: session.url
    })
  };
}
