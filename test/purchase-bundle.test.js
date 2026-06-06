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
  RARITIES: [
    { id: 0, name: 'Common', statBonus: 0, dropChance: 75 },
    { id: 1, name: 'Uncommon', statBonus: 1, dropChance: 15 },
    { id: 2, name: 'Rare', statBonus: 2, dropChance: 7 },
    { id: 3, name: 'Epic', statBonus: 3, dropChance: 2.5 },
    { id: 4, name: 'Legendary', statBonus: 6, dropChance: 0.5 },
    { id: 5, name: 'Limited', statBonus: 4, dropChance: 0 },
  ],
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const dbClient = require('../src/common/db-client');
const {
  purchaseBundle,
  getCurrentMonthlySpecial,
} = require('../src/functions/shop/purchase-bundle');

// Same cached array reference that purchase-bundle's LIMITED_TOTEM_SERIES points at.
const shopConfig = require('../src/data/shop-config.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every month now has a configured series, so to exercise the "unconfigured month"
 * path we temporarily remove a month's series for the duration of fn (restored after).
 */
async function withoutSeriesForMonth(month, fn) {
  const series = shopConfig.limitedTotemSeries.series;
  const idx = series.findIndex((s) => s.month === month);
  const [removed] = idx >= 0 ? series.splice(idx, 1) : [null];
  try {
    return await fn();
  } finally {
    if (removed) series.splice(idx, 0, removed);
  }
}

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

    it('should resolve the October limited (Phantom Raven)', () => {
      const restore = mockUTCDate('2026-10-15T12:00:00.000Z');
      try {
        const special = getCurrentMonthlySpecial();
        expect(special).not.toBeNull();
        expect(special.month).toBe('October');
        expect(special.species).toBe(9); // Raven
        expect(special.color).toBe(25); // Phantom Black
      } finally {
        restore();
      }
    });

    it('should return null for months with no series defined', () => {
      // Simulate an unconfigured month by removing November's series for this test.
      return withoutSeriesForMonth('November', () => {
        const restore = mockUTCDate('2026-11-15T12:00:00.000Z');
        try {
          const special = getCurrentMonthlySpecial();
          expect(special).toBeNull();
        } finally {
          restore();
        }
      });
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
        // Innate trait is surfaced so the bundle celebration can show the born-trait badge.
        expect(result.data.totem.traits).toBeDefined();
        expect(result.data.totem.traits.innate).toMatch(/^trt_/);
        expect(result.data.totem.traits.learned).toBeNull();
        expect(result.data.totem.traits.awakened).toBeNull();

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
      // Simulate an unconfigured month by removing November's series for this test.
      await withoutSeriesForMonth('November', async () => {
        const restore = mockUTCDate('2026-11-10T15:00:00.000Z');
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
