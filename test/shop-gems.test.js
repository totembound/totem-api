/**
 * Shop Gems & Exchange Handler Tests
 *
 * Tests for gem exchange, gem purchase, purchase-bundle, and special offer handlers.
 */

// Mock db-client
jest.mock('../src/common/db-client', () => ({
  getUser: jest.fn(),
  getUserTotems: jest.fn().mockResolvedValue([]),
  logTransaction: jest.fn().mockResolvedValue({}),
  addGems: jest.fn(),
  getBundlePurchasesToday: jest.fn().mockResolvedValue(0),
  transactWrite: jest.fn().mockResolvedValue({}),
  docClient: { send: jest.fn() },
  TABLES: {
    USERS: 'TotemBound-Users',
    TOTEMS: 'TotemBound-Totems',
    TRANSACTIONS: 'TotemBound-Transactions',
  },
  KEY_PREFIX: { USER: 'USER#' },
}));

// Mock ssm-loader
jest.mock('../src/common/ssm-loader', () => ({
  getSecret: jest.fn().mockResolvedValue(null),
}));

// Mock email
jest.mock('../src/common/email', () => ({
  sendGemPurchaseReceiptEmail: jest.fn().mockResolvedValue({}),
}));

// Mock iot-publisher
jest.mock('../src/common/iot-publisher', () => ({
  publishBalanceUpdate: jest.fn().mockResolvedValue({}),
  publishNotification: jest.fn().mockResolvedValue({}),
}));

// Mock id-utils
jest.mock('../src/common/id-utils', () => ({
  generateId: jest.fn(() => 'ttm_generated123'),
}));

// Mock totem-creation
jest.mock('../src/services/totem-creation', () => ({
  selectRandomSpecies: jest.fn(() => ({ speciesId: 2, name: 'Wolf' })),
  selectColor: jest.fn(() => ({ colorId: 4 })),
  calculateInitialStats: jest.fn((base, bonus) => ({
    strength: 10 + bonus,
    agility: 8 + bonus,
    wisdom: 6 + bonus,
    happiness: 50,
  })),
  SPECIES: [
    { name: 'Goose', baseStats: { strength: 5, agility: 7, wisdom: 5 } },
    { name: 'Otter', baseStats: { strength: 6, agility: 8, wisdom: 6 } },
    { name: 'Wolf', baseStats: { strength: 10, agility: 8, wisdom: 6 } },
  ],
}));

// Mock achievements-service
jest.mock('../src/services/achievements-service', () => ({
  onTotemAcquired: jest.fn().mockResolvedValue([]),
}));

const dbClient = require('../src/common/db-client');

// =============================================================================
// TEST DATA
// =============================================================================

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

// =============================================================================
// EXCHANGE GEMS TESTS
// =============================================================================

