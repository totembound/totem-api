/**
 * Subscription Handlers
 *
 * POST /v1/subscription/checkout - Create Stripe checkout session (subscription mode)
 * GET  /v1/subscription/status   - Get current subscription status
 * POST /v1/subscription/cancel   - Cancel subscription at period end
 * GET  /v1/subscription/portal   - Get Stripe billing portal URL
 *
 * Webhook events handled in handleSubscriptionWebhook():
 *   - checkout.session.completed (mode: subscription)
 *   - customer.subscription.updated
 *   - customer.subscription.deleted
 */

const { getUser, updateUser, logTransaction, getUserByStripeCustomerId, addEssence, addGems } = require('../common/db-client');
const { getItem, putItem, TABLES } = require('../common/db-client');
const { sendSubscriptionCanceledEmail, sendSubscriptionReactivatedEmail, sendSubscriptionConfirmedEmail } = require('../common/email');
const { publishBalanceUpdate, publishNotification } = require('../common/iot-publisher');
const { getSecret } = require('../common/ssm-loader');

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

// Map Stripe price IDs to tier names
function getTierFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_VIP) return 'vip';
  if (priceId === process.env.STRIPE_PRICE_PREMIUM) return 'premium';
  return null;
}

function getPriceIdFromTier(tier) {
  if (tier === 'vip') return process.env.STRIPE_PRICE_VIP;
  if (tier === 'premium') return process.env.STRIPE_PRICE_PREMIUM;
  return null;
}

/**
 * Create Stripe checkout session for subscription
 */
