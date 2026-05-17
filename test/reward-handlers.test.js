/**
 * Reward Handler Tests
 *
 * Tests for reward route handlers:
 * - claim-daily.js
 * - claim-weekly.js
 * - claim-tutorial.js
 * - status.js
 * - purchase-protection.js
 */

// Mock db-client
jest.mock('../src/common/db-client', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  updateItem: jest.fn(),
  deductEssence: jest.fn(),
  logTransaction: jest.fn(),
  getUser: jest.fn(),
  TABLES: {
    REWARDS_CLAIMS: 'TotemBound-RewardsClaims',
  },
}));

// Mock rewards service
jest.mock('../src/services/rewards-service', () => ({
  claimDailyReward: jest.fn(),
  claimWeeklyReward: jest.fn(),
  claimTutorialReward: jest.fn(),
  getTutorialProgress: jest.fn(),
  getRewardStatus: jest.fn(),
}));

// Mock achievements service
jest.mock('../src/services/achievements-service', () => ({
  getAchievementProgress: jest.fn(),
}));

const dbClient = require('../src/common/db-client');
const rewardsService = require('../src/services/rewards-service');
const achievementsService = require('../src/services/achievements-service');
const { claimDaily } = require('../src/functions/rewards/claim-daily');
const { claimWeekly } = require('../src/functions/rewards/claim-weekly');
const { claimTutorial, getTutorialProgress } = require('../src/functions/rewards/claim-tutorial');
const { getStatus } = require('../src/functions/rewards/status');
const { purchaseProtection, PROTECTION_TIERS } = require('../src/functions/rewards/purchase-protection');

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123', tier: 'free' };

// =============================================================================
// TESTS
// =============================================================================

