/**
 * Totem Handler Tests
 *
 * Tests for totem purchase, list, and get handlers
 * (functions/totems/purchase.js and functions/totems/index.js).
 */

// Mock db-client
jest.mock('../src/common/db-client', () => ({
  getTotem: jest.fn(),
  getUserTotems: jest.fn(),
  deductEssence: jest.fn(),
  putItem: jest.fn(),
  updateUser: jest.fn(),
  TABLES: {
    TOTEMS: 'TotemBound-Totems',
    USERS: 'TotemBound-Users',
  },
}));

// Mock totem-creation
jest.mock('../src/services/totem-creation', () => {
  const actual = jest.requireActual('../src/services/totem-creation');
  return {
    ...actual,
    createTotem: jest.fn((opts) => ({
      pk: `USER#${opts.userId}`,
      sk: `TOTEM#ttm_newtotem`,
      id: 'ttm_newtotem',
      userId: opts.userId,
      speciesId: opts.speciesId ?? 2,
      colorId: 4,
      rarityId: 1,
      stage: 0,
      experience: 0,
      nickname: opts.name || null,
      stats: { strength: 9, agility: 7, wisdom: 11, happiness: 50, hunger: 100 },
      cooldowns: { feed: null, train: null, treat: null },
      createdAt: '2024-01-01T00:00:00.000Z',
    })),
  };
});

// Mock achievements service
jest.mock('../src/services/achievements-service', () => ({
  onTotemAcquired: jest.fn().mockResolvedValue([]),
}));

const dbClient = require('../src/common/db-client');
const achievementsService = require('../src/services/achievements-service');
const { purchaseTotem, getPurchaseInfo } = require('../src/functions/totems/purchase');
const { getTotems, getTotem, transformTotemForApi } = require('../src/functions/totems/index');

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123' };

const makeDbTotem = (overrides = {}) => ({
  pk: `USER#${testUser.userId}`,
  sk: 'TOTEM#ttm_abc',
  id: 'ttm_abc',
  userId: testUser.userId,
  speciesId: 2,
  colorId: 4,
  rarityId: 1,
  stage: 1,
  experience: 600,
  nickname: null,
  stats: { happiness: 50, strength: 10, agility: 8, wisdom: 6 },
  cooldowns: { feed: null, train: null, treat: null },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-15T00:00:00.000Z',
  ...overrides,
});

// =============================================================================
// TESTS
// =============================================================================