async function createSubscriptionCheckout(user, body) {
  const userId = user.userId;
  const { tier } = body || {};

  if (!tier || !['premium', 'vip'].includes(tier)) {
    return {
      success: false,
      error: { code: 'INVALID_TIER', message: 'Tier must be "premium" or "vip"' },
    };
  }

  // Check current tier before any checkout (applies to both dev mode and Stripe)
  const currentUser = await getUser(userId);
  if (currentUser?.tier === tier) {
    return {
      success: false,
      error: { code: 'ALREADY_SUBSCRIBED', message: `Already on ${tier} plan` },
    };
  }

  const previousTier = currentUser?.tier || 'free';

  const priceId = getPriceIdFromTier(tier);
  if (!priceId) {
    return {
      success: false,
      error: { code: 'PRICE_NOT_CONFIGURED', message: `Price not configured for ${tier} tier` },
    };
  }

  const stripeClient = await getStripeAsync();
  if (!stripeClient) {
    // Dev mode: directly set the tier
    console.log(`[Subscription] Stripe not configured, dev mode: ${previousTier} → ${tier} for ${userId}`);
    await updateUser(userId, {
      tier,
      subscription: {
        status: 'active',
        tier,
        devMode: true,
        cancelAtPeriodEnd: false,
      },
    });

    // Log the tier change transaction
    await logTransaction(userId, {
      type: previousTier === 'free' ? 'subscription_activated' : 'subscription_upgraded',
      details: { from: previousTier, to: tier, devMode: true },
    });

    // Send subscription confirmed email (await to ensure Lambda doesn't freeze before send completes)
    if (user.email) {
      try {
        const nextBilling = new Date();
        nextBilling.setMonth(nextBilling.getMonth() + 1);
        await sendSubscriptionConfirmedEmail(user.email, tier, nextBilling.toISOString());
      }
      catch (err) {
        console.error('[Subscription] Confirmed email failed:', err.message);
      }
    }

    // Push real-time tier update via IoT (non-blocking)
    publishBalanceUpdate(userId, {
      currency: 'tier',
      amount: 0,
      newBalance: tier,
      reason: `Subscribed to ${tier} (dev)`,
    }).catch(err => console.error('[Subscription] IoT balance push failed:', err.message));

    publishNotification(userId, {
      notificationType: 'REWARD_CLAIMED',
      title: previousTier === 'free' ? 'Subscription Active!' : 'Subscription Upgraded!',
      message: previousTier === 'free'
        ? `Welcome to the ${tier.charAt(0).toUpperCase() + tier.slice(1)} plan!`
        : `Upgraded from ${previousTier} to ${tier}!`,
      data: { tier, previousTier, devMode: true },
    }).catch(err => console.error('[Subscription] IoT notification push failed:', err.message));

    return {
      success: true,
      data: {
        tier,
        previousTier,
        message: previousTier === 'free'
          ? `Dev mode: subscribed to ${tier}`
          : `Dev mode: upgraded from ${previousTier} to ${tier}`,
        devMode: true,
      },
    };
  }

  try {
    // If user already has an active Stripe subscription, update it (swap price) instead of creating a new one
    const existingSubId = currentUser?.subscription?.subscriptionId;
    if (existingSubId && currentUser?.subscription?.status === 'active') {
      console.log(`[Subscription] Upgrading existing subscription ${existingSubId}: ${previousTier} → ${tier}`);
      const existingSub = await stripeClient.subscriptions.retrieve(existingSubId);
      const _updatedSub = await stripeClient.subscriptions.update(existingSubId, {
        items: [{
          id: existingSub.items.data[0].id,
          price: priceId,
        }],
        proration_behavior: 'create_prorations',
        metadata: { userId, tier },
      });

      // Update user record immediately (webhook will also fire, but this is faster)
      await updateUser(userId, {
        tier,
        'subscription.tier': tier,
      });

      await logTransaction(userId, {
        type: 'subscription_upgraded',
        details: { from: previousTier, to: tier, subscriptionId: existingSubId },
      });

      console.log(`[Subscription] Upgraded ${existingSubId} to ${tier} for user ${userId}`);

      return {
        success: true,
        data: {
          tier,
          previousTier,
          message: `Upgraded from ${previousTier} to ${tier}`,
          upgraded: true,
        },
      };
    }

    // New subscription — create Stripe checkout session
    const sessionParams = {
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}/plans?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/plans?subscription=cancelled`,
      client_reference_id: userId,
      customer_email: user.email,
      metadata: {
        userId,
        tier,
      },
    };

    // If user already has a Stripe customer ID, use it
    if (currentUser?.stripeCustomerId) {
      delete sessionParams.customer_email;
      sessionParams.customer = currentUser.stripeCustomerId;
    }

    const session = await stripeClient.checkout.sessions.create(sessionParams);
    console.log(`[Subscription] Created checkout session ${session.id} for user ${userId}, tier ${tier}`);

    return {
      success: true,
      data: {
        sessionId: session.id,
        sessionUrl: session.url,
      },
    };
  }
  catch (error) {
    console.error('[Subscription] Checkout error:', error);
    return {
      success: false,
      error: { code: 'CHECKOUT_FAILED', message: error.message },
    };
  }
}

/**
 * Get current subscription status
 */
async function getSubscriptionStatus(user) {
  const userId = user.userId;
  const currentUser = await getUser(userId);

  if (!currentUser) {
    return {
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    };
  }

  const sub = currentUser.subscription || {};

  return {
    success: true,
    data: {
      tier: currentUser.tier || 'free',
      stripeCustomerId: currentUser.stripeCustomerId || null,
      subscription: {
        status: sub.status || 'none',
        tier: sub.tier || null,
        currentPeriodEnd: sub.currentPeriodEnd || null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd || false,
        subscriptionId: sub.subscriptionId || null,
      },
    },
  };
}

/**
 * Cancel subscription at period end
 */
async function cancelSubscription(user) {
  const userId = user.userId;
  const currentUser = await getUser(userId);

  if (!currentUser || currentUser.tier === 'free') {
    return {
      success: false,
      error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription' },
    };
  }

  // Dev mode subscriptions: mirror Stripe behavior (cancel at period end)
  if (currentUser.subscription?.devMode) {
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await updateUser(userId, {
      subscription: {
        status: 'active',
        tier: currentUser.tier,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: periodEnd.toISOString(),
        devMode: true,
      },
    });

    // Send cancellation email (await to ensure Lambda doesn't freeze before send completes)
    if (currentUser.email) {
      try {
        await sendSubscriptionCanceledEmail(currentUser.email, periodEnd, currentUser.tier);
      }
      catch (err) {
        console.error('[Subscription] Cancel email failed:', err.message);
      }
    }

    return {
      success: true,
      data: {
        message: 'Dev mode: subscription will cancel at period end',
        currentPeriodEnd: periodEnd.toISOString(),
        cancelAtPeriodEnd: true,
      },
    };
  }

  const stripeClient = await getStripeAsync();
  if (!stripeClient || !currentUser.subscription?.subscriptionId) {
    return {
      success: false,
      error: { code: 'NO_STRIPE_SUBSCRIPTION', message: 'No Stripe subscription found' },
    };
  }

  try {
    const subscription = await stripeClient.subscriptions.update(
      currentUser.subscription.subscriptionId,
      { cancel_at_period_end: true }
    );

    const periodEndDate = new Date(subscription.current_period_end * 1000);

    await updateUser(userId, {
      'subscription.cancelAtPeriodEnd': true,
      'subscription.currentPeriodEnd': periodEndDate.toISOString(),
    });

    console.log(`[Subscription] Canceled at period end for user ${userId}`);

    // Send cancellation email (await to ensure Lambda doesn't freeze before send completes)
    if (user.email || currentUser.email) {
      try {
        await sendSubscriptionCanceledEmail(user.email || currentUser.email, periodEndDate, currentUser.tier || user.tier);
      }
      catch (err) {
        console.error('[Subscription] Cancel email failed:', err.message);
      }
    }

    return {
      success: true,
      data: {
        message: 'Subscription will cancel at end of billing period',
        currentPeriodEnd: periodEndDate.toISOString(),
        cancelAtPeriodEnd: true,
      },
    };
  }
  catch (error) {
    console.error('[Subscription] Cancel error:', error);
    return {
      success: false,
      error: { code: 'CANCEL_FAILED', message: error.message },
    };
  }
}

/**
 * Reactivate a subscription that was scheduled to cancel
 */
async function reactivateSubscription(user) {
  const userId = user.userId;
  const currentUser = await getUser(userId);

  if (!currentUser || currentUser.tier === 'free') {
    return {
      success: false,
      error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription to reactivate' },
    };
  }

  if (!currentUser.subscription?.cancelAtPeriodEnd) {
    return {
      success: false,
      error: { code: 'NOT_CANCELED', message: 'Subscription is not scheduled to cancel' },
    };
  }

  // Dev mode
  if (currentUser.subscription?.devMode) {
    await updateUser(userId, {
      'subscription.cancelAtPeriodEnd': false,
    });

    // Send reactivation email (await to ensure Lambda doesn't freeze before send completes)
    if (currentUser.email) {
      try {
        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        await sendSubscriptionReactivatedEmail(currentUser.email, nextMonth, currentUser.tier);
      }
      catch (err) {
        console.error('[Subscription] Reactivation email failed:', err.message);
      }
    }

    return {
      success: true,
      data: { message: 'Dev mode: subscription reactivated' },
    };
  }

  const stripeClient = await getStripeAsync();
  if (!stripeClient || !currentUser.subscription?.subscriptionId) {
    return {
      success: false,
      error: { code: 'NO_STRIPE_SUBSCRIPTION', message: 'No Stripe subscription found' },
    };
  }

  try {
    const subscription = await stripeClient.subscriptions.update(
      currentUser.subscription.subscriptionId,
      { cancel_at_period_end: false }
    );

    await updateUser(userId, {
      'subscription.cancelAtPeriodEnd': false,
    });

    console.log(`[Subscription] Reactivated for user ${userId}`);

    // Send reactivation email (await to ensure Lambda doesn't freeze before send completes)
    if (user.email || currentUser.email) {
      try {
        await sendSubscriptionReactivatedEmail(
          user.email || currentUser.email,
          new Date(subscription.current_period_end * 1000),
          currentUser.tier || user.tier
        );
      }
      catch (err) {
        console.error('[Subscription] Reactivation email failed:', err.message);
      }
    }

    return {
      success: true,
      data: {
        message: 'Subscription reactivated',
        currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      },
    };
  }
  catch (error) {
    console.error('[Subscription] Reactivate error:', error);
    return {
      success: false,
      error: { code: 'REACTIVATE_FAILED', message: error.message },
    };
  }
}

/**
 * Get Stripe billing portal URL
 */
async function getBillingPortal(user) {
  const userId = user.userId;
  const currentUser = await getUser(userId);

  if (!currentUser?.stripeCustomerId) {
    return {
      success: false,
      error: { code: 'NO_CUSTOMER', message: 'No Stripe customer found' },
    };
  }

  const stripeClient = await getStripeAsync();
  if (!stripeClient) {
    return {
      success: false,
      error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe not configured' },
    };
  }

  try {
    const session = await stripeClient.billingPortal.sessions.create({
      customer: currentUser.stripeCustomerId,
      return_url: `${process.env.APP_URL || 'http://localhost:3000'}/plans`,
    });

    return {
      success: true,
      data: { portalUrl: session.url },
    };
  }
  catch (error) {
    console.error('[Subscription] Portal error:', error);
    return {
      success: false,
      error: { code: 'PORTAL_FAILED', message: error.message },
    };
  }
}

/**
 * Handle Stripe webhook events for subscriptions
 * Called from the main webhook handler when event type matches subscription events
 */
async function handleSubscriptionWebhook(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') return null; // Not a subscription event

      const userId = session.client_reference_id || session.metadata?.userId;
      const tier = session.metadata?.tier;
      const subscriptionId = session.subscription;
      const customerId = session.customer;

      if (!userId) {
        console.error('[Subscription] Webhook missing userId:', session.id);
        return { success: false, error: 'Missing user ID' };
      }

      // Determine tier from metadata or from the subscription's price
      let finalTier = tier;
      if (!finalTier && subscriptionId) {
        const stripeClient = await getStripeAsync();
        if (stripeClient) {
          const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
          const priceId = sub.items?.data?.[0]?.price?.id;
          finalTier = getTierFromPriceId(priceId) || 'premium';
        }
      }
      finalTier = finalTier || 'premium';

      console.log(`[Subscription] Activating ${finalTier} for user ${userId}, sub ${subscriptionId}`);

      await updateUser(userId, {
        tier: finalTier,
        stripeCustomerId: customerId,
        subscription: {
          status: 'active',
          tier: finalTier,
          subscriptionId,
          cancelAtPeriodEnd: false,
        },
      });

      await logTransaction(userId, {
        type: 'subscription_activated',
        currency: 'tier',
        amount: 0,
        balanceBefore: 0,
        balanceAfter: 0,
        refType: 'subscription',
        refName: `${finalTier} subscription activated`,
      });

      // Send subscription confirmed email (await to ensure Lambda doesn't freeze before send completes)
      const subscriberEmail = session.customer_email || session.customer_details?.email;
      if (subscriberEmail) {
        try {
          const nextBilling = new Date();
          nextBilling.setMonth(nextBilling.getMonth() + 1);
          await sendSubscriptionConfirmedEmail(subscriberEmail, finalTier, nextBilling.toISOString());
        }
        catch (err) {
          console.error('[Subscription] Confirmed email failed:', err.message);
        }
      }

      // Push real-time tier update via IoT (non-blocking)
      publishBalanceUpdate(userId, {
        currency: 'tier',
        amount: 0,
        newBalance: finalTier,
        reason: `Subscribed to ${finalTier}`,
      }).catch(err => console.error('[Subscription] IoT balance push failed:', err.message));

      publishNotification(userId, {
        notificationType: 'REWARD_CLAIMED',
        title: 'Subscription Active!',
        message: `Welcome to the ${finalTier.charAt(0).toUpperCase() + finalTier.slice(1)} plan!`,
        data: { tier: finalTier },
      }).catch(err => console.error('[Subscription] IoT notification push failed:', err.message));

      return { success: true, message: `Subscription activated: ${finalTier}` };
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      // Find user by stripeCustomerId
      const user = await getUserByStripeCustomerId(customerId);
      if (!user) {
        console.error('[Subscription] User not found for customer:', customerId);
        return { success: true, message: 'User not found, skipped' };
      }

      // Check for plan change
      const priceId = subscription.items?.data?.[0]?.price?.id;
      const newTier = getTierFromPriceId(priceId);

      const updates = {
        'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
        'subscription.currentPeriodEnd': new Date(subscription.current_period_end * 1000).toISOString(),
      };

      if (newTier && newTier !== user.tier) {
        updates.tier = newTier;
        updates['subscription.tier'] = newTier;
        console.log(`[Subscription] Plan changed for ${user.id}: ${user.tier} → ${newTier}`);
      }

      if (subscription.cancel_at_period_end) {
        console.log(`[Subscription] Cancellation scheduled for ${user.id}`);
      }

      await updateUser(user.id, updates);
      return { success: true, message: 'Subscription updated' };
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const user = await getUserByStripeCustomerId(customerId);
      if (!user) {
        console.error('[Subscription] User not found for customer:', customerId);
        return { success: true, message: 'User not found, skipped' };
      }

      console.log(`[Subscription] Subscription ended for ${user.id}, downgrading to free`);

      await updateUser(user.id, {
        tier: 'free',
        subscription: {
          status: 'canceled',
          tier: null,
          subscriptionId: null,
          cancelAtPeriodEnd: false,
        },
      });

      await logTransaction(user.id, {
        type: 'subscription_canceled',
        currency: 'tier',
        amount: 0,
        balanceBefore: 0,
        balanceAfter: 0,
        refType: 'subscription',
        refName: 'Subscription ended - downgraded to free',
      });

      // Push real-time tier downgrade via IoT (non-blocking)
      publishBalanceUpdate(user.id, {
        currency: 'tier',
        amount: 0,
        newBalance: 'free',
        reason: 'Subscription ended',
      }).catch(err => console.error('[Subscription] IoT balance push failed:', err.message));

      publishNotification(user.id, {
        notificationType: 'REWARD_CLAIMED',
        title: 'Subscription Ended',
        message: 'Your subscription has ended. You are now on the Free plan.',
        data: { tier: 'free' },
      }).catch(err => console.error('[Subscription] IoT notification push failed:', err.message));

      return { success: true, message: 'Subscription canceled, downgraded to free' };
    }

    default:
      return null; // Not a subscription event
  }
}

// =============================================================================
// SUBSCRIPTION MONTHLY BONUS - Pull-based claiming
// =============================================================================

const REWARDS_CLAIMS_TABLE = TABLES.REWARDS_CLAIMS;

const SUBSCRIPTION_BONUS = {
  premium: { essence: 500, gems: 100 },
  vip: { essence: 1500, gems: 500 },
};

/**
 * Get current billing month key (YYYY-MM)
 * Used as the claim period identifier
 */
function getCurrentMonthKey() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get subscription bonus status - can the user claim this month?
 */
async function getSubscriptionBonusStatus(user) {
  const userId = user.userId;
  const currentUser = await getUser(userId);

  if (!currentUser) {
    return {
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    };
  }

  const tier = currentUser.tier || 'free';
  if (tier === 'free') {
    return {
      success: true,
      data: {
        eligible: false,
        tier: 'free',
        canClaim: false,
        reason: 'Free tier does not include monthly bonuses',
      },
    };
  }

  const bonus = SUBSCRIPTION_BONUS[tier];
  if (!bonus) {
    return {
      success: true,
      data: { eligible: false, tier, canClaim: false, reason: 'Unknown tier' },
    };
  }

  const monthKey = getCurrentMonthKey();
  const claimKey = {
    pk: `USER#${userId}`,
    sk: `SUBSCRIPTION_BONUS#${monthKey}`,
  };

  const existingClaim = await getItem(REWARDS_CLAIMS_TABLE, claimKey);
  const alreadyClaimed = !!existingClaim;

  return {
    success: true,
    data: {
      eligible: true,
      tier,
      canClaim: !alreadyClaimed,
      alreadyClaimed,
      claimedAt: existingClaim?.claimedAt || null,
      currentMonth: monthKey,
      bonus: {
        essence: bonus.essence,
        gems: bonus.gems,
      },
    },
  };
}

