/**
 * Gem Purchase Handlers
 *
 * GET  /api/shop/gems/packages - List available gem packages
 * POST /api/shop/gems/checkout - Create Stripe checkout session
 * POST /api/shop/gems/fulfill  - Fulfill purchase (called by webhook or dev mode)
 *
 * In development: Direct purchase without Stripe
 * In production: Stripe checkout flow with webhook fulfillment
 */

const { GEM_TO_ESSENCE_RATIO, getPackageById, getPackagesForDisplay } = require('../../config/gem-packages');
const { addGems, getUser, getBundlePurchasesToday } = require('../../common/db-client');
const { sendGemPurchaseReceiptEmail } = require('../../common/email');
const { publishBalanceUpdate, publishNotification } = require('../../common/iot-publisher');
const { getSecret } = require('../../common/ssm-loader');

// Stripe instance (lazy loaded, resolves from SSM if needed)
let stripe = null;
async function getStripeAsync() {
  if (stripe) return stripe;
  const key = await getSecret('STRIPE_SECRET_KEY');
  if (key) {
    stripe = require('stripe')(key);
  }
  return stripe;
}


/**
 * Get available gem packages
 */
async function getGemPackages() {
  return {
    success: true,
    data: {
      packages: getPackagesForDisplay(),
      conversionRate: GEM_TO_ESSENCE_RATIO,
      conversionNote: `Use the Gem Exchange to convert 1 Gem = ${GEM_TO_ESSENCE_RATIO} Essence`,
    },
  };
}

/**
 * Create Stripe checkout session for gem purchase
 */
async function createCheckoutSession(user, body) {
  const userId = user.userId;
  const { packageId } = body || {};

  // Validate package
  const pkg = getPackageById(packageId);
  if (!pkg) {
    return {
      success: false,
      error: { code: 'INVALID_PACKAGE', message: 'Package not found' },
    };
  }

  // Check if Stripe is configured (resolve from SSM if needed)
  const stripeClient = await getStripeAsync();
  if (!stripeClient) {
    // Development mode: direct fulfillment
    console.log('[Gems] Stripe not configured, using direct fulfillment (dev mode)');
    return fulfillGemPurchase(user, { packageId, isDev: true });
  }

  // Check if package has Stripe price ID - if not, use dev mode
  if (!pkg.stripePriceId) {
    console.log('[Gems] No Stripe price ID for package, using direct fulfillment (dev mode)');
    return fulfillGemPurchase(user, { packageId, isDev: true });
  }

  try {
    // Create Stripe checkout session
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: pkg.stripePriceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}/shop?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/shop?purchase=cancelled`,
      client_reference_id: userId,
      customer_email: user.email,
      metadata: {
        userId,
        packageId: pkg.id,
        gems: pkg.gems.toString(),
      },
    });

    console.log(`[Gems] Created checkout session ${session.id} for user ${userId}, package ${packageId}`);

    return {
      success: true,
      data: {
        sessionId: session.id,
        sessionUrl: session.url,
      },
    };
  }
  catch (error) {
    console.error('[Gems] Stripe checkout error:', error);
    return {
      success: false,
      error: {
        code: 'CHECKOUT_FAILED',
        message: error.message || 'Failed to create checkout session',
      },
    };
  }
}

/**
 * Fulfill gem purchase (called after successful payment)
 * In dev mode, called directly. In production, called by webhook.
 */
async function fulfillGemPurchase(user, body) {
  const userId = user?.userId || body?.userId;
  const { packageId, sessionId, isDev } = body || {};

  if (!userId) {
    return {
      success: false,
      error: { code: 'MISSING_USER', message: 'User ID required' },
    };
  }

  // Validate package
  const pkg = getPackageById(packageId);
  if (!pkg) {
    return {
      success: false,
      error: { code: 'INVALID_PACKAGE', message: 'Package not found' },
    };
  }

  // Get current user
  const currentUser = await getUser(userId);
  if (!currentUser) {
    return {
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    };
  }

  // Check daily limit for bundles (collector bundles have dailyLimit)
  if (pkg.dailyLimit && pkg.dailyLimit > 0) {
    const purchasesToday = await getBundlePurchasesToday(userId, packageId);
    if (purchasesToday >= pkg.dailyLimit) {
      console.log(`[Gems] Daily limit reached for ${packageId}: ${purchasesToday}/${pkg.dailyLimit}`);
      return {
        success: false,
        error: {
          code: 'DAILY_LIMIT_REACHED',
          message: `You've already purchased this bundle today. Limit: ${pkg.dailyLimit} per day.`,
        },
      };
    }
  }

  try {
    // Add gems to user account
    const gemsResult = await addGems(userId, pkg.gems, {
      type: 'purchase_gems',
      ref: packageId,
    });

    if (!gemsResult.success) {
      return {
        success: false,
        error: { code: 'GEM_ADD_FAILED', message: 'Failed to add gems to account' },
      };
    }

    console.log(`[Gems] Fulfilled purchase for user ${userId}: +${pkg.gems} gems (${isDev ? 'dev mode' : 'stripe'}, session: ${sessionId || 'n/a'})`);

    // Send receipt email (await to ensure Lambda doesn't freeze before send completes)
    if (currentUser.email) {
      try {
        await sendGemPurchaseReceiptEmail(currentUser.email, pkg.name, pkg.gems, gemsResult.newBalance);
      }
      catch (err) {
        console.error('[Gems] Receipt email failed:', err.message);
      }
    }

    // Push real-time balance update via IoT (non-blocking)
    // Critical for Stripe flow: webhook fires async, user needs immediate UI sync
    publishBalanceUpdate(userId, {
      currency: 'gems',
      amount: pkg.gems,
      newBalance: gemsResult.newBalance,
      reason: `Purchased ${pkg.name}`,
    }).catch(err => console.error('[Gems] IoT balance push failed:', err.message));

    publishNotification(userId, {
      notificationType: 'REWARD_CLAIMED',
      title: 'Gems Purchased!',
      message: `+${pkg.gems.toLocaleString()} Gems added to your account.`,
      data: { gemsAdded: pkg.gems, packageName: pkg.name },
    }).catch(err => console.error('[Gems] IoT notification push failed:', err.message));

    return {
      success: true,
      data: {
        package: pkg.name,
        gemsAdded: pkg.gems,
        newGemsBalance: gemsResult.newBalance,
        isDev: !!isDev,
      },
      message: `Purchased ${pkg.name}! +${pkg.gems} Gems`,
    };
  }
  catch (error) {
    console.error('[Gems] Fulfillment error:', error);
    return {
      success: false,
      error: {
        code: 'FULFILLMENT_FAILED',
        message: error.message || 'Failed to fulfill purchase',
      },
    };
  }
}