describe('Exchange Gems', () => {
  const { getExchangeBundles, exchangeGemsForEssence, getExchangeBundleById } =
    require('../src/functions/shop/exchange-gems');

  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.getUser.mockResolvedValue(makeUserRecord());
  });

  describe('getExchangeBundles', () => {
    it('should return enabled bundles', async () => {
      const result = await getExchangeBundles();
      expect(result.success).toBe(true);
      expect(result.data.bundles.length).toBeGreaterThan(0);
      expect(result.data.conversionRate).toBe(5);
    });

    it('should include bundle details', async () => {
      const result = await getExchangeBundles();
      const bundle = result.data.bundles[0];
      expect(bundle).toHaveProperty('id');
      expect(bundle).toHaveProperty('name');
      expect(bundle).toHaveProperty('gemCost');
      expect(bundle).toHaveProperty('essenceAmount');
    });
  });

  describe('getExchangeBundleById', () => {
    it('should find an enabled bundle', () => {
      const bundle = getExchangeBundleById('exchange_small');
      expect(bundle).toBeDefined();
      expect(bundle.gemCost).toBe(100);
    });

    it('should return null for unknown bundle', () => {
      expect(getExchangeBundleById('nonexistent')).toBeNull();
    });
  });

  describe('exchangeGemsForEssence', () => {
    beforeEach(() => {
      dbClient.docClient.send.mockResolvedValue({
        Attributes: {
          currencies: { gems: 4900, essence: 10500 },
        },
      });
    });

    it('should exchange gems successfully', async () => {
      const result = await exchangeGemsForEssence(testUser, { bundleId: 'exchange_small' });
      expect(result.success).toBe(true);
      expect(result.data.gemsSpent).toBe(100);
      expect(result.data.essenceReceived).toBe(500);
      expect(result.data.newGemsBalance).toBe(4900);
      expect(result.data.newEssenceBalance).toBe(10500);
    });

    it('should require userId', async () => {
      const result = await exchangeGemsForEssence({}, { bundleId: 'exchange_small' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_USER');
    });

    it('should require bundleId', async () => {
      const result = await exchangeGemsForEssence(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_BUNDLE');
    });

    it('should reject invalid bundleId', async () => {
      const result = await exchangeGemsForEssence(testUser, { bundleId: 'bad_bundle' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_BUNDLE');
    });

    it('should return USER_NOT_FOUND when user missing', async () => {
      dbClient.getUser.mockResolvedValue(null);
      const result = await exchangeGemsForEssence(testUser, { bundleId: 'exchange_small' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('should return INSUFFICIENT_GEMS when not enough gems', async () => {
      dbClient.getUser.mockResolvedValue(makeUserRecord({ currencies: { gems: 10, essence: 0 } }));
      const result = await exchangeGemsForEssence(testUser, { bundleId: 'exchange_small' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_GEMS');
      expect(result.error.required).toBe(100);
    });

    it('should handle ConditionalCheckFailedException (race condition)', async () => {
      const condErr = new Error('Condition not met');
      condErr.name = 'ConditionalCheckFailedException';
      dbClient.docClient.send.mockRejectedValue(condErr);
      dbClient.getUser
        .mockResolvedValueOnce(makeUserRecord())
        .mockResolvedValueOnce(makeUserRecord({ currencies: { gems: 50, essence: 0 } }));
      const result = await exchangeGemsForEssence(testUser, { bundleId: 'exchange_small' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_GEMS');
    });

    it('should handle generic DynamoDB error', async () => {
      dbClient.docClient.send.mockRejectedValue(new Error('DynamoDB timeout'));
      const result = await exchangeGemsForEssence(testUser, { bundleId: 'exchange_small' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('EXCHANGE_FAILED');
    });

    it('should log both transactions after success', async () => {
      await exchangeGemsForEssence(testUser, { bundleId: 'exchange_small' });
      expect(dbClient.logTransaction).toHaveBeenCalledTimes(2);
    });
  });
});

// =============================================================================
// GEM PURCHASE TESTS
// =============================================================================

describe('Gem Purchases', () => {
  const { getGemPackages, fulfillGemPurchase, createCheckoutSession } =
    require('../src/functions/shop/purchase-gems');

  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.getUser.mockResolvedValue(makeUserRecord());
    dbClient.addGems.mockResolvedValue({ success: true, newBalance: 5500 });
    dbClient.getBundlePurchasesToday.mockResolvedValue(0);
  });

  describe('getGemPackages', () => {
    it('should return available gem packages', async () => {
      const result = await getGemPackages();
      expect(result.success).toBe(true);
      expect(result.data.packages.length).toBeGreaterThan(0);
      expect(result.data.conversionRate).toBeDefined();
    });
  });

  describe('fulfillGemPurchase', () => {
    it('should fulfill a gem purchase', async () => {
      const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
      expect(result.success).toBe(true);
      expect(result.data.gemsAdded).toBe(500);
      expect(result.data.newGemsBalance).toBe(5500);
    });

    it('should require userId', async () => {
      const result = await fulfillGemPurchase({}, { packageId: 'pkg_starter' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_USER');
    });

    it('should reject invalid packageId', async () => {
      const result = await fulfillGemPurchase(testUser, { packageId: 'bad_pkg' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_PACKAGE');
    });

    it('should return USER_NOT_FOUND', async () => {
      dbClient.getUser.mockResolvedValue(null);
      const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('should return GEM_ADD_FAILED when addGems fails', async () => {
      dbClient.addGems.mockResolvedValue({ success: false });
      const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('GEM_ADD_FAILED');
    });

    it('should handle fulfillment error', async () => {
      dbClient.addGems.mockRejectedValue(new Error('boom'));
      const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('FULFILLMENT_FAILED');
    });

    it('should mark isDev in response for dev mode', async () => {
      const result = await fulfillGemPurchase(testUser, { packageId: 'pkg_starter', isDev: true });
      expect(result.data.isDev).toBe(true);
    });
  });

  describe('createCheckoutSession', () => {
    it('should use dev mode when Stripe not configured', async () => {
      const result = await createCheckoutSession(testUser, { packageId: 'pkg_starter' });
      // With no Stripe configured, it falls through to dev mode fulfillment
      expect(result.success).toBe(true);
      expect(result.data.isDev).toBe(true);
    });

    it('should reject invalid package', async () => {
      const result = await createCheckoutSession(testUser, { packageId: 'bad_pkg' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_PACKAGE');
    });
  });
});

// =============================================================================
// PURCHASE BUNDLE TESTS
// =============================================================================

describe('Purchase Bundle', () => {
  const { purchaseBundle, getSpecialOfferBundles, getBundleByBundleId } =
    require('../src/functions/shop/purchase-bundle');

  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.getUser
      .mockResolvedValueOnce(makeUserRecord())  // initial check
      .mockResolvedValueOnce(makeUserRecord({ currencies: { gems: 4500, essence: 10500 } })); // post-transaction read
    dbClient.transactWrite.mockResolvedValue({});
    dbClient.getBundlePurchasesToday.mockResolvedValue(0);
    dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_existing' }]);
  });

  describe('getSpecialOfferBundles', () => {
    it('should return enabled bundles', async () => {
      const result = await getSpecialOfferBundles();
      expect(result.success).toBe(true);
      expect(result.data.bundles.length).toBeGreaterThan(0);
    });

    it('should include bundle details', async () => {
      const result = await getSpecialOfferBundles();
      const bundle = result.data.bundles[0];
      expect(bundle).toHaveProperty('bundleId');
      expect(bundle).toHaveProperty('name');
      expect(bundle).toHaveProperty('gemCost');
      expect(bundle).toHaveProperty('essence');
      expect(bundle).toHaveProperty('totemRarity');
    });
  });

  describe('getBundleByBundleId', () => {
    it('should find bundle 0', () => {
      const bundle = getBundleByBundleId(0);
      expect(bundle).toBeDefined();
      expect(bundle.name).toBe('New Player Bundle');
    });

    it('should return null for invalid bundleId', () => {
      expect(getBundleByBundleId(99)).toBeNull();
    });
  });

  describe('purchaseBundle', () => {
    it('should purchase bundle 0 successfully', async () => {
      const result = await purchaseBundle(testUser, { bundleId: 0 });
      expect(result.success).toBe(true);
      expect(result.data.bundle.name).toBe('New Player Bundle');
      expect(result.data.totem).toBeDefined();
      expect(result.data.totem.id).toBe('ttm_generated123');
      expect(result.data.gemsSpent).toBe(500);
      expect(result.data.essenceReceived).toBe(500);
    });

    it('should require userId', async () => {
      const result = await purchaseBundle({}, { bundleId: 0 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_USER');
    });

    it('should require bundleId', async () => {
      const result = await purchaseBundle(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_BUNDLE_ID');
    });

    it('should reject non-number bundleId', async () => {
      const result = await purchaseBundle(testUser, { bundleId: 'abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_BUNDLE_ID');
    });

    it('should reject bundleId out of range', async () => {
      const result = await purchaseBundle(testUser, { bundleId: 5 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_BUNDLE_ID');
    });

    it('should reject negative bundleId', async () => {
      const result = await purchaseBundle(testUser, { bundleId: -1 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_BUNDLE_ID');
    });

    it('should return USER_NOT_FOUND', async () => {
      dbClient.getUser.mockReset().mockResolvedValue(null);
      const result = await purchaseBundle(testUser, { bundleId: 0 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('should return INSUFFICIENT_GEMS', async () => {
      dbClient.getUser.mockReset().mockResolvedValue(
        makeUserRecord({ currencies: { gems: 10, essence: 0 } })
      );
      const result = await purchaseBundle(testUser, { bundleId: 0 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_GEMS');
    });

    it('should enforce daily limit', async () => {
      dbClient.getBundlePurchasesToday.mockResolvedValue(1);
      const result = await purchaseBundle(testUser, { bundleId: 0 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('DAILY_LIMIT_REACHED');
    });

    it('should handle TransactionCanceledException', async () => {
      const txErr = new Error('Transaction cancelled');
      txErr.name = 'TransactionCanceledException';
      dbClient.transactWrite.mockRejectedValue(txErr);
      dbClient.getUser.mockReset()
        .mockResolvedValueOnce(makeUserRecord())
        .mockResolvedValueOnce(makeUserRecord({ currencies: { gems: 100, essence: 0 } }));
      const result = await purchaseBundle(testUser, { bundleId: 0 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_GEMS');
    });

    it('should handle generic transaction error', async () => {
      dbClient.transactWrite.mockRejectedValue(new Error('DynamoDB error'));
      const result = await purchaseBundle(testUser, { bundleId: 0 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('PURCHASE_FAILED');
    });

    it('should call transactWrite with user update and totem put', async () => {
      await purchaseBundle(testUser, { bundleId: 0 });
      expect(dbClient.transactWrite).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ Update: expect.any(Object) }),
          expect.objectContaining({ Put: expect.any(Object) }),
        ])
      );
    });
  });
});
