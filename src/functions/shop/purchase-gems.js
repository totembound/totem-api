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
const {
  addGems, deductGems, getUser, getBundlePurchasesToday,
  getItem, putItem, claimIdempotencyKey, releaseIdempotencyKey, TABLES,
} = require('../../common/db-client');
const { sendGemPurchaseReceiptEmail, sendRefundIssuedEmail } = require('../../common/email');
const { publishBalanceUpdate, publishNotification } = require('../../common/iot-publisher');
const { getSecret } = require('../../common/ssm-loader');
const { STRIPE_API_VERSION } = require('../../common/stripe');

// Stripe instance (lazy loaded, resolves from SSM if needed)
let stripe = null;
async function getStripeAsync() {
  if (stripe) return stripe;
  const key = await getSecret('STRIPE_SECRET_KEY');
  if (key) {
    stripe = require('stripe')(key, { apiVersion: STRIPE_API_VERSION });
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
      // Mirror the metadata onto the PaymentIntent → Charge so refund webhooks
      // (charge.refunded) can resolve the user/package without an extra Stripe lookup.
      payment_intent_data: {
        metadata: {
          userId,
          packageId: pkg.id,
          gems: pkg.gems.toString(),
        },
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

  return handleStripeEvent(event);
}

// Error codes from fulfillGemPurchase that are TRANSIENT (worth a Stripe retry).
// Everything else is a terminal business failure: keep the idempotency claim so Stripe
// stops retrying, and alert for manual fulfillment (the customer has already paid).
const TRANSIENT_FULFILLMENT_ERRORS = new Set(['GEM_ADD_FAILED', 'FULFILLMENT_FAILED']);

/**
 * Handle an already-verified Stripe event (gem fulfillment, refund, dispute).
 * Split from handleStripeWebhook so the central dispatcher in app.js — which has already
 * verified the signature once — can pass the parsed event without a second constructEvent.
 */
async function handleStripeEvent(event) {
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

    // Idempotency: Stripe delivers at-least-once. Claim the session before crediting so
    // a redelivered checkout.session.completed can't double-credit gems. If fulfillment
    // fails, release the claim so a genuine retry can re-run.
    const { firstTime } = await claimIdempotencyKey('gem-fulfillment', session.id);
    if (!firstTime) {
      console.log(`[Gems] Duplicate checkout.session.completed for ${session.id}, skipping`);
      return { success: true, message: 'Already fulfilled (duplicate webhook)' };
    }

    let result;
    try {
      result = await fulfillGemPurchase({ userId }, { packageId, sessionId: session.id });
    }
    catch (err) {
      // Unexpected throw = transient — release so Stripe retries.
      await releaseIdempotencyKey('gem-fulfillment', session.id);
      throw err;
    }

    // fulfillGemPurchase swallows its own errors into { success: false }. Only release the
    // claim (→ Stripe retry) for TRANSIENT failures. Terminal business failures (daily
    // limit, invalid package, user not found) must NOT loop forever: keep the claim, alert
    // for manual fulfillment, and ack 2xx so Stripe stops.
    if (!result || result.success === false) {
      const code = result?.error?.code;
      if (TRANSIENT_FULFILLMENT_ERRORS.has(code)) {
        await releaseIdempotencyKey('gem-fulfillment', session.id);
        return result;
      }
      console.error(`[Gems][ALERT] Paid checkout could not be fulfilled (terminal): session=${session.id} code=${code || 'unknown'} — manual fulfillment needed`);
      return { success: true, message: `Fulfillment skipped (${code || 'unknown'}); flagged for manual review` };
    }

    return result;
  }

  // Handle refunds — claw back gems where the balance allows and confirm to the user.
  if (event.type === 'charge.refunded') {
    return handleChargeRefunded(event.data.object);
  }

  // Chargebacks/disputes — operator-facing alert so the team can contest in Stripe.
  // (No customer email; this is handled in the Stripe dashboard.)
  if (event.type === 'charge.dispute.created') {
    const dispute = event.data.object;
    console.error(`[Gems][ALERT] Dispute opened: dispute=${dispute.id} charge=${dispute.charge} amount=${dispute.amount} ${dispute.currency} reason=${dispute.reason}. Respond in the Stripe dashboard before the evidence due date.`);
    return { success: true, message: 'Dispute logged for operator review' };
  }

  return { success: true, message: `Unhandled event: ${event.type}` };
}

/**
 * Process a refunded charge: reverse the purchased gems where the balance allows (never
 * forces a negative balance), then send a refund confirmation email.
 *
 * Stripe's `charge.amount_refunded` is CUMULATIVE across every refund on the charge, and
 * `charge.refunded` is delivered at-least-once. We handle both:
 *  - Redelivery of the same refund state is a no-op (idempotency key on charge+cumulative).
 *  - A later partial refund (higher cumulative) reverses only the INCREMENTAL gems, using a
 *    per-charge marker of how many gems we've already reversed — so partial-then-full never
 *    over-reverses.
 */
async function handleChargeRefunded(charge) {
  console.log(`[Gems] Refund received: charge=${charge.id} refunded=${charge.amount_refunded}/${charge.amount} ${charge.currency}`);

  const meta = charge.metadata || {};
  const userId = meta.userId || null;
  const packageId = meta.packageId || null;
  const pkg = packageId ? getPackageById(packageId) : null;

  // Without metadata we can't safely attribute the refund — flag for manual handling.
  if (!userId || !pkg) {
    console.error(`[Gems][ALERT] Refund needs manual review (cannot resolve user/package): charge=${charge.id} userId=${userId || 'n/a'} packageId=${packageId || 'n/a'}`);
    return { success: true, message: 'Refund logged; manual review required (no metadata)' };
  }

  // Idempotency keyed on (charge, cumulative-refunded): a redelivery of the SAME refund
  // state is skipped; a later partial refund is a new state and falls through to the
  // incremental-delta math below.
  const idemId = `${charge.id}:${charge.amount_refunded}`;
  const { firstTime } = await claimIdempotencyKey('refund', idemId);
  if (!firstTime) {
    console.log(`[Gems] Duplicate charge.refunded for ${idemId}, skipping`);
    return { success: true, message: 'Refund already processed (duplicate webhook)' };
  }

  try {
    const stateKey = { pk: `REFUND_STATE#${charge.id}`, sk: 'STATE' };
    const state = await getItem(TABLES.REWARDS_CLAIMS, stateKey);
    const alreadyReversed = state?.reversedGems || 0;

    // Target = total gems that should be reversed given cumulative refunds so far.
    const refundFraction = charge.amount > 0 ? Math.min(1, charge.amount_refunded / charge.amount) : 1;
    const targetReversed = Math.floor(pkg.gems * refundFraction);
    const delta = targetReversed - alreadyReversed;

    const currentUser = await getUser(userId);
    const recipientEmail = currentUser?.email || charge.receipt_email || charge.billing_details?.email || null;

    let gemNote;
    if (delta > 0) {
      const result = await deductGems(userId, delta, {
        type: 'refund_reversal',
        ref: charge.id,
        refType: 'refund',
        refName: `Refund reversal for ${pkg.name}`,
      });
      if (result.success) {
        await putItem(TABLES.REWARDS_CLAIMS, { ...stateKey, chargeId: charge.id, reversedGems: alreadyReversed + delta });
        gemNote = `We've removed ${delta.toLocaleString()} Gems associated with this refund from your account.`;
        console.log(`[Gems] Reversed ${delta} gems for ${userId} (charge ${charge.id}); new balance ${result.newBalance}`);
      }
      else {
        // Balance no longer covers the gems (already spent) — do NOT force negative; flag for ops.
        // Intentional: we leave the reversedGems marker un-advanced and keep the idempotency
        // claim. The shortfall is ops-handled, not auto-retried (a retry would keep failing).
        // Don't "fix" this into a negative balance.
        gemNote = 'The Gems from this purchase had already been used, so your Gem balance was not adjusted.';
        console.error(`[Gems][ALERT] Could not reverse ${delta} gems for ${userId} (charge ${charge.id}) — insufficient balance. Manual review may be needed.`);
      }
    }
    else {
      gemNote = 'Your account balances were not affected by this refund.';
    }

    if (recipientEmail) {
      try {
        await sendRefundIssuedEmail(recipientEmail, charge.amount_refunded, charge.currency, pkg.name, gemNote);
      }
      catch (err) {
        console.error('[Gems] Refund email failed:', err.message);
      }
    }

    return { success: true, message: 'Refund processed' };
  }
  catch (err) {
    // Roll back the idempotency claim so a Stripe retry can re-process this refund state.
    await releaseIdempotencyKey('refund', idemId);
    throw err;
  }
}

module.exports = {
  getGemPackages,
  createCheckoutSession,
  handleStripeEvent,
  fulfillGemPurchase,
  handleStripeWebhook,
};