/**
 * Handle Stripe webhook for gem purchases
 * Verifies signature and fulfills purchase
 */
async function handleStripeWebhook(rawBody, signature) {
  const stripeClient = await getStripeAsync();
  if (!stripeClient) {
    return { success: false, error: 'Stripe not configured' };
  }

  const webhookSecret = await getSecret('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    return { success: false, error: 'Webhook secret not configured' };
  }

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }
  catch (err) {
    console.error('[Gems] Webhook signature verification failed:', err.message);
    return { success: false, error: 'Invalid signature' };
  }

  // Handle checkout completion
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Only handle payment mode (not subscriptions)
    if (session.mode !== 'payment') {
      return { success: true, message: 'Ignored non-payment session' };
    }

    // Check if it's a gem purchase (has packageId in metadata)
    const packageId = session.metadata?.packageId;
    if (!packageId) {
      return { success: true, message: 'Ignored non-gem purchase' };
    }

    const userId = session.client_reference_id || session.metadata?.userId;
    if (!userId) {
      console.error('[Gems] Webhook missing userId:', session.id);
      return { success: false, error: 'Missing user ID' };
    }

    // Fulfill the purchase
    const result = await fulfillGemPurchase(
      { userId },
      { packageId, sessionId: session.id }
    );

    return result;
  }

  // Handle refunds
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    console.log('[Gems] Refund received:', charge.id);
    // TODO: Implement gem reversal if needed
    return { success: true, message: 'Refund logged' };
  }

  return { success: true, message: `Unhandled event: ${event.type}` };
}

module.exports = {
  getGemPackages,
  createCheckoutSession,
  fulfillGemPurchase,
  handleStripeWebhook,
};
