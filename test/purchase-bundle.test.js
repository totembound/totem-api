/**
 * Purchase Bundle Tests
 *
 * Covers:
 * - getCurrentMonthlySpecial UTC month resolution
 * - Monthly special returns correct species/color per month
 * - Daily limit enforcement (pre-check + atomic condition)
 * - purchaseBundle end-to-end for monthly special (bundleId 3)
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../src/common/db-client', () => ({
  getUser: jest.fn(),
  logTransaction: jest.fn().mockResolvedValue({}),
  transactWrite: jest.fn().mockResolvedValue({}),
  getBundlePurchasesToday: jest.fn().mockResolvedValue(0),
  getUserTotems: jest.fn().mockResolvedValue([]),
  TABLES: {
    USERS: 'TotemBound-Users',
    TOTEMS: 'TotemBound-Totems',
    TRANSACTIONS: 'TotemBound-Transactions',
  },
  KEY_PREFIX: { USER: 'USER#', TOTEM: 'TOTEM#' },
}));

jest.mock('../src/common/id-utils', () => ({
  generateId: jest.fn().mockReturnValue('ttm_test123'),
}));

jest.mock('../src/services/totem-creation', () => {
  const baseStats = { strength: 10, agility: 12, wisdom: 8 };
  const SPECIES = Array.from({ length: 12 }, (_, i) => ({
    id: i,
    name: `Species${i}`,
    baseStats,
  }));
  return {
    selectRandomSpecies: jest.fn().mockReturnValue({ speciesId: 0, speciesName: 'Goose', baseStats }),
    selectColor: jest.fn().mockReturnValue({ colorId: 4 }),
    calculateInitialStats: jest.fn((stats, bonus = 0) => ({
      strength: stats.strength + bonus,
      agility: stats.agility + bonus,
      wisdom: stats.wisdom + bonus,
      happiness: 50,
      hunger: 100,
    })),
    SPECIES,
  };
});

jest.mock('../src/services/achievements-service', () => ({
  onTotemAcquired: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/config/totem-config', () => ({
  getTotemImageUrl: jest.fn().mockReturnValue('https://example.com/totem.png'),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const dbClient = require('../src/common/db-client');
const {
  purchaseBundle,
  getCurrentMonthlySpecial,
} = require('../src/functions/shop/purchase-bundle');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = { userId: 'usr_test123' };

const makeUserRecord = (gems = 10000) => ({
  id: 'usr_test123',
  displayName: 'Tester',
  currencies: { gems, essence: 5000 },
});

/**
 * Mock Date to return a specific UTC timestamp.
 * Returns a cleanup function to restore the original Date.
 */
