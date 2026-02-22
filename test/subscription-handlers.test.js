/**
 * Subscription Handler Tests
 *
 * Tests for all subscription functions:
 * - createSubscriptionCheckout
 * - getSubscriptionStatus
 * - cancelSubscription
 * - reactivateSubscription
 * - getBillingPortal
 * - handleSubscriptionWebhook
 * - getSubscriptionBonusStatus
 * - claimSubscriptionBonus
 */

// Mock db-client
jest.mock('../src/common/db-client', () => ({
  getUser: jest.fn(),
  updateUser: jest.fn(),
  getUserByStripeCustomerId: jest.fn(),
  addEssence: jest.fn(),
  addGems: jest.fn(),
  logTransaction: jest.fn(),
  getItem: jest.fn(),
  putItem: jest.fn(),
  TABLES: {
    REWARDS_CLAIMS: 'TotemBound-RewardsClaims',
  },
}));

// Mock email
jest.mock('../src/common/email', () => ({
  sendSubscriptionCanceledEmail: jest.fn().mockResolvedValue({}),
  sendSubscriptionReactivatedEmail: jest.fn().mockResolvedValue({}),
  sendSubscriptionConfirmedEmail: jest.fn().mockResolvedValue({}),
}));

// Mock iot-publisher
jest.mock('../src/common/iot-publisher', () => ({
  publishBalanceUpdate: jest.fn().mockResolvedValue({}),
  publishNotification: jest.fn().mockResolvedValue({}),
}));

// Mock ssm-loader - default: getSecret returns null (Stripe not configured = dev mode)
jest.mock('../src/common/ssm-loader', () => ({
  getSecret: jest.fn().mockResolvedValue(null),
}));

// Mock stripe module - provides a mock Stripe client when required
const mockCheckoutCreate = jest.fn();
const mockSubscriptionsUpdate = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();
const mockBillingPortalCreate = jest.fn();
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: mockCheckoutCreate } },
  subscriptions: { update: mockSubscriptionsUpdate, retrieve: mockSubscriptionsRetrieve },
  billingPortal: { sessions: { create: mockBillingPortalCreate } },
})));

const dbClient = require('../src/common/db-client');
const email = require('../src/common/email');
const iotPublisher = require('../src/common/iot-publisher');
const ssmLoader = require('../src/common/ssm-loader');

// =============================================================================
// IMPORTANT: Reset the module-level cached stripe instance between tests.
// The subscriptions module caches `stripe` at module scope. We must re-require
// it for tests that need different stripe behavior. For simplicity, we do a
// fresh require after resetting modules for stripe-enabled tests.
// =============================================================================

let subscriptions;

// Load module fresh (stripe will be null since getSecret returns null by default)
beforeAll(() => {
  // Clear any env-based stripe key so getStripe() returns null too
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_PREMIUM;
  delete process.env.STRIPE_PRICE_VIP;

  // We need to isolate the module so the cached stripe=null is fresh
  jest.isolateModules(() => {
    subscriptions = require('../src/functions/subscriptions');
  });
});

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123', email: 'test@example.com' };

const premiumUser = {
  userId: 'usr_premium',
  email: 'premium@example.com',
  tier: 'premium',
  subscription: {
    status: 'active',
    tier: 'premium',
    devMode: true,
    cancelAtPeriodEnd: false,
  },
};

const _vipUser = {
  userId: 'usr_vip',
  email: 'vip@example.com',
  tier: 'vip',
  subscription: {
    status: 'active',
    tier: 'vip',
    devMode: true,
    cancelAtPeriodEnd: false,
  },
};

const canceledPremiumUser = {
  userId: 'usr_canceled',
  email: 'canceled@example.com',
  tier: 'premium',
  subscription: {
    status: 'active',
    tier: 'premium',
    devMode: true,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: '2026-03-15T00:00:00.000Z',
  },
};

const _stripeSubscribedUser = {
  userId: 'usr_stripe',
  email: 'stripe@example.com',
  tier: 'premium',
  stripeCustomerId: 'cus_test123',
  subscription: {
    status: 'active',
    tier: 'premium',
    subscriptionId: 'sub_test123',
    cancelAtPeriodEnd: false,
  },
};

const _stripeCanceledUser = {
  userId: 'usr_stripe_cancel',
  email: 'stripecancel@example.com',
  tier: 'premium',
  stripeCustomerId: 'cus_cancel123',
  subscription: {
    status: 'active',
    tier: 'premium',
    subscriptionId: 'sub_cancel123',
    cancelAtPeriodEnd: true,
    currentPeriodEnd: '2026-03-15T00:00:00.000Z',
  },
};

// =============================================================================
// TESTS
// =============================================================================

