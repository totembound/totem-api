/**
 * Expedition Handler Tests
 *
 * Tests for expedition start, claim, active, list, history, status, and index handlers.
 */

// Mock expeditions-service
jest.mock('../src/services/expeditions-service', () => ({
  startExpedition: jest.fn(),
  claimExpeditionReward: jest.fn(),
  getActiveExpeditions: jest.fn(),
  getExpeditionDefinition: jest.fn(),
  getAllExpeditions: jest.fn(),
  checkExpeditionStatus: jest.fn(),
  getExpeditionHistory: jest.fn(),
}));

const expService = require('../src/services/expeditions-service');

const { startExpeditionHandler } = require('../src/functions/expeditions/start');
const { claimExpeditionHandler } = require('../src/functions/expeditions/claim');
const { getActiveExpeditionsHandler } = require('../src/functions/expeditions/active');
const { listExpeditionsHandler } = require('../src/functions/expeditions/list');
const { getExpeditionHistoryHandler } = require('../src/functions/expeditions/history');
const { getExpeditionStatusHandler } = require('../src/functions/expeditions/status');
const { getExpeditions, start, claim } = require('../src/functions/expeditions/index');

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123' };

const makeExpeditionDef = (overrides = {}) => ({
  id: 'meadow-stroll',
  name: 'Meadow Stroll',
  description: 'A pleasant walk through the meadow',
  durationMinutes: 30,
  rewardMin: 10,
  rewardMax: 20,
  bonusChance: 0.1,
  requiredStage: 0,
  ...overrides,
});

const makeActiveExpedition = (overrides = {}) => {
  const now = new Date();
  const startedAt = new Date(now.getTime() - 15 * 60000); // started 15 min ago
  const endsAt = new Date(now.getTime() + 15 * 60000); // ends in 15 min
  return {
    id: 'exp_abc',
    expeditionId: 'meadow-stroll',
    totemId: 'ttm_abc',
    totemIds: ['ttm_abc'],
    startedAt: startedAt.toISOString(),
    endsAt: endsAt.toISOString(),
    claimed: false,
    ...overrides,
  };
};

// =============================================================================
// TESTS
// =============================================================================

