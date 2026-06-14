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

      // Quick: 5 baseExp, 3 baseEssence (no Essence cost — happiness-gated only)
      const quick = expeditions.filter(e => e.durationMinutes === 30);
      quick.forEach(exp => {
        expect(exp.baseExp).toBe(5);
        expect(exp.baseEssence).toBe(3);
        expect(exp.essenceCost).toBeUndefined();
      });

      // Epic: 120 baseExp, 60 baseEssence (no Essence cost)
      const epic = expeditions.filter(e => e.durationMinutes === 1440);
      epic.forEach(exp => {
        expect(exp.baseExp).toBe(120);
        expect(exp.baseEssence).toBe(60);
        expect(exp.essenceCost).toBeUndefined();
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
        'exp_lunch-delivery-mission',
        [testTotemId, 'ttm_2', 'ttm_3']
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

      // Expeditions no longer charge an Essence deposit on start — happiness-gated only
      expect(dbClient.deductEssence).not.toHaveBeenCalled();

      // Verify totem was marked as busy
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        expect.objectContaining({
          expedition: expect.objectContaining({ active: true }),
        })
      );
    });

    it('should deduct happiness from ALL team totems', async () => {
      const totem1 = { ...mockTotem, id: 'ttm_captain', stats: { happiness: 50 } };
      const totem2 = { ...mockTotem, id: 'ttm_member1', stats: { happiness: 40 } };
      const totem3 = { ...mockTotem, id: 'ttm_member2', stats: { happiness: 30 } };

      dbClient.getTotem
        .mockResolvedValueOnce(totem1) // captain lookup
        .mockResolvedValueOnce(totem2) // team member 2
        .mockResolvedValueOnce(totem3); // team member 3
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_captain' }, { id: 'ttm_member1' }, { id: 'ttm_member2' }]);
      dbClient.getItem.mockResolvedValue(null); // No active expedition
      dbClient.deductEssence.mockResolvedValue({ success: true });
      dbClient.putItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});

      const result = await expeditionsService.startExpedition(
        testUserId,
        'ttm_captain',
        'exp_lunch-delivery-mission', // happinessCost: 1
        ['ttm_captain', 'ttm_member1', 'ttm_member2']
      );

      expect(result.success).toBe(true);

      // Verify happiness was deducted from ALL 3 totems (happinessCost=1)
      const updateCalls = dbClient.updateTotem.mock.calls;
      const happinessUpdates = updateCalls.filter(
        ([, , updates]) => updates['stats.happiness'] !== undefined
      );
      expect(happinessUpdates).toHaveLength(3);
      expect(happinessUpdates[0]).toEqual([testUserId, 'ttm_captain', { 'stats.happiness': 49 }]);
      expect(happinessUpdates[1]).toEqual([testUserId, 'ttm_member1', { 'stats.happiness': 39 }]);
      expect(happinessUpdates[2]).toEqual([testUserId, 'ttm_member2', { 'stats.happiness': 29 }]);
    });

    it('should fail when any team totem has insufficient happiness', async () => {
      const totem1 = { ...mockTotem, id: 'ttm_captain', stats: { happiness: 50 } };
      const totem2 = { ...mockTotem, id: 'ttm_member1', stats: { happiness: 0 } }; // too low

      dbClient.getTotem
        .mockResolvedValueOnce(totem1) // captain lookup
        .mockResolvedValueOnce(totem2); // team member with 0 happiness
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_captain' }, { id: 'ttm_member1' }, { id: 'ttm_member2' }]);
      dbClient.getItem.mockResolvedValue(null);

      const result = await expeditionsService.startExpedition(
        testUserId,
        'ttm_captain',
        'exp_lunch-delivery-mission', // happinessCost: 1
        ['ttm_captain', 'ttm_member1', 'ttm_member2']
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient happiness');
      // Verify no Essence was deducted (validation happens before cost)
      expect(dbClient.deductEssence).not.toHaveBeenCalled();
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

    it('should mark ALL team totems as busy on start', async () => {
      const totem1 = { ...mockTotem, id: 'ttm_captain', stats: { happiness: 50 } };

      dbClient.getTotem.mockResolvedValue(totem1);
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_captain' }, { id: 'ttm_m1' }, { id: 'ttm_m2' }]);
      dbClient.getItem.mockResolvedValue(null); // No active expedition for any totem
      dbClient.deductEssence.mockResolvedValue({ success: true });
      dbClient.putItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});

      const result = await expeditionsService.startExpedition(
        testUserId,
        'ttm_captain',
        'exp_lunch-delivery-mission',
        ['ttm_captain', 'ttm_m1', 'ttm_m2']
      );

      expect(result.success).toBe(true);

      // Verify ALL 3 totems marked busy (expedition.active = true)
      const busyCalls = dbClient.updateTotem.mock.calls.filter(
        ([, , updates]) => updates.expedition && updates.expedition.active === true
      );
      expect(busyCalls).toHaveLength(3);
      const busyIds = busyCalls.map(([, tid]) => tid);
      expect(busyIds).toContain('ttm_captain');
      expect(busyIds).toContain('ttm_m1');
      expect(busyIds).toContain('ttm_m2');
    });

    it('should fail when a team member totem is already on expedition', async () => {
      dbClient.getTotem.mockResolvedValue(mockTotem);
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_1' }, { id: 'ttm_2' }, { id: 'ttm_3' }]);
      // First totem (captain) is free, second totem is busy
      dbClient.getItem
        .mockResolvedValueOnce(null)   // captain free
        .mockResolvedValueOnce({       // member busy
          id: 'uex_existing',
          expeditionId: 'exp_lunch-delivery-mission',
          endsAt: new Date(Date.now() + 3600000).toISOString(),
        });

      const result = await expeditionsService.startExpedition(
        testUserId,
        testTotemId,
        'exp_weed-pulling-quest',
        [testTotemId, 'ttm_busy_member', 'ttm_free_member']
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Totem is busy');
      expect(result.activeExpedition.busyTotemId).toBe('ttm_busy_member');
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
        'exp_weed-pulling-quest',
        [testTotemId, 'ttm_2', 'ttm_3']
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Totem is busy');
      expect(result.activeExpedition).toBeDefined();
    });

    it('should reject solo / partial team', async () => {
      dbClient.getTotem.mockResolvedValue(mockTotem);
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_1' }, { id: 'ttm_2' }, { id: 'ttm_3' }]);
      const result = await expeditionsService.startExpedition(
        testUserId,
        testTotemId,
        'exp_lunch-delivery-mission',
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid team size');
    });

    it('should reject team with duplicate totem IDs', async () => {
      dbClient.getTotem.mockResolvedValue(mockTotem);
      dbClient.getUserTotems.mockResolvedValue([{ id: 'ttm_1' }, { id: 'ttm_2' }, { id: 'ttm_3' }]);
      const result = await expeditionsService.startExpedition(
        testUserId,
        testTotemId,
        'exp_lunch-delivery-mission',
        ['ttm_1', 'ttm_1', 'ttm_2'],
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid team size');
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

    it('should award XP to ALL team totems on claim', async () => {
      const teamExpedition = {
        ...completedExpedition,
        totemIds: [testTotemId, 'ttm_member1', 'ttm_member2'],
      };
      const member1 = { ...mockTotemForClaim, id: 'ttm_member1', experience: 200 };
      const member2 = { ...mockTotemForClaim, id: 'ttm_member2', experience: 300 };

      dbClient.getItem.mockResolvedValue(teamExpedition);
      dbClient.getTotem
        .mockResolvedValueOnce(mockTotemForClaim) // lead totem
        .mockResolvedValueOnce(member1)           // team member 1
        .mockResolvedValueOnce(member2);          // team member 2
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      dbClient.addRunes.mockResolvedValue({ success: true, newBalances: { lesser: 1, greater: 0, ancient: 0 } });
      dbClient.putItem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.queryItems.mockResolvedValue([]);

      const result = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);

      expect(result.success).toBe(true);
      expect(result.rewards.totemExpUpdates).toBeDefined();
      // All 3 totems should have XP updates
      expect(Object.keys(result.rewards.totemExpUpdates)).toHaveLength(3);
      expect(result.rewards.totemExpUpdates[testTotemId]).toBe(mockTotemForClaim.experience + result.rewards.experience);
      expect(result.rewards.totemExpUpdates['ttm_member1']).toBe(200 + result.rewards.experience);
      expect(result.rewards.totemExpUpdates['ttm_member2']).toBe(300 + result.rewards.experience);

      // Verify updateTotem was called for XP on all 3 totems
      const xpCalls = dbClient.updateTotem.mock.calls.filter(
        ([, , updates]) => updates.experience !== undefined
      );
      expect(xpCalls).toHaveLength(3);
    });

    it('should clear busy status on ALL team totems on claim', async () => {
      const teamExpedition = {
        ...completedExpedition,
        totemIds: [testTotemId, 'ttm_member1', 'ttm_member2'],
      };

      dbClient.getItem.mockResolvedValue(teamExpedition);
      dbClient.getTotem.mockResolvedValue(mockTotemForClaim);
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      dbClient.addRunes.mockResolvedValue({ success: true, newBalances: { lesser: 1, greater: 0, ancient: 0 } });
      dbClient.putItem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.queryItems.mockResolvedValue([]);

      const result = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);

      expect(result.success).toBe(true);

      // Verify busy cleared on all 3 totems
      const busyClearCalls = dbClient.updateTotem.mock.calls.filter(
        ([, , updates]) => updates.expedition && updates.expedition.active === false
      );
      expect(busyClearCalls).toHaveLength(3);
      const clearedIds = busyClearCalls.map(([, tid]) => tid);
      expect(clearedIds).toContain(testTotemId);
      expect(clearedIds).toContain('ttm_member1');
      expect(clearedIds).toContain('ttm_member2');
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
  // TRAIT EFFECTS (Phase 2) — team-scope resolver
  // =============================================================================

  describe('trait effects on expeditions', () => {
    const baseTotem = (overrides = {}) => ({
      pk: 'USER#usr_test123',
      sk: `TOTEM#${overrides.id || testTotemId}`,
      id: overrides.id || testTotemId,
      userId: testUserId,
      speciesId: 2,
      stage: 2,
      experience: 100,
      stats: { happiness: 50 },
      traits: { innate: null, learned: null, awakened: null },
      ...overrides,
    });

    const completedExpedition = {
      pk: 'USER#usr_test123',
      sk: `EXPEDITION#ACTIVE#${testTotemId}`,
      id: mockExpId,
      odUserId: testUserId,
      totemId: testTotemId,
      totemIds: [testTotemId, 'ttm_m1', 'ttm_m2'],
      expeditionId: 'exp_celestial-mapping',
      startedAt: new Date(Date.now() - 7200000).toISOString(),
      endsAt: new Date(Date.now() - 1800000).toISOString(),
      status: 'in_progress',
      claimed: false,
    };

    beforeEach(() => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5); // deterministic variance
      dbClient.putItem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      dbClient.addRunes.mockResolvedValue({ success: true, newBalances: { lesser: 0, greater: 0, ancient: 0 } });
      dbClient.queryItems.mockResolvedValue([]);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function mockTeam({ leadTraits = {}, member1Traits = {}, member2Traits = {} } = {}) {
      const lead = baseTotem({ id: testTotemId, traits: { innate: null, learned: null, awakened: null, ...leadTraits } });
      const m1 = baseTotem({ id: 'ttm_m1', traits: { innate: null, learned: null, awakened: null, ...member1Traits } });
      const m2 = baseTotem({ id: 'ttm_m2', traits: { innate: null, learned: null, awakened: null, ...member2Traits } });
      dbClient.getItem.mockResolvedValue(completedExpedition);
      dbClient.getTotem.mockImplementation((_uid, tid) =>
        Promise.resolve(tid === testTotemId ? lead : tid === 'ttm_m1' ? m1 : m2),
      );
      return { lead, m1, m2 };
    }

    it('baseline: no traits → baseline essence reward', async () => {
      mockTeam();
      const result = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      expect(result.success).toBe(true);
      const baseline = result.rewards.essence;
      expect(baseline).toBeGreaterThan(0);
    });

    it('Curious (+5% expedition essence) on the lead totem bumps essence reward', async () => {
      // Capture baseline first.
      mockTeam();
      const base = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      jest.clearAllMocks();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      dbClient.putItem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      dbClient.addRunes.mockResolvedValue({ success: true, newBalances: { lesser: 0, greater: 0, ancient: 0 } });
      dbClient.queryItems.mockResolvedValue([]);
      mockTeam({ leadTraits: { innate: 'trt_curious' } });
      const boosted = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      expect(boosted.rewards.essence).toBeGreaterThan(base.rewards.essence);
    });

    it('Mentor aura on a teammate folds +10% XP for the whole team', async () => {
      mockTeam();
      const base = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      jest.clearAllMocks();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      dbClient.putItem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      dbClient.addRunes.mockResolvedValue({ success: true, newBalances: { lesser: 0, greater: 0, ancient: 0 } });
      dbClient.queryItems.mockResolvedValue([]);
      mockTeam({ member1Traits: { awakened: 'trt_mentor' } });
      const boosted = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      expect(boosted.rewards.experience).toBeGreaterThan(base.rewards.experience);
    });

    it('two Mentors on the team de-dupe (apply once, same as one)', async () => {
      mockTeam({ leadTraits: { awakened: 'trt_mentor' } });
      const oneMentor = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      jest.clearAllMocks();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      dbClient.putItem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      dbClient.addRunes.mockResolvedValue({ success: true, newBalances: { lesser: 0, greater: 0, ancient: 0 } });
      dbClient.queryItems.mockResolvedValue([]);
      mockTeam({
        leadTraits: { awakened: 'trt_mentor' },
        member1Traits: { awakened: 'trt_mentor' },
      });
      const twoMentors = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      expect(twoMentors.rewards.experience).toBe(oneMentor.rewards.experience);
    });

    it('Kindred Soul fires only when another same-species teammate is present', async () => {
      // Same species
      mockTeam({ leadTraits: { awakened: 'trt_kindred_soul' } });
      const withSibling = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      const xpWithSibling = withSibling.rewards.experience;

      jest.clearAllMocks();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      dbClient.putItem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      dbClient.addRunes.mockResolvedValue({ success: true, newBalances: { lesser: 0, greater: 0, ancient: 0 } });
      dbClient.queryItems.mockResolvedValue([]);

      // Different species for teammates → no bonus
      const lead = baseTotem({ id: testTotemId, speciesId: 2, traits: { innate: null, learned: null, awakened: 'trt_kindred_soul' } });
      const m1 = baseTotem({ id: 'ttm_m1', speciesId: 7 });
      const m2 = baseTotem({ id: 'ttm_m2', speciesId: 8 });
      dbClient.getItem.mockResolvedValue(completedExpedition);
      dbClient.getTotem.mockImplementation((_uid, tid) =>
        Promise.resolve(tid === testTotemId ? lead : tid === 'ttm_m1' ? m1 : m2),
      );
      const aloneByKind = await expeditionsService.claimExpeditionReward(testUserId, testTotemId);
      expect(xpWithSibling).toBeGreaterThan(aloneByKind.rewards.experience);
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

    it('should clear busy on ALL team totems when cancelled', async () => {
      const teamExpedition = {
        id: 'uex_123',
        expeditionId: 'exp_lunch-delivery-mission',
        totemId: testTotemId,
        totemIds: [testTotemId, 'ttm_m1', 'ttm_m2'],
      };
      dbClient.getItem.mockResolvedValue(teamExpedition);
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});

      const result = await expeditionsService.cancelExpedition(testUserId, testTotemId);

      expect(result.success).toBe(true);

      // Verify busy cleared on all 3 totems
      const busyClearCalls = dbClient.updateTotem.mock.calls.filter(
        ([, , updates]) => updates.expedition && updates.expedition.active === false
      );
      expect(busyClearCalls).toHaveLength(3);
      const clearedIds = busyClearCalls.map(([, tid]) => tid);
      expect(clearedIds).toContain(testTotemId);
      expect(clearedIds).toContain('ttm_m1');
      expect(clearedIds).toContain('ttm_m2');
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
    it('should award 0 or 1 lesser rune for 30min expedition (20% chance)', () => {
      // exp_lunch-delivery-mission: 30min, lesser 20%, greater 0%, ancient 0%
      const expedition = expeditionsService.getExpeditionDefinition('exp_lunch-delivery-mission');
      let lesserCount = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const runes = expeditionsService.rollForRunes(expedition);
        // Each roll should be 0 or 1
        expect(runes.lesser).toBeLessThanOrEqual(1);
        expect(runes.greater).toBe(0);
        expect(runes.ancient).toBe(0);
        lesserCount += runes.lesser;
      }

      // ~20% drop rate
      expect(lesserCount / iterations).toBeGreaterThan(0.12);
      expect(lesserCount / iterations).toBeLessThan(0.28);
    });

    it('should award exactly 1 lesser rune for 3hr expedition (100% chance)', () => {
      // exp_wind-scout-patrol: 180min, lesser 100%, greater 0%, ancient 0%
      const expedition = expeditionsService.getExpeditionDefinition('exp_wind-scout-patrol');
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const runes = expeditionsService.rollForRunes(expedition);
        expect(runes.lesser).toBe(1);
        expect(runes.greater).toBe(0);
        expect(runes.ancient).toBe(0);
      }
    });

    it('should award exactly 1 lesser rune for 6hr expedition (100% chance)', () => {
      // exp_diplomatic-envoy: 360min, lesser 100%, greater 25%, ancient 0%
      const expedition = expeditionsService.getExpeditionDefinition('exp_diplomatic-envoy');
      let lesserCount = 0, greaterCount = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const runes = expeditionsService.rollForRunes(expedition);
        expect(runes.lesser).toBe(1);
        expect(runes.ancient).toBe(0);
        lesserCount += runes.lesser;
        greaterCount += runes.greater;
      }

      expect(lesserCount).toBe(iterations);
      // Greater ~25% chance, 0 or 1 each roll
      expect(greaterCount / iterations).toBeGreaterThan(0.17);
      expect(greaterCount / iterations).toBeLessThan(0.33);
    });

    it('should award 2 lesser runes for 12hr expedition (100% chance)', () => {
      // exp_festival-envoy: 720min, lesser 100%, greater 50%, ancient 10%
      const expedition = expeditionsService.getExpeditionDefinition('exp_festival-envoy');
      let lesserCount = 0, greaterCount = 0, ancientCount = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const runes = expeditionsService.rollForRunes(expedition);
        expect(runes.lesser).toBe(2);
        lesserCount += runes.lesser;
        greaterCount += runes.greater;
        ancientCount += runes.ancient;
      }

      expect(lesserCount).toBe(iterations * 2);
      // Greater ~50% chance
      expect(greaterCount / iterations).toBeGreaterThan(0.42);
      expect(greaterCount / iterations).toBeLessThan(0.58);
      // Ancient ~10% chance
      expect(ancientCount / iterations).toBeGreaterThan(0.05);
      expect(ancientCount / iterations).toBeLessThan(0.15);
    });

    it('should award 3 lesser runes for 24hr expedition (100% chance)', () => {
      // exp_spirit-diplomacy: 1440min, lesser 100%, greater 75%, ancient 25%
      const expedition = expeditionsService.getExpeditionDefinition('exp_spirit-diplomacy');
      let lesserCount = 0, greaterCount = 0, ancientCount = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const runes = expeditionsService.rollForRunes(expedition);
        expect(runes.lesser).toBe(3);
        lesserCount += runes.lesser;
        greaterCount += runes.greater;
        ancientCount += runes.ancient;
      }

      expect(lesserCount).toBe(iterations * 3);
      // Greater ~75% chance (still 0 or 1 per drop)
      expect(greaterCount / iterations).toBeGreaterThan(0.65);
      expect(greaterCount / iterations).toBeLessThan(0.85);
      // Ancient ~25% chance (still 0 or 1 per drop)
      expect(ancientCount / iterations).toBeGreaterThan(0.15);
      expect(ancientCount / iterations).toBeLessThan(0.35);
    });

    it('should apply runeMultiplier to drop chances', () => {
      // 3hr expedition with 100% lesser — halved to 50% by below_average multiplier
      const expedition = expeditionsService.getExpeditionDefinition('exp_wind-scout-patrol');
      let lesserCount = 0;
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const runes = expeditionsService.rollForRunes(expedition, 0.5);
        lesserCount += runes.lesser;
      }

      // ~50% of iterations should drop 1 lesser rune
      expect(lesserCount / iterations).toBeGreaterThan(0.42);
      expect(lesserCount / iterations).toBeLessThan(0.58);
    });

    it('should return no runes for expedition with no drop chances', () => {
      const runes = expeditionsService.rollForRunes({});
      expect(runes).toEqual({ lesser: 0, greater: 0, ancient: 0 });
    });
  });
});