describe('Subscription Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock returns
    dbClient.getUser.mockResolvedValue(null);
    dbClient.updateUser.mockResolvedValue({});
    dbClient.logTransaction.mockResolvedValue({});
    dbClient.getItem.mockResolvedValue(null);
    dbClient.putItem.mockResolvedValue({});
    dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
    dbClient.addGems.mockResolvedValue({ success: true, newBalance: 600 });
    dbClient.getUserByStripeCustomerId.mockResolvedValue(null);
    // Default: Stripe not configured (dev mode)
    ssmLoader.getSecret.mockResolvedValue(null);
    // Clear env vars that affect price lookups
    delete process.env.STRIPE_PRICE_PREMIUM;
    delete process.env.STRIPE_PRICE_VIP;
  });

  // ===========================================================================
  // createSubscriptionCheckout
  // ===========================================================================

  describe('createSubscriptionCheckout', () => {
    it('should reject invalid tier', async () => {
      const result = await subscriptions.createSubscriptionCheckout(testUser, { tier: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_TIER');
      expect(result.error.message).toContain('premium');
    });

    it('should reject missing tier', async () => {
      const result = await subscriptions.createSubscriptionCheckout(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_TIER');
    });

    it('should reject null body', async () => {
      const result = await subscriptions.createSubscriptionCheckout(testUser, null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_TIER');
    });

    it('should return PRICE_NOT_CONFIGURED when env var not set', async () => {
      // No STRIPE_PRICE_PREMIUM env var set
      const result = await subscriptions.createSubscriptionCheckout(testUser, { tier: 'premium' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('PRICE_NOT_CONFIGURED');
      expect(result.error.message).toContain('premium');
    });

    it('should return PRICE_NOT_CONFIGURED for vip when env var not set', async () => {
      const result = await subscriptions.createSubscriptionCheckout(testUser, { tier: 'vip' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('PRICE_NOT_CONFIGURED');
      expect(result.error.message).toContain('vip');
    });

    it('should activate subscription in dev mode (Stripe not configured)', async () => {
      process.env.STRIPE_PRICE_PREMIUM = 'price_premium_test';
      ssmLoader.getSecret.mockResolvedValue(null); // Stripe not configured

      const result = await subscriptions.createSubscriptionCheckout(testUser, { tier: 'premium' });

      expect(result.success).toBe(true);
      expect(result.data.tier).toBe('premium');
      expect(result.data.devMode).toBe(true);
      expect(result.data.message).toContain('Dev mode');

      // Should have updated user with dev mode subscription
      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_test123', {
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          devMode: true,
          cancelAtPeriodEnd: false,
        },
      });
    });

    it('should send subscription confirmed email in dev mode', async () => {
      process.env.STRIPE_PRICE_PREMIUM = 'price_premium_test';

      await subscriptions.createSubscriptionCheckout(testUser, { tier: 'premium' });

      // Allow async email to fire
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionConfirmedEmail).toHaveBeenCalledWith(
        'test@example.com',
        'premium',
        expect.any(String)
      );
    });

    it('should not send email when user has no email in dev mode', async () => {
      process.env.STRIPE_PRICE_PREMIUM = 'price_premium_test';
      const noEmailUser = { userId: 'usr_noemail' };

      await subscriptions.createSubscriptionCheckout(noEmailUser, { tier: 'premium' });

      expect(email.sendSubscriptionConfirmedEmail).not.toHaveBeenCalled();
    });

    it('should publish IoT balance update and notification in dev mode', async () => {
      process.env.STRIPE_PRICE_VIP = 'price_vip_test';

      await subscriptions.createSubscriptionCheckout(testUser, { tier: 'vip' });

      // Allow async IoT calls to fire
      await new Promise(r => setTimeout(r, 10));

      expect(iotPublisher.publishBalanceUpdate).toHaveBeenCalledWith('usr_test123', {
        currency: 'tier',
        amount: 0,
        newBalance: 'vip',
        reason: 'Subscribed to vip (dev)',
      });

      expect(iotPublisher.publishNotification).toHaveBeenCalledWith('usr_test123', {
        notificationType: 'REWARD_CLAIMED',
        title: 'Subscription Active!',
        message: 'Welcome to the Vip plan!',
        data: { tier: 'vip', previousTier: 'free', devMode: true },
      });
    });

    it('should handle IoT publish failures gracefully in dev mode', async () => {
      process.env.STRIPE_PRICE_PREMIUM = 'price_premium_test';
      iotPublisher.publishBalanceUpdate.mockRejectedValue(new Error('IoT down'));
      iotPublisher.publishNotification.mockRejectedValue(new Error('IoT down'));

      // Should not throw even though IoT fails
      const result = await subscriptions.createSubscriptionCheckout(testUser, { tier: 'premium' });
      expect(result.success).toBe(true);

      // Wait for async catches
      await new Promise(r => setTimeout(r, 10));
    });

    it('should handle email send failure gracefully in dev mode', async () => {
      process.env.STRIPE_PRICE_PREMIUM = 'price_premium_test';
      email.sendSubscriptionConfirmedEmail.mockRejectedValue(new Error('SMTP down'));

      const result = await subscriptions.createSubscriptionCheckout(testUser, { tier: 'premium' });
      expect(result.success).toBe(true);

      await new Promise(r => setTimeout(r, 10));
    });
  });

  // ===========================================================================
  // getSubscriptionStatus
  // ===========================================================================

  describe('getSubscriptionStatus', () => {
    it('should return error when user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);

      const result = await subscriptions.getSubscriptionStatus(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('should return free tier for user with no subscription', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test123' });

      const result = await subscriptions.getSubscriptionStatus(testUser);
      expect(result.success).toBe(true);
      expect(result.data.tier).toBe('free');
      expect(result.data.stripeCustomerId).toBeNull();
      expect(result.data.subscription.status).toBe('none');
      expect(result.data.subscription.tier).toBeNull();
      expect(result.data.subscription.currentPeriodEnd).toBeNull();
      expect(result.data.subscription.cancelAtPeriodEnd).toBe(false);
      expect(result.data.subscription.subscriptionId).toBeNull();
    });

    it('should return full subscription data for subscribed user', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        stripeCustomerId: 'cus_abc123',
        subscription: {
          status: 'active',
          tier: 'premium',
          currentPeriodEnd: '2026-03-15T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          subscriptionId: 'sub_xyz789',
        },
      });

      const result = await subscriptions.getSubscriptionStatus({ userId: 'usr_premium' });
      expect(result.success).toBe(true);
      expect(result.data.tier).toBe('premium');
      expect(result.data.stripeCustomerId).toBe('cus_abc123');
      expect(result.data.subscription.status).toBe('active');
      expect(result.data.subscription.tier).toBe('premium');
      expect(result.data.subscription.currentPeriodEnd).toBe('2026-03-15T00:00:00.000Z');
      expect(result.data.subscription.cancelAtPeriodEnd).toBe(false);
      expect(result.data.subscription.subscriptionId).toBe('sub_xyz789');
    });

    it('should return canceled subscription data', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_canceled',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: '2026-03-15T00:00:00.000Z',
        },
      });

      const result = await subscriptions.getSubscriptionStatus({ userId: 'usr_canceled' });
      expect(result.success).toBe(true);
      expect(result.data.subscription.cancelAtPeriodEnd).toBe(true);
    });
  });

  // ===========================================================================
  // cancelSubscription
  // ===========================================================================

  describe('cancelSubscription', () => {
    it('should return NO_SUBSCRIPTION for user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);

      const result = await subscriptions.cancelSubscription(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_SUBSCRIPTION');
    });

    it('should return NO_SUBSCRIPTION for free user', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test123', tier: 'free' });

      const result = await subscriptions.cancelSubscription(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_SUBSCRIPTION');
    });

    it('should cancel dev mode subscription at period end', async () => {
      dbClient.getUser.mockResolvedValue(premiumUser);

      const result = await subscriptions.cancelSubscription({ userId: 'usr_premium' });
      expect(result.success).toBe(true);
      expect(result.data.cancelAtPeriodEnd).toBe(true);
      expect(result.data.currentPeriodEnd).toBeDefined();
      expect(result.data.message).toContain('Dev mode');

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_premium', {
        subscription: {
          status: 'active',
          tier: 'premium',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: expect.any(String),
          devMode: true,
        },
      });
    });

    it('should send cancellation email for dev mode subscription', async () => {
      dbClient.getUser.mockResolvedValue(premiumUser);

      await subscriptions.cancelSubscription({ userId: 'usr_premium' });

      // Allow async email to fire
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledWith(
        'premium@example.com',
        expect.any(Date),
        'premium'
      );
    });

    it('should not send cancellation email when user has no email', async () => {
      const noEmailUser = {
        ...premiumUser,
        email: undefined,
      };
      dbClient.getUser.mockResolvedValue(noEmailUser);

      await subscriptions.cancelSubscription({ userId: 'usr_premium' });
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
    });

    it('should return NO_STRIPE_SUBSCRIPTION when Stripe not configured and not dev mode', async () => {
      // User has a non-dev subscription but no Stripe client available
      const nonDevUser = {
        userId: 'usr_nondev',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          cancelAtPeriodEnd: false,
          // No devMode flag, no subscriptionId
        },
      };
      dbClient.getUser.mockResolvedValue(nonDevUser);
      ssmLoader.getSecret.mockResolvedValue(null);

      const result = await subscriptions.cancelSubscription({ userId: 'usr_nondev' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_STRIPE_SUBSCRIPTION');
    });

    it('should return NO_STRIPE_SUBSCRIPTION when no subscriptionId exists', async () => {
      const noSubIdUser = {
        userId: 'usr_nosub',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          cancelAtPeriodEnd: false,
        },
      };
      dbClient.getUser.mockResolvedValue(noSubIdUser);
      ssmLoader.getSecret.mockResolvedValue(null);

      const result = await subscriptions.cancelSubscription({ userId: 'usr_nosub' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_STRIPE_SUBSCRIPTION');
    });
  });

  // ===========================================================================
  // reactivateSubscription
  // ===========================================================================

  describe('reactivateSubscription', () => {
    it('should return NO_SUBSCRIPTION for user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);

      const result = await subscriptions.reactivateSubscription(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_SUBSCRIPTION');
    });

    it('should return NO_SUBSCRIPTION for free user', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test123', tier: 'free' });

      const result = await subscriptions.reactivateSubscription(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_SUBSCRIPTION');
    });

    it('should return NOT_CANCELED when subscription is not scheduled to cancel', async () => {
      dbClient.getUser.mockResolvedValue(premiumUser);

      const result = await subscriptions.reactivateSubscription({ userId: 'usr_premium' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_CANCELED');
    });

    it('should reactivate dev mode subscription', async () => {
      dbClient.getUser.mockResolvedValue(canceledPremiumUser);

      const result = await subscriptions.reactivateSubscription({ userId: 'usr_canceled' });
      expect(result.success).toBe(true);
      expect(result.data.message).toContain('Dev mode');

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_canceled', {
        'subscription.cancelAtPeriodEnd': false,
      });
    });

    it('should send reactivation email for dev mode subscription', async () => {
      dbClient.getUser.mockResolvedValue(canceledPremiumUser);

      await subscriptions.reactivateSubscription({ userId: 'usr_canceled' });
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionReactivatedEmail).toHaveBeenCalledWith(
        'canceled@example.com',
        expect.any(Date),
        'premium'
      );
    });

    it('should not send reactivation email when user has no email', async () => {
      const noEmailCanceled = {
        ...canceledPremiumUser,
        email: undefined,
      };
      dbClient.getUser.mockResolvedValue(noEmailCanceled);

      await subscriptions.reactivateSubscription({ userId: 'usr_canceled' });
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionReactivatedEmail).not.toHaveBeenCalled();
    });

    it('should return NO_STRIPE_SUBSCRIPTION when Stripe not configured and not dev mode', async () => {
      const nonDevCanceled = {
        userId: 'usr_nondev',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          cancelAtPeriodEnd: true,
          // No devMode, no subscriptionId
        },
      };
      dbClient.getUser.mockResolvedValue(nonDevCanceled);
      ssmLoader.getSecret.mockResolvedValue(null);

      const result = await subscriptions.reactivateSubscription({ userId: 'usr_nondev' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_STRIPE_SUBSCRIPTION');
    });
  });

  // ===========================================================================
  // getBillingPortal
  // ===========================================================================

  describe('getBillingPortal', () => {
    it('should return NO_CUSTOMER when user has no stripeCustomerId', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test123' });

      const result = await subscriptions.getBillingPortal(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_CUSTOMER');
    });

    it('should return NO_CUSTOMER when user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);

      const result = await subscriptions.getBillingPortal(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_CUSTOMER');
    });

    it('should return STRIPE_NOT_CONFIGURED when Stripe not available', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_test123',
        stripeCustomerId: 'cus_test',
      });
      ssmLoader.getSecret.mockResolvedValue(null);

      const result = await subscriptions.getBillingPortal(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });
  });

  // ===========================================================================
  // handleSubscriptionWebhook
  // ===========================================================================

  describe('handleSubscriptionWebhook', () => {
    it('should return null for non-subscription checkout.session.completed', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'payment', // Not subscription
            client_reference_id: 'usr_test123',
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result).toBeNull();
    });

    it('should activate subscription on checkout.session.completed', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            client_reference_id: 'usr_test123',
            metadata: { tier: 'premium', userId: 'usr_test123' },
            subscription: 'sub_new123',
            customer: 'cus_new123',
            customer_email: 'test@example.com',
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(result.message).toContain('premium');

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_test123', {
        tier: 'premium',
        stripeCustomerId: 'cus_new123',
        subscription: {
          status: 'active',
          tier: 'premium',
          subscriptionId: 'sub_new123',
          cancelAtPeriodEnd: false,
        },
      });

      expect(dbClient.logTransaction).toHaveBeenCalledWith('usr_test123', {
        type: 'subscription_activated',
        currency: 'tier',
        amount: 0,
        balanceBefore: 0,
        balanceAfter: 0,
        refType: 'subscription',
        refName: 'premium subscription activated',
      });
    });

    it('should send confirmation email on checkout.session.completed', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            client_reference_id: 'usr_test123',
            metadata: { tier: 'vip' },
            subscription: 'sub_vip',
            customer: 'cus_vip',
            customer_email: 'vip@example.com',
          },
        },
      };

      await subscriptions.handleSubscriptionWebhook(event);
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionConfirmedEmail).toHaveBeenCalledWith(
        'vip@example.com',
        'vip',
        expect.any(String)
      );
    });

    it('should use customer_details.email as fallback for email', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            client_reference_id: 'usr_test123',
            metadata: { tier: 'premium' },
            subscription: 'sub_123',
            customer: 'cus_123',
            // No customer_email, but customer_details.email
            customer_details: { email: 'details@example.com' },
          },
        },
      };

      await subscriptions.handleSubscriptionWebhook(event);
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionConfirmedEmail).toHaveBeenCalledWith(
        'details@example.com',
        'premium',
        expect.any(String)
      );
    });

    it('should not send email when no email available', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            client_reference_id: 'usr_test123',
            metadata: { tier: 'premium' },
            subscription: 'sub_123',
            customer: 'cus_123',
            // No email fields
          },
        },
      };

      await subscriptions.handleSubscriptionWebhook(event);
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionConfirmedEmail).not.toHaveBeenCalled();
    });

    it('should publish IoT updates on checkout.session.completed', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            client_reference_id: 'usr_test123',
            metadata: { tier: 'premium' },
            subscription: 'sub_123',
            customer: 'cus_123',
          },
        },
      };

      await subscriptions.handleSubscriptionWebhook(event);
      await new Promise(r => setTimeout(r, 10));

      expect(iotPublisher.publishBalanceUpdate).toHaveBeenCalledWith('usr_test123', {
        currency: 'tier',
        amount: 0,
        newBalance: 'premium',
        reason: 'Subscribed to premium',
      });

      expect(iotPublisher.publishNotification).toHaveBeenCalledWith('usr_test123', {
        notificationType: 'REWARD_CLAIMED',
        title: 'Subscription Active!',
        message: 'Welcome to the Premium plan!',
        data: { tier: 'premium' },
      });
    });

    it('should return error when checkout.session.completed has no userId', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            // No client_reference_id, no metadata.userId
            subscription: 'sub_123',
            customer: 'cus_123',
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing user ID');
    });

    it('should use metadata.userId as fallback for client_reference_id', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            // No client_reference_id
            metadata: { userId: 'usr_meta123', tier: 'vip' },
            subscription: 'sub_123',
            customer: 'cus_123',
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(dbClient.updateUser).toHaveBeenCalledWith(
        'usr_meta123',
        expect.objectContaining({ tier: 'vip' })
      );
    });

    it('should default to premium tier when no tier in metadata and no Stripe', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            client_reference_id: 'usr_test123',
            metadata: {}, // No tier
            subscription: 'sub_123',
            customer: 'cus_123',
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(result.message).toContain('premium');
    });

    it('should handle customer.subscription.updated event', async () => {
      const user = { id: 'usr_found', tier: 'premium' };
      dbClient.getUserByStripeCustomerId.mockResolvedValue(user);

      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            customer: 'cus_found',
            cancel_at_period_end: false,
            current_period_end: 1740000000, // timestamp
            items: {
              data: [{ price: { id: 'price_premium_test' } }],
            },
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(result.message).toBe('Subscription updated');

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_found', {
        'subscription.cancelAtPeriodEnd': false,
        'subscription.currentPeriodEnd': expect.any(String),
      });
    });

    it('should update tier on plan change in subscription.updated', async () => {
      process.env.STRIPE_PRICE_VIP = 'price_vip_test';
      const user = { id: 'usr_found', tier: 'premium' };
      dbClient.getUserByStripeCustomerId.mockResolvedValue(user);

      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            customer: 'cus_found',
            cancel_at_period_end: false,
            current_period_end: 1740000000,
            items: {
              data: [{ price: { id: 'price_vip_test' } }],
            },
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_found', expect.objectContaining({
        tier: 'vip',
        'subscription.tier': 'vip',
      }));
    });

    it('should skip user not found in subscription.updated', async () => {
      dbClient.getUserByStripeCustomerId.mockResolvedValue(null);

      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            customer: 'cus_unknown',
            cancel_at_period_end: false,
            current_period_end: 1740000000,
            items: { data: [] },
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(result.message).toContain('not found');
      expect(dbClient.updateUser).not.toHaveBeenCalled();
    });

    it('should handle customer.subscription.deleted event', async () => {
      const user = { id: 'usr_deleted', tier: 'premium' };
      dbClient.getUserByStripeCustomerId.mockResolvedValue(user);

      const event = {
        type: 'customer.subscription.deleted',
        data: {
          object: {
            customer: 'cus_deleted',
          },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(result.message).toContain('free');

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_deleted', {
        tier: 'free',
        subscription: {
          status: 'canceled',
          tier: null,
          subscriptionId: null,
          cancelAtPeriodEnd: false,
        },
      });

      expect(dbClient.logTransaction).toHaveBeenCalledWith('usr_deleted', {
        type: 'subscription_canceled',
        currency: 'tier',
        amount: 0,
        balanceBefore: 0,
        balanceAfter: 0,
        refType: 'subscription',
        refName: 'Subscription ended - downgraded to free',
      });
    });

    it('should publish IoT updates on subscription.deleted', async () => {
      const user = { id: 'usr_deleted', tier: 'vip' };
      dbClient.getUserByStripeCustomerId.mockResolvedValue(user);

      const event = {
        type: 'customer.subscription.deleted',
        data: {
          object: { customer: 'cus_deleted' },
        },
      };

      await subscriptions.handleSubscriptionWebhook(event);
      await new Promise(r => setTimeout(r, 10));

      expect(iotPublisher.publishBalanceUpdate).toHaveBeenCalledWith('usr_deleted', {
        currency: 'tier',
        amount: 0,
        newBalance: 'free',
        reason: 'Subscription ended',
      });

      expect(iotPublisher.publishNotification).toHaveBeenCalledWith('usr_deleted', {
        notificationType: 'REWARD_CLAIMED',
        title: 'Subscription Ended',
        message: 'Your subscription has ended. You are now on the Free plan.',
        data: { tier: 'free' },
      });
    });

    it('should skip user not found in subscription.deleted', async () => {
      dbClient.getUserByStripeCustomerId.mockResolvedValue(null);

      const event = {
        type: 'customer.subscription.deleted',
        data: {
          object: { customer: 'cus_unknown' },
        },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(result.message).toContain('not found');
      expect(dbClient.updateUser).not.toHaveBeenCalled();
    });

    it('should return null for unknown event type', async () => {
      const event = {
        type: 'invoice.payment_succeeded',
        data: { object: {} },
      };

      const result = await subscriptions.handleSubscriptionWebhook(event);
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // getSubscriptionBonusStatus
  // ===========================================================================

  describe('getSubscriptionBonusStatus', () => {
    it('should return error when user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);

      const result = await subscriptions.getSubscriptionBonusStatus(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('should return not eligible for free tier', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test123', tier: 'free' });

      const result = await subscriptions.getSubscriptionBonusStatus(testUser);
      expect(result.success).toBe(true);
      expect(result.data.eligible).toBe(false);
      expect(result.data.tier).toBe('free');
      expect(result.data.canClaim).toBe(false);
      expect(result.data.reason).toContain('Free tier');
    });

    it('should return not eligible for user with no tier (defaults to free)', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test123' });

      const result = await subscriptions.getSubscriptionBonusStatus(testUser);
      expect(result.success).toBe(true);
      expect(result.data.eligible).toBe(false);
      expect(result.data.tier).toBe('free');
    });

    it('should return eligible and canClaim for premium user who has not claimed', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_premium', tier: 'premium' });
      dbClient.getItem.mockResolvedValue(null); // No existing claim

      const result = await subscriptions.getSubscriptionBonusStatus({ userId: 'usr_premium' });
      expect(result.success).toBe(true);
      expect(result.data.eligible).toBe(true);
      expect(result.data.tier).toBe('premium');
      expect(result.data.canClaim).toBe(true);
      expect(result.data.alreadyClaimed).toBe(false);
      expect(result.data.claimedAt).toBeNull();
      expect(result.data.bonus.essence).toBe(500);
      expect(result.data.bonus.gems).toBe(100);
    });

    it('should return eligible and canClaim for vip user who has not claimed', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_vip', tier: 'vip' });
      dbClient.getItem.mockResolvedValue(null);

      const result = await subscriptions.getSubscriptionBonusStatus({ userId: 'usr_vip' });
      expect(result.success).toBe(true);
      expect(result.data.eligible).toBe(true);
      expect(result.data.tier).toBe('vip');
      expect(result.data.canClaim).toBe(true);
      expect(result.data.bonus.essence).toBe(1500);
      expect(result.data.bonus.gems).toBe(500);
    });

    it('should return already claimed for premium user who claimed this month', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_premium', tier: 'premium' });
      const claimedAt = '2026-02-10T12:00:00.000Z';
      dbClient.getItem.mockResolvedValue({ claimedAt });

      const result = await subscriptions.getSubscriptionBonusStatus({ userId: 'usr_premium' });
      expect(result.success).toBe(true);
      expect(result.data.eligible).toBe(true);
      expect(result.data.canClaim).toBe(false);
      expect(result.data.alreadyClaimed).toBe(true);
      expect(result.data.claimedAt).toBe(claimedAt);
    });

    it('should query the correct table and key for claim check', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_premium', tier: 'premium' });
      dbClient.getItem.mockResolvedValue(null);

      await subscriptions.getSubscriptionBonusStatus({ userId: 'usr_premium' });

      const now = new Date();
      const expectedMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

      expect(dbClient.getItem).toHaveBeenCalledWith('TotemBound-RewardsClaims', {
        pk: 'USER#usr_premium',
        sk: `SUBSCRIPTION_BONUS#${expectedMonthKey}`,
      });
    });

    it('should return not eligible for unknown tier', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test', tier: 'unknown_tier' });

      const result = await subscriptions.getSubscriptionBonusStatus({ userId: 'usr_test' });
      expect(result.success).toBe(true);
      expect(result.data.eligible).toBe(false);
      expect(result.data.canClaim).toBe(false);
      expect(result.data.reason).toContain('Unknown tier');
    });
  });

  // ===========================================================================
  // claimSubscriptionBonus
  // ===========================================================================

  describe('claimSubscriptionBonus', () => {
    it('should return USER_NOT_FOUND when user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);

      const result = await subscriptions.claimSubscriptionBonus(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('should return NOT_SUBSCRIBED for free tier', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test123', tier: 'free' });

      const result = await subscriptions.claimSubscriptionBonus(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_SUBSCRIBED');
    });

    it('should return NOT_SUBSCRIBED when tier is not set (defaults to free)', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test123' });

      const result = await subscriptions.claimSubscriptionBonus(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_SUBSCRIBED');
    });

    it('should return SUBSCRIPTION_INACTIVE when subscription status is not active', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_test',
        tier: 'premium',
        subscription: { status: 'canceled' },
      });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_test' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('SUBSCRIPTION_INACTIVE');
    });

    it('should allow claim when subscription is active even if cancelAtPeriodEnd is true', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_test',
        tier: 'premium',
        subscription: { status: 'active', cancelAtPeriodEnd: true },
      });
      dbClient.getItem.mockResolvedValue(null); // No existing claim
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: 200 });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_test' });
      expect(result.success).toBe(true);
    });

    it('should allow claim when subscription is devMode (even with non-active status)', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_dev',
        tier: 'premium',
        subscription: { status: 'some_status', devMode: true },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: 200 });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_dev' });
      expect(result.success).toBe(true);
    });

    it('should return INVALID_TIER when tier has no bonus defined', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_weird',
        tier: 'unknown_tier',
        subscription: { status: 'active' },
      });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_weird' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_TIER');
    });

    it('should return ALREADY_CLAIMED when already claimed this month', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        subscription: { status: 'active' },
      });
      const claimedAt = '2026-02-05T10:00:00.000Z';
      dbClient.getItem.mockResolvedValue({ claimedAt });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_premium' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ALREADY_CLAIMED');
      expect(result.error.claimedAt).toBe(claimedAt);
    });

    it('should successfully claim premium bonus', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        subscription: { status: 'active' },
      });
      dbClient.getItem.mockResolvedValue(null); // No existing claim
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: 200 });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_premium' });

      expect(result.success).toBe(true);
      expect(result.data.tier).toBe('premium');
      expect(result.data.essence).toBe(500);
      expect(result.data.gems).toBe(100);
      expect(result.data.newEssenceBalance).toBe(2500);
      expect(result.data.newGemsBalance).toBe(200);
      expect(result.data.message).toContain('500 Essence');
      expect(result.data.message).toContain('100 Gems');
    });

    it('should successfully claim vip bonus', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_vip',
        tier: 'vip',
        subscription: { status: 'active' },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 3500 });
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: 1000 });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_vip' });

      expect(result.success).toBe(true);
      expect(result.data.tier).toBe('vip');
      expect(result.data.essence).toBe(1500);
      expect(result.data.gems).toBe(500);
      expect(result.data.newEssenceBalance).toBe(3500);
      expect(result.data.newGemsBalance).toBe(1000);
    });

    it('should call addEssence with correct params for premium', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        subscription: { status: 'active' },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: 200 });

      const now = new Date();
      const expectedMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

      await subscriptions.claimSubscriptionBonus({ userId: 'usr_premium' });

      expect(dbClient.addEssence).toHaveBeenCalledWith('usr_premium', 500, {
        type: 'subscription_bonus',
        ref: `sub_bonus_essence_${expectedMonthKey}`,
      });

      expect(dbClient.addGems).toHaveBeenCalledWith('usr_premium', 100, {
        type: 'subscription_bonus',
        ref: `sub_bonus_gems_${expectedMonthKey}`,
      });
    });

    it('should record the claim in RewardsClaims table', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        subscription: { status: 'active' },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: 200 });

      const now = new Date();
      const expectedMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

      await subscriptions.claimSubscriptionBonus({ userId: 'usr_premium' });

      expect(dbClient.putItem).toHaveBeenCalledWith('TotemBound-RewardsClaims', expect.objectContaining({
        pk: 'USER#usr_premium',
        sk: `SUBSCRIPTION_BONUS#${expectedMonthKey}`,
        userId: 'usr_premium',
        rewardType: 'subscription_bonus',
        tier: 'premium',
        monthKey: expectedMonthKey,
        essenceAwarded: 500,
        gemsAwarded: 100,
        claimedAt: expect.any(String),
        createdAt: expect.any(String),
      }));
    });

    it('should return ESSENCE_FAILED when addEssence fails', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        subscription: { status: 'active' },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: false, error: 'DB write failed' });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_premium' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ESSENCE_FAILED');
      expect(result.error.message).toBe('DB write failed');

      // Should NOT have called addGems or putItem
      expect(dbClient.addGems).not.toHaveBeenCalled();
      expect(dbClient.putItem).not.toHaveBeenCalled();
    });

    it('should return ESSENCE_FAILED with default message when no error detail', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        subscription: { status: 'active' },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: false });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_premium' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ESSENCE_FAILED');
      expect(result.error.message).toBe('Failed to add essence');
    });

    it('should return GEMS_FAILED when addGems fails after essence succeeds', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        subscription: { status: 'active' },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: false, error: 'Gems DB write failed' });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_premium' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('GEMS_FAILED');
      expect(result.error.message).toBe('Gems DB write failed');

      // Essence was already added, but putItem should NOT be called
      expect(dbClient.addEssence).toHaveBeenCalled();
      expect(dbClient.putItem).not.toHaveBeenCalled();
    });

    it('should return GEMS_FAILED with default message when no error detail', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_premium',
        tier: 'premium',
        subscription: { status: 'active' },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: false });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_premium' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('GEMS_FAILED');
      expect(result.error.message).toBe('Failed to add gems');
    });

    it('should allow claim when subscription has no status field (backwards compat)', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_nostat',
        tier: 'premium',
        subscription: {}, // No status field
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: 200 });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_nostat' });
      expect(result.success).toBe(true);
    });

    it('should allow claim when no subscription object (backwards compat)', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_nosub',
        tier: 'premium',
        // No subscription field at all
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: 200 });

      const result = await subscriptions.claimSubscriptionBonus({ userId: 'usr_nosub' });
      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // SUBSCRIPTION_BONUS constant
  // ===========================================================================

  describe('SUBSCRIPTION_BONUS', () => {
    it('should have premium bonus defined', () => {
      expect(subscriptions.SUBSCRIPTION_BONUS.premium).toEqual({
        essence: 500,
        gems: 100,
      });
    });

    it('should have vip bonus defined', () => {
      expect(subscriptions.SUBSCRIPTION_BONUS.vip).toEqual({
        essence: 1500,
        gems: 500,
      });
    });
  });
});

