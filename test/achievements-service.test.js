/**
 * Achievements Service Tests
 *
 * Tests for achievement progress tracking, milestone unlocking,
 * reward distribution, and trigger routing.
 */

// Mock db-client before requiring the service
jest.mock('../src/common/db-client', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  updateItem: jest.fn(),
  queryItems: jest.fn(),
  getUser: jest.fn(),
  getTotem: jest.fn(),
  updateTotem: jest.fn(),
  addEssence: jest.fn(),
  logTransaction: jest.fn(),
  TABLES: {
    USERS: 'TotemBound-Users',
    TOTEMS: 'TotemBound-Totems',
    ACHIEVEMENT_PROGRESS: 'TotemBound-AchievementProgress',
    TRANSACTIONS: 'TotemBound-Transactions',
  },
}));

const dbClient = require('../src/common/db-client');
const {
  // Constants
  ACHIEVEMENT_IDS,
  ACHIEVEMENT_MILESTONES,
  ONETIME_ACHIEVEMENTS,
  ONE_TIME_REWARDS,
  MILESTONE_REWARDS,
  // Core functions
  getAchievementProgress,
  getAllAchievementProgress,
  updateAchievementProgress,
  checkAndUnlockMilestone,
  // Reward functions
  getRewardConfig,
  distributeAchievementReward,
  // Main trigger
  checkAchievement,
  // Convenience helpers
  onUserSignup,
  onTotemAcquired,
  onTotemEvolved,
  onGameAction,
  onLoginStreak,
  onChallengeCompleted,
  onExpeditionCompleted,
} = require('../src/services/achievements-service');

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Achievements Service', () => {
  const testUserId = 'usr_test123';
  const testTotemId = 'ttm_test456';

  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.getItem.mockResolvedValue(null);
    dbClient.putItem.mockResolvedValue({});
    dbClient.updateItem.mockResolvedValue({});
    dbClient.queryItems.mockResolvedValue([]);
    dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2050 });
    dbClient.logTransaction.mockResolvedValue({});
    dbClient.getTotem.mockResolvedValue({ experience: 100 });
    dbClient.updateTotem.mockResolvedValue({});
  });

  // =============================================================================
  // CONSTANTS TESTS
  // =============================================================================

  describe('Achievement Constants', () => {
    it('should define 19 achievement IDs', () => {
      expect(Object.keys(ACHIEVEMENT_IDS)).toHaveLength(19);
    });

    it('should have all achievement IDs prefixed with ach_', () => {
      Object.values(ACHIEVEMENT_IDS).forEach(id => {
        expect(id).toMatch(/^ach_/);
      });
    });

    it('should define 8 one-time achievements', () => {
      expect(ONETIME_ACHIEVEMENTS).toHaveLength(8);
      expect(ONETIME_ACHIEVEMENTS).toContain(ACHIEVEMENT_IDS.RARE_COLLECTOR);
      expect(ONETIME_ACHIEVEMENTS).toContain(ACHIEVEMENT_IDS.EPIC_COLLECTOR);
      expect(ONETIME_ACHIEVEMENTS).toContain(ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR);
      expect(ONETIME_ACHIEVEMENTS).toContain(ACHIEVEMENT_IDS.CHALLENGE_INITIATE);
      expect(ONETIME_ACHIEVEMENTS).toContain(ACHIEVEMENT_IDS.EXPEDITION_EXPLORER);
    });

    it('should define milestone thresholds for 11 progression achievements', () => {
      expect(Object.keys(ACHIEVEMENT_MILESTONES)).toHaveLength(11);
    });

    it('should have ascending milestone thresholds', () => {
      Object.entries(ACHIEVEMENT_MILESTONES).forEach(([achId, thresholds]) => {
        for (let i = 1; i < thresholds.length; i++) {
          expect(thresholds[i]).toBeGreaterThan(thresholds[i - 1]);
        }
      });
    });

    it('should define collector progression milestones at 1, 3, 6, 12, 32, 64, 128, 256', () => {
      expect(ACHIEVEMENT_MILESTONES[ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION])
        .toEqual([1, 3, 6, 12, 32, 64, 128, 256]);
    });

    it('should define evolution milestones at stages 1-4', () => {
      expect(ACHIEVEMENT_MILESTONES[ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION])
        .toEqual([1, 2, 3, 4]);
    });
  });

  // =============================================================================
  // REWARD CONFIGURATION TESTS
  // =============================================================================

  describe('Reward Configuration', () => {
    it('should define rewards for all 5 one-time achievements', () => {
      ONETIME_ACHIEVEMENTS.forEach(achId => {
        expect(ONE_TIME_REWARDS[achId]).toBeDefined();
        expect(ONE_TIME_REWARDS[achId].essence).toBeGreaterThan(0);
        expect(ONE_TIME_REWARDS[achId].name).toBeDefined();
      });
    });

    it('should define milestone rewards matching milestone counts', () => {
      Object.keys(ACHIEVEMENT_MILESTONES).forEach(achId => {
        const milestoneCount = ACHIEVEMENT_MILESTONES[achId].length;
        const rewards = MILESTONE_REWARDS[achId];
        expect(rewards).toBeDefined();
        expect(rewards).toHaveLength(milestoneCount);
      });
    });

    it('should have escalating Essence rewards per milestone tier', () => {
      Object.values(MILESTONE_REWARDS).forEach(rewards => {
        for (let i = 1; i < rewards.length; i++) {
          expect(rewards[i].essence).toBeGreaterThanOrEqual(rewards[i - 1].essence);
        }
      });
    });

    it('should award correct one-time Rare Collector rewards', () => {
      const reward = ONE_TIME_REWARDS[ACHIEVEMENT_IDS.RARE_COLLECTOR];
      expect(reward.essence).toBe(50);
      expect(reward.xp).toBe(100);
      expect(reward.name).toBe('Rare Collector');
    });

    it('should award correct one-time Legendary Collector rewards', () => {
      const reward = ONE_TIME_REWARDS[ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR];
      expect(reward.essence).toBe(250);
      expect(reward.xp).toBe(500);
    });
  });

  // =============================================================================
  // getRewardConfig TESTS
  // =============================================================================

  describe('getRewardConfig', () => {
    it('should return one-time reward when milestoneIndex is null', () => {
      const config = getRewardConfig(ACHIEVEMENT_IDS.RARE_COLLECTOR, null);
      expect(config).toEqual({ essence: 50, xp: 100, name: 'Rare Collector' });
    });

    it('should return null for unknown achievement ID', () => {
      expect(getRewardConfig('ach_nonexistent', null)).toBeNull();
    });

    it('should return milestone reward at given index', () => {
      const config = getRewardConfig(ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION, 0);
      expect(config).toEqual({ essence: 10, xp: 0, name: 'Chosen Keeper' });
    });

    it('should return null for out-of-bounds milestone index', () => {
      expect(getRewardConfig(ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION, 99)).toBeNull();
    });

    it('should return last milestone reward correctly', () => {
      const milestones = MILESTONE_REWARDS[ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION];
      const config = getRewardConfig(ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION, milestones.length - 1);
      expect(config.essence).toBe(500);
      expect(config.name).toBe('Legendary Sage');
    });
  });

  // =============================================================================
  // distributeAchievementReward TESTS
  // =============================================================================

  describe('distributeAchievementReward', () => {
    it('should award Essence when essenceReward > 0', async () => {
      const result = await distributeAchievementReward(
        testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 'Rare Collector', 50, 0
      );

      expect(result.essence).toBe(50);
      expect(result.newEssenceBalance).toBe(2050);
      expect(dbClient.addEssence).toHaveBeenCalledWith(testUserId, 50, {
        type: 'reward_achievement',
        ref: ACHIEVEMENT_IDS.RARE_COLLECTOR,
        refType: 'achievement',
        refName: 'Rare Collector',
      });
    });

    it('should award XP to totem when xpReward > 0 and totemId provided', async () => {
      dbClient.getTotem.mockResolvedValue({ experience: 200 });

      const result = await distributeAchievementReward(
        testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 'Rare Collector', 0, 100, testTotemId
      );

      expect(result.xp).toBe(100);
      expect(result.newTotemExp).toBe(300);
      expect(dbClient.updateTotem).toHaveBeenCalledWith(testUserId, testTotemId, { experience: 300 });
      expect(dbClient.logTransaction).toHaveBeenCalledWith(testUserId, expect.objectContaining({
        type: 'reward_achievement_xp',
        currency: 'xp',
        amount: 100,
      }));
    });

    it('should not award XP if no totemId provided', async () => {
      const result = await distributeAchievementReward(
        testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 'Rare Collector', 0, 100, null
      );

      expect(result.xp).toBe(0);
      expect(dbClient.getTotem).not.toHaveBeenCalled();
    });

    it('should award both Essence and XP together', async () => {
      dbClient.getTotem.mockResolvedValue({ experience: 500 });

      const result = await distributeAchievementReward(
        testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 'Rare Collector', 50, 100, testTotemId
      );

      expect(result.essence).toBe(50);
      expect(result.xp).toBe(100);
      expect(dbClient.addEssence).toHaveBeenCalled();
      expect(dbClient.updateTotem).toHaveBeenCalled();
    });

    it('should handle addEssence failure gracefully', async () => {
      dbClient.addEssence.mockResolvedValue({ success: false, error: 'DB error' });

      const result = await distributeAchievementReward(
        testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 'Rare Collector', 50, 0
      );

      expect(result.essence).toBe(0);
    });

    it('should handle missing totem gracefully', async () => {
      dbClient.getTotem.mockResolvedValue(null);

      const result = await distributeAchievementReward(
        testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 'Rare Collector', 0, 100, testTotemId
      );

      expect(result.xp).toBe(0);
    });

    it('should include milestone suffix in ref when milestoneIndex provided', async () => {
      await distributeAchievementReward(
        testUserId, ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION, 'Chosen Keeper', 10, 0, null, 0
      );

      expect(dbClient.addEssence).toHaveBeenCalledWith(testUserId, 10, expect.objectContaining({
        ref: `${ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION}_m0`,
      }));
    });
  });

  // =============================================================================
  // getAchievementProgress / getAllAchievementProgress TESTS
  // =============================================================================

  describe('getAchievementProgress', () => {
    it('should query with correct pk/sk', async () => {
      await getAchievementProgress(testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR);

      expect(dbClient.getItem).toHaveBeenCalledWith('TotemBound-AchievementProgress', {
        pk: `USER#${testUserId}`,
        sk: `ACH#${ACHIEVEMENT_IDS.RARE_COLLECTOR}`,
      });
    });

    it('should return null when no progress exists', async () => {
      const result = await getAchievementProgress(testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR);
      expect(result).toBeNull();
    });

    it('should return existing progress record', async () => {
      const mockProgress = { currentValue: 5, milestoneIndex: 1, isComplete: false };
      dbClient.getItem.mockResolvedValue(mockProgress);

      const result = await getAchievementProgress(testUserId, ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION);
      expect(result).toEqual(mockProgress);
    });
  });

  describe('getAllAchievementProgress', () => {
    it('should query with ACH# prefix', async () => {
      await getAllAchievementProgress(testUserId);

      expect(dbClient.queryItems).toHaveBeenCalledWith(
        'TotemBound-AchievementProgress',
        'pk',
        `USER#${testUserId}`,
        { skPrefix: 'ACH#' }
      );
    });
  });

  // =============================================================================
  // updateAchievementProgress TESTS
  // =============================================================================

  describe('updateAchievementProgress', () => {
    it('should create new record when none exists', async () => {
      dbClient.getItem.mockResolvedValue(null);

      const result = await updateAchievementProgress(testUserId, ACHIEVEMENT_IDS.FEED_PROGRESSION, 5);

      expect(dbClient.putItem).toHaveBeenCalledWith('TotemBound-AchievementProgress', expect.objectContaining({
        pk: `USER#${testUserId}`,
        sk: `ACH#${ACHIEVEMENT_IDS.FEED_PROGRESSION}`,
        currentValue: 5,
        milestoneIndex: -1,
        isComplete: false,
      }));
    });

    it('should update existing record', async () => {
      dbClient.getItem.mockResolvedValue({
        pk: `USER#${testUserId}`,
        sk: `ACH#${ACHIEVEMENT_IDS.FEED_PROGRESSION}`,
        currentValue: 5,
      });

      await updateAchievementProgress(testUserId, ACHIEVEMENT_IDS.FEED_PROGRESSION, 10);

      expect(dbClient.updateItem).toHaveBeenCalledWith(
        'TotemBound-AchievementProgress',
        { pk: `USER#${testUserId}`, sk: `ACH#${ACHIEVEMENT_IDS.FEED_PROGRESSION}` },
        expect.objectContaining({ currentValue: 10 })
      );
    });
  });

  // =============================================================================
  // checkAndUnlockMilestone TESTS
  // =============================================================================

  describe('checkAndUnlockMilestone', () => {
    describe('One-time achievements', () => {
      it('should unlock one-time achievement and distribute rewards', async () => {
        const result = await checkAndUnlockMilestone(
          testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 1, testTotemId
        );

        expect(result.unlocked).toBe(true);
        expect(result.achievementId).toBe(ACHIEVEMENT_IDS.RARE_COLLECTOR);
        expect(result.milestone).toBe(0);
        expect(result.rewards.essence).toBe(50);
        // Should mark as complete in DB
        expect(dbClient.updateItem).toHaveBeenCalledWith(
          'TotemBound-AchievementProgress',
          expect.any(Object),
          expect.objectContaining({ isComplete: true, currentValue: 1 })
        );
      });

      it('should not re-unlock completed one-time achievement', async () => {
        dbClient.getItem.mockResolvedValue({
          pk: `USER#${testUserId}`,
          sk: `ACH#${ACHIEVEMENT_IDS.RARE_COLLECTOR}`,
          currentValue: 1,
          milestoneIndex: -1,
          isComplete: true,
        });

        const result = await checkAndUnlockMilestone(
          testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 1
        );

        expect(result.unlocked).toBe(false);
      });

      it('should not unlock one-time achievement with value 0', async () => {
        const result = await checkAndUnlockMilestone(
          testUserId, ACHIEVEMENT_IDS.RARE_COLLECTOR, 0
        );

        expect(result.unlocked).toBe(false);
      });
    });

    describe('Progression achievements', () => {
      it('should unlock first milestone of collector progression at count 1', async () => {
        const result = await checkAndUnlockMilestone(
          testUserId, ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION, 1
        );

        expect(result.unlocked).toBe(true);
        expect(result.newMilestones).toEqual([0]);
        expect(result.milestone).toBe(0);
        expect(result.rewards.essence).toBe(10); // 'Chosen Keeper' = 10 Essence
      });

      it('should unlock multiple milestones at once when value jumps', async () => {
        // Value of 6 should unlock milestones 0 (1), 1 (3), and 2 (6)
        const result = await checkAndUnlockMilestone(
          testUserId, ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION, 6
        );

        expect(result.unlocked).toBe(true);
        expect(result.newMilestones).toEqual([0, 1, 2]);
        expect(result.milestone).toBe(2); // Last unlocked
        // 10 + 25 + 50 = 85 Essence total
        expect(result.rewards.essence).toBe(85);
      });

      it('should only unlock new milestones beyond current index', async () => {
        // Already at milestone 1 (3 totems), now at 12 (should unlock 2 and 3)
        dbClient.getItem.mockResolvedValue({
          pk: `USER#${testUserId}`,
          sk: `ACH#${ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION}`,
          currentValue: 3,
          milestoneIndex: 1,
          isComplete: false,
          milestones: [
            { index: 0, unlockedAt: '2024-01-01T00:00:00.000Z' },
            { index: 1, unlockedAt: '2024-01-05T00:00:00.000Z' },
          ],
        });

        const result = await checkAndUnlockMilestone(
          testUserId, ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION, 12
        );

        expect(result.unlocked).toBe(true);
        expect(result.newMilestones).toEqual([2, 3]); // milestones at 6 and 12
        expect(result.rewards.essence).toBe(150); // 50 + 100
      });

      it('should not unlock when value is below next milestone', async () => {
        dbClient.getItem.mockResolvedValue({
          pk: `USER#${testUserId}`,
          sk: `ACH#${ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION}`,
          currentValue: 1,
          milestoneIndex: 0,
          isComplete: false,
          milestones: [{ index: 0, unlockedAt: '2024-01-01T00:00:00.000Z' }],
        });

        const result = await checkAndUnlockMilestone(
          testUserId, ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION, 2
        );

        expect(result.unlocked).toBe(false);
        expect(result.newMilestones).toEqual([]);
        // Should still update currentValue
        expect(dbClient.updateItem).toHaveBeenCalledWith(
          'TotemBound-AchievementProgress',
          expect.any(Object),
          expect.objectContaining({ currentValue: 2 })
        );
      });

      it('should accumulate XP rewards with totemId', async () => {
        dbClient.getTotem.mockResolvedValue({ experience: 100 });

        // Evolution progression milestones include XP
        const result = await checkAndUnlockMilestone(
          testUserId, ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION, 1, testTotemId
        );

        expect(result.unlocked).toBe(true);
        expect(result.rewards.xp).toBe(100); // First Evolution = 100 XP
        expect(result.rewards.essence).toBe(25);
      });
    });
  });

  // =============================================================================
  // checkAchievement (MAIN TRIGGER) TESTS
  // =============================================================================

  describe('checkAchievement', () => {
    it('should return empty array for unknown trigger', async () => {
      const results = await checkAchievement(testUserId, 'UNKNOWN_TRIGGER', {});
      expect(results).toEqual([]);
    });

    it('should handle USER_SIGNUP trigger', async () => {
      const results = await checkAchievement(testUserId, 'USER_SIGNUP', { totemCount: 1 });

      // USER_SIGNUP maps to COLLECTOR_PROGRESSION
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].achievementId).toBe(ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION);
      expect(results[0].unlocked).toBe(true);
    });

    it('should check rarity-specific achievements on TOTEM_ACQUIRED', async () => {
      const results = await checkAchievement(testUserId, 'TOTEM_ACQUIRED', {
        rarityId: 2, // Rare
        totemCount: 5,
        totemId: testTotemId,
      });

      // Should trigger RARE_COLLECTOR (one-time) + COLLECTOR_PROGRESSION (milestone at 3)
      const rareResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.RARE_COLLECTOR);
      expect(rareResult).toBeDefined();
      expect(rareResult.unlocked).toBe(true);
    });

    it('should not trigger RARE_COLLECTOR for common totem', async () => {
      const results = await checkAchievement(testUserId, 'TOTEM_ACQUIRED', {
        rarityId: 0, // Common
        totemCount: 1,
      });

      const rareResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.RARE_COLLECTOR);
      expect(rareResult).toBeUndefined();
    });

    it('should trigger EPIC_COLLECTOR for epic totem', async () => {
      const results = await checkAchievement(testUserId, 'TOTEM_ACQUIRED', {
        rarityId: 3, // Epic
        totemCount: 1,
      });

      const epicResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.EPIC_COLLECTOR);
      expect(epicResult).toBeDefined();
      expect(epicResult.unlocked).toBe(true);
    });

    it('should trigger LEGENDARY_COLLECTOR for legendary totem', async () => {
      const results = await checkAchievement(testUserId, 'TOTEM_ACQUIRED', {
        rarityId: 4, // Legendary
        totemCount: 1,
      });

      const legendaryResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR);
      expect(legendaryResult).toBeDefined();
      expect(legendaryResult.unlocked).toBe(true);
    });

    it('should handle TOTEM_EVOLVED trigger', async () => {
      dbClient.getTotem.mockResolvedValue({ experience: 500 });

      const results = await checkAchievement(testUserId, 'TOTEM_EVOLVED', {
        newStage: 1,
        totemId: testTotemId,
      });

      const evoResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION);
      expect(evoResult).toBeDefined();
      expect(evoResult.unlocked).toBe(true);
    });

    it('should handle ACTION_FEED trigger', async () => {
      // Feed count 100 = first milestone
      const results = await checkAchievement(testUserId, 'ACTION_FEED', {
        totalFeedCount: 100,
        totemId: testTotemId,
      });

      const feedResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.FEED_PROGRESSION);
      expect(feedResult).toBeDefined();
      expect(feedResult.unlocked).toBe(true);
    });

    it('should handle ACTION_TRAIN trigger', async () => {
      const results = await checkAchievement(testUserId, 'ACTION_TRAIN', {
        totalTrainCount: 100,
      });

      const trainResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.TRAIN_PROGRESSION);
      expect(trainResult).toBeDefined();
    });

    it('should handle ACTION_TREAT trigger', async () => {
      const results = await checkAchievement(testUserId, 'ACTION_TREAT', {
        totalTreatCount: 100,
      });

      const treatResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.TREAT_PROGRESSION);
      expect(treatResult).toBeDefined();
    });

    it('should handle LOGIN_STREAK trigger at 7-day milestone', async () => {
      const results = await checkAchievement(testUserId, 'LOGIN_STREAK', { streak: 7 });

      const loginResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.LOGIN_PROGRESSION);
      expect(loginResult).toBeDefined();
      expect(loginResult.unlocked).toBe(true);
    });

    it('should handle CHALLENGE_COMPLETED trigger (first challenge)', async () => {
      const results = await checkAchievement(testUserId, 'CHALLENGE_COMPLETED', {
        totalChallengeCount: 1,
        totemId: testTotemId,
      });

      const initiateResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.CHALLENGE_INITIATE);
      expect(initiateResult).toBeDefined();
      expect(initiateResult.unlocked).toBe(true);
    });

    it('should handle CHALLENGE_COMPLETED trigger (progression milestone)', async () => {
      // Mark CHALLENGE_INITIATE as already complete
      dbClient.getItem.mockImplementation((table, key) => {
        if (key.sk === `ACH#${ACHIEVEMENT_IDS.CHALLENGE_INITIATE}`) {
          return Promise.resolve({ isComplete: true, currentValue: 1, milestoneIndex: -1 });
        }
        return Promise.resolve(null);
      });

      const results = await checkAchievement(testUserId, 'CHALLENGE_COMPLETED', {
        totalChallengeCount: 10,
      });

      const progressResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.CHALLENGE_PROGRESSION);
      expect(progressResult).toBeDefined();
      expect(progressResult.unlocked).toBe(true);
    });

    it('should handle EXPEDITION_COMPLETED trigger (first expedition)', async () => {
      const results = await checkAchievement(testUserId, 'EXPEDITION_COMPLETED', {
        totalExpeditionCount: 1,
        totemId: testTotemId,
      });

      const explorerResult = results.find(r => r.achievementId === ACHIEVEMENT_IDS.EXPEDITION_EXPLORER);
      expect(explorerResult).toBeDefined();
      expect(explorerResult.unlocked).toBe(true);
    });

    it('should handle errors in individual achievements gracefully', async () => {
      // Force an error on the first achievement check
      dbClient.getItem.mockRejectedValueOnce(new Error('DB error'));

      const results = await checkAchievement(testUserId, 'TOTEM_ACQUIRED', {
        rarityId: 2,
        totemCount: 5,
      });

      // Should still process remaining achievements despite one failing
      expect(Array.isArray(results)).toBe(true);
    });

    it('should not trigger when value is 0', async () => {
      const results = await checkAchievement(testUserId, 'ACTION_FEED', {
        totalFeedCount: 0,
      });

      expect(results).toEqual([]);
    });
  });

  // =============================================================================
  // CONVENIENCE HELPER TESTS
  // =============================================================================

  describe('Convenience Helpers', () => {
    describe('onUserSignup', () => {
      it('should call checkAchievement with USER_SIGNUP and totemCount 1', async () => {
        const results = await onUserSignup(testUserId, testTotemId);
        expect(Array.isArray(results)).toBe(true);
        // Should unlock first collector milestone (1 totem)
        expect(results.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('onTotemAcquired', () => {
      it('should pass rarityId and totalTotemCount', async () => {
        const results = await onTotemAcquired(testUserId, {
          rarityId: 2,
          totalTotemCount: 5,
          totemId: testTotemId,
        });

        expect(Array.isArray(results)).toBe(true);
      });
    });

    describe('onTotemEvolved', () => {
      it('should pass newStage and totemId', async () => {
        dbClient.getTotem.mockResolvedValue({ experience: 500 });

        const results = await onTotemEvolved(testUserId, {
          newStage: 2,
          totemId: testTotemId,
        });

        expect(Array.isArray(results)).toBe(true);
      });
    });

    describe('onGameAction', () => {
      it('should map feed action correctly', async () => {
        const results = await onGameAction(testUserId, 'feed', 100, testTotemId);
        expect(Array.isArray(results)).toBe(true);
      });

      it('should map train action correctly', async () => {
        const results = await onGameAction(testUserId, 'train', 100, testTotemId);
        expect(Array.isArray(results)).toBe(true);
      });

      it('should map treat action correctly', async () => {
        const results = await onGameAction(testUserId, 'treat', 100, testTotemId);
        expect(Array.isArray(results)).toBe(true);
      });

      it('should return empty for unknown action type', async () => {
        const results = await onGameAction(testUserId, 'unknown', 100);
        expect(results).toEqual([]);
      });
    });

    describe('onLoginStreak', () => {
      it('should pass streak value', async () => {
        const results = await onLoginStreak(testUserId, 7);
        expect(Array.isArray(results)).toBe(true);
      });
    });

    describe('onChallengeCompleted', () => {
      it('should pass totalChallengeCount and totemId', async () => {
        const results = await onChallengeCompleted(testUserId, 1, testTotemId);
        expect(Array.isArray(results)).toBe(true);
      });
    });

    describe('onExpeditionCompleted', () => {
      it('should pass totalExpeditionCount and totemId', async () => {
        const results = await onExpeditionCompleted(testUserId, 1, testTotemId);
        expect(Array.isArray(results)).toBe(true);
      });
    });
  });
});