function mockUTCDate(isoString) {
  const RealDate = global.Date;
  const fakeNow = new RealDate(isoString).getTime();

  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fakeNow);
      } else {
        super(...args);
      }
    }
    static now() { return fakeNow; }
    static UTC(...args) { return RealDate.UTC(...args); }
  };

  return () => { global.Date = RealDate; };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Purchase Bundle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // getCurrentMonthlySpecial — UTC month resolution
  // =========================================================================
  describe('getCurrentMonthlySpecial', () => {
    it('should return March Wolf when UTC time is March 1 00:01', () => {
      const restore = mockUTCDate('2026-03-01T00:01:00.000Z');
      try {
        const special = getCurrentMonthlySpecial();
        expect(special).not.toBeNull();
        expect(special.month).toBe('March');
        expect(special.name).toBe('Cloverfang Wolf');
        expect(special.species).toBe(2);
        expect(special.color).toBe(18);
      } finally {
        restore();
      }
    });

    it('should return February Otter when UTC time is Feb 28 23:59', () => {
      const restore = mockUTCDate('2026-02-28T23:59:00.000Z');
      try {
        const special = getCurrentMonthlySpecial();
        expect(special).not.toBeNull();
        expect(special.month).toBe('February');
        expect(special.name).toBe('Lovewave Otter');
        expect(special.species).toBe(1);
        expect(special.color).toBe(17);
      } finally {
        restore();
      }
    });

    it('should use UTC not local time — PT 6pm Feb 28 is UTC Mar 1', () => {
      // 2026-03-01T02:00:00Z = 2026-02-28T18:00:00 PT
      // In UTC this is March, in PT this is still February
      const restore = mockUTCDate('2026-03-01T02:00:00.000Z');
      try {
        const special = getCurrentMonthlySpecial();
        expect(special).not.toBeNull();
        expect(special.month).toBe('March');
        // Must NOT be February even though PT would say Feb 28
      } finally {
        restore();
      }
    });

    it('should return January Goose for January', () => {
      const restore = mockUTCDate('2026-01-15T12:00:00.000Z');
      try {
        const special = getCurrentMonthlySpecial();
        expect(special).not.toBeNull();
        expect(special.month).toBe('January');
        expect(special.species).toBe(0); // Goose
      } finally {
        restore();
      }
    });

    it('should return December Owl for December', () => {
      const restore = mockUTCDate('2026-12-25T12:00:00.000Z');
      try {
        const special = getCurrentMonthlySpecial();
        expect(special).not.toBeNull();
        expect(special.month).toBe('December');
        expect(special.species).toBe(11); // Owl
      } finally {
        restore();
      }
    });

    it('should return null for months with no series defined', () => {
      // October is not yet configured
      const restore = mockUTCDate('2026-10-15T12:00:00.000Z');
      try {
        const special = getCurrentMonthlySpecial();
        expect(special).toBeNull();
      } finally {
        restore();
      }
    });
  });

  // =========================================================================
  // Daily limit pre-check
  // =========================================================================
  describe('daily limit enforcement', () => {
    it('should reject when daily limit already reached (pre-check)', async () => {
      dbClient.getBundlePurchasesToday.mockResolvedValue(1);
      dbClient.getUser.mockResolvedValue(makeUserRecord(10000));

      const result = await purchaseBundle(testUser, { bundleId: 3 });

      expect(result.success).toBe(false);
      expect(result.error.code).toBe('DAILY_LIMIT_REACHED');
      expect(dbClient.transactWrite).not.toHaveBeenCalled();
    });

    it('should include daily limit attribute in transactWrite condition', async () => {
      const restore = mockUTCDate('2026-03-15T12:00:00.000Z');
      try {
        dbClient.getBundlePurchasesToday.mockResolvedValue(0);
        dbClient.getUser
          .mockResolvedValueOnce(makeUserRecord(10000))  // initial check
          .mockResolvedValueOnce(makeUserRecord(5000));   // post-purchase read
        dbClient.transactWrite.mockResolvedValue({});

        await purchaseBundle(testUser, { bundleId: 3 });

        // Verify transactWrite was called
        expect(dbClient.transactWrite).toHaveBeenCalledTimes(1);
        const transactItems = dbClient.transactWrite.mock.calls[0][0];
        const userUpdate = transactItems[0].Update;

        // Should have daily limit condition
        expect(userUpdate.ConditionExpression).toContain('attribute_not_exists(#lpd)');
        expect(userUpdate.ConditionExpression).toContain('#lpd <> :todayUTC');
        expect(userUpdate.UpdateExpression).toContain('#lpd = :todayUTC');
        expect(userUpdate.ExpressionAttributeNames['#lpd']).toBe('lpd_bundle_monthly');
        expect(userUpdate.ExpressionAttributeValues[':todayUTC']).toBe('2026-03-15');
      } finally {
        restore();
      }
    });

    it('should return DAILY_LIMIT_REACHED when transactWrite fails and gems sufficient', async () => {
      const restore = mockUTCDate('2026-03-15T12:00:00.000Z');
      try {
        dbClient.getBundlePurchasesToday.mockResolvedValue(0);
        dbClient.getUser
          .mockResolvedValueOnce(makeUserRecord(10000))  // initial check
          .mockResolvedValueOnce(makeUserRecord(10000));  // post-failure re-read (gems still sufficient)

        const txnError = new Error('Transaction cancelled');
        Object.defineProperty(txnError, 'name', { value: 'TransactionCanceledException' });
        dbClient.transactWrite.mockRejectedValueOnce(txnError);

        const result = await purchaseBundle(testUser, { bundleId: 3 });

        expect(result.success).toBe(false);
        expect(result.error.code).toBe('DAILY_LIMIT_REACHED');
      } finally {
        restore();
      }
    });
  });

  // =========================================================================
  // Monthly special purchase end-to-end
  // =========================================================================
  describe('purchaseBundle monthly special (bundleId 3)', () => {
    it('should mint the correct species/color for the current UTC month', async () => {
      const restore = mockUTCDate('2026-03-10T15:00:00.000Z');
      try {
        dbClient.getBundlePurchasesToday.mockResolvedValue(0);
        dbClient.getUser
          .mockResolvedValueOnce(makeUserRecord(10000))
          .mockResolvedValueOnce(makeUserRecord(5000));
        dbClient.transactWrite.mockResolvedValue({});

        const result = await purchaseBundle(testUser, { bundleId: 3 });

        expect(result.success).toBe(true);
        expect(result.data.totem.speciesId).toBe(2);  // Wolf
        expect(result.data.totem.colorId).toBe(18);   // Verdant
        expect(result.data.totem.rarityId).toBe(5);   // Limited
        expect(result.data.totem.rarityName).toBe('Limited');

        // Verify totem was created with correct data
        const transactItems = dbClient.transactWrite.mock.calls[0][0];
        const totemPut = transactItems[1].Put.Item;
        expect(totemPut.speciesId).toBe(2);
        expect(totemPut.colorId).toBe(18);
        expect(totemPut.rarityId).toBe(5);
      } finally {
        restore();
      }
    });

    it('should return MONTHLY_SPECIAL_NOT_AVAILABLE for unconfigured month', async () => {
      const restore = mockUTCDate('2026-10-10T15:00:00.000Z');
      try {
        dbClient.getBundlePurchasesToday.mockResolvedValue(0);
        dbClient.getUser.mockResolvedValue(makeUserRecord(10000));

        const result = await purchaseBundle(testUser, { bundleId: 3 });

        expect(result.success).toBe(false);
        expect(result.error.code).toBe('MONTHLY_SPECIAL_NOT_AVAILABLE');
        expect(dbClient.transactWrite).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('should deduct 5000 gems and add 2000 essence', async () => {
      const restore = mockUTCDate('2026-03-10T15:00:00.000Z');
      try {
        dbClient.getBundlePurchasesToday.mockResolvedValue(0);
        dbClient.getUser
          .mockResolvedValueOnce(makeUserRecord(10000))
          .mockResolvedValueOnce(makeUserRecord(5000));
        dbClient.transactWrite.mockResolvedValue({});

        const result = await purchaseBundle(testUser, { bundleId: 3 });

        expect(result.success).toBe(true);
        expect(result.data.gemsSpent).toBe(5000);
        expect(result.data.essenceReceived).toBe(2000);

        const userUpdate = dbClient.transactWrite.mock.calls[0][0][0].Update;
        expect(userUpdate.ExpressionAttributeValues[':gemCost']).toBe(5000);
        expect(userUpdate.ExpressionAttributeValues[':essenceAmount']).toBe(2000);
      } finally {
        restore();
      }
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('should reject insufficient gems', async () => {
      const restore = mockUTCDate('2026-03-10T15:00:00.000Z');
      try {
        dbClient.getBundlePurchasesToday.mockResolvedValue(0);
        dbClient.getUser.mockResolvedValue(makeUserRecord(100)); // only 100 gems

        const result = await purchaseBundle(testUser, { bundleId: 3 });

        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INSUFFICIENT_GEMS');
      } finally {
        restore();
      }
    });

    it('should reject missing bundleId', async () => {
      const result = await purchaseBundle(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_BUNDLE_ID');
    });

    it('should reject invalid bundleId', async () => {
      const result = await purchaseBundle(testUser, { bundleId: 5 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_BUNDLE_ID');
    });
  });
});