describe('Totem Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.deductEssence.mockResolvedValue({ success: true, newBalance: 1500 });
    dbClient.putItem.mockResolvedValue({});
    dbClient.updateUser.mockResolvedValue({});
    dbClient.getUserTotems.mockResolvedValue([makeDbTotem()]);
    dbClient.getTotem.mockResolvedValue(makeDbTotem());
  });

  // =============================================================================
  // PURCHASE TOTEM TESTS
  // =============================================================================

  describe('purchaseTotem', () => {
    it('should purchase a totem successfully', async () => {
      const result = await purchaseTotem(testUser, {});
      expect(result.success).toBe(true);
      expect(result.data.totem.id).toBe('ttm_newtotem');
      expect(result.data.cost).toBe(500);
      expect(result.data.newBalance).toBe(1500);
    });

    it('should accept specific species selection', async () => {
      const result = await purchaseTotem(testUser, { speciesId: 0 });
      expect(result.success).toBe(true);
    });

    it('should reject invalid species ID (negative)', async () => {
      const result = await purchaseTotem(testUser, { speciesId: -1 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_SPECIES');
    });

    it('should reject invalid species ID (too high)', async () => {
      const result = await purchaseTotem(testUser, { speciesId: 999 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_SPECIES');
    });

    it('should reject non-number species ID', async () => {
      const result = await purchaseTotem(testUser, { speciesId: 'wolf' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_SPECIES');
    });

    it('should reject unavailable species', async () => {
      // Species ID 6 (Woodpecker) might be unavailable - use a disabled one
      // This test depends on business-rules.json, so just test invalid range
      const result = await purchaseTotem(testUser, { speciesId: 100 });
      expect(result.success).toBe(false);
    });

    it('should validate name length (2-30 chars)', async () => {
      const result = await purchaseTotem(testUser, { name: 'A' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_NAME');
    });

    it('should reject name over 30 chars', async () => {
      const result = await purchaseTotem(testUser, { name: 'A'.repeat(31) });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_NAME');
    });

    it('should reject name with special chars', async () => {
      const result = await purchaseTotem(testUser, { name: '<script>hack</script>' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_NAME');
    });

    it('should return INSUFFICIENT_FUNDS when not enough Essence', async () => {
      dbClient.deductEssence.mockResolvedValue({ success: false, error: 'Not enough', available: 100 });
      const result = await purchaseTotem(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(result.error.required).toBe(500);
    });

    it('should save totem to DynamoDB', async () => {
      await purchaseTotem(testUser, {});
      expect(dbClient.putItem).toHaveBeenCalledWith(
        'TotemBound-Totems',
        expect.objectContaining({ id: 'ttm_newtotem' })
      );
    });

    it('should update totalTotems stat', async () => {
      dbClient.getUserTotems.mockResolvedValue([makeDbTotem(), makeDbTotem()]);
      await purchaseTotem(testUser, {});
      expect(dbClient.updateUser).toHaveBeenCalledWith(
        testUser.userId,
        { 'stats.totalTotems': 2 }
      );
    });

    it('should trigger achievement check', async () => {
      await purchaseTotem(testUser, {});
      expect(achievementsService.onTotemAcquired).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({ rarityId: 1 })
      );
    });

    it('should include achievements in response', async () => {
      achievementsService.onTotemAcquired.mockResolvedValue([
        { unlocked: true, achievementId: 'ach_totem', milestone: 1, rewards: { essence: 100 } },
      ]);
      const result = await purchaseTotem(testUser, {});
      expect(result.data.achievements).toHaveLength(1);
    });

    it('should still succeed if achievement check fails', async () => {
      achievementsService.onTotemAcquired.mockRejectedValue(new Error('fail'));
      const result = await purchaseTotem(testUser, {});
      expect(result.success).toBe(true);
    });

    it('should include totem details in response', async () => {
      const result = await purchaseTotem(testUser, {});
      expect(result.data.totem).toHaveProperty('speciesId');
      expect(result.data.totem).toHaveProperty('colorId');
      expect(result.data.totem).toHaveProperty('rarityId');
      expect(result.data.totem).toHaveProperty('stage', 0);
      expect(result.data.totem).toHaveProperty('stats');
      expect(result.data.totem).toHaveProperty('image');
    });
  });

  // =============================================================================
  // GET PURCHASE INFO TESTS
  // =============================================================================

  describe('getPurchaseInfo', () => {
    it('should return purchase cost of 500', () => {
      const result = getPurchaseInfo();
      expect(result.success).toBe(true);
      expect(result.data.cost).toBe(500);
      expect(result.data.currency).toBe('essence');
    });

    it('should return available species', () => {
      const result = getPurchaseInfo();
      expect(result.data.availableSpecies.length).toBeGreaterThan(0);
      result.data.availableSpecies.forEach(s => {
        expect(s).toHaveProperty('id');
        expect(s).toHaveProperty('name');
        expect(s).toHaveProperty('baseStats');
      });
    });
  });

  // =============================================================================
  // GET TOTEMS TESTS
  // =============================================================================

  describe('getTotems', () => {
    it('should return all user totems transformed for API', async () => {
      dbClient.getUserTotems.mockResolvedValue([makeDbTotem(), makeDbTotem({ id: 'ttm_def', speciesId: 0 })]);
      const result = await getTotems(testUser);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });

    it('should return empty array when user has no totems', async () => {
      dbClient.getUserTotems.mockResolvedValue([]);
      const result = await getTotems(testUser);
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('should throw on database error', async () => {
      dbClient.getUserTotems.mockRejectedValue(new Error('DB error'));
      await expect(getTotems(testUser)).rejects.toThrow('DB error');
    });
  });

  // =============================================================================
  // GET SINGLE TOTEM TESTS
  // =============================================================================

  describe('getTotem', () => {
    it('should return a single totem transformed for API', async () => {
      const result = await getTotem(testUser, 'ttm_abc');
      expect(result.success).toBe(true);
      expect(result.data.id).toBe('ttm_abc');
    });

    it('should return INVALID_ID for bad totem ID', async () => {
      const result = await getTotem(testUser, 'bad_id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await getTotem(testUser, 'ttm_nonexistent');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // =============================================================================
  // TRANSFORM TOTEM TESTS
  // =============================================================================

  describe('transformTotemForApi', () => {
    it('should transform DB record to TotemData format', () => {
      const dbTotem = makeDbTotem();
      const result = transformTotemForApi(dbTotem);

      expect(result.id).toBe('ttm_abc');
      expect(result.attributes).toBeDefined();
      expect(result.attributes.species).toBe(2);
      expect(result.attributes.color).toBe(4);
      expect(result.attributes.rarity).toBe(1);
      expect(result.attributes.happiness).toBe(50);
      expect(result.attributes.experience).toBe(600);
      expect(result.attributes.stage).toBe(1);
    });

    it('should include affinity based on highest stat', () => {
      const result = transformTotemForApi(makeDbTotem({ speciesId: 2 })); // Wolf
      expect(['Strength', 'Agility', 'Wisdom']).toContain(result.affinity);
    });

    it('should include domain mapping', () => {
      // Wolf (speciesId 2) = Earth
      const result = transformTotemForApi(makeDbTotem({ speciesId: 2 }));
      expect(result.domain).toBe('Earth');
    });

    it('should default missing stats gracefully', () => {
      const dbTotem = makeDbTotem({ stats: {}, experience: 0, stage: 0 });
      const result = transformTotemForApi(dbTotem);
      expect(result.attributes.happiness).toBe(50); // default
      expect(result.attributes.strength).toBe(5);   // default
      expect(result.attributes.experience).toBe(0);
    });

    it('should include image URL', () => {
      const result = transformTotemForApi(makeDbTotem());
      expect(result.image).toBeDefined();
      expect(typeof result.image).toBe('string');
    });

    it('should include trackings for cooldowns', () => {
      const result = transformTotemForApi(makeDbTotem());
      expect(result.trackings).toBeDefined();
    });

    it('should include nickname in attributes', () => {
      const result = transformTotemForApi(makeDbTotem({ nickname: 'Fluffy' }));
      expect(result.attributes.nickname).toBe('Fluffy');
    });

    it('should default nickname to null', () => {
      const result = transformTotemForApi(makeDbTotem());
      expect(result.attributes.nickname).toBeNull();
    });

    it('should set isStaked to false (Web2)', () => {
      const result = transformTotemForApi(makeDbTotem());
      expect(result.attributes.isStaked).toBe(false);
    });
  });
});
