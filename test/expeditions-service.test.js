/**
 * Expeditions Service Tests
 *
 * Tests for the expedition management system.
 * Expedition IDs use exp_ prefix with semantic slugs.
 * Rewards use baseExp/baseEssence with score multipliers.
 */

// Mock the db-client before requiring the service
jest.mock('../src/common/db-client', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  updateItem: jest.fn(),
  deleteItem: jest.fn(),
  queryItems: jest.fn(),
  getUser: jest.fn(),
  getTotem: jest.fn(),
  getUserTotems: jest.fn(),
  updateTotem: jest.fn(),
  addEssence: jest.fn(),
  deductEssence: jest.fn(),
  addRunes: jest.fn(),
  logTransaction: jest.fn(),
  TABLES: {
    EXPEDITION_STATE: 'TotemBound-ExpeditionState',
    TOTEMS: 'TotemBound-Totems',
    USERS: 'TotemBound-Users',
  },
  userPK: jest.fn((userId) => `USER#${userId}`),
}));

// Mock achievements service
jest.mock('../src/services/achievements-service', () => ({
  onExpeditionCompleted: jest.fn().mockResolvedValue([]),
}));

// Mock id-utils (service uses generateId instead of crypto.randomUUID)
const mockExpId = 'uex_01TEST000000000000000000TEST';
jest.mock('../src/common/id-utils', () => ({
  generateId: jest.fn(() => mockExpId),
}));

// Now import the modules
const expeditionsService = require('../src/services/expeditions-service');
const dbClient = require('../src/common/db-client');
const achievementsService = require('../src/services/achievements-service');

