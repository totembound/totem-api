const AWS = require('aws-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const apigateway = new AWS.APIGateway();
const SES = new AWS.SES({ region: 'us-east-1' });
const { v4: uuidv4 } = require('uuid');

// Handle Stripe webhook events for Premium tier subscription
exports.handler = async (event, context) => {
  try {
    // Stripe webhook signature verification
    const stripeSignature = event.headers['stripe-signature'];
    let stripeEvent;

    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        stripeSignature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    }
    catch (err) {
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

    // Deactivate old API key
    await apigateway
      .updateApiKey({
        apiKey: existingUser.apiKeyId,
        patchOperations: [
          {
            op: 'replace',
            path: '/enabled',
            value: 'false'
          }
        ]
      })
      .promise();

    // Create new premium API key
    const apiKey = await createAPIKey(email, walletAddress, 'PREMIUM_TIER');

    // Update user in DynamoDB
    await dynamoDB
      .update({
        TableName: process.env.USERS_TABLE,
        Key: { userId: existingUser.userId },
        UpdateExpression:
          'set tier = :tier, apiKeyId = :keyId, apiKey = :key, stripeCustomerId = :stripeId, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':tier': 'premium',
          ':keyId': apiKey.id,
          ':key': apiKey.value,
          ':stripeId': session.customer,
          ':updatedAt': new Date().toISOString()
        }
      })
      .promise();

    // Send upgrade email
    await sendPremiumEmail(email, apiKey.value, true);
  } else {
    // Create new premium user
    const apiKey = await createAPIKey(email, walletAddress, 'PREMIUM_TIER');

    // Store user in DynamoDB
    await dynamoDB
      .put({
        TableName: process.env.USERS_TABLE,
        Item: {
          userId: uuidv4(),
          email: email.toLowerCase(),
          walletAddress: walletAddress.toLowerCase(),
          apiKeyId: apiKey.id,
          apiKey: apiKey.value,
          tier: 'premium',
          stripeCustomerId: session.customer,
          createdAt: new Date().toISOString(),
          isActive: true
        }
      })
      .promise();

    // Send welcome email
    await sendPremiumEmail(email, apiKey.value, false);
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

  // Create new free tier API key
  const apiKey = await createAPIKey(user.email, user.walletAddress, 'FREE_TIER');

  // Update user in DynamoDB
  await dynamoDB
    .update({
      TableName: process.env.USERS_TABLE,
      Key: { userId: user.userId },
      UpdateExpression:
        'set tier = :tier, apiKeyId = :keyId, apiKey = :key, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':tier': 'free',
        ':keyId': apiKey.id,
        ':key': apiKey.value,
        ':updatedAt': new Date().toISOString()
      }
    })
    .promise();

  // Send downgrade email
  await sendDowngradeEmail(user.email, apiKey.value);

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
}

// Helper functions
async function getUserByEmail(email) {
  const params = {
    TableName: process.env.USERS_TABLE,
    FilterExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': email.toLowerCase()
    }
  };

  const result = await dynamoDB.scan(params).promise();
  return result.Items.length > 0 ? result.Items[0] : null;
}

async function getUserByStripeCustomerId(customerId) {
  const params = {
    TableName: process.env.USERS_TABLE,
    FilterExpression: 'stripeCustomerId = :customerId',
    ExpressionAttributeValues: {
      ':customerId': customerId
    }
  };

  const result = await dynamoDB.scan(params).promise();
  return result.Items.length > 0 ? result.Items[0] : null;
}

async function createAPIKey(email, walletAddress, usagePlanId) {
  // Prefix determines tier (free_ or premium_)
  const prefix = usagePlanId === 'PREMIUM_TIER' ? 'premium_' : 'free_';
  const keyName = `${prefix}${uuidv4().substring(0, 8)}`;

  // Create key in API Gateway
  const createKeyParams = {
    name: `${email}-${keyName}`,
    description: `API key for ${email} (${walletAddress})`,
    enabled: true
  };

  const keyResult = await apigateway.createApiKey(createKeyParams).promise();

  // Associate key with usage plan
  const usagePlanParams = {
    keyId: keyResult.id,
    keyType: 'API_KEY',
    usagePlanId: usagePlanId
  };

  await apigateway.createUsagePlanKey(usagePlanParams).promise();

  return {
    id: keyResult.id,
    value: keyResult.value
  };
}

// Email templates
function sendPremiumEmail(email, apiKey, isUpgrade) {
  const subject = isUpgrade
    ? 'Your TotemBound Account Has Been Upgraded to Premium!'
    : 'Welcome to TotemBound Premium!';

  const upgradeText = isUpgrade
    ? 'Your account has been successfully upgraded to Premium tier.'
    : 'Welcome to TotemBound Premium!';

  const params = {
    Source: process.env.EMAIL_FROM,
    Destination: {
      ToAddresses: [email]
    },
    Message: {
      Subject: {
        Data: subject
      },
      Body: {
        Html: {
          Data: `
              <h1>${upgradeText}</h1>
              <p>Thank you for subscribing to our premium service. Here is your new Premium API key:</p>
              <p><strong>${apiKey}</strong></p>
              <p>Please update your API key in the user settings to enjoy premium benefits:</p>
              <ul>
              <li>Higher rate limits</li>
              <li>Priority transaction processing</li>
              <li>Access to exclusive game features</li>
              </ul>
              <p>Happy gaming!</p>
          `
        }
      }
    }
  };

  return SES.sendEmail(params).promise();
}

function sendDowngradeEmail(email, apiKey) {
  const params = {
    Source: process.env.EMAIL_FROM,
    Destination: {
      ToAddresses: [email]
    },
    Message: {
      Subject: {
        Data: 'Your TotemBound Premium Subscription Has Ended'
      },
      Body: {
        Html: {
          Data: `
              <h1>Your Premium Subscription Has Ended</h1>
              <p>Your TotemBound account has been reverted to the Free tier.</p>
              <p>Here is your new Free tier API key:</p>
              <p><strong>${apiKey}</strong></p>
              <p>Please update your API key in the user settings to continue using gasless transactions.</p>
              <p>If you'd like to upgrade again, visit your account page anytime.</p>
              <p>Thank you for using TotemBound!</p>
          `
        }
      }
    }
  };

  return SES.sendEmail(params).promise();
}
