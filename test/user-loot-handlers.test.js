/**
 * User Profile & Loot Handler Tests
 *
 * Tests for get-profile, update-profile, and loot handlers.
 */

// Mock db-client
jest.mock('../src/common/db-client', () => ({
  getUser: jest.fn(),
  getUserTotems: jest.fn(),
  updateUser: jest.fn(),
}));

// Mock loot-service
jest.mock('../src/services/loot-service', () => ({
  getUnclaimedLoot: jest.fn(),
  claimLootItem: jest.fn(),
}));

const dbClient = require('../src/common/db-client');
const lootService = require('../src/services/loot-service');

const { getProfile } = require('../src/functions/user/get-profile');
const { updateProfile } = require('../src/functions/user/update-profile');
const { getLootItems, claimLoot } = require('../src/functions/loot/index');

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123' };

const makeUserRecord = (overrides = {}) => ({
  id: 'usr_test123',
  email: 'test@example.com',
  displayName: 'Tester',
  tier: 'free',
  currencies: { essence: 2000, gems: 500 },
  stats: {
    totalTotems: 3,
    totalChallengesCompleted: 5,
    loginStreak: 7,
    lastLoginDate: '2024-01-15',
    bestLoginStreak: 10,
  },
  settings: {
    notifications: true,
    darkMode: 'dark',
    soundEffects: true,
    language: 'en',
  },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-15T00:00:00.000Z',
  ...overrides,
});

// =============================================================================
// GET PROFILE TESTS
// =============================================================================