describe('Expeditions Service', () => {
  const testUserId = 'usr_test123';
  const testTotemId = 'ttm_test456';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // =============================================================================
  // EXPEDITION DEFINITIONS
  // =============================================================================

  describe('EXPEDITIONS constant', () => {
    it('should have 15 expeditions defined', () => {
      const expeditions = expeditionsService.getAllExpeditions();
      expect(expeditions).toHaveLength(15);
    });

    it('should have correct duration categories', () => {
      const expeditions = expeditionsService.getAllExpeditions();

      // Quick (30 min) - 3 expeditions
      const quick = expeditions.filter(e => e.durationMinutes === 30);
      expect(quick).toHaveLength(3);
      expect(quick.map(e => e.id).sort()).toEqual([
        'exp_backyard-fishing-journey',
        'exp_lunch-delivery-mission',
        'exp_weed-pulling-quest',
      ]);

      // Medium (3 hr) - 3 expeditions
      const medium = expeditions.filter(e => e.durationMinutes === 180);
      expect(medium).toHaveLength(3);

      // Long (6 hr) - 3 expeditions
      const long = expeditions.filter(e => e.durationMinutes === 360);
      expect(long).toHaveLength(3);

      // Extended (12 hr) - 3 expeditions
      const extended = expeditions.filter(e => e.durationMinutes === 720);
      expect(extended).toHaveLength(3);

      // Epic (24 hr) - 3 expeditions
      const epic = expeditions.filter(e => e.durationMinutes === 1440);
      expect(epic).toHaveLength(3);
    });

    it('should have correct base rewards for each tier', () => {
      const expeditions = expeditionsService.getAllExpeditions();

      // Quick: 5 baseExp, 3 baseEssence, 2 essenceCost
      const quick = expeditions.filter(e => e.durationMinutes === 30);
      quick.forEach(exp => {
        expect(exp.baseExp).toBe(5);
        expect(exp.baseEssence).toBe(3);
        expect(exp.essenceCost).toBe(2);
      });

      // Epic: 120 baseExp, 60 baseEssence, 50 essenceCost
      const epic = expeditions.filter(e => e.durationMinutes === 1440);
      epic.forEach(exp => {
        expect(exp.baseExp).toBe(120);
        expect(exp.baseEssence).toBe(60);
        expect(exp.essenceCost).toBe(50);
      });
    });
  });

  // =============================================================================
  // EXPEDITION DEFINITION LOOKUP
  // =============================================================================

  describe('getExpeditionDefinition', () => {
    it('should return expedition definition for valid ID', () => {
      const expedition = expeditionsService.getExpeditionDefinition('exp_lunch-delivery-mission');
      expect(expedition).toBeDefined();
      expect(expedition.name).toBe('Lunch Delivery Mission');
      expect(expedition.durationMinutes).toBe(30);
    });

    it('should return null for invalid ID', () => {
      const expedition = expeditionsService.getExpeditionDefinition('nonexistent');
      expect(expedition).toBeNull();
    });
  });

  // =============================================================================
  // AVAILABLE EXPEDITIONS BY STAGE
  // =============================================================================

  describe('getAvailableExpeditions', () => {
    it('should return only stage 0 expeditions for stage 0 totems', () => {
      const available = expeditionsService.getAvailableExpeditions(0);
      expect(available).toHaveLength(3);
      available.forEach(exp => {
        expect(exp.requiredStage).toBe(0);
      });
    });

    it('should return stage 0-1 expeditions for stage 1 totems', () => {
      const available = expeditionsService.getAvailableExpeditions(1);
      expect(available).toHaveLength(12); // 3 quick + 3 medium + 3 long + 3 extended
      available.forEach(exp => {
        expect(exp.requiredStage).toBeLessThanOrEqual(1);
      });
    });

    it('should return all expeditions for stage 2+ totems', () => {
      const available = expeditionsService.getAvailableExpeditions(2);
      expect(available).toHaveLength(15);
    });

    it('should return all expeditions for stage 4 totems', () => {
      const available = expeditionsService.getAvailableExpeditions(4);
      expect(available).toHaveLength(15);
    });
  });

  // =============================================================================
  // REWARD CALCULATION
  // =============================================================================

  describe('calculateExpReward', () => {
    it('should return XP reward for quick expedition', () => {
      // baseExp 5 → variance = floor(5*0.1) = 0 → always 5
      const reward = expeditionsService.calculateExpReward('exp_lunch-delivery-mission');
      expect(reward).toBe(5);
    });

    it('should return XP reward within range for epic expedition', () => {
      // baseExp 120 → variance 12 → range [108, 132]
      for (let i = 0; i < 100; i++) {
        const reward = expeditionsService.calculateExpReward('exp_celestial-mapping');
        expect(reward).toBeGreaterThanOrEqual(108);
        expect(reward).toBeLessThanOrEqual(132);
      }
    });

    it('should apply multiplier to XP reward', () => {
      // baseExp 120 with 1.5x multiplier → ~180 range
      for (let i = 0; i < 100; i++) {
        const reward = expeditionsService.calculateExpReward('exp_celestial-mapping', 1.5);
        expect(reward).toBeGreaterThanOrEqual(162); // floor(108 * 1.5)
        expect(reward).toBeLessThanOrEqual(198); // floor(132 * 1.5)
      }
    });

    it('should throw error for invalid expedition', () => {
      expect(() => {
        expeditionsService.calculateExpReward('nonexistent');
      }).toThrow('Unknown expedition: nonexistent');
    });
  });

  // =============================================================================
  // START EXPEDITION
  // =============================================================================

  describe('startExpedition', () => {
    const mockTotem = {
      pk: 'USER#usr_test123',
      sk: 'TOTEM#ttm_test456',
      id: 'ttm_test456',
      userId: 'usr_test123',
      speciesId: 2, // Wolf
      stage: 2,
      name: 'Test Totem',
      experience: 100,
      stats: { happiness: 50 },
    };

    it('should start expedition successfully when totem is available', async () => {
      dbClient.getTotem.mockResolvedValue(mockTotem);
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_1' }, { id: 'ttm_2' }, { id: 'ttm_3' }]);
      dbClient.getItem.mockResolvedValue(null); // No active expedition
      dbClient.deductEssence.mockResolvedValue({ success: true });
      dbClient.putItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});

      const result = await expeditionsService.startExpedition(
        testUserId,
        testTotemId,
        'exp_lunch-delivery-mission'
      );

      expect(result.success).toBe(true);
      expect(result.expedition).toBeDefined();
      expect(result.expedition.expeditionId).toBe('exp_lunch-delivery-mission');
      expect(result.expedition.name).toBe('Lunch Delivery Mission');
      expect(result.expedition.durationMinutes).toBe(30);
      expect(result.expedition.status).toBe('in_progress');

      // Verify expedition was saved
      expect(dbClient.putItem).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        expect.objectContaining({
          pk: 'USER#usr_test123',
          sk: `EXPEDITION#ACTIVE#${testTotemId}`,
          totemId: testTotemId,
          expeditionId: 'exp_lunch-delivery-mission',
          status: 'in_progress',
        })
      );

      // Verify Essence was deducted (cost: 2)
      expect(dbClient.deductEssence).toHaveBeenCalledWith(
        testUserId,
        2,
        expect.objectContaining({
          type: 'expedition_start',
          ref: 'exp_lunch-delivery-mission',
        })
      );

      // Verify totem was marked as busy
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        expect.objectContaining({
          expedition: expect.objectContaining({ active: true }),
        })
      );
    });

    it('should fail when expedition does not exist', async () => {
      const result = await expeditionsService.startExpedition(
        testUserId,
        testTotemId,
        'nonexistent-expedition'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid expedition');
    });

    it('should fail when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);

      const result = await expeditionsService.startExpedition(
        testUserId,
        testTotemId,
        'exp_lunch-delivery-mission'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Totem not found');
    });

    it('should fail when totem stage is too low', async () => {
      const lowStageTotem = { ...mockTotem, stage: 0 };
      dbClient.getTotem.mockResolvedValue(lowStageTotem);
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_1' }, { id: 'ttm_2' }, { id: 'ttm_3' }]);

      const result = await expeditionsService.startExpedition(
        testUserId,
        testTotemId,
        'exp_celestial-mapping' // Requires stage 2
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Totem stage too low');
    });

    it('should fail when totem is already on expedition', async () => {
      dbClient.getTotem.mockResolvedValue(mockTotem);
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_1' }, { id: 'ttm_2' }, { id: 'ttm_3' }]);
      dbClient.getItem.mockResolvedValue({
        id: 'uex_existing',
        expeditionId: 'exp_lunch-delivery-mission',
        endsAt: new Date(Date.now() + 3600000).toISOString(),
      });

      const result = await expeditionsService.startExpedition(
        testUserId,
        testTotemId,
        'exp_weed-pulling-quest'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Totem is busy');
      expect(result.activeExpedition).toBeDefined();
    });
  });

  // =============================================================================
  // CLAIM EXPEDITION REWARD
  // =============================================================================

  describe('claimExpeditionReward', () => {
    const completedExpedition = {
      pk: 'USER#usr_test123',
      sk: `EXPEDITION#ACTIVE#${testTotemId}`,
      id: mockExpId,
      odUserId: testUserId,
      totemId: testTotemId,
      expeditionId: 'exp_lunch-delivery-mission',
      startedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      endsAt: new Date(Date.now() - 1800000).toISOString(), // 30 min ago (completed)
      status: 'in_progress',
      claimed: false,
    };

    const mockTotemForClaim = {
      pk: 'USER#usr_test123',
      sk: 'TOTEM#ttm_test456',
      id: testTotemId,
      userId: testUserId,
      speciesId: 2, // Wolf (strength affinity, Earth domain)
      stage: 2,
      name: 'Test Totem',
      experience: 100,
      stats: { happiness: 50 },
    };

    it('should claim reward successfully when expedition is complete', async () => {
      dbClient.getItem.mockResolvedValue(completedExpedition);
      dbClient.getTotem.mockResolvedValue(mockTotemForClaim);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      dbClient.addRunes.mockResolvedValue({ success: true, newBalances: { lesser: 1, greater: 0, ancient: 0 } });
      dbClient.putItem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.queryItems.mockResolvedValue([]); // Empty history for count

      const result = await expeditionsService.claimExpeditionReward(
        testUserId,
        testTotemId
      );

      expect(result.success).toBe(true);
      expect(result.rewards).toBeDefined();
      expect(result.rewards.experience).toBeGreaterThanOrEqual(1);
      expect(result.rewards.essence).toBeGreaterThanOrEqual(1);
      expect(result.rewards.newEssenceBalance).toBe(1000);
      expect(result.rewards.runes).toBeDefined();
      expect(result.score).toBeDefined();
      expect(result.score.tier).toBeDefined();

      // Verify Essence was added
      expect(dbClient.addEssence).toHaveBeenCalledWith(
        testUserId,
        expect.any(Number),
        expect.objectContaining({
          type: 'reward_expedition',
          ref: 'exp_lunch-delivery-mission',
        })
      );

      // Verify history record was created
      expect(dbClient.putItem).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        expect.objectContaining({
          pk: 'USER#usr_test123',
          sk: expect.stringContaining('EXPEDITION#HISTORY#'),
          expeditionName: 'Lunch Delivery Mission',
        })
      );

      // Verify active expedition was deleted
      expect(dbClient.deleteItem).toHaveBeenCalled();

      // Verify totem busy status was cleared
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        expect.objectContaining({
          expedition: expect.objectContaining({ active: false }),
        })
      );

      // Verify achievement was triggered
      expect(achievementsService.onExpeditionCompleted).toHaveBeenCalledWith(
        testUserId,
        expect.any(Number),
        testTotemId
      );
    });

    it('should fail when no active expedition exists', async () => {
      dbClient.getItem.mockResolvedValue(null);

      const result = await expeditionsService.claimExpeditionReward(
        testUserId,
        testTotemId
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('No active expedition');
    });

    it('should fail when expedition is already claimed', async () => {
      dbClient.getItem.mockResolvedValue({ ...completedExpedition, claimed: true });

      const result = await expeditionsService.claimExpeditionReward(
        testUserId,
        testTotemId
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Already claimed');
    });

    it('should fail when expedition is not yet complete', async () => {
      const inProgressExpedition = {
        ...completedExpedition,
        endsAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      };
      dbClient.getItem.mockResolvedValue(inProgressExpedition);

      const result = await expeditionsService.claimExpeditionReward(
        testUserId,
        testTotemId
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Expedition in progress');
      expect(result.remainingMinutes).toBeGreaterThan(0);
    });
  });

  // =============================================================================
  // ACTIVE EXPEDITIONS QUERY
  // =============================================================================

  describe('getActiveExpeditions', () => {
    it('should return all active expeditions for a user', async () => {
      const mockExpeditions = [
        {
          id: 'uex_1',
          expeditionId: 'exp_lunch-delivery-mission',
          totemId: 'ttm_1',
          endsAt: new Date(Date.now() + 3600000).toISOString(),
          claimed: false,
        },
        {
          id: 'uex_2',
          expeditionId: 'exp_wind-scout-patrol',
          totemId: 'ttm_2',
          endsAt: new Date(Date.now() - 3600000).toISOString(), // Completed
          claimed: false,
        },
      ];
      dbClient.queryItems.mockResolvedValue(mockExpeditions);

      const result = await expeditionsService.getActiveExpeditions(testUserId);

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('in_progress');
      expect(result[0].canClaim).toBe(false);
      expect(result[1].status).toBe('completed');
      expect(result[1].canClaim).toBe(true);
    });

    it('should return empty array when no active expeditions', async () => {
      dbClient.queryItems.mockResolvedValue([]);

      const result = await expeditionsService.getActiveExpeditions(testUserId);

      expect(result).toEqual([]);
    });
  });

  // =============================================================================
  // EXPEDITION HISTORY
  // =============================================================================

  describe('getExpeditionHistory', () => {
    it('should return expedition history with limit', async () => {
      const mockHistory = [
        {
          id: 'uex_1',
          expeditionName: 'Lunch Delivery Mission',
          essenceEarned: 3,
          completedAt: '2025-01-15T10:00:00.000Z',
        },
      ];
      dbClient.queryItems.mockResolvedValue(mockHistory);

      const result = await expeditionsService.getExpeditionHistory(testUserId, 10);

      expect(dbClient.queryItems).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        'pk',
        'USER#usr_test123',
        expect.objectContaining({
          skPrefix: 'EXPEDITION#HISTORY#',
          limit: 10,
          scanIndexForward: false,
        })
      );
      expect(result).toEqual(mockHistory);
    });
  });

  // =============================================================================
  // CANCEL EXPEDITION
  // =============================================================================

  describe('cancelExpedition', () => {
    it('should cancel active expedition and clear totem status', async () => {
      const activeExpedition = {
        id: 'uex_123',
        expeditionId: 'exp_lunch-delivery-mission',
        totemId: testTotemId,
      };
      dbClient.getItem.mockResolvedValue(activeExpedition);
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});

      const result = await expeditionsService.cancelExpedition(testUserId, testTotemId);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Expedition cancelled. No rewards earned.');
      expect(dbClient.deleteItem).toHaveBeenCalled();
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        expect.objectContaining({
          expedition: expect.objectContaining({ active: false }),
        })
      );
    });

    it('should fail when no active expedition', async () => {
      dbClient.getItem.mockResolvedValue(null);

      const result = await expeditionsService.cancelExpedition(testUserId, testTotemId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No active expedition');
    });
  });

  // =============================================================================
  // CHECK EXPEDITION STATUS
  // =============================================================================

  describe('checkExpeditionStatus', () => {
    it('should return idle status when no active expedition', async () => {
      dbClient.getItem.mockResolvedValue(null);

      const result = await expeditionsService.checkExpeditionStatus(testUserId, testTotemId);

      expect(result.hasActiveExpedition).toBe(false);
      expect(result.status).toBe('idle');
    });

    it('should return in_progress status for ongoing expedition', async () => {
      const ongoingExpedition = {
        id: 'uex_123',
        expeditionId: 'exp_lunch-delivery-mission',
        startedAt: new Date(Date.now() - 900000).toISOString(), // 15 min ago
        endsAt: new Date(Date.now() + 900000).toISOString(), // 15 min from now
        claimed: false,
      };
      dbClient.getItem.mockResolvedValue(ongoingExpedition);

      const result = await expeditionsService.checkExpeditionStatus(testUserId, testTotemId);

      expect(result.hasActiveExpedition).toBe(true);
      expect(result.status).toBe('in_progress');
      expect(result.canClaim).toBe(false);
      expect(result.expedition.progress).toBeGreaterThan(0);
      expect(result.expedition.progress).toBeLessThan(100);
    });

    it('should return completed status when expedition is done', async () => {
      const completedExpedition = {
        id: 'uex_123',
        expeditionId: 'exp_lunch-delivery-mission',
        startedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        endsAt: new Date(Date.now() - 1800000).toISOString(), // 30 min ago
        claimed: false,
      };
      dbClient.getItem.mockResolvedValue(completedExpedition);

      const result = await expeditionsService.checkExpeditionStatus(testUserId, testTotemId);

      expect(result.hasActiveExpedition).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.canClaim).toBe(true);
      expect(result.expedition.progress).toBe(100);
      expect(result.expedition.remainingMinutes).toBe(0);
    });
  });

  // =============================================================================
  // RUNE DROPS
  // =============================================================================

  describe('rollForRunes', () => {
    it('should return rune drop results for epic expedition', () => {
      // exp_spirit-diplomacy: lesser 100%, greater 75%, ancient 25%
      const expedition = expeditionsService.getExpeditionDefinition('exp_spirit-diplomacy');
      let lesserCount = 0, greaterCount = 0, ancientCount = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const runes = expeditionsService.rollForRunes(expedition);
        lesserCount += runes.lesser;
        greaterCount += runes.greater;
        ancientCount += runes.ancient;
      }

      // Lesser has 100% chance — always drops
      expect(lesserCount).toBe(iterations);
      // Greater has 75% chance
      expect(greaterCount / iterations).toBeGreaterThan(0.65);
      expect(greaterCount / iterations).toBeLessThan(0.85);
      // Ancient has 25% chance
      expect(ancientCount / iterations).toBeGreaterThan(0.15);
      expect(ancientCount / iterations).toBeLessThan(0.35);
    });

    it('should return no runes for expedition with no drop chances', () => {
      const runes = expeditionsService.rollForRunes({});
      expect(runes).toEqual({ lesser: 0, greater: 0, ancient: 0 });
    });
  });
});