// =============================================================================
// STRIPE-ENABLED TESTS
//
// These tests use a fresh module instance where getSecret returns a key,
// causing getStripeAsync() to create a mock Stripe client via the mocked
// stripe module.
// =============================================================================

describe('Subscription Handlers (Stripe-enabled)', () => {
  let stripeSubs;

  beforeAll(() => {
    // Set env vars needed for price mapping
    process.env.STRIPE_PRICE_PREMIUM = 'price_premium_stripe';
    process.env.STRIPE_PRICE_VIP = 'price_vip_stripe';

    // Make getSecret return a key so getStripeAsync() creates a Stripe client
    ssmLoader.getSecret.mockResolvedValue('sk_test_fake_key');

    // Get a fresh module instance with its own stripe cache
    jest.isolateModules(() => {
      stripeSubs = require('../src/functions/subscriptions');
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-set getSecret to return key for Stripe-enabled mode
    ssmLoader.getSecret.mockResolvedValue('sk_test_fake_key');
    dbClient.getUser.mockResolvedValue(null);
    dbClient.updateUser.mockResolvedValue({});
    dbClient.logTransaction.mockResolvedValue({});
    dbClient.getUserByStripeCustomerId.mockResolvedValue(null);
    // Reset Stripe mock defaults
    mockCheckoutCreate.mockResolvedValue({
      id: 'cs_test_session',
      url: 'https://checkout.stripe.com/cs_test_session',
    });
    mockSubscriptionsUpdate.mockResolvedValue({
      current_period_end: 1740000000,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      items: { data: [{ price: { id: 'price_premium_stripe' } }] },
    });
    mockBillingPortalCreate.mockResolvedValue({
      url: 'https://billing.stripe.com/portal_session',
    });
  });

  afterAll(() => {
    delete process.env.STRIPE_PRICE_PREMIUM;
    delete process.env.STRIPE_PRICE_VIP;
  });

  // ===========================================================================
  // createSubscriptionCheckout - Stripe enabled
  // ===========================================================================

  describe('createSubscriptionCheckout (Stripe)', () => {
    it('should return ALREADY_SUBSCRIBED when user already on requested tier', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_test', tier: 'premium' });

      const result = await stripeSubs.createSubscriptionCheckout(
        { userId: 'usr_test', email: 'test@example.com' },
        { tier: 'premium' }
      );
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ALREADY_SUBSCRIBED');
      expect(result.error.message).toContain('premium');
    });

    it('should create Stripe checkout session for new subscriber', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_new', tier: 'free' });

      const result = await stripeSubs.createSubscriptionCheckout(
        { userId: 'usr_new', email: 'new@example.com' },
        { tier: 'premium' }
      );

      expect(result.success).toBe(true);
      expect(result.data.sessionId).toBe('cs_test_session');
      expect(result.data.sessionUrl).toBe('https://checkout.stripe.com/cs_test_session');

      expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
        payment_method_types: ['card'],
        line_items: [{ price: 'price_premium_stripe', quantity: 1 }],
        mode: 'subscription',
        client_reference_id: 'usr_new',
        customer_email: 'new@example.com',
        metadata: { userId: 'usr_new', tier: 'premium' },
      }));
    });

    it('should use existing stripeCustomerId when available', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_existing',
        tier: 'free',
        stripeCustomerId: 'cus_existing',
      });

      await stripeSubs.createSubscriptionCheckout(
        { userId: 'usr_existing', email: 'existing@example.com' },
        { tier: 'vip' }
      );

      // Should pass customer instead of customer_email
      expect(mockCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_existing',
          line_items: [{ price: 'price_vip_stripe', quantity: 1 }],
        })
      );
      // Should NOT have customer_email when customer is set
      const callArgs = mockCheckoutCreate.mock.calls[0][0];
      expect(callArgs.customer_email).toBeUndefined();
    });

    it('should return CHECKOUT_FAILED when Stripe throws', async () => {
      dbClient.getUser.mockResolvedValue({ userId: 'usr_fail', tier: 'free' });
      mockCheckoutCreate.mockRejectedValue(new Error('Stripe API error'));

      const result = await stripeSubs.createSubscriptionCheckout(
        { userId: 'usr_fail', email: 'fail@example.com' },
        { tier: 'premium' }
      );

      expect(result.success).toBe(false);
      expect(result.error.code).toBe('CHECKOUT_FAILED');
      expect(result.error.message).toBe('Stripe API error');
    });

    it('should include success and cancel URLs from APP_URL', async () => {
      process.env.APP_URL = 'https://myapp.com';
      dbClient.getUser.mockResolvedValue({ userId: 'usr_url', tier: 'free' });

      await stripeSubs.createSubscriptionCheckout(
        { userId: 'usr_url', email: 'url@example.com' },
        { tier: 'premium' }
      );

      const callArgs = mockCheckoutCreate.mock.calls[0][0];
      expect(callArgs.success_url).toContain('https://myapp.com/plans');
      expect(callArgs.cancel_url).toContain('https://myapp.com/plans');

      delete process.env.APP_URL;
    });
  });

  // ===========================================================================
  // cancelSubscription - Stripe enabled
  // ===========================================================================

  describe('cancelSubscription (Stripe)', () => {
    it('should cancel Stripe subscription at period end', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_stripe',
        email: 'stripe@example.com',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          subscriptionId: 'sub_cancel_me',
          cancelAtPeriodEnd: false,
        },
      });

      const result = await stripeSubs.cancelSubscription({
        userId: 'usr_stripe',
        email: 'stripe@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.data.cancelAtPeriodEnd).toBe(true);
      expect(result.data.currentPeriodEnd).toBeDefined();

      expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_cancel_me', {
        cancel_at_period_end: true,
      });

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_stripe', {
        'subscription.cancelAtPeriodEnd': true,
        'subscription.currentPeriodEnd': expect.any(String),
      });
    });

    it('should send cancellation email on Stripe cancel', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_stripe',
        email: 'stripe@example.com',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          subscriptionId: 'sub_cancel_email',
          cancelAtPeriodEnd: false,
        },
      });

      await stripeSubs.cancelSubscription({
        userId: 'usr_stripe',
        email: 'stripe@example.com',
      });
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionCanceledEmail).toHaveBeenCalledWith(
        'stripe@example.com',
        expect.any(Date),
        'premium'
      );
    });

    it('should return CANCEL_FAILED when Stripe throws', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_fail',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          subscriptionId: 'sub_fail',
          cancelAtPeriodEnd: false,
        },
      });
      mockSubscriptionsUpdate.mockRejectedValue(new Error('Stripe cancel error'));

      const result = await stripeSubs.cancelSubscription({ userId: 'usr_fail' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('CANCEL_FAILED');
      expect(result.error.message).toBe('Stripe cancel error');
    });
  });

  // ===========================================================================
  // reactivateSubscription - Stripe enabled
  // ===========================================================================

  describe('reactivateSubscription (Stripe)', () => {
    it('should reactivate Stripe subscription', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_reactivate',
        email: 'reactivate@example.com',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          subscriptionId: 'sub_reactivate',
          cancelAtPeriodEnd: true,
        },
      });

      const result = await stripeSubs.reactivateSubscription({
        userId: 'usr_reactivate',
        email: 'reactivate@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.data.cancelAtPeriodEnd).toBe(false);
      expect(result.data.currentPeriodEnd).toBeDefined();

      expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_reactivate', {
        cancel_at_period_end: false,
      });

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_reactivate', {
        'subscription.cancelAtPeriodEnd': false,
      });
    });

    it('should send reactivation email on Stripe reactivate', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_reactivate',
        email: 'reactivate@example.com',
        tier: 'vip',
        subscription: {
          status: 'active',
          tier: 'vip',
          subscriptionId: 'sub_reactivate',
          cancelAtPeriodEnd: true,
        },
      });

      await stripeSubs.reactivateSubscription({
        userId: 'usr_reactivate',
        email: 'reactivate@example.com',
      });
      await new Promise(r => setTimeout(r, 10));

      expect(email.sendSubscriptionReactivatedEmail).toHaveBeenCalledWith(
        'reactivate@example.com',
        expect.any(Date),
        'vip'
      );
    });

    it('should return REACTIVATE_FAILED when Stripe throws', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_fail',
        tier: 'premium',
        subscription: {
          status: 'active',
          tier: 'premium',
          subscriptionId: 'sub_fail',
          cancelAtPeriodEnd: true,
        },
      });
      mockSubscriptionsUpdate.mockRejectedValue(new Error('Stripe reactivate error'));

      const result = await stripeSubs.reactivateSubscription({ userId: 'usr_fail' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('REACTIVATE_FAILED');
      expect(result.error.message).toBe('Stripe reactivate error');
    });
  });

  // ===========================================================================
  // getBillingPortal - Stripe enabled
  // ===========================================================================

  describe('getBillingPortal (Stripe)', () => {
    it('should return portal URL successfully', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_portal',
        stripeCustomerId: 'cus_portal',
      });

      const result = await stripeSubs.getBillingPortal({ userId: 'usr_portal' });

      expect(result.success).toBe(true);
      expect(result.data.portalUrl).toBe('https://billing.stripe.com/portal_session');

      expect(mockBillingPortalCreate).toHaveBeenCalledWith({
        customer: 'cus_portal',
        return_url: expect.stringContaining('/plans'),
      });
    });

    it('should return PORTAL_FAILED when Stripe throws', async () => {
      dbClient.getUser.mockResolvedValue({
        userId: 'usr_portal',
        stripeCustomerId: 'cus_portal_fail',
      });
      mockBillingPortalCreate.mockRejectedValue(new Error('Portal creation failed'));

      const result = await stripeSubs.getBillingPortal({ userId: 'usr_portal' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('PORTAL_FAILED');
      expect(result.error.message).toBe('Portal creation failed');
    });
  });

  // ===========================================================================
  // handleSubscriptionWebhook - tier resolution via Stripe
  // ===========================================================================

  describe('handleSubscriptionWebhook (Stripe tier resolution)', () => {
    it('should resolve tier from Stripe subscription when metadata has no tier', async () => {
      mockSubscriptionsRetrieve.mockResolvedValue({
        items: { data: [{ price: { id: 'price_vip_stripe' } }] },
      });

      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            client_reference_id: 'usr_resolve',
            metadata: {}, // No tier
            subscription: 'sub_resolve',
            customer: 'cus_resolve',
          },
        },
      };

      const result = await stripeSubs.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(result.message).toContain('vip');

      expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_resolve');
    });

    it('should default to premium when Stripe price ID is unrecognized', async () => {
      mockSubscriptionsRetrieve.mockResolvedValue({
        items: { data: [{ price: { id: 'price_unknown' } }] },
      });

      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            client_reference_id: 'usr_default',
            metadata: {}, // No tier
            subscription: 'sub_default',
            customer: 'cus_default',
          },
        },
      };

      const result = await stripeSubs.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);
      expect(result.message).toContain('premium');
    });
  });

  // ===========================================================================
  // subscription.updated - cancel_at_period_end logging
  // ===========================================================================

  describe('subscription.updated (cancel scheduling)', () => {
    it('should log cancel scheduling when cancel_at_period_end is true', async () => {
      const user = { id: 'usr_scheduled', tier: 'premium' };
      dbClient.getUserByStripeCustomerId.mockResolvedValue(user);

      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            customer: 'cus_scheduled',
            cancel_at_period_end: true,
            current_period_end: 1740000000,
            items: { data: [{ price: { id: 'price_premium_stripe' } }] },
          },
        },
      };

      const result = await stripeSubs.handleSubscriptionWebhook(event);
      expect(result.success).toBe(true);

      expect(dbClient.updateUser).toHaveBeenCalledWith('usr_scheduled', expect.objectContaining({
        'subscription.cancelAtPeriodEnd': true,
      }));
    });
  });
});