describe('Expedition Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // START EXPEDITION
  // ===========================================================================

  describe('startExpeditionHandler', () => {
    it('should start an expedition successfully', async () => {
      expService.startExpedition.mockResolvedValue({
        success: true,
        expedition: {
          id: 'exp_new',
          name: 'Meadow Stroll',
          durationMinutes: 30,
        },
      });
      const result = await startExpeditionHandler(testUser, {
        totemId: 'ttm_abc',
        expeditionId: 'meadow-stroll',
      });
      expect(result.success).toBe(true);
      expect(result.data.expedition.id).toBe('exp_new');
      expect(result.data.message).toContain('Meadow Stroll');
    });

    it('should require totemId', async () => {
      const result = await startExpeditionHandler(testUser, { expeditionId: 'meadow-stroll' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should require expeditionId', async () => {
      const result = await startExpeditionHandler(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should reject invalid totemId format', async () => {
      const result = await startExpeditionHandler(testUser, {
        totemId: 'bad_id',
        expeditionId: 'meadow-stroll',
      });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should reject empty expeditionId', async () => {
      const result = await startExpeditionHandler(testUser, {
        totemId: 'ttm_abc',
        expeditionId: '',
      });
      expect(result.success).toBe(false);
      // Empty string is falsy, so triggers MISSING_PARAM check
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should map "Invalid expedition" to NOT_FOUND', async () => {
      expService.startExpedition.mockResolvedValue({
        success: false,
        error: 'Invalid expedition',
        message: 'Expedition not found',
      });
      const result = await startExpeditionHandler(testUser, {
        totemId: 'ttm_abc',
        expeditionId: 'nonexistent',
      });
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should map "Totem not found" to NOT_FOUND', async () => {
      expService.startExpedition.mockResolvedValue({
        success: false,
        error: 'Totem not found',
        message: 'Totem not found',
      });
      const result = await startExpeditionHandler(testUser, {
        totemId: 'ttm_missing',
        expeditionId: 'meadow-stroll',
      });
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should map "Totem stage too low" to STAGE_REQUIREMENT_NOT_MET', async () => {
      expService.startExpedition.mockResolvedValue({
        success: false,
        error: 'Totem stage too low',
        message: 'Stage too low',
      });
      const result = await startExpeditionHandler(testUser, {
        totemId: 'ttm_abc',
        expeditionId: 'ocean-voyage',
      });
      expect(result.error.code).toBe('STAGE_REQUIREMENT_NOT_MET');
    });

    it('should map "Totem is busy" to TOTEM_BUSY', async () => {
      expService.startExpedition.mockResolvedValue({
        success: false,
        error: 'Totem is busy',
        message: 'Totem already on expedition',
        activeExpedition: { id: 'exp_old' },
      });
      const result = await startExpeditionHandler(testUser, {
        totemId: 'ttm_abc',
        expeditionId: 'meadow-stroll',
      });
      expect(result.error.code).toBe('TOTEM_BUSY');
      expect(result.error.activeExpedition).toBeDefined();
    });

    it('should handle unexpected service error', async () => {
      expService.startExpedition.mockRejectedValue(new Error('DB down'));
      const result = await startExpeditionHandler(testUser, {
        totemId: 'ttm_abc',
        expeditionId: 'meadow-stroll',
      });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // CLAIM EXPEDITION
  // ===========================================================================

  describe('claimExpeditionHandler', () => {
    it('should claim reward successfully', async () => {
      expService.claimExpeditionReward.mockResolvedValue({
        success: true,
        rewards: { essence: 15 },
        expedition: { name: 'Meadow Stroll' },
        totalExpeditions: 5,
        achievements: [],
      });
      const result = await claimExpeditionHandler(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(result.data.rewards.essence).toBe(15);
      expect(result.data.message).toContain('15 Essence');
    });

    it('should require totemId', async () => {
      const result = await claimExpeditionHandler(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should reject invalid totemId format', async () => {
      const result = await claimExpeditionHandler(testUser, { totemId: 'bad' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should map "No active expedition" to NO_EXPEDITION', async () => {
      expService.claimExpeditionReward.mockResolvedValue({
        success: false,
        error: 'No active expedition',
        message: 'No expedition',
      });
      const result = await claimExpeditionHandler(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('NO_EXPEDITION');
    });

    it('should map "Expedition in progress" to NOT_COMPLETE', async () => {
      expService.claimExpeditionReward.mockResolvedValue({
        success: false,
        error: 'Expedition in progress',
        message: 'Still running',
        remainingMinutes: 10,
        endsAt: '2024-01-01T01:00:00.000Z',
      });
      const result = await claimExpeditionHandler(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('NOT_COMPLETE');
      expect(result.error.remainingMinutes).toBe(10);
    });

    it('should map "Already claimed" to ALREADY_CLAIMED', async () => {
      expService.claimExpeditionReward.mockResolvedValue({
        success: false,
        error: 'Already claimed',
        message: 'Already claimed',
      });
      const result = await claimExpeditionHandler(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('ALREADY_CLAIMED');
    });

    it('should handle unexpected error', async () => {
      expService.claimExpeditionReward.mockRejectedValue(new Error('fail'));
      const result = await claimExpeditionHandler(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // ACTIVE EXPEDITIONS
  // ===========================================================================

  describe('getActiveExpeditionsHandler', () => {
    it('should return active expeditions with progress', async () => {
      expService.getActiveExpeditions.mockResolvedValue([makeActiveExpedition()]);
      expService.getExpeditionDefinition.mockReturnValue(makeExpeditionDef());

      const result = await getActiveExpeditionsHandler(testUser);
      expect(result.success).toBe(true);
      expect(result.data.expeditions).toHaveLength(1);
      expect(result.data.expeditions[0].status).toBe('in_progress');
      expect(result.data.expeditions[0].progress).toBeLessThan(100);
      expect(result.data.summary.total).toBe(1);
    });

    it('should mark completed expeditions', async () => {
      const past = new Date(Date.now() - 60 * 60000); // ended 1hr ago
      expService.getActiveExpeditions.mockResolvedValue([
        makeActiveExpedition({ endsAt: past.toISOString(), startedAt: new Date(past.getTime() - 30 * 60000).toISOString() }),
      ]);
      expService.getExpeditionDefinition.mockReturnValue(makeExpeditionDef());

      const result = await getActiveExpeditionsHandler(testUser);
      expect(result.data.expeditions[0].status).toBe('completed');
      expect(result.data.expeditions[0].canClaim).toBe(true);
      expect(result.data.summary.claimable).toBe(1);
    });

    it('should return empty list when no active expeditions', async () => {
      expService.getActiveExpeditions.mockResolvedValue([]);
      const result = await getActiveExpeditionsHandler(testUser);
      expect(result.success).toBe(true);
      expect(result.data.expeditions).toHaveLength(0);
      expect(result.data.summary.total).toBe(0);
    });

    it('should handle service error', async () => {
      expService.getActiveExpeditions.mockRejectedValue(new Error('fail'));
      const result = await getActiveExpeditionsHandler(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // LIST EXPEDITIONS
  // ===========================================================================

  describe('listExpeditionsHandler', () => {
    it('should return all expedition definitions grouped by tier', () => {
      expService.getAllExpeditions.mockReturnValue([
        makeExpeditionDef({ id: 'meadow-stroll', durationMinutes: 30 }),
        makeExpeditionDef({ id: 'forest-trail', durationMinutes: 180 }),
        makeExpeditionDef({ id: 'ocean-voyage', durationMinutes: 1440 }),
      ]);

      const result = listExpeditionsHandler(testUser);
      expect(result.success).toBe(true);
      expect(result.data.expeditions).toHaveLength(3);
      expect(result.data.byTier.quick).toHaveLength(1);
      expect(result.data.byTier.medium).toHaveLength(1);
      expect(result.data.byTier.epic).toHaveLength(1);
    });

    it('should include summary counts', () => {
      expService.getAllExpeditions.mockReturnValue([
        makeExpeditionDef({ durationMinutes: 30 }),
        makeExpeditionDef({ durationMinutes: 30 }),
      ]);

      const result = listExpeditionsHandler(testUser);
      expect(result.data.summary.totalExpeditions).toBe(2);
      expect(result.data.summary.tierCounts.quick).toBe(2);
    });

    it('should format durations', () => {
      expService.getAllExpeditions.mockReturnValue([
        makeExpeditionDef({ durationMinutes: 30 }),
        makeExpeditionDef({ durationMinutes: 180 }),
        makeExpeditionDef({ durationMinutes: 1440 }),
      ]);

      const result = listExpeditionsHandler(testUser);
      expect(result.data.expeditions[0].durationDisplay).toBe('30 min');
      expect(result.data.expeditions[1].durationDisplay).toBe('3 hr');
      expect(result.data.expeditions[2].durationDisplay).toBe('24 hr');
    });

    it('should handle service error', () => {
      expService.getAllExpeditions.mockImplementation(() => { throw new Error('fail'); });
      const result = listExpeditionsHandler(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // EXPEDITION HISTORY
  // ===========================================================================

  describe('getExpeditionHistoryHandler', () => {
    it('should return history with summary', async () => {
      expService.getExpeditionHistory.mockResolvedValue([
        {
          id: 'exp_1',
          expeditionId: 'meadow-stroll',
          expeditionName: 'Meadow Stroll',
          totemId: 'ttm_abc',
          startedAt: '2024-01-01T00:00:00.000Z',
          completedAt: '2024-01-01T00:30:00.000Z',
          durationMinutes: 30,
          essenceEarned: 15,
          bonusItems: [],
        },
      ]);

      const result = await getExpeditionHistoryHandler(testUser, {});
      expect(result.success).toBe(true);
      expect(result.data.history).toHaveLength(1);
      expect(result.data.summary.totalEssenceEarned).toBe(15);
      expect(result.data.byExpedition).toHaveLength(1);
    });

    it('should parse limit from query', async () => {
      expService.getExpeditionHistory.mockResolvedValue([]);
      await getExpeditionHistoryHandler(testUser, { limit: '10' });
      expect(expService.getExpeditionHistory).toHaveBeenCalledWith(testUser.userId, 10);
    });

    it('should default to limit 50', async () => {
      expService.getExpeditionHistory.mockResolvedValue([]);
      await getExpeditionHistoryHandler(testUser, {});
      expect(expService.getExpeditionHistory).toHaveBeenCalledWith(testUser.userId, 50);
    });

    it('should default limit 0 to 50 (parseInt returns 0, || 50 kicks in)', async () => {
      expService.getExpeditionHistory.mockResolvedValue([]);
      const result = await getExpeditionHistoryHandler(testUser, { limit: '0' });
      // 0 is falsy, so parseInt('0') || 50 = 50
      expect(result.success).toBe(true);
      expect(expService.getExpeditionHistory).toHaveBeenCalledWith(testUser.userId, 50);
    });

    it('should reject limit above 100', async () => {
      const result = await getExpeditionHistoryHandler(testUser, { limit: '101' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_PARAM');
    });

    it('should handle service error', async () => {
      expService.getExpeditionHistory.mockRejectedValue(new Error('fail'));
      const result = await getExpeditionHistoryHandler(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // EXPEDITION STATUS
  // ===========================================================================

  describe('getExpeditionStatusHandler', () => {
    it('should return status for a totem', async () => {
      expService.checkExpeditionStatus.mockResolvedValue({
        hasActiveExpedition: true,
        status: 'in_progress',
        canClaim: false,
        expedition: { id: 'exp_abc' },
      });
      const result = await getExpeditionStatusHandler(testUser, 'ttm_abc');
      expect(result.success).toBe(true);
      expect(result.data.hasActiveExpedition).toBe(true);
      expect(result.data.totemId).toBe('ttm_abc');
    });

    it('should require totemId', async () => {
      const result = await getExpeditionStatusHandler(testUser, null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should reject invalid totemId format', async () => {
      const result = await getExpeditionStatusHandler(testUser, 'bad');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should handle service error', async () => {
      expService.checkExpeditionStatus.mockRejectedValue(new Error('fail'));
      const result = await getExpeditionStatusHandler(testUser, 'ttm_abc');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // INDEX WRAPPERS
  // ===========================================================================

  describe('index wrappers', () => {
    it('getExpeditions should combine list and active', async () => {
      expService.getAllExpeditions.mockReturnValue([makeExpeditionDef()]);
      expService.getActiveExpeditions.mockResolvedValue([]);

      const result = await getExpeditions(testUser);
      expect(result.success).toBe(true);
      expect(result.data.available).toBeDefined();
      expect(result.data.active).toBeDefined();
    });

    it('start should merge expeditionId from param', async () => {
      expService.startExpedition.mockResolvedValue({
        success: true,
        expedition: { id: 'exp_new', name: 'Test', durationMinutes: 30 },
      });
      await start(testUser, 'meadow-stroll', { totemId: 'ttm_abc' });
      expect(expService.startExpedition).toHaveBeenCalledWith(
        testUser.userId, 'ttm_abc', 'meadow-stroll', undefined
      );
    });

    it('claim should merge totemId from param', async () => {
      expService.claimExpeditionReward.mockResolvedValue({
        success: true,
        rewards: { essence: 10 },
        expedition: { name: 'Test' },
        totalExpeditions: 1,
        achievements: [],
      });
      await claim(testUser, 'ttm_abc', {});
      expect(expService.claimExpeditionReward).toHaveBeenCalledWith(testUser.userId, 'ttm_abc');
    });
  });
});