/**
 * Claim subscription monthly bonus
 * Pull-based: user must explicitly claim. Miss a month, lose it.
 */
async function claimSubscriptionBonus(user) {
  const userId = user.userId;
  const currentUser = await getUser(userId);

  if (!currentUser) {
    return {
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    };
  }

  const tier = currentUser.tier || 'free';

  // Must be a subscriber
  if (tier === 'free') {
    return {
      success: false,
      error: { code: 'NOT_SUBSCRIBED', message: 'Monthly bonuses require an active subscription' },
    };
  }

  // Subscription must be active (not just scheduled to cancel - they still get it until period ends)
  const sub = currentUser.subscription || {};
  if (sub.status && sub.status !== 'active' && !sub.devMode) {
    return {
      success: false,
      error: { code: 'SUBSCRIPTION_INACTIVE', message: 'Subscription is not active' },
    };
  }

  const bonus = SUBSCRIPTION_BONUS[tier];
  if (!bonus) {
    return {
      success: false,
      error: { code: 'INVALID_TIER', message: `No bonus defined for tier: ${tier}` },
    };
  }

  // Check if already claimed this month
  const monthKey = getCurrentMonthKey();
  const claimKey = {
    pk: `USER#${userId}`,
    sk: `SUBSCRIPTION_BONUS#${monthKey}`,
  };

  const existingClaim = await getItem(REWARDS_CLAIMS_TABLE, claimKey);
  if (existingClaim) {
    return {
      success: false,
      error: {
        code: 'ALREADY_CLAIMED',
        message: `Monthly bonus already claimed for ${monthKey}`,
        claimedAt: existingClaim.claimedAt,
      },
    };
  }

  // Award Essence
  const essenceResult = await addEssence(userId, bonus.essence, {
    type: 'subscription_bonus',
    ref: `sub_bonus_essence_${monthKey}`,
  });

  if (!essenceResult.success) {
    return {
      success: false,
      error: { code: 'ESSENCE_FAILED', message: essenceResult.error || 'Failed to add essence' },
    };
  }

  // Award Gems
  const gemsResult = await addGems(userId, bonus.gems, {
    type: 'subscription_bonus',
    ref: `sub_bonus_gems_${monthKey}`,
  });

  if (!gemsResult.success) {
    // Essence was already added - log but don't fail completely
    console.error(`[Subscription] Gems failed for ${userId} but essence succeeded. Manual fix needed.`);
    return {
      success: false,
      error: { code: 'GEMS_FAILED', message: gemsResult.error || 'Failed to add gems' },
    };
  }

  // Record the claim
  const now = new Date();
  const claimRecord = {
    pk: claimKey.pk,
    sk: claimKey.sk,
    userId,
    rewardType: 'subscription_bonus',
    tier,
    monthKey,
    essenceAwarded: bonus.essence,
    gemsAwarded: bonus.gems,
    claimedAt: now.toISOString(),
    createdAt: now.toISOString(),
  };

  await putItem(REWARDS_CLAIMS_TABLE, claimRecord);

  console.log(`[Subscription] User ${userId} claimed ${tier} monthly bonus: ${bonus.essence} Essence + ${bonus.gems} Gems (${monthKey})`);

  return {
    success: true,
    data: {
      tier,
      monthKey,
      essence: bonus.essence,
      gems: bonus.gems,
      newEssenceBalance: essenceResult.newBalance,
      newGemsBalance: gemsResult.newBalance,
      message: `Claimed ${tier} monthly bonus: ${bonus.essence} Essence + ${bonus.gems} Gems`,
    },
  };
}

module.exports = {
  createSubscriptionCheckout,
  getSubscriptionStatus,
  cancelSubscription,
  reactivateSubscription,
  getBillingPortal,
  handleSubscriptionWebhook,
  getSubscriptionBonusStatus,
  claimSubscriptionBonus,
  SUBSCRIPTION_BONUS,
};