describe('Reward Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.getItem.mockResolvedValue(null);
    dbClient.putItem.mockResolvedValue({});
    dbClient.updateItem.mockResolvedValue({});
    dbClient.deductEssence.mockResolvedValue({ success: true, newBalance: 1000 });
    dbClient.logTransaction.mockResolvedValue({});
    dbClient.getUser.mockResolvedValue({ userId: testUser.userId });
  });

  // =============================================================================
  // CLAIM DAILY TESTS
  // =============================================================================

  describe('claimDaily', () => {
    it('should claim daily reward successfully', async () => {
      rewardsService.claimDailyReward.mockResolvedValue({
        success: true,
        reward: { totalAmount: 15, essence: 15, bonusAmount: 5 },
        newStreak: 3,
        nextClaimTime: '2024-01-16T00:00:00.000Z',
      });

      const result = await claimDaily(testUser);
      expect(result.success).toBe(true);
      expect(result.data.newStreak).toBe(3);
      expect(result.data.message).toContain('Daily reward claimed');
    });

    it('should return UNAUTHORIZED when user missing', async () => {
      const result = await claimDaily(null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('UNAUTHORIZED');
    });

    it('should return UNAUTHORIZED when userId missing', async () => {
      const result = await claimDaily({});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('UNAUTHORIZED');
    });

    it('should handle service errors', async () => {
      rewardsService.claimDailyReward.mockResolvedValue({
        success: false,
        error: 'Daily reward not yet available',
        nextClaimAt: '2024-01-16T00:00:00.000Z',
        remainingMs: 3600000,
      });

      const result = await claimDaily(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('CLAIM_FAILED');
    });

    it('should handle exceptions gracefully', async () => {
      rewardsService.claimDailyReward.mockRejectedValue(new Error('DB error'));
      const result = await claimDaily(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });

    it('should include streak info in response', async () => {
      rewardsService.claimDailyReward.mockResolvedValue({
        success: true,
        reward: { totalAmount: 10, bonusAmount: 0, streakAtClaim: 1 },
        newStreak: 1,
        nextClaimTime: '2024-01-16T00:00:00.000Z',
      });

      const result = await claimDaily(testUser);
      expect(result.data.newStreak).toBe(1);
      expect(result.data.reward.streakAtClaim).toBe(1);
      expect(result.data.nextClaimAt).toBeDefined();
      expect(result.data.nextClaimTime).toBeDefined();
    });
  });

  // =============================================================================
  // CLAIM WEEKLY TESTS
  // =============================================================================

  describe('claimWeekly', () => {
    it('should claim weekly reward successfully', async () => {
      rewardsService.claimWeeklyReward.mockResolvedValue({
        success: true,
        reward: { totalAmount: 110, bonusAmount: 10 },
        newStreak: 2,
        newBalance: 1110,
        nextClaimTime: '2024-01-22T00:00:00.000Z',
      });

      const result = await claimWeekly(testUser);
      expect(result.success).toBe(true);
      expect(result.data.newStreak).toBe(2);
      expect(result.data.message).toContain('Weekly reward claimed');
    });

    it('should return UNAUTHORIZED when user missing', async () => {
      const result = await claimWeekly(null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('UNAUTHORIZED');
    });

    it('should handle service error with daily streak info', async () => {
      rewardsService.claimWeeklyReward.mockResolvedValue({
        success: false,
        error: 'Weekly reward not yet available',
        dailyStreakRequired: 7,
        currentDailyStreak: 3,
      });

      const result = await claimWeekly(testUser);
      expect(result.success).toBe(false);
    });

    it('should handle exceptions gracefully', async () => {
      rewardsService.claimWeeklyReward.mockRejectedValue(new Error('Timeout'));
      const result = await claimWeekly(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // =============================================================================
  // CLAIM TUTORIAL TESTS
  // =============================================================================

  describe('claimTutorial', () => {
    it('should claim tutorial step 1 successfully', async () => {
      rewardsService.claimTutorialReward.mockResolvedValue({
        success: true,
        reward: { step: 1, id: 'rwd_tutorial-1-signup', name: 'Claim Your Spiritkeeper Reward', essenceReward: 25, experienceReward: 0 },
        newBalance: 2025,
        totemId: null,
        totemExperience: null,
      });

      const result = await claimTutorial(testUser, { step: 1 });
      expect(result.success).toBe(true);
      expect(result.data.reward.step).toBe(1);
      expect(result.data.message).toContain('+25 Essence');
    });

    it('should include XP in message for steps with XP', async () => {
      rewardsService.claimTutorialReward.mockResolvedValue({
        success: true,
        reward: { step: 2, essenceReward: 50, experienceReward: 100 },
        newBalance: 2075,
        totemId: 'ttm_abc',
        totemExperience: 100,
      });

      const result = await claimTutorial(testUser, { step: 2, totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(result.data.message).toContain('+100 XP');
    });

    it('should return UNAUTHORIZED when user missing', async () => {
      const result = await claimTutorial(null, { step: 1 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('UNAUTHORIZED');
    });

    it('should return MISSING_STEP when step not provided', async () => {
      const result = await claimTutorial(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_STEP');
    });

    it('should return INVALID_STEP for step 0', async () => {
      const result = await claimTutorial(testUser, { step: 0 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_STEP');
    });

    it('should return INVALID_STEP for step 7', async () => {
      const result = await claimTutorial(testUser, { step: 7 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_STEP');
    });

    it('should return INVALID_STEP for non-numeric step', async () => {
      const result = await claimTutorial(testUser, { step: 'abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_STEP');
    });

    it('should handle ALREADY_CLAIMED error from service', async () => {
      rewardsService.claimTutorialReward.mockResolvedValue({
        success: false,
        error: 'Tutorial step 1 has already been claimed',
      });

      const result = await claimTutorial(testUser, { step: 1 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ALREADY_CLAIMED');
    });

    it('should handle TOTEM_REQUIRED error from service', async () => {
      rewardsService.claimTutorialReward.mockResolvedValue({
        success: false,
        error: 'Tutorial step 2 requires a totemId',
      });

      const result = await claimTutorial(testUser, { step: 2 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('TOTEM_REQUIRED');
    });

    it('should handle NOT_FOUND error from service', async () => {
      rewardsService.claimTutorialReward.mockResolvedValue({
        success: false,
        error: 'Totem ttm_abc not found',
      });

      const result = await claimTutorial(testUser, { step: 2, totemId: 'ttm_abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should handle exceptions gracefully', async () => {
      rewardsService.claimTutorialReward.mockRejectedValue(new Error('DB error'));
      const result = await claimTutorial(testUser, { step: 1 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });

    it('should parse string step as number', async () => {
      rewardsService.claimTutorialReward.mockResolvedValue({
        success: true,
        reward: { step: 3, essenceReward: 20, experienceReward: 150 },
        newBalance: 2045,
        totemId: 'ttm_abc',
        totemExperience: 150,
      });

      const result = await claimTutorial(testUser, { step: '3', totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(rewardsService.claimTutorialReward).toHaveBeenCalledWith(testUser.userId, 3, 'ttm_abc');
    });
  });

  // =============================================================================
  // GET TUTORIAL PROGRESS TESTS
  // =============================================================================

  describe('getTutorialProgress', () => {
    it('should return tutorial progress', async () => {
      rewardsService.getTutorialProgress.mockResolvedValue({
        success: true,
        completedSteps: [1, 2],
        totalSteps: 6,
        nextStep: 3,
        rewards: {},
        totalEssenceEarned: 75,
        totalExperienceEarned: 100,
      });

      const result = await getTutorialProgress(testUser);
      expect(result.success).toBe(true);
      expect(result.data.completedSteps).toEqual([1, 2]);
      expect(result.data.nextStep).toBe(3);
    });

    it('should return UNAUTHORIZED when user missing', async () => {
      const result = await getTutorialProgress(null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('UNAUTHORIZED');
    });

    it('should handle service error', async () => {
      rewardsService.getTutorialProgress.mockResolvedValue({
        success: false,
        error: 'User not found',
      });

      const result = await getTutorialProgress(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('FETCH_FAILED');
    });

    it('should handle exceptions gracefully', async () => {
      rewardsService.getTutorialProgress.mockRejectedValue(new Error('DB error'));
      const result = await getTutorialProgress(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // =============================================================================
  // GET STATUS TESTS
  // =============================================================================

  describe('getStatus', () => {
    it('should return daily and weekly status', async () => {
      rewardsService.getRewardStatus.mockResolvedValue({
        success: true,
        daily: { canClaim: true, currentStreak: 5, longestStreak: 10 },
        weekly: { canClaim: false, currentStreak: 2, longestStreak: 4 },
      });
      achievementsService.getAchievementProgress.mockResolvedValue(null);

      const result = await getStatus(testUser);
      expect(result.success).toBe(true);
      expect(result.data.daily.canClaim).toBe(true);
      expect(result.data.daily.streakDays).toBe(5);
      expect(result.data.weekly.canClaim).toBe(false);
    });

    it('should include protection charge count when charges held', async () => {
      rewardsService.getRewardStatus.mockResolvedValue({
        success: true,
        daily: { canClaim: true, currentStreak: 10 },
        weekly: { canClaim: false },
      });
      dbClient.getItem.mockImplementation(async (table, key) => {
        if (key.sk === 'STREAK#daily') return { protectionCharges: 3 };
        return null;
      });
      achievementsService.getAchievementProgress.mockResolvedValue(null);

      const result = await getStatus(testUser);
      expect(result.data.daily.isProtected).toBe(true);
      expect(result.data.daily.protectionCharges).toBe(3);
    });

    it('should treat legacy active protectionExpiry as 1 charge (migration)', async () => {
      rewardsService.getRewardStatus.mockResolvedValue({
        success: true,
        daily: { canClaim: true, currentStreak: 10 },
        weekly: { canClaim: false },
      });
      dbClient.getItem.mockImplementation(async (table, key) => {
        if (key.sk === 'STREAK#daily') {
          // Legacy record: no charges field, but has an active expiry.
          return { protectionExpiry: new Date(Date.now() + 86400000).toISOString() };
        }
        return null;
      });
      achievementsService.getAchievementProgress.mockResolvedValue(null);

      const result = await getStatus(testUser);
      expect(result.data.daily.isProtected).toBe(true);
      expect(result.data.daily.protectionCharges).toBe(1);
    });

    it('should report no protection when neither charges nor active expiry exist', async () => {
      rewardsService.getRewardStatus.mockResolvedValue({
        success: true,
        daily: { canClaim: true, currentStreak: 10 },
        weekly: { canClaim: false },
      });
      dbClient.getItem.mockImplementation(async (table, key) => {
        if (key.sk === 'STREAK#daily') {
          return {
            protectionCharges: 0,
            protectionExpiry: new Date(Date.now() - 86400000).toISOString(), // expired
          };
        }
        return null;
      });
      achievementsService.getAchievementProgress.mockResolvedValue(null);

      const result = await getStatus(testUser);
      expect(result.data.daily.isProtected).toBe(false);
      expect(result.data.daily.protectionCharges).toBe(0);
    });

    it('should check weekly unlock via achievement milestoneIndex', async () => {
      rewardsService.getRewardStatus.mockResolvedValue({
        success: true,
        daily: { canClaim: true },
        weekly: { canClaim: false },
      });
      achievementsService.getAchievementProgress.mockResolvedValue({
        milestoneIndex: 0, // >= 0 means Week Warrior unlocked
      });

      const result = await getStatus(testUser);
      expect(result.data.weekly.isUnlocked).toBe(true);
    });

    it('should show weekly locked when no milestone reached', async () => {
      rewardsService.getRewardStatus.mockResolvedValue({
        success: true,
        daily: { canClaim: true },
        weekly: { canClaim: false },
      });
      achievementsService.getAchievementProgress.mockResolvedValue({
        milestoneIndex: -1, // no milestones unlocked
      });

      const result = await getStatus(testUser);
      expect(result.data.weekly.isUnlocked).toBe(false);
    });

    it('should return UNAUTHORIZED when user missing', async () => {
      const result = await getStatus(null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('UNAUTHORIZED');
    });

    it('should handle service error', async () => {
      rewardsService.getRewardStatus.mockResolvedValue({
        success: false,
        error: 'User not found',
      });
      achievementsService.getAchievementProgress.mockResolvedValue(null);

      const result = await getStatus(testUser);
      expect(result.success).toBe(false);
    });

    it('should handle exceptions gracefully', async () => {
      rewardsService.getRewardStatus.mockRejectedValue(new Error('DB error'));
      const result = await getStatus(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // =============================================================================
  // PURCHASE PROTECTION TESTS
  // =============================================================================

  describe('purchaseProtection (charge model)', () => {
    describe('Configuration', () => {
      it('should have daily protection tiers in charge form', () => {
        expect(PROTECTION_TIERS.daily).toHaveLength(2);
        expect(PROTECTION_TIERS.daily[0]).toMatchObject({ cost: 50, charges: 1, requiredStreak: 7 });
        expect(PROTECTION_TIERS.daily[1]).toMatchObject({ cost: 250, charges: 7, requiredStreak: 14 });
      });

      it('should have weekly protection tier in charge form', () => {
        expect(PROTECTION_TIERS.weekly).toHaveLength(1);
        expect(PROTECTION_TIERS.weekly[0]).toMatchObject({ cost: 500, charges: 2, requiredStreak: 4 });
      });
    });

    describe('Daily protection purchase', () => {
      beforeEach(() => {
        dbClient.getItem.mockResolvedValue({
          pk: `USER#${testUser.userId}`,
          sk: 'STREAK#daily',
          currentStreak: 10,
        });
      });

      it('should purchase tier 0 and grant 1 charge', async () => {
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({
          rewardType: 'daily',
          tier: 0,
          cost: 50,
          chargesAdded: 1,
          protectionCharges: 1,
        });
      });

      it('should deduct Essence for protection', async () => {
        await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(dbClient.deductEssence).toHaveBeenCalledWith(
          testUser.userId, 50,
          expect.objectContaining({ type: 'protection_purchase' })
        );
      });

      it('should persist charges and clear legacy expiry on the streak record', async () => {
        await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(dbClient.updateItem).toHaveBeenCalledWith(
          'TotemBound-RewardsClaims',
          expect.objectContaining({ sk: 'STREAK#daily' }),
          expect.objectContaining({
            protectionCharges: 1,
            protectionTier: 0,
            protectionExpiry: null,
          })
        );
      });

      it('should pass audit metadata to deductEssence (logs via auto-log path)', async () => {
        await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(dbClient.deductEssence).toHaveBeenCalledWith(
          testUser.userId, 50,
          expect.objectContaining({
            type: 'protection_purchase',
            refType: 'protection',
            refName: expect.stringContaining('Daily Protection'),
          }),
        );
      });

      it('should stack charges across multiple purchases', async () => {
        // User already has 1 charge banked
        dbClient.getItem.mockResolvedValue({ currentStreak: 14, protectionCharges: 1 });
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(true);
        expect(result.data.protectionCharges).toBe(2);
      });

      it('tier 1 grants 7 charges in one purchase', async () => {
        dbClient.getItem.mockResolvedValue({ currentStreak: 14 });
        const result = await purchaseProtection(testUser, { tier: 1 }, 'daily');
        expect(result.success).toBe(true);
        expect(result.data.chargesAdded).toBe(7);
        expect(result.data.protectionCharges).toBe(7);
      });
    });

    describe('Validation', () => {
      it('should return UNAUTHORIZED when user missing', async () => {
        const result = await purchaseProtection(null, { tier: 0 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('UNAUTHORIZED');
      });

      it('should reject invalid reward type', async () => {
        const result = await purchaseProtection(testUser, { tier: 0 }, 'monthly');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INVALID_TYPE');
      });

      it('should reject invalid tier', async () => {
        const result = await purchaseProtection(testUser, { tier: 5 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INVALID_TIER');
      });

      it('should return NO_STREAK when no streak exists', async () => {
        dbClient.getItem.mockResolvedValue(null);
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('NO_STREAK');
      });

      it('should return INSUFFICIENT_STREAK when streak too low', async () => {
        dbClient.getItem.mockResolvedValue({ currentStreak: 3 }); // need 7
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INSUFFICIENT_STREAK');
      });

      it('should return CHARGES_FULL when buying would exceed cap', async () => {
        // Daily cap is 7. Already has 7, attempt to add 1 more.
        dbClient.getItem.mockResolvedValue({ currentStreak: 14, protectionCharges: 7 });
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('CHARGES_FULL');
        expect(result.error.protectionCharges).toBe(7);
      });

      it('should return CHARGES_FULL when stacking tier 1 onto existing charges', async () => {
        // 1 banked + 7 from tier 1 = 8, > 7 cap.
        dbClient.getItem.mockResolvedValue({ currentStreak: 14, protectionCharges: 1 });
        const result = await purchaseProtection(testUser, { tier: 1 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('CHARGES_FULL');
      });

      it('should treat legacy active expiry as 1 charge for cap math', async () => {
        // Legacy field present, no charges field. Counts as 1.
        // Buying tier 0 (1 charge) → 2 total, well under 7-cap.
        dbClient.getItem.mockResolvedValue({
          currentStreak: 10,
          protectionExpiry: new Date(Date.now() + 86400000).toISOString(),
        });
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(true);
        expect(result.data.protectionCharges).toBe(2);
      });

      it('should ignore expired legacy expiry (not counted toward cap)', async () => {
        dbClient.getItem.mockResolvedValue({
          currentStreak: 10,
          protectionExpiry: new Date(Date.now() - 86400000).toISOString(),
        });
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(true);
        expect(result.data.protectionCharges).toBe(1);
      });

      it('should return INSUFFICIENT_ESSENCE when not enough balance', async () => {
        dbClient.getItem.mockResolvedValue({ currentStreak: 10 });
        dbClient.deductEssence.mockResolvedValue({ success: false, currentBalance: 30 });
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INSUFFICIENT_ESSENCE');
      });

      it('should handle exceptions gracefully', async () => {
        dbClient.getItem.mockRejectedValue(new Error('DB error'));
        const result = await purchaseProtection(testUser, { tier: 0 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INTERNAL_ERROR');
      });
    });

    describe('Daily tier 1', () => {
      it('rejects tier 1 when streak is between 7 and 13', async () => {
        dbClient.getItem.mockResolvedValue({ currentStreak: 10 });
        const result = await purchaseProtection(testUser, { tier: 1 }, 'daily');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INSUFFICIENT_STREAK');
        expect(result.error.message).toContain('14');
      });
    });

    describe('Weekly protection', () => {
      it('purchases weekly tier 0 and grants 2 charges', async () => {
        dbClient.getItem.mockResolvedValue({ currentStreak: 5 });
        const result = await purchaseProtection(testUser, { tier: 0 }, 'weekly');
        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ cost: 500, chargesAdded: 2, protectionCharges: 2, maxCharges: 2 });
      });

      it('rejects tier 1 for weekly (only tier 0 exists)', async () => {
        const result = await purchaseProtection(testUser, { tier: 1 }, 'weekly');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INVALID_TIER');
      });

      it('rejects weekly when streak below 4 weeks', async () => {
        dbClient.getItem.mockResolvedValue({ currentStreak: 3 });
        const result = await purchaseProtection(testUser, { tier: 0 }, 'weekly');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('INSUFFICIENT_STREAK');
        expect(result.error.message).toContain('week');
      });

      it('rejects when weekly cap (2) would be exceeded', async () => {
        dbClient.getItem.mockResolvedValue({ currentStreak: 5, protectionCharges: 1 });
        const result = await purchaseProtection(testUser, { tier: 0 }, 'weekly');
        expect(result.success).toBe(false);
        expect(result.error.code).toBe('CHARGES_FULL');
      });

      it('updates STREAK#weekly (not daily) on purchase', async () => {
        dbClient.getItem.mockResolvedValue({ currentStreak: 5 });
        await purchaseProtection(testUser, { tier: 0 }, 'weekly');
        expect(dbClient.updateItem).toHaveBeenCalledWith(
          'TotemBound-RewardsClaims',
          expect.objectContaining({ sk: 'STREAK#weekly' }),
          expect.objectContaining({
            protectionCharges: 2,
            protectionTier: 0,
            protectionExpiry: null,
          })
        );
      });
    });
  });
});
