/**
 * Game Actions Handler Tests
 *
 * Tests for feed, train, treat, evolve action handlers and
 * index helpers (setNickname, getCooldowns, getTotemStatus).
 */

// Mock db-client before requiring handlers
jest.mock('../src/common/db-client', () => ({
  getTotem: jest.fn(),
  updateTotem: jest.fn(),
  deductEssence: jest.fn(),
  getUser: jest.fn(),
  updateUser: jest.fn(),
}));

// Mock achievements service
jest.mock('../src/services/achievements-service', () => ({
  onGameAction: jest.fn().mockResolvedValue([]),
  onTotemEvolved: jest.fn().mockResolvedValue([]),
  checkBalancedCare: jest.fn().mockResolvedValue([]),
}));

const dbClient = require('../src/common/db-client');
const achievementsService = require('../src/services/achievements-service');
const { feed } = require('../src/functions/game-actions/feed');
const { train } = require('../src/functions/game-actions/train');
const { treat } = require('../src/functions/game-actions/treat');
const { evolve, getEvolutionStatus } = require('../src/functions/game-actions/evolve');
const { setNickname, getCooldowns } = require('../src/functions/game-actions/index');

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123' };
const testTotemId = 'ttm_abc123';

const makeTotem = (overrides = {}) => ({
  id: testTotemId,
  userId: testUser.userId,
  speciesId: 2,
  stage: 0,
  experience: 0,
  stats: { happiness: 50, hunger: 80, strength: 10, agility: 8, wisdom: 6 },
  cooldowns: { feed: null, train: null, treat: null },
  feedHistory: [],
  ...overrides,
});

// =============================================================================
// SETUP
// =============================================================================

