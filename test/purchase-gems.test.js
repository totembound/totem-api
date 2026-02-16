/**
 * Purchase Gems Handler Tests - GAP COVERAGE
 *
 * Covers paths NOT tested in shop-gems.test.js to push coverage from 47% to 85%+.
 * Focuses on: getGemPackages detail, createCheckoutSession edge cases,
 * fulfillGemPurchase daily limits / IoT / email, and handleStripeWebhook paths.
 */

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted by Jest)
// ---------------------------------------------------------------------------

jest.mock('../src/common/db-client', () => ({
  addGems: jest.fn(),
  getUser: jest.fn(),
  logTransaction: jest.fn(),
  getBundlePurchasesToday: jest.fn(),
  TABLES: { REWARDS_CLAIMS: 'TotemBound-RewardsClaims' },
}));

jest.mock('../src/common/email', () => ({
  sendGemPurchaseReceiptEmail: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/common/iot-publisher', () => ({
  publishBalanceUpdate: jest.fn().mockResolvedValue({}),
  publishNotification: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/common/ssm-loader', () => ({
  getSecret: jest.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const dbClient = require('../src/common/db-client');
const email = require('../src/common/email');
const iot = require('../src/common/iot-publisher');
const ssm = require('../src/common/ssm-loader');
const { GEM_TO_STARLIGHT_RATIO, getPackagesForDisplay } = require('../src/config/gem-packages');
const {
  getGemPackages,
  createCheckoutSession,
  fulfillGemPurchase,
  handleStripeWebhook,
} = require('../src/functions/shop/purchase-gems');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = { userId: 'usr_test123', email: 'test@example.com' };

const makeUserRecord = (overrides = {}) => ({
  id: 'usr_test123',
  email: 'test@example.com',
  displayName: 'Tester',
  currencies: { gems: 5000, essence: 10000 },
  stats: {},
  settings: {},
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  dbClient.getUser.mockResolvedValue(makeUserRecord());
  dbClient.addGems.mockResolvedValue({ success: true, newBalance: 5500 });
  dbClient.getBundlePurchasesToday.mockResolvedValue(0);
  dbClient.logTransaction.mockResolvedValue({});
  ssm.getSecret.mockResolvedValue(null);
});

// =============================================================================
// getGemPackages
// =============================================================================

describe('getGemPackages', () => {
  it('should return success true with packages array', async () => {
    const result = await getGemPackages();
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data.packages)).toBe(true);
    expect(result.data.packages.length).toBeGreaterThan(0);
  });

  it('should include correct conversion rate from config', async () => {
    const result = await getGemPackages();
    expect(result.data.conversionRate).toBe(GEM_TO_STARLIGHT_RATIO);
    expect(result.data.conversionRate).toBe(5);
  });

  it('should include conversion note with the ratio', async () => {
    const result = await getGemPackages();
    expect(result.data.conversionNote).toContain(String(GEM_TO_STARLIGHT_RATIO));
    expect(result.data.conversionNote).toContain('Gem Exchange');
  });

  it('should return packages matching getPackagesForDisplay output', async () => {
    const result = await getGemPackages();
    const expected = getPackagesForDisplay();
    expect(result.data.packages).toEqual(expected);
  });

  it('should include id, name, gems, price for each package', async () => {
    const result = await getGemPackages();
    for (const pkg of result.data.packages) {
      expect(pkg).toHaveProperty('id');
      expect(pkg).toHaveProperty('name');
      expect(pkg).toHaveProperty('gems');
      expect(pkg).toHaveProperty('price');
      expect(pkg).toHaveProperty('category');
    }
  });

  it('should include pkg_starter as a package', async () => {
    const result = await getGemPackages();
    const starter = result.data.packages.find(p => p.id === 'pkg_starter');
    expect(starter).toBeDefined();
    expect(starter.name).toBe('Starter Pack');
    expect(starter.gems).toBe(500);
  });
});

// =============================================================================
// createCheckoutSession
// =============================================================================

describe('createCheckoutSession', () => {
  it('should return INVALID_PACKAGE for unknown packageId', async () => {
    const result = await createCheckoutSession(testUser, { packageId: 'does_not_exist' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_PACKAGE');
    expect(result.error.message).toBe('Package not found');
  });

  it('should return INVALID_PACKAGE when body is null', async () => {
    const result = await createCheckoutSession(testUser, null);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_PACKAGE');
  });

  it('should return INVALID_PACKAGE when body is undefined', async () => {
    const result = await createCheckoutSession(testUser, undefined);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_PACKAGE');
  });

  it('should return INVALID_PACKAGE when packageId is missing from body', async () => {
    const result = await createCheckoutSession(testUser, {});
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_PACKAGE');
  });

  it('should fall through to dev mode fulfillment when Stripe not configured', async () => {
    const result = await createCheckoutSession(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(true);
    expect(result.data.isDev).toBe(true);
    expect(result.data.gemsAdded).toBe(500);
  });
});

// =============================================================================
// fulfillGemPurchase
// =============================================================================

describe('fulfillGemPurchase', () => {
  it('should return MISSING_USER when user is null and body has no userId', async () => {
    const result = await fulfillGemPurchase(null, { packageId: 'pkg_starter' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('MISSING_USER');
  });

  it('should return MISSING_USER when both user and body are null', async () => {
    const result = await fulfillGemPurchase(null, null);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('MISSING_USER');
  });

  it('should return MISSING_USER when user is empty and body is undefined', async () => {
    const result = await fulfillGemPurchase({}, undefined);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('MISSING_USER');
  });

  it('should use userId from body when user object has no userId', async () => {
    const result = await fulfillGemPurchase(
      {},
      { packageId: 'pkg_starter', userId: 'usr_test123' }
    );
    expect(result.success).toBe(true);
    expect(dbClient.getUser).toHaveBeenCalledWith('usr_test123');
  });

  it('should return INVALID_PACKAGE for unknown packageId', async () => {
    const result = await fulfillGemPurchase(testUser, { packageId: 'bad_pkg' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_PACKAGE');
    expect(result.error.message).toBe('Package not found');
  });

  it('should return INVALID_PACKAGE when body has no packageId', async () => {
    const result = await fulfillGemPurchase(testUser, {});
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_PACKAGE');
  });

  it('should return USER_NOT_FOUND when user does not exist in DB', async () => {
    dbClient.getUser.mockResolvedValue(null);
    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('USER_NOT_FOUND');
  });

  it('should return DAILY_LIMIT_REACHED when bundle dailyLimit exceeded', async () => {
    // bundle_collector has dailyLimit: 1 in COLLECTOR_BUNDLES
    dbClient.getBundlePurchasesToday.mockResolvedValue(1);
    const result = await fulfillGemPurchase(testUser, { packageId: 'bundle_collector' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('DAILY_LIMIT_REACHED');
    expect(result.error.message).toContain('already purchased');
    expect(result.error.message).toContain('1 per day');
  });

  it('should skip daily limit check for packages without dailyLimit', async () => {
    // pkg_starter has no dailyLimit
    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(true);
    expect(dbClient.getBundlePurchasesToday).not.toHaveBeenCalled();
  });

  it('should allow purchase when dailyLimit not reached', async () => {
    dbClient.getBundlePurchasesToday.mockResolvedValue(0);
    dbClient.addGems.mockResolvedValue({ success: true, newBalance: 15000 });

    const result = await fulfillGemPurchase(testUser, { packageId: 'bundle_collector' });
    expect(result.success).toBe(true);
    expect(result.data.gemsAdded).toBe(10000);
  });

  it('should return GEM_ADD_FAILED when addGems returns success: false', async () => {
    dbClient.addGems.mockResolvedValue({ success: false });
    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('GEM_ADD_FAILED');
    expect(result.error.message).toBe('Failed to add gems to account');
  });

  it('should return successful purchase data with correct fields', async () => {
    dbClient.addGems.mockResolvedValue({ success: true, newBalance: 6100 });

    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_popular' });
    expect(result.success).toBe(true);
    expect(result.data.package).toBe('Popular Pack');
    expect(result.data.gemsAdded).toBe(1100);
    expect(result.data.newGemsBalance).toBe(6100);
    expect(result.data.isDev).toBe(false);
    expect(result.message).toContain('Popular Pack');
    expect(result.message).toContain('1100');
  });

  it('should set isDev true when isDev flag is passed', async () => {
    const result = await fulfillGemPurchase(testUser, {
      packageId: 'pkg_starter',
      isDev: true,
    });
    expect(result.data.isDev).toBe(true);
  });

  it('should set isDev false when isDev flag is not passed', async () => {
    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.data.isDev).toBe(false);
  });

  it('should call addGems with correct userId, gems, and metadata', async () => {
    dbClient.addGems.mockResolvedValue({ success: true, newBalance: 8000 });

    await fulfillGemPurchase(testUser, { packageId: 'pkg_best_value' });
    expect(dbClient.addGems).toHaveBeenCalledWith('usr_test123', 3000, {
      type: 'purchase_gems',
      ref: 'pkg_best_value',
    });
  });

  it('should call sendGemPurchaseReceiptEmail when user has email', async () => {
    await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });

    // Give the non-blocking promise a tick to resolve
    await new Promise(resolve => setImmediate(resolve));

    expect(email.sendGemPurchaseReceiptEmail).toHaveBeenCalledWith(
      'test@example.com',
      'Starter Pack',
      500,
      5500
    );
  });

  it('should not call sendGemPurchaseReceiptEmail when user has no email', async () => {
    dbClient.getUser.mockResolvedValue(makeUserRecord({ email: null }));

    await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    await new Promise(resolve => setImmediate(resolve));

    expect(email.sendGemPurchaseReceiptEmail).not.toHaveBeenCalled();
  });

  it('should not call sendGemPurchaseReceiptEmail when user email is empty string', async () => {
    dbClient.getUser.mockResolvedValue(makeUserRecord({ email: '' }));

    await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    await new Promise(resolve => setImmediate(resolve));

    expect(email.sendGemPurchaseReceiptEmail).not.toHaveBeenCalled();
  });

  it('should call publishBalanceUpdate with correct data', async () => {
    await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    await new Promise(resolve => setImmediate(resolve));

    expect(iot.publishBalanceUpdate).toHaveBeenCalledWith('usr_test123', {
      currency: 'gems',
      amount: 500,
      newBalance: 5500,
      reason: 'Purchased Starter Pack',
    });
  });

  it('should call publishNotification with correct data', async () => {
    await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    await new Promise(resolve => setImmediate(resolve));

    expect(iot.publishNotification).toHaveBeenCalledWith('usr_test123', {
      notificationType: 'REWARD_CLAIMED',
      title: 'Gems Purchased!',
      message: expect.stringContaining('500'),
      data: { gemsAdded: 500, packageName: 'Starter Pack' },
    });
  });

  it('should not fail if email send throws (non-blocking)', async () => {
    email.sendGemPurchaseReceiptEmail.mockRejectedValue(new Error('SMTP down'));

    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(true);

    // Let non-blocking catches settle
    await new Promise(resolve => setImmediate(resolve));
  });

  it('should not fail if IoT publishBalanceUpdate throws (non-blocking)', async () => {
    iot.publishBalanceUpdate.mockRejectedValue(new Error('IoT down'));

    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
  });

  it('should not fail if IoT publishNotification throws (non-blocking)', async () => {
    iot.publishNotification.mockRejectedValue(new Error('IoT notification down'));

    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
  });

  it('should return FULFILLMENT_FAILED when addGems throws', async () => {
    dbClient.addGems.mockRejectedValue(new Error('DynamoDB timeout'));

    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('FULFILLMENT_FAILED');
    expect(result.error.message).toBe('DynamoDB timeout');
  });

  it('should return generic FULFILLMENT_FAILED message when error has no message', async () => {
    dbClient.addGems.mockRejectedValue({ code: 'UNKNOWN' });

    const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('FULFILLMENT_FAILED');
    expect(result.error.message).toBe('Failed to fulfill purchase');
  });

  it('should work with all 4 standard gem packages', async () => {
    const pkgIds = ['pkg_starter', 'pkg_popular', 'pkg_best_value', 'pkg_ultimate'];
    const expectedGems = [500, 1100, 3000, 6500];

    for (let i = 0; i < pkgIds.length; i++) {
      jest.clearAllMocks();
      dbClient.getUser.mockResolvedValue(makeUserRecord());
      dbClient.addGems.mockResolvedValue({ success: true, newBalance: expectedGems[i] });

      const result = await fulfillGemPurchase(testUser, { packageId: pkgIds[i] });
      expect(result.success).toBe(true);
      expect(result.data.gemsAdded).toBe(expectedGems[i]);
    }
  });

  it('should include sessionId in console log when provided', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await fulfillGemPurchase(testUser, {
      packageId: 'pkg_starter',
      sessionId: 'cs_test_123',
    });

    const logCall = consoleSpy.mock.calls.find(c => c[0].includes('[Gems] Fulfilled'));
    expect(logCall).toBeDefined();
    expect(logCall[0]).toContain('cs_test_123');

    consoleSpy.mockRestore();
  });

  it('should log n/a when no sessionId provided', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });

    const logCall = consoleSpy.mock.calls.find(c => c[0].includes('[Gems] Fulfilled'));
    expect(logCall).toBeDefined();
    expect(logCall[0]).toContain('n/a');

    consoleSpy.mockRestore();
  });
});

// =============================================================================
// handleStripeWebhook
// =============================================================================

describe('handleStripeWebhook', () => {
  it('should return error when Stripe is not configured', async () => {
    // ssm.getSecret returns null by default (no Stripe key)
    const result = await handleStripeWebhook('raw-body', 'sig-header');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Stripe not configured');
  });

  // For deeper webhook tests, we need to bypass the module-level stripe cache.
  // Since the top-level require already cached the module with stripe=null,
  // we use jest.resetModules to get a fresh module instance for each webhook scenario.

  describe('with Stripe configured via fresh module', () => {
    let mod;
    let mockConstructEvent;
    let mockSessionCreate;
    let freshDb;
    let freshSsm;
    let _freshEmail;
    let _freshIot;

    beforeEach(() => {
      jest.resetModules();

      mockConstructEvent = jest.fn();
      mockSessionCreate = jest.fn();

      // Re-establish all mocks after resetModules
      jest.doMock('../src/common/ssm-loader', () => ({
        getSecret: jest.fn().mockImplementation((key) => {
          if (key === 'STRIPE_SECRET_KEY') return Promise.resolve('sk_test_key');
          if (key === 'STRIPE_WEBHOOK_SECRET') return Promise.resolve('whsec_test');
          return Promise.resolve(null);
        }),
      }));

      jest.doMock('stripe', () => jest.fn(() => ({
        checkout: { sessions: { create: mockSessionCreate } },
        webhooks: { constructEvent: mockConstructEvent },
      })));

      jest.doMock('../src/common/db-client', () => ({
        addGems: jest.fn().mockResolvedValue({ success: true, newBalance: 5500 }),
        getUser: jest.fn().mockResolvedValue({
          id: 'usr_test123',
          email: 'test@example.com',
          displayName: 'Tester',
          currencies: { gems: 5000, essence: 10000 },
          stats: {},
          settings: {},
          createdAt: '2024-01-01T00:00:00.000Z',
        }),
        logTransaction: jest.fn().mockResolvedValue({}),
        getBundlePurchasesToday: jest.fn().mockResolvedValue(0),
        TABLES: { REWARDS_CLAIMS: 'TotemBound-RewardsClaims' },
      }));

      jest.doMock('../src/common/email', () => ({
        sendGemPurchaseReceiptEmail: jest.fn().mockResolvedValue({}),
      }));

      jest.doMock('../src/common/iot-publisher', () => ({
        publishBalanceUpdate: jest.fn().mockResolvedValue({}),
        publishNotification: jest.fn().mockResolvedValue({}),
      }));

      mod = require('../src/functions/shop/purchase-gems');
      freshDb = require('../src/common/db-client');
      freshSsm = require('../src/common/ssm-loader');
      _freshEmail = require('../src/common/email');
      _freshIot = require('../src/common/iot-publisher');
    });

    it('should return error when webhook secret is not configured', async () => {
      freshSsm.getSecret.mockImplementation((key) => {
        if (key === 'STRIPE_SECRET_KEY') return Promise.resolve('sk_test_key');
        if (key === 'STRIPE_WEBHOOK_SECRET') return Promise.resolve(null);
        return Promise.resolve(null);
      });

      const result = await mod.handleStripeWebhook('raw-body', 'sig-header');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Webhook secret not configured');
    });

    it('should return error when signature verification fails', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature');
      });

      const result = await mod.handleStripeWebhook('raw-body', 'bad-sig');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('should fulfill gem purchase on checkout.session.completed with payment mode', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'payment',
            client_reference_id: 'usr_test123',
            metadata: { packageId: 'pkg_starter', userId: 'usr_test123', gems: '500' },
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);
      expect(result.data.gemsAdded).toBe(500);
      expect(result.data.newGemsBalance).toBe(5500);
      expect(freshDb.addGems).toHaveBeenCalledWith('usr_test123', 500, expect.any(Object));
    });

    it('should use metadata.userId when client_reference_id is missing', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'payment',
            client_reference_id: null,
            metadata: { packageId: 'pkg_starter', userId: 'usr_fallback456' },
          },
        },
      });
      freshDb.getUser.mockResolvedValue({
        id: 'usr_fallback456',
        email: 'fallback@test.com',
        currencies: { gems: 5000, essence: 10000 },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);
      expect(freshDb.getUser).toHaveBeenCalledWith('usr_fallback456');
    });

    it('should ignore non-payment session mode (subscription)', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'subscription',
            metadata: { packageId: 'pkg_starter' },
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Ignored non-payment session');
      expect(freshDb.addGems).not.toHaveBeenCalled();
    });

    it('should ignore non-payment session mode (setup)', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'setup',
            metadata: { packageId: 'pkg_starter' },
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Ignored non-payment session');
    });

    it('should ignore checkout without packageId in metadata (non-gem purchase)', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'payment',
            client_reference_id: 'usr_test123',
            metadata: {},
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Ignored non-gem purchase');
      expect(freshDb.addGems).not.toHaveBeenCalled();
    });

    it('should return error when session has no userId at all', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'payment',
            client_reference_id: null,
            metadata: { packageId: 'pkg_starter' },
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing user ID');
    });

    it('should handle charge.refunded event', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'charge.refunded',
        data: {
          object: { id: 'ch_test_charge123' },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Refund logged');
      expect(freshDb.addGems).not.toHaveBeenCalled();
    });

    it('should return unhandled event message for unknown event types', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'customer.created',
        data: { object: {} },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Unhandled event: customer.created');
    });

    it('should return unhandled event message for payment_intent.succeeded', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_test123' } },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Unhandled event: payment_intent.succeeded');
    });

    it('should pass through INVALID_PACKAGE error from fulfillment', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'payment',
            client_reference_id: 'usr_test123',
            metadata: { packageId: 'bad_package_id' },
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_PACKAGE');
    });

    it('should pass through USER_NOT_FOUND from webhook fulfillment', async () => {
      freshDb.getUser.mockResolvedValue(null);

      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'payment',
            client_reference_id: 'usr_nonexistent',
            metadata: { packageId: 'pkg_starter', userId: 'usr_nonexistent' },
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('should pass sessionId from webhook session to fulfillGemPurchase', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_webhook_session_789',
            mode: 'payment',
            client_reference_id: 'usr_test123',
            metadata: { packageId: 'pkg_starter', userId: 'usr_test123', gems: '500' },
          },
        },
      });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(true);

      // Verify sessionId was passed through by checking the log
      const logCall = consoleSpy.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('cs_webhook_session_789')
      );
      expect(logCall).toBeDefined();
      consoleSpy.mockRestore();
    });

    it('should handle null metadata gracefully', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'payment',
            client_reference_id: 'usr_test123',
            metadata: null,
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      // metadata?.packageId will be undefined, so it should be "Ignored non-gem purchase"
      expect(result.success).toBe(true);
      expect(result.message).toBe('Ignored non-gem purchase');
    });

    it('should call constructEvent with correct arguments', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'customer.created',
        data: { object: {} },
      });

      await mod.handleStripeWebhook('my-raw-body', 'my-sig-header');
      expect(mockConstructEvent).toHaveBeenCalledWith('my-raw-body', 'my-sig-header', 'whsec_test');
    });

    it('should handle GEM_ADD_FAILED during webhook fulfillment', async () => {
      freshDb.addGems.mockResolvedValue({ success: false });

      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session',
            mode: 'payment',
            client_reference_id: 'usr_test123',
            metadata: { packageId: 'pkg_starter' },
          },
        },
      });

      const result = await mod.handleStripeWebhook('raw-body', 'valid-sig');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('GEM_ADD_FAILED');
    });
  });

  describe('createCheckoutSession with Stripe configured', () => {
    let mod;
    let mockSessionCreate;

    beforeEach(() => {
      jest.resetModules();

      mockSessionCreate = jest.fn();

      jest.doMock('../src/common/ssm-loader', () => ({
        getSecret: jest.fn().mockImplementation((key) => {
          if (key === 'STRIPE_SECRET_KEY') return Promise.resolve('sk_test_key');
          return Promise.resolve(null);
        }),
      }));

      jest.doMock('stripe', () => jest.fn(() => ({
        checkout: { sessions: { create: mockSessionCreate } },
        webhooks: { constructEvent: jest.fn() },
      })));

      jest.doMock('../src/common/db-client', () => ({
        addGems: jest.fn().mockResolvedValue({ success: true, newBalance: 5500 }),
        getUser: jest.fn().mockResolvedValue({
          id: 'usr_test123',
          email: 'test@example.com',
          displayName: 'Tester',
          currencies: { gems: 5000, essence: 10000 },
          stats: {},
          settings: {},
          createdAt: '2024-01-01T00:00:00.000Z',
        }),
        logTransaction: jest.fn().mockResolvedValue({}),
        getBundlePurchasesToday: jest.fn().mockResolvedValue(0),
        TABLES: { REWARDS_CLAIMS: 'TotemBound-RewardsClaims' },
      }));

      jest.doMock('../src/common/email', () => ({
        sendGemPurchaseReceiptEmail: jest.fn().mockResolvedValue({}),
      }));

      jest.doMock('../src/common/iot-publisher', () => ({
        publishBalanceUpdate: jest.fn().mockResolvedValue({}),
        publishNotification: jest.fn().mockResolvedValue({}),
      }));

      mod = require('../src/functions/shop/purchase-gems');
    });

    it('should fall through to dev mode when package has no stripePriceId', async () => {
      // pkg_starter has no STRIPE_PRICE_STARTER env var set, so stripePriceId = null
      const result = await mod.createCheckoutSession(testUser, { packageId: 'pkg_starter' });
      expect(result.success).toBe(true);
      expect(result.data.isDev).toBe(true);
    });

    it('should create Stripe session when package has stripePriceId', async () => {
      const origEnv = process.env.STRIPE_PRICE_STARTER;
      process.env.STRIPE_PRICE_STARTER = 'price_test123';

      // Need to re-require so gem-packages picks up the env var
      jest.resetModules();

      jest.doMock('../src/common/ssm-loader', () => ({
        getSecret: jest.fn().mockImplementation((key) => {
          if (key === 'STRIPE_SECRET_KEY') return Promise.resolve('sk_test_key');
          return Promise.resolve(null);
        }),
      }));
      jest.doMock('stripe', () => jest.fn(() => ({
        checkout: {
          sessions: {
            create: jest.fn().mockResolvedValue({
              id: 'cs_test_session',
              url: 'https://checkout.stripe.com/session/cs_test_session',
            }),
          },
        },
        webhooks: { constructEvent: jest.fn() },
      })));
      jest.doMock('../src/common/db-client', () => ({
        addGems: jest.fn(),
        getUser: jest.fn(),
        logTransaction: jest.fn(),
        getBundlePurchasesToday: jest.fn(),
        TABLES: { REWARDS_CLAIMS: 'TotemBound-RewardsClaims' },
      }));
      jest.doMock('../src/common/email', () => ({
        sendGemPurchaseReceiptEmail: jest.fn().mockResolvedValue({}),
      }));
      jest.doMock('../src/common/iot-publisher', () => ({
        publishBalanceUpdate: jest.fn().mockResolvedValue({}),
        publishNotification: jest.fn().mockResolvedValue({}),
      }));

      const freshMod = require('../src/functions/shop/purchase-gems');
      const result = await freshMod.createCheckoutSession(testUser, { packageId: 'pkg_starter' });

      expect(result.success).toBe(true);
      expect(result.data.sessionId).toBe('cs_test_session');
      expect(result.data.sessionUrl).toContain('checkout.stripe.com');

      // Cleanup
      if (origEnv === undefined) {
        delete process.env.STRIPE_PRICE_STARTER;
      }
      else {
        process.env.STRIPE_PRICE_STARTER = origEnv;
      }
    });

    it('should return CHECKOUT_FAILED when Stripe session create throws', async () => {
      const origEnv = process.env.STRIPE_PRICE_STARTER;
      process.env.STRIPE_PRICE_STARTER = 'price_test123';

      jest.resetModules();

      jest.doMock('../src/common/ssm-loader', () => ({
        getSecret: jest.fn().mockImplementation((key) => {
          if (key === 'STRIPE_SECRET_KEY') return Promise.resolve('sk_test_key');
          return Promise.resolve(null);
        }),
      }));
      jest.doMock('stripe', () => jest.fn(() => ({
        checkout: {
          sessions: {
            create: jest.fn().mockRejectedValue(new Error('Stripe API error')),
          },
        },
        webhooks: { constructEvent: jest.fn() },
      })));
      jest.doMock('../src/common/db-client', () => ({
        addGems: jest.fn(),
        getUser: jest.fn(),
        logTransaction: jest.fn(),
        getBundlePurchasesToday: jest.fn(),
        TABLES: { REWARDS_CLAIMS: 'TotemBound-RewardsClaims' },
      }));
      jest.doMock('../src/common/email', () => ({
        sendGemPurchaseReceiptEmail: jest.fn().mockResolvedValue({}),
      }));
      jest.doMock('../src/common/iot-publisher', () => ({
        publishBalanceUpdate: jest.fn().mockResolvedValue({}),
        publishNotification: jest.fn().mockResolvedValue({}),
      }));

      const freshMod = require('../src/functions/shop/purchase-gems');
      const result = await freshMod.createCheckoutSession(testUser, { packageId: 'pkg_starter' });

      expect(result.success).toBe(false);
      expect(result.error.code).toBe('CHECKOUT_FAILED');
      expect(result.error.message).toBe('Stripe API error');

      if (origEnv === undefined) {
        delete process.env.STRIPE_PRICE_STARTER;
      }
      else {
        process.env.STRIPE_PRICE_STARTER = origEnv;
      }
    });

    it('should return CHECKOUT_FAILED with generic message when error has no message', async () => {
      const origEnv = process.env.STRIPE_PRICE_STARTER;
      process.env.STRIPE_PRICE_STARTER = 'price_test123';

      jest.resetModules();

      jest.doMock('../src/common/ssm-loader', () => ({
        getSecret: jest.fn().mockImplementation((key) => {
          if (key === 'STRIPE_SECRET_KEY') return Promise.resolve('sk_test_key');
          return Promise.resolve(null);
        }),
      }));
      jest.doMock('stripe', () => jest.fn(() => ({
        checkout: {
          sessions: {
            create: jest.fn().mockRejectedValue({}),
          },
        },
        webhooks: { constructEvent: jest.fn() },
      })));
      jest.doMock('../src/common/db-client', () => ({
        addGems: jest.fn(),
        getUser: jest.fn(),
        logTransaction: jest.fn(),
        getBundlePurchasesToday: jest.fn(),
        TABLES: { REWARDS_CLAIMS: 'TotemBound-RewardsClaims' },
      }));
      jest.doMock('../src/common/email', () => ({
        sendGemPurchaseReceiptEmail: jest.fn().mockResolvedValue({}),
      }));
      jest.doMock('../src/common/iot-publisher', () => ({
        publishBalanceUpdate: jest.fn().mockResolvedValue({}),
        publishNotification: jest.fn().mockResolvedValue({}),
      }));

      const freshMod = require('../src/functions/shop/purchase-gems');
      const result = await freshMod.createCheckoutSession(testUser, { packageId: 'pkg_starter' });

      expect(result.success).toBe(false);
      expect(result.error.code).toBe('CHECKOUT_FAILED');
      expect(result.error.message).toBe('Failed to create checkout session');

      if (origEnv === undefined) {
        delete process.env.STRIPE_PRICE_STARTER;
      }
      else {
        process.env.STRIPE_PRICE_STARTER = origEnv;
      }
    });
  });
});