describe('User Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.getUser.mockResolvedValue(makeUserRecord());
    dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_1' }, { id: 'ttm_2' }]);
  });

  describe('getProfile', () => {
    it('should return full user profile', async () => {
      const result = await getProfile(testUser);
      expect(result.success).toBe(true);
      expect(result.data.id).toBe('usr_test123');
      expect(result.data.email).toBe('test@example.com');
      expect(result.data.displayName).toBe('Tester');
      expect(result.data.tier).toBe('free');
    });

    it('should include currencies', async () => {
      const result = await getProfile(testUser);
      expect(result.data.currencies.essence).toBe(2000);
      expect(result.data.currencies.gems).toBe(500);
    });

    it('should include stats with live totem count', async () => {
      const result = await getProfile(testUser);
      // Live count from getUserTotems (2), not stored stat (3)
      expect(result.data.stats.totalTotems).toBe(2);
      expect(result.data.stats.totalChallengesCompleted).toBe(5);
      expect(result.data.stats.loginStreak).toBe(7);
      expect(result.data.stats.bestLoginStreak).toBe(10);
    });

    it('should include settings', async () => {
      const result = await getProfile(testUser);
      expect(result.data.settings.notifications).toBe(true);
      expect(result.data.settings.darkMode).toBe('dark');
      expect(result.data.settings.language).toBe('en');
    });

    it('should return NOT_FOUND when user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);
      const result = await getProfile(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should fallback to stored totem count if getUserTotems fails', async () => {
      dbClient.getUserTotems.mockRejectedValue(new Error('fail'));
      const result = await getProfile(testUser);
      expect(result.success).toBe(true);
      expect(result.data.stats.totalTotems).toBe(3); // falls back to stored stat
    });

    it('should default missing currencies to 0', async () => {
      dbClient.getUser.mockResolvedValue(makeUserRecord({ currencies: {} }));
      const result = await getProfile(testUser);
      expect(result.data.currencies.essence).toBe(0);
      expect(result.data.currencies.gems).toBe(0);
    });

    it('should throw on database error', async () => {
      dbClient.getUser.mockRejectedValue(new Error('DB error'));
      await expect(getProfile(testUser)).rejects.toThrow('DB error');
    });
  });

  // ===========================================================================
  // UPDATE PROFILE TESTS
  // ===========================================================================

  describe('updateProfile', () => {
    beforeEach(() => {
      dbClient.updateUser.mockResolvedValue(makeUserRecord({ displayName: 'NewName' }));
    });

    it('should update displayName', async () => {
      const result = await updateProfile(testUser, { displayName: 'NewName' });
      expect(result.success).toBe(true);
      expect(dbClient.updateUser).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({ displayName: 'NewName' })
      );
    });

    it('should update settings', async () => {
      dbClient.updateUser.mockResolvedValue(makeUserRecord({
        settings: { darkMode: 'light', notifications: true, soundEffects: true, language: 'en' },
      }));
      const result = await updateProfile(testUser, {
        settings: { darkMode: 'light' },
      });
      expect(result.success).toBe(true);
      expect(dbClient.updateUser).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({ 'settings.darkMode': 'light' })
      );
    });

    it('should reject short displayName', async () => {
      const result = await updateProfile(testUser, { displayName: 'A' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject long displayName', async () => {
      const result = await updateProfile(testUser, { displayName: 'A'.repeat(31) });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject displayName with special chars', async () => {
      const result = await updateProfile(testUser, { displayName: '<script>xss</script>' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid darkMode value', async () => {
      const result = await updateProfile(testUser, {
        settings: { darkMode: 'purple' },
      });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid language', async () => {
      const result = await updateProfile(testUser, {
        settings: { language: 'klingon' },
      });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return NO_CHANGES when no valid fields', async () => {
      const result = await updateProfile(testUser, { email: 'new@test.com' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_CHANGES');
    });

    it('should return NOT_FOUND when user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);
      const result = await updateProfile(testUser, { displayName: 'NewName' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should throw on database error', async () => {
      dbClient.updateUser.mockRejectedValue(new Error('DB error'));
      await expect(updateProfile(testUser, { displayName: 'Test' })).rejects.toThrow('DB error');
    });

    it('should accept valid language codes', async () => {
      for (const lang of ['en', 'es', 'fr', 'de', 'ja', 'zh']) {
        dbClient.getUser.mockResolvedValue(makeUserRecord());
        dbClient.updateUser.mockResolvedValue(makeUserRecord({ settings: { language: lang } }));
        const result = await updateProfile(testUser, { settings: { language: lang } });
        expect(result.success).toBe(true);
      }
    });
  });
});

// =============================================================================
// LOOT HANDLER TESTS
// =============================================================================

describe('Loot Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getLootItems', () => {
    it('should return unclaimed loot items', async () => {
      lootService.getUnclaimedLoot.mockResolvedValue([
        { id: 'loot_1', type: 'essence', amount: 100 },
        { id: 'loot_2', type: 'totem', speciesId: 2 },
      ]);
      const result = await getLootItems(testUser);
      expect(result.success).toBe(true);
      expect(result.data.items).toHaveLength(2);
      expect(result.data.count).toBe(2);
    });

    it('should return empty when no loot', async () => {
      lootService.getUnclaimedLoot.mockResolvedValue([]);
      const result = await getLootItems(testUser);
      expect(result.success).toBe(true);
      expect(result.data.items).toHaveLength(0);
      expect(result.data.count).toBe(0);
    });
  });

  describe('claimLoot', () => {
    it('should claim a loot item successfully', async () => {
      lootService.claimLootItem.mockResolvedValue({
        type: 'essence',
        amount: 100,
        newBalance: 2100,
      });
      const result = await claimLoot(testUser, { lootItemId: 'loot_1' });
      expect(result.success).toBe(true);
      expect(result.data.amount).toBe(100);
    });

    it('should require lootItemId', async () => {
      const result = await claimLoot(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should handle claim failure', async () => {
      lootService.claimLootItem.mockRejectedValue(new Error('Loot already claimed'));
      const result = await claimLoot(testUser, { lootItemId: 'loot_1' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('CLAIM_FAILED');
      expect(result.error.message).toBe('Loot already claimed');
    });

    it('should pass options to service', async () => {
      lootService.claimLootItem.mockResolvedValue({ type: 'totem' });
      await claimLoot(testUser, { lootItemId: 'loot_2', options: { speciesId: 3 } });
      expect(lootService.claimLootItem).toHaveBeenCalledWith(
        testUser.userId,
        'loot_2',
        { speciesId: 3 }
      );
    });
  });
});