describe('Game Actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.getTotem.mockResolvedValue(makeTotem());
    dbClient.updateTotem.mockResolvedValue({});
    dbClient.deductEssence.mockResolvedValue({ success: true, newBalance: 1990 });
    dbClient.getUser.mockResolvedValue({ stats: { totalFeedCount: 5, totalTrainCount: 3, totalTreatCount: 2 } });
    dbClient.updateUser.mockResolvedValue({});
  });

  // =============================================================================
  // FEED TESTS
  // =============================================================================

  describe('feed', () => {
    it('should successfully feed a totem', async () => {
      const result = await feed(testUser, testTotemId);
      expect(result.success).toBe(true);
      expect(result.data.essenceSpent).toBe(10);
      expect(result.data.newEssenceBalance).toBe(1990);
    });

    it('should return INVALID_ID for bad totem ID', async () => {
      const result = await feed(testUser, 'bad_id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return INVALID_ID for null totem ID', async () => {
      const result = await feed(testUser, null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await feed(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should return INSUFFICIENT_BALANCE when not enough Essence', async () => {
      dbClient.deductEssence.mockResolvedValue({ success: false, available: 5 });
      const result = await feed(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(result.error.required).toBe(10);
    });

    it('should update totem with new happiness and feed history', async () => {
      await feed(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({
          'stats.happiness': 60, // 50 + 10
          experience: 0, // feed gives 0 XP
        })
      );
    });

    it('should include feedsToday in response', async () => {
      const result = await feed(testUser, testTotemId);
      expect(result.data.feedsToday).toBeDefined();
      expect(result.data.maxDaily).toBe(3);
    });

    it('should trigger achievement check', async () => {
      await feed(testUser, testTotemId);
      expect(achievementsService.onGameAction).toHaveBeenCalledWith(
        testUser.userId, 'feed', 6, testTotemId // totalFeedCount was 5, +1 = 6
      );
    });

    it('should include achievements in response', async () => {
      achievementsService.onGameAction.mockResolvedValue([
        { unlocked: true, achievementId: 'ach_feed', milestone: 5, rewards: { essence: 50 } },
      ]);
      const result = await feed(testUser, testTotemId);
      expect(result.data.achievements).toHaveLength(1);
      expect(result.data.achievements[0].achievementId).toBe('ach_feed');
    });

    it('should still succeed if achievement check fails', async () => {
      achievementsService.onGameAction.mockRejectedValue(new Error('Achievement error'));
      const result = await feed(testUser, testTotemId);
      expect(result.success).toBe(true);
    });

    it('should block feeding when already fed in current window', async () => {
      const now = new Date();
      const totem = makeTotem({
        feedHistory: [{ timestamp: now.toISOString(), window: 0 }],
      });
      dbClient.getTotem.mockResolvedValue(totem);

      // We need to ensure the feed is in the current window
      const secondsSinceMidnight = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
      let currentWindow = 0;
      if (secondsSinceMidnight >= 28800 && secondsSinceMidnight < 57600) currentWindow = 1;
      else if (secondsSinceMidnight >= 57600) currentWindow = 2;

      const totemWithCurrentWindow = makeTotem({
        feedHistory: [{ timestamp: now.toISOString(), window: currentWindow }],
      });
      dbClient.getTotem.mockResolvedValue(totemWithCurrentWindow);

      const result = await feed(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('TIME_WINDOW');
    });
  });

  // =============================================================================
  // TRAIN TESTS
  // =============================================================================

  describe('train', () => {
    it('should successfully train a totem', async () => {
      const result = await train(testUser, testTotemId);
      expect(result.success).toBe(true);
      expect(result.data.xpGained).toBe(50);
      expect(result.data.essenceSpent).toBe(20);
    });

    it('should return INVALID_ID for bad totem ID', async () => {
      const result = await train(testUser, 'bad_id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await train(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should return LOW_HAPPINESS when happiness < 20', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ stats: { happiness: 10 } }));
      const result = await train(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('LOW_HAPPINESS');
      expect(result.error.required).toBe(20);
      expect(result.error.current).toBe(10);
    });

    it('should return INSUFFICIENT_BALANCE when not enough Essence', async () => {
      dbClient.deductEssence.mockResolvedValue({ success: false, available: 15 });
      const result = await train(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('should update totem with XP and reduced happiness', async () => {
      await train(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({
          experience: 50, // 0 + 50
          'stats.happiness': 40, // 50 - 10
        })
      );
    });

    it('should trigger achievement check for train', async () => {
      await train(testUser, testTotemId);
      expect(achievementsService.onGameAction).toHaveBeenCalledWith(
        testUser.userId, 'train', 4, testTotemId // was 3, +1 = 4
      );
    });

    it('should allow train at exactly 20 happiness', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ stats: { happiness: 20 } }));
      const result = await train(testUser, testTotemId);
      expect(result.success).toBe(true);
    });
  });

  // =============================================================================
  // TREAT TESTS
  // =============================================================================

  describe('treat', () => {
    it('should successfully treat a totem', async () => {
      const result = await treat(testUser, testTotemId);
      expect(result.success).toBe(true);
      expect(result.data.essenceSpent).toBe(20);
    });

    it('should return INVALID_ID for bad totem ID', async () => {
      const result = await treat(testUser, 'bad_id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await treat(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should return ON_COOLDOWN when treated recently', async () => {
      const justNow = new Date().toISOString();
      dbClient.getTotem.mockResolvedValue(makeTotem({ cooldowns: { treat: justNow } }));
      const result = await treat(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ON_COOLDOWN');
      expect(result.error.readyAt).toBeDefined();
      expect(result.error.remainingMs).toBeGreaterThan(0);
    });

    it('should allow treat when cooldown has expired', async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      dbClient.getTotem.mockResolvedValue(makeTotem({ cooldowns: { treat: fiveHoursAgo } }));
      const result = await treat(testUser, testTotemId);
      expect(result.success).toBe(true);
    });

    it('should update totem with new happiness and cooldown', async () => {
      await treat(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({
          'stats.happiness': 60, // 50 + 10
          'cooldowns.treat': expect.any(String),
        })
      );
    });

    it('should include cooldown info in response', async () => {
      const result = await treat(testUser, testTotemId);
      expect(result.data.statChanges.happinessChange).toBe(10);
    });

    it('should trigger achievement check for treat', async () => {
      await treat(testUser, testTotemId);
      expect(achievementsService.onGameAction).toHaveBeenCalledWith(
        testUser.userId, 'treat', 3, testTotemId // was 2, +1 = 3
      );
    });
  });

  // =============================================================================
  // EVOLVE TESTS
  // =============================================================================

  describe('evolve', () => {
    it('should successfully evolve a totem from stage 0 to 1', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ experience: 600, stats: { happiness: 50, strength: 10, agility: 8, wisdom: 6 } }));
      const result = await evolve(testUser, testTotemId);
      expect(result.success).toBe(true);
      expect(result.data.evolution.previousStage).toBe(0);
      expect(result.data.evolution.newStage).toBe(1);
    });

    it('should return INVALID_ID for bad totem ID', async () => {
      const result = await evolve(testUser, 'bad_id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await evolve(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should return MAX_STAGE when already at stage 4', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ stage: 4, experience: 10000 }));
      const result = await evolve(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MAX_STAGE');
    });

    it('should return REQUIREMENTS_NOT_MET when insufficient XP', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ stage: 0, experience: 100, stats: { happiness: 50 } }));
      const result = await evolve(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('REQUIREMENTS_NOT_MET');
    });

    it('should return REQUIREMENTS_NOT_MET when insufficient happiness', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ stage: 0, experience: 600, stats: { happiness: 10 } }));
      const result = await evolve(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('REQUIREMENTS_NOT_MET');
    });

    it('should boost stats on evolution (scaling: +newStage)', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({
        experience: 600,
        stats: { happiness: 50, strength: 10, agility: 8, wisdom: 6 },
      }));
      await evolve(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({
          stage: 1,
          'stats.strength': 11, // 10 + 1
          'stats.agility': 9,   // 8 + 1
          'stats.wisdom': 7,    // 6 + 1
          'stats.happiness': 60, // 50 + 10
        })
      );
    });

    it('should cap stats at 100', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({
        stage: 3,
        experience: 8000,
        stats: { happiness: 95, strength: 99, agility: 98, wisdom: 97 },
      }));
      await evolve(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({
          stage: 4,
          'stats.strength': 100, // 99 + 4 = 103 capped to 100
          'stats.agility': 100,  // 98 + 4 = 102 capped to 100
          'stats.wisdom': 100,   // 97 + 4 = 101 capped to 100
          'stats.happiness': 100, // 95 + 10 = 105 capped to 100
        })
      );
    });

    it('should include stat boosts in response', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ experience: 600, stats: { happiness: 50, strength: 10, agility: 8, wisdom: 6 } }));
      const result = await evolve(testUser, testTotemId);
      expect(result.data.statBoosts).toEqual({
        strength: 1, agility: 1, wisdom: 1, happiness: 10,
      });
    });

    it('should trigger evolution achievement', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ experience: 600, stats: { happiness: 50, strength: 10, agility: 8, wisdom: 6 } }));
      await evolve(testUser, testTotemId);
      expect(achievementsService.onTotemEvolved).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({ newStage: 1, totemId: testTotemId })
      );
    });

    it('should still succeed if achievement check fails', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ experience: 600, stats: { happiness: 50, strength: 10, agility: 8, wisdom: 6 } }));
      achievementsService.onTotemEvolved.mockRejectedValue(new Error('Achievement error'));
      const result = await evolve(testUser, testTotemId);
      expect(result.success).toBe(true);
    });
  });

  // =============================================================================
  // EVOLUTION STATUS TESTS
  // =============================================================================

  describe('getEvolutionStatus', () => {
    it('should return evolution status for a totem', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ stage: 1, experience: 1200 }));
      const result = await getEvolutionStatus(testUser, testTotemId);
      expect(result.success).toBe(true);
      expect(result.data.currentStage).toBe(1);
      expect(result.data.canEvolve).toBe(false); // needs 1500 XP
      expect(result.data.nextStage).toBe(2);
    });

    it('should show isMaxStage at stage 4', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({ stage: 4, experience: 10000 }));
      const result = await getEvolutionStatus(testUser, testTotemId);
      expect(result.data.isMaxStage).toBe(true);
      expect(result.data.nextStage).toBeNull();
    });

    it('should return INVALID_ID for bad totem ID', async () => {
      const result = await getEvolutionStatus(testUser, 'bad_id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await getEvolutionStatus(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // =============================================================================
  // SET NICKNAME TESTS
  // =============================================================================

  describe('setNickname', () => {
    it('should set a valid nickname', async () => {
      const result = await setNickname(testUser, testTotemId, 'Fluffy');
      expect(result.success).toBe(true);
      expect(result.data.nickname).toBe('Fluffy');
    });

    it('should clear nickname with null', async () => {
      const result = await setNickname(testUser, testTotemId, null);
      expect(result.success).toBe(true);
      expect(result.data.nickname).toBeNull();
    });

    it('should return INVALID_ID for bad totem ID', async () => {
      const result = await setNickname(testUser, 'bad_id', 'Test');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await setNickname(testUser, testTotemId, 'Test');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should reject non-string nickname', async () => {
      const result = await setNickname(testUser, testTotemId, 123);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_NICKNAME');
    });

    it('should reject nickname shorter than 2 chars', async () => {
      const result = await setNickname(testUser, testTotemId, 'A');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_NICKNAME');
      expect(result.error.message).toContain('at least 2');
    });

    it('should reject nickname longer than 20 chars', async () => {
      const result = await setNickname(testUser, testTotemId, 'A'.repeat(21));
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_NICKNAME');
      expect(result.error.message).toContain('20 characters');
    });

    it('should reject special characters (XSS prevention)', async () => {
      const result = await setNickname(testUser, testTotemId, '<script>alert(1)</script>');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_NICKNAME');
    });

    it('should allow letters, numbers, spaces, underscores, hyphens', async () => {
      const result = await setNickname(testUser, testTotemId, 'My Totem-1_A');
      expect(result.success).toBe(true);
      expect(result.data.nickname).toBe('My Totem-1_A');
    });

    it('should trim whitespace', async () => {
      const result = await setNickname(testUser, testTotemId, '  Fluffy  ');
      expect(result.success).toBe(true);
      expect(result.data.nickname).toBe('Fluffy');
    });

    it('should clear nickname with empty string', async () => {
      const result = await setNickname(testUser, testTotemId, '   ');
      expect(result.success).toBe(true);
      expect(result.data.nickname).toBeNull();
    });
  });

  // =============================================================================
  // GET COOLDOWNS TESTS
  // =============================================================================

  describe('getCooldowns', () => {
    it('should return cooldown statuses for a totem', async () => {
      const result = await getCooldowns(testUser, testTotemId);
      expect(result.success).toBe(true);
      expect(result.data.cooldowns).toHaveProperty('feed');
      expect(result.data.cooldowns).toHaveProperty('train');
      expect(result.data.cooldowns).toHaveProperty('treat');
    });

    it('should return INVALID_ID for bad totem ID', async () => {
      const result = await getCooldowns(testUser, 'bad_id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem does not exist', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await getCooldowns(testUser, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should show treat on cooldown when treated recently', async () => {
      const justNow = new Date().toISOString();
      dbClient.getTotem.mockResolvedValue(makeTotem({ cooldowns: { treat: justNow } }));
      const result = await getCooldowns(testUser, testTotemId);
      expect(result.data.cooldowns.treat.onCooldown).toBe(true);
      expect(result.data.cooldowns.treat.remainingMs).toBeGreaterThan(0);
    });

    it('should show treat not on cooldown when expired', async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      dbClient.getTotem.mockResolvedValue(makeTotem({ cooldowns: { treat: fiveHoursAgo } }));
      const result = await getCooldowns(testUser, testTotemId);
      expect(result.data.cooldowns.treat.onCooldown).toBe(false);
    });
  });

  // =============================================================================
  // BATCH 1: lastActionDates + balanced-care wire-up
  // =============================================================================

  describe('Batch 1 wire-up — lastActionDates + balanced-care', () => {
    const today = new Date().toISOString().slice(0, 10);

    it('feed writes lastActionDates with feed = today UTC to the totem', async () => {
      await feed(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({ lastActionDates: expect.objectContaining({ feed: today }) })
      );
    });

    it('train writes lastActionDates with train = today UTC to the totem', async () => {
      await train(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({ lastActionDates: expect.objectContaining({ train: today }) })
      );
    });

    it('treat writes lastActionDates with treat = today UTC to the totem', async () => {
      await treat(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({ lastActionDates: expect.objectContaining({ treat: today }) })
      );
    });

    it('feed preserves existing lastActionDates entries', async () => {
      const totem = makeTotem({ lastActionDates: { train: today, treat: today } });
      dbClient.getTotem.mockResolvedValue(totem);
      await feed(testUser, testTotemId);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUser.userId, testTotemId,
        expect.objectContaining({
          lastActionDates: expect.objectContaining({
            feed: today, train: today, treat: today,
          }),
        })
      );
    });

    it('feed calls checkBalancedCare with the merged totem state', async () => {
      const totem = makeTotem({
        lastActionDates: { train: today, treat: today },
      });
      dbClient.getTotem.mockResolvedValue(totem);
      await feed(testUser, testTotemId);
      // Expect a totem-shaped argument with all 3 dates set to today.
      expect(achievementsService.checkBalancedCare).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({
          lastActionDates: expect.objectContaining({
            feed: today, train: today, treat: today,
          }),
        })
      );
    });

    it('train calls checkBalancedCare with merged totem state', async () => {
      const totem = makeTotem({
        lastActionDates: { feed: today, treat: today },
      });
      dbClient.getTotem.mockResolvedValue(totem);
      await train(testUser, testTotemId);
      expect(achievementsService.checkBalancedCare).toHaveBeenCalled();
    });

    it('treat calls checkBalancedCare with merged totem state', async () => {
      const totem = makeTotem({
        lastActionDates: { feed: today, train: today },
      });
      dbClient.getTotem.mockResolvedValue(totem);
      await treat(testUser, testTotemId);
      expect(achievementsService.checkBalancedCare).toHaveBeenCalled();
    });

    it('feed/train/treat merge balanced-care unlocks into achievements response', async () => {
      achievementsService.checkBalancedCare.mockResolvedValue([
        { unlocked: true, achievementId: 'ach_balanced-care', milestone: 0, rewards: { essence: 25 } },
      ]);
      const result = await feed(testUser, testTotemId);
      expect(result.data.achievements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ achievementId: 'ach_balanced-care', milestone: 0 }),
        ])
      );
    });

    it('still succeeds if balanced-care helper throws', async () => {
      achievementsService.checkBalancedCare.mockRejectedValue(new Error('boom'));
      const result = await feed(testUser, testTotemId);
      expect(result.success).toBe(true);
    });
  });

  // =============================================================================
  // TRAIT EFFECTS — care handlers fold resolver bonuses (Phase 2)
  // =============================================================================

  describe('trait effects on care actions', () => {
    const traits = (overrides = {}) => ({ innate: null, learned: null, awakened: null, ...overrides });

    describe('train', () => {
      it('Quick Learner (+10% XP) → 50 → 55 XP', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({ traits: traits({ learned: 'trt_quick_learner' }) }));
        const result = await train(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.xpGained).toBe(55);
      });

      it('Thrifty (−10% cost) → 20 → 18 Essence', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({ traits: traits({ learned: 'trt_thrifty' }) }));
        const result = await train(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.essenceSpent).toBe(18);
        expect(dbClient.deductEssence).toHaveBeenCalledWith(testUser.userId, 18, expect.any(Object));
      });

      it('Gentle (+2 happinessFlat) → train happinessChange −10 → −8', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({ traits: traits({ innate: 'trt_gentle' }) }));
        const result = await train(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.statChanges.happinessChange).toBe(-8);
      });

      it('Quick Learner (learned) + Mentor aura (awakened) stack: 50 → 60 XP', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({
          traits: traits({ learned: 'trt_quick_learner', awakened: 'trt_mentor' }),
        }));
        const result = await train(testUser, testTotemId);
        // ×1.10 (Quick Learner) × ×1.10 (Mentor on aura) → 60.5 → round → 61
        expect(result.data.xpGained).toBe(61);
      });

      it('no traits → baseline 50 XP, 20 cost, −10 happiness', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({ traits: traits() }));
        const result = await train(testUser, testTotemId);
        expect(result.data.xpGained).toBe(50);
        expect(result.data.essenceSpent).toBe(20);
        expect(result.data.statChanges.happinessChange).toBe(-10);
      });

      it('blocks training when too hungry (TOO_HUNGRY) WITHOUT charging essence', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({
          stats: { happiness: 50, hunger: 15, strength: 10, agility: 8, wisdom: 6 },
        }));
        const result = await train(testUser, testTotemId);
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('TOO_HUNGRY');
        expect(dbClient.deductEssence).not.toHaveBeenCalled();
      });

      it('cranky band (hunger 30): training allowed but 2× happiness loss (−20)', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({
          stats: { happiness: 50, hunger: 30, strength: 10, agility: 8, wisdom: 6 },
        }));
        const result = await train(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.statChanges.happinessChange).toBe(-20);
      });
    });

    describe('feed', () => {
      it('Hardy (+2 happinessFlat) → feed happinessChange +10 → +12', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({ traits: traits({ innate: 'trt_hardy' }) }));
        const result = await feed(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.statChanges.happinessChange).toBe(12);
      });

      it('Thrifty (−10% cost) → 10 → 9 Essence', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({ traits: traits({ learned: 'trt_thrifty' }) }));
        const result = await feed(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.essenceSpent).toBe(9);
      });

      it('feed grants a fixed +30 partial restore (hunger 20 → 50)', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({
          stats: { happiness: 50, hunger: 20, strength: 10, agility: 8, wisdom: 6 },
        }));
        const result = await feed(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.statChanges.hunger).toBe(50);
        expect(result.data.statChanges.hungerGained).toBe(30);
      });

      it('Diligent Forager widens the restore to +36 (hunger 20 → 56)', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({
          stats: { happiness: 50, hunger: 20, strength: 10, agility: 8, wisdom: 6 },
          traits: traits({ learned: 'trt_diligent_forager' }),
        }));
        const result = await feed(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.statChanges.hunger).toBe(56); // 20 + round(30 × 1.20)=36
      });

      it('does not overshoot the hunger cap of 100', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({
          stats: { happiness: 50, hunger: 90, strength: 10, agility: 8, wisdom: 6 },
        }));
        const result = await feed(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.statChanges.hunger).toBe(100);
        expect(result.data.statChanges.hungerGained).toBe(10);
      });
    });

    describe('treat', () => {
      it('Playful (+2 happinessFlat) → treat happinessChange +10 → +12', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({ traits: traits({ innate: 'trt_playful' }) }));
        const result = await treat(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.statChanges.happinessChange).toBe(12);
      });

      it('Thrifty (−10% cost) → 20 → 18 Essence', async () => {
        dbClient.getTotem.mockResolvedValue(makeTotem({ traits: traits({ learned: 'trt_thrifty' }) }));
        const result = await treat(testUser, testTotemId);
        expect(result.success).toBe(true);
        expect(result.data.essenceSpent).toBe(18);
      });
    });
  });

  // =============================================================================
  // BATCH 1: evolve passes rarityId + speciesId
  // =============================================================================

  describe('Batch 1 wire-up — evolve passes rarityId + speciesId', () => {
    it('evolve calls onTotemEvolved with rarityId and speciesId from totem', async () => {
      dbClient.getTotem.mockResolvedValue(makeTotem({
        experience: 600,
        rarityId: 2,
        speciesId: 0,
        stats: { happiness: 50, strength: 10, agility: 8, wisdom: 6 },
      }));
      await evolve(testUser, testTotemId);
      expect(achievementsService.onTotemEvolved).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({
          newStage: 1,
          totemId: testTotemId,
          rarityId: 2,
          speciesId: 0,
        })
      );
    });
  });
});
