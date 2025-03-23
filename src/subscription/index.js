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

    } catch (error) {
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
}

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

    // TODO test
    console.log(user);

    let renewalDate = null;
    // get subscription status for renewal date, etc.
    if (user.stripeCustomerId) {
        const stripeSecretKey = await getParameter(process.env.STRIPE_SECRET_KEY_PARAM);
        const stripe = require('stripe')(stripeSecretKey);
    
        // Get subscription info from Stripe
        const subscriptions = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: 'active',
            limit: 1,
        });

        // TODO test
        console.log(subscriptions);

        renewalDate = subscriptions.data.length > 0 ? 
            new Date(subscriptions.data[0].current_period_end * 1000).toISOString() : null;
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          tier: user.tier,
          memberSince: user.createdAt,
          renewalDate
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

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: 'Success'
        })
    };
}
