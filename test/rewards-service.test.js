/**
 * Rewards Service Tests
 *
 * Tests for daily and weekly reward claiming with streak tracking.
 * Daily rewards use UTC midnight reset (not rolling 24h).
 * Weekly rewards use rolling 7-day cooldown.
 */

// Mock the db-client module
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
    SHOP: 'TotemBound-Shop',
    TRANSACTIONS: 'TotemBound-Transactions',
    ACHIEVEMENT_PROGRESS: 'TotemBound-AchievementProgress',
    CHALLENGE_PROGRESS: 'TotemBound-ChallengeProgress',
    EXPEDITION_STATE: 'TotemBound-ExpeditionState',
    REWARD_STATE: 'TotemBound-RewardState',
    REWARDS_CLAIMS: 'TotemBound-RewardsClaims',
  },
}));

// Mock achievements service (claimDailyReward calls onLoginStreak)
jest.mock('../src/services/achievements-service', () => ({
  onLoginStreak: jest.fn().mockResolvedValue([]),
}));

const dbClient = require('../src/common/db-client');
const achievementsService = require('../src/services/achievements-service');
const {
  claimDailyReward,
  claimWeeklyReward,
  getRewardStatus,
  claimTutorialReward,
  getTutorialProgress,
  isTutorialStepClaimed,
  calculateDailyBonus,
  calculateWeeklyBonus,
  calculateRewardAmount,
  canClaimReward,
  shouldResetStreak,
  REWARD_CONFIG,
} = require('../src/services/rewards-service');

// =============================================================================
// HELPERS - Deterministic UTC dates for daily reward tests
// =============================================================================

/** Get UTC midnight for N days ago */
function utcMidnight(daysAgo = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 0, 0, 0, 0));
}

/** Get a timestamp N days ago at a specific hour (UTC) */
function utcTime(daysAgo, hour) {
  return new Date(utcMidnight(daysAgo).getTime() + hour * 60 * 60 * 1000).toISOString();
}

describe('Rewards Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock implementations
    dbClient.getUser.mockResolvedValue({
      id: 'usr_test123',
      currencies: { essence: 1000, gems: 50 },
    });
    dbClient.getItem.mockResolvedValue(null);
    dbClient.putItem.mockResolvedValue({});
    dbClient.updateItem.mockResolvedValue({});
    dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1010 });
    dbClient.logTransaction.mockResolvedValue({});
  });

  // =============================================================================
  // CALCULATION TESTS
  // =============================================================================

  describe('calculateDailyBonus', () => {
    it('should return 0% bonus for 0 streak', () => {
      expect(calculateDailyBonus(0)).toBe(0);
    });

    it('should return 0% bonus for 1 day streak (first claim, no consecutive bonus)', () => {
      expect(calculateDailyBonus(1)).toBe(0);
    });

    it('should return 20% bonus for 5 day streak', () => {
      expect(calculateDailyBonus(5)).toBe(20); // (5-1) * 5% = 20%
    });

    it('should return 95% bonus for 20 day streak', () => {
      expect(calculateDailyBonus(20)).toBe(95); // (20-1) * 5% = 95%
    });

    it('should cap at 100% bonus for streaks over 21 days', () => {
      expect(calculateDailyBonus(21)).toBe(100); // (21-1) * 5% = 100%
      expect(calculateDailyBonus(25)).toBe(100);
      expect(calculateDailyBonus(50)).toBe(100);
      expect(calculateDailyBonus(100)).toBe(100);
    });
  });

  describe('calculateWeeklyBonus', () => {
    it('should return 0% bonus for 0 streak', () => {
      expect(calculateWeeklyBonus(0)).toBe(0);
    });

    it('should return 0% bonus for 1 week streak (first claim, no consecutive bonus)', () => {
      expect(calculateWeeklyBonus(1)).toBe(0);
    });

    it('should return 40% bonus for 5 week streak', () => {
      expect(calculateWeeklyBonus(5)).toBe(40); // (5-1) * 10% = 40%
    });

    it('should return 90% bonus for 10 week streak', () => {
      expect(calculateWeeklyBonus(10)).toBe(90); // (10-1) * 10% = 90%
    });

    it('should cap at 100% bonus for streaks over 11 weeks', () => {
      expect(calculateWeeklyBonus(11)).toBe(100); // (11-1) * 10% = 100%
      expect(calculateWeeklyBonus(15)).toBe(100);
      expect(calculateWeeklyBonus(20)).toBe(100);
    });
  });

  describe('calculateRewardAmount', () => {
    it('should calculate daily reward correctly for new player (no bonus on first claim)', () => {
      const result = calculateRewardAmount('daily', 1);
      expect(result.baseAmount).toBe(30);
      expect(result.bonusPercent).toBe(0); // (1-1) * 5% = 0%
      expect(result.bonusAmount).toBe(0);
      expect(result.totalAmount).toBe(30);
    });

    it('should calculate daily reward with 10 day streak', () => {
      const result = calculateRewardAmount('daily', 10);
      expect(result.baseAmount).toBe(30);
      expect(result.bonusPercent).toBe(45); // (10-1) * 5% = 45%
      expect(result.bonusAmount).toBe(13); // floor(30 * 0.45) = 13
      expect(result.totalAmount).toBe(43);
    });

    it('should calculate daily reward at max streak', () => {
      const result = calculateRewardAmount('daily', 21);
      expect(result.baseAmount).toBe(30);
      expect(result.bonusPercent).toBe(100); // (21-1) * 5% = 100%
      expect(result.bonusAmount).toBe(30); // floor(30 * 1.0) = 30
      expect(result.totalAmount).toBe(60);
    });

    it('should calculate weekly reward correctly for new player (no bonus on first claim)', () => {
      const result = calculateRewardAmount('weekly', 1);
      expect(result.baseAmount).toBe(200);
      expect(result.bonusPercent).toBe(0); // (1-1) * 10% = 0%
      expect(result.bonusAmount).toBe(0);
      expect(result.totalAmount).toBe(200);
    });

    it('should calculate weekly reward at max streak', () => {
      const result = calculateRewardAmount('weekly', 11);
      expect(result.baseAmount).toBe(200);
      expect(result.bonusPercent).toBe(100); // (11-1) * 10% = 100%
      expect(result.bonusAmount).toBe(200); // floor(200 * 1.0) = 200
      expect(result.totalAmount).toBe(400);
    });
  });

  // =============================================================================
  // COOLDOWN TESTS (Daily uses UTC midnight, Weekly uses rolling 7-day)
  // =============================================================================

  describe('canClaimReward', () => {
    it('should allow claim when no previous claim exists', () => {
      const result = canClaimReward(null, 'daily');
      expect(result.canClaim).toBe(true);
      expect(result.nextClaimTime).toBeNull();
    });

    it('should not allow daily claim if already claimed today', () => {
      // Claimed earlier today (1am UTC)
      const claimedToday = utcTime(0, 1);
      const result = canClaimReward(claimedToday, 'daily');
      expect(result.canClaim).toBe(false);
      expect(result.nextClaimTime).toBeDefined();
    });

    it('should allow daily claim if last claim was yesterday', () => {
      // Claimed yesterday at noon UTC
      const claimedYesterday = utcTime(1, 12);
      const result = canClaimReward(claimedYesterday, 'daily');
      expect(result.canClaim).toBe(true);
    });

    it('should not allow weekly claim within 7 days', () => {
      const recentClaim = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
      const result = canClaimReward(recentClaim, 'weekly');
      expect(result.canClaim).toBe(false);
      expect(result.nextClaimTime).toBeDefined();
    });

    it('should allow weekly claim after 7 days', () => {
      const oldClaim = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
      const result = canClaimReward(oldClaim, 'weekly');
      expect(result.canClaim).toBe(true);
    });
  });

  describe('shouldResetStreak', () => {
    it('resets when no previous claim', () => {
      expect(shouldResetStreak(null, 'daily')).toEqual({ reset: true, consumeCharge: false });
    });

    it('does not reset daily streak if claimed yesterday', () => {
      const claimedYesterday = utcTime(1, 14);
      expect(shouldResetStreak(claimedYesterday, 'daily')).toEqual({ reset: false, consumeCharge: false });
    });

    it('resets daily streak if last claim was 2+ days ago and no charges held', () => {
      const claimed3DaysAgo = utcTime(3, 12);
      expect(shouldResetStreak(claimed3DaysAgo, 'daily')).toEqual({ reset: true, consumeCharge: false });
    });

    it('does not reset weekly streak within 14 days', () => {
      const recentClaim = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(recentClaim, 'weekly')).toEqual({ reset: false, consumeCharge: false });
    });

    it('resets weekly streak after 14 days when no charges held', () => {
      const oldClaim = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(oldClaim, 'weekly')).toEqual({ reset: true, consumeCharge: false });
    });

    it('consumes a charge instead of resetting daily streak', () => {
      const claimed3DaysAgo = utcTime(3, 12);
      expect(shouldResetStreak(claimed3DaysAgo, 'daily', { protectionCharges: 2 }))
        .toEqual({ reset: false, consumeCharge: true });
    });

    it('consumes a charge instead of resetting weekly streak', () => {
      const oldClaim = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(oldClaim, 'weekly', { protectionCharges: 1 }))
        .toEqual({ reset: false, consumeCharge: true });
    });

    it('does not consume a charge when streak would not have reset', () => {
      const claimedYesterday = utcTime(1, 14);
      expect(shouldResetStreak(claimedYesterday, 'daily', { protectionCharges: 5 }))
        .toEqual({ reset: false, consumeCharge: false });
    });

    it('treats legacy active expiry as a one-shot save (migration)', () => {
      const claimed3DaysAgo = utcTime(3, 12);
      const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(claimed3DaysAgo, 'daily', { protectionExpiry: futureExpiry }))
        .toEqual({ reset: false, consumeCharge: true });
    });

    it('expired legacy expiry does not save streak', () => {
      const claimed3DaysAgo = utcTime(3, 12);
      const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(claimed3DaysAgo, 'daily', { protectionExpiry: pastExpiry }))
        .toEqual({ reset: true, consumeCharge: false });
    });
  });

  // =============================================================================
  // CLAIM DAILY REWARD TESTS
  // =============================================================================

  describe('claimDailyReward', () => {
    it('should successfully claim first daily reward', async () => {
      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.reward.type).toBe('daily');
      expect(result.reward.baseAmount).toBe(30);
      expect(result.reward.streakAtClaim).toBe(1);
      expect(result.newStreak).toBe(1);
      expect(result.newBalance).toBe(1010);
      expect(result.nextClaimTime).toBeDefined();

      expect(dbClient.addEssence).toHaveBeenCalledWith(
        'usr_test123',
        30, // base amount for streak 1
        {
          type: 'reward_daily',
          ref: expect.stringMatching(/^daily_\d{4}-\d{2}-\d{2}$/),
          refType: 'reward',
          refName: 'Daily Reward (1 day streak)',
        },
      );
    });

    it('should increment streak on consecutive daily claim', async () => {
      // Last claim was yesterday — can claim today, streak continues
      const lastClaim = utcTime(1, 14); // yesterday afternoon
      const streakState = {
        currentStreak: 5,
        longestStreak: 5,
        lastClaimTimestamp: lastClaim,
        totalClaims: 5,
        totalEssenceEarned: 50,
      };
      dbClient.getItem.mockResolvedValue(streakState);

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.newStreak).toBe(6);
      expect(result.reward.streakAtClaim).toBe(6);
      expect(result.reward.bonusPercent).toBe(25); // (6-1) * 5% = 25%
    });

    it('should reset streak if claim is too late', async () => {
      // Last claim 3 days ago — beyond grace period (before yesterday midnight)
      const oldClaim = utcTime(3, 12);
      const streakState = {
        currentStreak: 10,
        longestStreak: 10,
        lastClaimTimestamp: oldClaim,
        totalClaims: 10,
        totalEssenceEarned: 150,
      };
      dbClient.getItem.mockResolvedValue(streakState);

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.newStreak).toBe(1); // Reset to 1
      expect(result.streakSaved).toBe(false);
    });

    it('consumes a protection charge to save a streak that would otherwise reset', async () => {
      const oldClaim = utcTime(3, 12);
      dbClient.getItem.mockResolvedValue({
        currentStreak: 10,
        longestStreak: 10,
        lastClaimTimestamp: oldClaim,
        totalClaims: 10,
        totalEssenceEarned: 150,
        protectionCharges: 2,
      });

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.newStreak).toBe(11); // streak preserved
      expect(result.streakSaved).toBe(true);
      // The streak update should decrement charges from 2 to 1.
      expect(dbClient.updateItem).toHaveBeenCalledWith(
        'TotemBound-RewardsClaims',
        expect.objectContaining({ sk: 'STREAK#daily' }),
        expect.objectContaining({ protectionCharges: 1, protectionExpiry: null })
      );
    });

    it('does not decrement charges on a normal consecutive claim', async () => {
      const lastClaim = utcTime(1, 14);
      dbClient.getItem.mockResolvedValue({
        currentStreak: 5,
        longestStreak: 5,
        lastClaimTimestamp: lastClaim,
        totalClaims: 5,
        totalEssenceEarned: 50,
        protectionCharges: 3,
      });

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.newStreak).toBe(6);
      expect(result.streakSaved).toBe(false);
      // No protectionCharges write — caller should not touch them on normal claims.
      const updateCall = dbClient.updateItem.mock.calls.find(c => c[1]?.sk === 'STREAK#daily');
      expect(updateCall?.[2]).not.toHaveProperty('protectionCharges');
    });

    it('should fail if claim is within cooldown (already claimed today)', async () => {
      // Claimed earlier today
      const claimedToday = utcTime(0, 1);
      dbClient.getItem.mockResolvedValueOnce({
        currentStreak: 5,
        longestStreak: 5,
        lastClaimTimestamp: claimedToday,
        totalClaims: 5,
        totalEssenceEarned: 50,
      });

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Daily reward not yet available');
      expect(result.nextClaimTime).toBeDefined();
      expect(dbClient.addEssence).not.toHaveBeenCalled();
    });

    it('should fail if user not found', async () => {
      dbClient.getUser.mockResolvedValueOnce(null);

      const result = await claimDailyReward('usr_invalid');

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });

    it('should handle addEssence failure', async () => {
      dbClient.addEssence.mockResolvedValueOnce({
        success: false,
        error: 'Database error',
      });

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Database error');
    });
  });

  // =============================================================================
  // CLAIM WEEKLY REWARD TESTS
  // =============================================================================

  describe('claimWeeklyReward', () => {
    it('should successfully claim first weekly reward (no bonus on first claim)', async () => {
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1100 });

      const result = await claimWeeklyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.reward.type).toBe('weekly');
      expect(result.reward.baseAmount).toBe(200);
      expect(result.reward.streakAtClaim).toBe(1);
      expect(result.reward.bonusPercent).toBe(0); // (1-1) * 10% = 0%
      expect(result.reward.bonusAmount).toBe(0);
      expect(result.reward.totalAmount).toBe(200);
      expect(result.newStreak).toBe(1);
      expect(result.newBalance).toBe(1100);

      expect(dbClient.addEssence).toHaveBeenCalledWith(
        'usr_test123',
        200, // 200 base, no bonus on first claim
        {
          type: 'reward_weekly',
          ref: expect.stringMatching(/^weekly_\d{4}-\d{2}-\d{2}$/),
          refType: 'reward',
          refName: 'Weekly Reward (1 week streak)',
        },
      );
    });

    it('should increment streak on consecutive weekly claim', async () => {
      const lastClaim = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
      const streakState = {
        currentStreak: 4,
        longestStreak: 4,
        lastClaimTimestamp: lastClaim,
        totalClaims: 4,
        totalEssenceEarned: 480,
      };
      dbClient.getItem.mockResolvedValue(streakState);
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1150 });

      const result = await claimWeeklyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.newStreak).toBe(5);
      expect(result.reward.bonusPercent).toBe(40); // (5-1) * 10% = 40%
      expect(result.reward.totalAmount).toBe(280); // 200 + 80
    });

    it('should cap weekly bonus at 100%', async () => {
      const lastClaim = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const streakState = {
        currentStreak: 15,
        longestStreak: 15,
        lastClaimTimestamp: lastClaim,
        totalClaims: 15,
        totalEssenceEarned: 2500,
      };
      dbClient.getItem.mockResolvedValue(streakState);
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1200 });

      const result = await claimWeeklyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.reward.bonusPercent).toBe(100); // Capped at 100%
      expect(result.reward.totalAmount).toBe(400); // 200 + 200
    });

    it('should fail if claim is within 7 day cooldown', async () => {
      const recentClaim = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
      dbClient.getItem.mockResolvedValueOnce({
        currentStreak: 2,
        lastClaimTimestamp: recentClaim,
      });

      const result = await claimWeeklyReward('usr_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Weekly reward not yet available');
    });
  });

  // =============================================================================
  // GET REWARD STATUS TESTS
  // =============================================================================

  describe('getRewardStatus', () => {
    it('should return status for new user with no claims', async () => {
      const result = await getRewardStatus('usr_test123');

      expect(result.success).toBe(true);
      expect(result.daily.canClaim).toBe(true);
      expect(result.daily.currentStreak).toBe(0);
      expect(result.daily.potentialReward.baseAmount).toBe(30);
      expect(result.daily.potentialReward.bonusPercent).toBe(0); // Streak 1 = no bonus (first claim)
      expect(result.weekly.canClaim).toBe(true);
      expect(result.weekly.currentStreak).toBe(0);
      expect(result.weekly.potentialReward.baseAmount).toBe(200);
    });

    it('should return correct status for user with active streak', async () => {
      // Daily: claimed yesterday (can claim today, streak continues)
      const lastDailyClaim = utcTime(1, 14); // yesterday afternoon
      // Weekly: claimed 8 days ago (can claim, streak continues)
      const lastWeeklyClaim = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      // Mock daily streak state (first getItem call)
      dbClient.getItem.mockResolvedValueOnce({
        currentStreak: 5,
        longestStreak: 10,
        lastClaimTimestamp: lastDailyClaim,
        totalClaims: 5,
        totalEssenceEarned: 55,
      });

      // Mock weekly streak state (second getItem call)
      dbClient.getItem.mockResolvedValueOnce({
        currentStreak: 3,
        longestStreak: 3,
        lastClaimTimestamp: lastWeeklyClaim,
        totalClaims: 3,
        totalEssenceEarned: 360,
      });

      const result = await getRewardStatus('usr_test123');

      expect(result.success).toBe(true);
      expect(result.daily.canClaim).toBe(true);
      expect(result.daily.currentStreak).toBe(5);
      expect(result.daily.longestStreak).toBe(10);
      expect(result.daily.potentialReward.bonusPercent).toBe(25); // ((5+1)-1) * 5% = 25%

      expect(result.weekly.canClaim).toBe(true);
      expect(result.weekly.currentStreak).toBe(3);
      expect(result.weekly.potentialReward.bonusPercent).toBe(30); // ((3+1)-1) * 10% = 30%
    });

    it('should show streak will reset if grace period exceeded', async () => {
      // Daily claim 3 days ago — beyond daily grace (before yesterday midnight)
      const oldDailyClaim = utcTime(3, 12);

      dbClient.getItem.mockResolvedValueOnce({
        currentStreak: 10,
        longestStreak: 10,
        lastClaimTimestamp: oldDailyClaim,
        totalClaims: 10,
        totalEssenceEarned: 150,
      });

      dbClient.getItem.mockResolvedValueOnce(null); // No weekly claims

      const result = await getRewardStatus('usr_test123');

      expect(result.success).toBe(true);
      expect(result.daily.canClaim).toBe(true);
      expect(result.daily.streakWillReset).toBe(true);
      expect(result.daily.currentStreak).toBe(0); // Effective streak is 0 since it will reset
    });

    it('should fail if user not found', async () => {
      dbClient.getUser.mockResolvedValueOnce(null);

      const result = await getRewardStatus('usr_invalid');

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });
  });

  // =============================================================================
  // EDGE CASE TESTS
  // =============================================================================

  describe('Edge Cases', () => {
    it('should allow daily claim when last claim was just before midnight', () => {
      // 1ms before today's midnight = last moment of yesterday
      const justBeforeMidnight = new Date(utcMidnight(0).getTime() - 1).toISOString();
      const result = canClaimReward(justBeforeMidnight, 'daily');
      expect(result.canClaim).toBe(true);
    });

    it('should not allow daily claim if last claim was exactly at midnight', () => {
      // Exactly at today's midnight = today
      const exactlyAtMidnight = utcMidnight(0).toISOString();
      const result = canClaimReward(exactlyAtMidnight, 'daily');
      expect(result.canClaim).toBe(false);
    });

    it('should handle exactly 7 day boundary for weekly', () => {
      const exactlyOnTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const result = canClaimReward(exactlyOnTime, 'weekly');
      expect(result.canClaim).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      dbClient.getItem.mockRejectedValueOnce(new Error('Database connection failed'));

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to claim daily reward');
    });
  });

  // =============================================================================
  // REWARD CONFIG TESTS
  // =============================================================================

  describe('Reward Configuration', () => {
    it('should have correct daily configuration', () => {
      expect(REWARD_CONFIG.daily.baseAmount).toBe(30);
      expect(REWARD_CONFIG.daily.streakBonusPercent).toBe(5);
      expect(REWARD_CONFIG.daily.maxStreakBonusPercent).toBe(100);
      expect(REWARD_CONFIG.daily.cooldownHours).toBe(24);
    });

    it('should have correct weekly configuration', () => {
      expect(REWARD_CONFIG.weekly.baseAmount).toBe(200);
      expect(REWARD_CONFIG.weekly.streakBonusPercent).toBe(10);
      expect(REWARD_CONFIG.weekly.maxStreakBonusPercent).toBe(100);
      expect(REWARD_CONFIG.weekly.cooldownDays).toBe(7);
    });
  });

  // =============================================================================
  // ADDITIONAL claimWeeklyReward TESTS (coverage for lines 541-628)
  // =============================================================================

  describe('claimWeeklyReward - additional coverage', () => {
    it('should fail if user not found', async () => {
      dbClient.getUser.mockResolvedValueOnce(null);

      const result = await claimWeeklyReward('usr_invalid');

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
      expect(dbClient.addEssence).not.toHaveBeenCalled();
    });

    it('should reset streak after 14 day grace period', async () => {
      // Last claim was 15 days ago — beyond weekly grace period of 14 days
      const oldClaim = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      const streakState = {
        currentStreak: 8,
        longestStreak: 8,
        lastClaimTimestamp: oldClaim,
        totalClaims: 8,
        totalEssenceEarned: 1200,
      };
      dbClient.getItem.mockResolvedValue(streakState);
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1100 });

      const result = await claimWeeklyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.newStreak).toBe(1); // Reset to 1
      expect(result.reward.streakAtClaim).toBe(1);
    });

    it('should continue streak within 14 day grace period', async () => {
      // Last claim was 10 days ago — within weekly grace period
      const recentClaim = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const streakState = {
        currentStreak: 3,
        longestStreak: 3,
        lastClaimTimestamp: recentClaim,
        totalClaims: 3,
        totalEssenceEarned: 360,
      };
      dbClient.getItem.mockResolvedValue(streakState);
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1130 });

      const result = await claimWeeklyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.newStreak).toBe(4); // Continues
      expect(result.reward.bonusPercent).toBe(30); // (4-1) * 10% = 30%
    });

    it('should handle addEssence failure', async () => {
      dbClient.addEssence.mockResolvedValueOnce({
        success: false,
        error: 'Insufficient balance update failed',
      });

      const result = await claimWeeklyReward('usr_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient balance update failed');
    });

    it('should handle exception from getUser', async () => {
      dbClient.getUser.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await claimWeeklyReward('usr_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to claim weekly reward');
    });

    it('should return successful claim with correct nextClaimTime', async () => {
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1100 });

      const before = Date.now();
      const result = await claimWeeklyReward('usr_test123');
      const after = Date.now();

      expect(result.success).toBe(true);
      expect(result.nextClaimTime).toBeDefined();

      // nextClaimTime should be ~7 days from now
      const nextClaim = new Date(result.nextClaimTime).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(nextClaim).toBeGreaterThanOrEqual(before + sevenDaysMs);
      expect(nextClaim).toBeLessThanOrEqual(after + sevenDaysMs);
    });
  });

  // =============================================================================
  // shouldResetStreak - weekly grace period (coverage for lines 264-266)
  // =============================================================================

  describe('shouldResetStreak - charges + legacy expiry', () => {
    it('charges save daily streak that would otherwise reset', () => {
      const oldClaim = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(oldClaim, 'daily', { protectionCharges: 1 }))
        .toEqual({ reset: false, consumeCharge: true });
      expect(shouldResetStreak(oldClaim, 'weekly', { protectionCharges: 1 }))
        .toEqual({ reset: false, consumeCharge: true });
    });

    it('zero charges and no legacy expiry => streak resets', () => {
      const oldClaim = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(oldClaim, 'daily', { protectionCharges: 0 }))
        .toEqual({ reset: true, consumeCharge: false });
      expect(shouldResetStreak(oldClaim, 'weekly', { protectionCharges: 0 }))
        .toEqual({ reset: true, consumeCharge: false });
    });

    it('weekly streak resets when beyond 14-day grace period', () => {
      const oldClaim = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(oldClaim, 'weekly')).toEqual({ reset: true, consumeCharge: false });
    });

    it('weekly streak survives within 14-day grace period', () => {
      const recentClaim = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
      expect(shouldResetStreak(recentClaim, 'weekly')).toEqual({ reset: false, consumeCharge: false });
    });
  });

  // =============================================================================
  // Achievement error handling in claimDailyReward (coverage for line 500)
  // =============================================================================

  describe('claimDailyReward - achievement error handling', () => {
    it('should still succeed if onLoginStreak throws', async () => {
      achievementsService.onLoginStreak.mockRejectedValueOnce(
        new Error('Achievement service unavailable')
      );

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.reward.type).toBe('daily');
      expect(result.achievements).toEqual([]); // Empty because achievement call failed
    });

    it('should include unlocked achievements when onLoginStreak returns them', async () => {
      achievementsService.onLoginStreak.mockResolvedValueOnce([
        {
          achievementId: 'ach_streak_3',
          milestone: 3,
          unlocked: true,
          rewards: { essence: 50 },
        },
        {
          achievementId: 'ach_streak_7',
          milestone: 7,
          unlocked: false,
          rewards: { essence: 100 },
        },
      ]);

      const result = await claimDailyReward('usr_test123');

      expect(result.success).toBe(true);
      expect(result.achievements).toHaveLength(1);
      expect(result.achievements[0].achievementId).toBe('ach_streak_3');
    });
  });

  // =============================================================================
  // TUTORIAL REWARD TESTS (coverage for lines 701-933)
  // =============================================================================

  describe('getTutorialProgress', () => {
    it('should fail if user not found', async () => {
      dbClient.getUser.mockResolvedValueOnce(null);

      const result = await getTutorialProgress('usr_invalid');

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });

    it('should return empty progress for user with no completed steps', async () => {
      dbClient.queryItems.mockResolvedValueOnce([]);

      const result = await getTutorialProgress('usr_test123');

      expect(result.success).toBe(true);
      expect(result.completedSteps).toEqual([]);
      expect(result.totalSteps).toBe(6);
      expect(result.nextStep).toBe(1);
      expect(result.totalEssenceEarned).toBe(0);
      expect(result.totalExperienceEarned).toBe(0);
      // All steps should be unclaimed
      for (let i = 1; i <= 6; i++) {
        expect(result.rewards[i].claimed).toBe(false);
        expect(result.rewards[i].claimedAt).toBeNull();
      }
    });

    it('should return correct progress for user with some completed steps', async () => {
      const now = new Date().toISOString();
      dbClient.queryItems.mockResolvedValueOnce([
        { step: 1, essenceReward: 25, experienceReward: 0, claimedAt: now },
        { step: 2, essenceReward: 50, experienceReward: 100, claimedAt: now },
      ]);

      const result = await getTutorialProgress('usr_test123');

      expect(result.success).toBe(true);
      expect(result.completedSteps).toEqual([1, 2]);
      expect(result.totalSteps).toBe(6);
      expect(result.nextStep).toBe(3);
      expect(result.totalEssenceEarned).toBe(75);
      expect(result.totalExperienceEarned).toBe(100);
      expect(result.rewards[1].claimed).toBe(true);
      expect(result.rewards[2].claimed).toBe(true);
      expect(result.rewards[3].claimed).toBe(false);
    });

    it('should return nextStep null when all steps completed', async () => {
      const now = new Date().toISOString();
      const allSteps = [1, 2, 3, 4, 5, 6].map((step) => ({
        step,
        essenceReward: 10,
        experienceReward: 10,
        claimedAt: now,
      }));
      dbClient.queryItems.mockResolvedValueOnce(allSteps);

      const result = await getTutorialProgress('usr_test123');

      expect(result.success).toBe(true);
      expect(result.completedSteps).toEqual([1, 2, 3, 4, 5, 6]);
      expect(result.nextStep).toBeNull();
    });

    it('should handle exception gracefully', async () => {
      dbClient.getUser.mockRejectedValueOnce(new Error('DB timeout'));

      const result = await getTutorialProgress('usr_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to get tutorial progress');
    });
  });

  describe('claimTutorialReward', () => {
    it('should fail for invalid step number', async () => {
      const result = await claimTutorialReward('usr_test123', 99);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid tutorial step: 99');
      expect(dbClient.getUser).not.toHaveBeenCalled();
    });

    it('should fail if user not found', async () => {
      dbClient.getUser.mockResolvedValueOnce(null);

      const result = await claimTutorialReward('usr_invalid', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });

    it('should fail if step already claimed', async () => {
      // isTutorialStepClaimed calls getItem — return a truthy record
      dbClient.getItem.mockResolvedValueOnce({
        pk: 'USER#usr_test123',
        sk: 'TUTORIAL#1',
        step: 1,
        claimedAt: new Date().toISOString(),
      });

      const result = await claimTutorialReward('usr_test123', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Tutorial step 1 has already been claimed');
    });

    it('should fail if step requires totem but no totemId provided', async () => {
      // Step 2 requires totem
      // isTutorialStepClaimed returns null (not claimed)
      dbClient.getItem.mockResolvedValueOnce(null);

      const result = await claimTutorialReward('usr_test123', 2);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Tutorial step 2 requires a totemId');
    });

    it('should fail if totem not found', async () => {
      // isTutorialStepClaimed returns null (not claimed)
      dbClient.getItem.mockResolvedValueOnce(null);
      // getTotem returns null
      dbClient.getTotem.mockResolvedValueOnce(null);

      const result = await claimTutorialReward('usr_test123', 2, 'totem_nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Totem totem_nonexistent not found');
    });

    it('should successfully claim step 1 (no totem needed)', async () => {
      // isTutorialStepClaimed returns null (not claimed)
      dbClient.getItem.mockResolvedValueOnce(null);
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1050 });

      const result = await claimTutorialReward('usr_test123', 1);

      expect(result.success).toBe(true);
      expect(result.reward.step).toBe(1);
      expect(result.reward.essenceReward).toBe(50);
      expect(result.reward.experienceReward).toBe(0);
      expect(result.newBalance).toBe(1050);
      expect(result.totemId).toBeNull();
      expect(result.totemExperience).toBeNull();

      expect(dbClient.addEssence).toHaveBeenCalledWith(
        'usr_test123',
        50,
        {
          type: 'reward_tutorial',
          ref: 'tutorial_step_1',
          refType: 'tutorial',
          refName: 'Claim Your Spiritkeeper Reward',
        },
      );
      expect(dbClient.putItem).toHaveBeenCalled();
      // No totem update for step 1 (experienceReward is 0)
      expect(dbClient.updateTotem).not.toHaveBeenCalled();
    });

    it('should successfully claim step 2 (totem needed, XP awarded)', async () => {
      // isTutorialStepClaimed returns null (not claimed)
      dbClient.getItem.mockResolvedValueOnce(null);
      // getTotem returns a totem
      dbClient.getTotem.mockResolvedValueOnce({
        id: 'totem_abc',
        userId: 'usr_test123',
        experience: 200,
        stage: 0,
      });
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1050 });
      dbClient.updateTotem.mockResolvedValueOnce({});

      const result = await claimTutorialReward('usr_test123', 2, 'totem_abc');

      expect(result.success).toBe(true);
      expect(result.reward.step).toBe(2);
      expect(result.reward.essenceReward).toBe(50);
      expect(result.reward.experienceReward).toBe(100);
      expect(result.newBalance).toBe(1050);
      expect(result.totemId).toBe('totem_abc');
      expect(result.totemExperience).toBe(300); // 200 existing + 100 reward

      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        'usr_test123',
        'totem_abc',
        { experience: 300 }
      );
    });

    it('should handle addEssence failure during tutorial claim', async () => {
      // isTutorialStepClaimed returns null
      dbClient.getItem.mockResolvedValueOnce(null);
      dbClient.addEssence.mockResolvedValueOnce({
        success: false,
        error: 'Balance update failed',
      });

      const result = await claimTutorialReward('usr_test123', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Balance update failed');
      // Should not record claim if balance failed
      expect(dbClient.putItem).not.toHaveBeenCalled();
    });

    it('should handle exception gracefully', async () => {
      // isTutorialStepClaimed returns null
      dbClient.getItem.mockResolvedValueOnce(null);
      // addEssence throws
      dbClient.addEssence.mockRejectedValueOnce(new Error('Unexpected DB error'));

      const result = await claimTutorialReward('usr_test123', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to claim tutorial reward');
    });

    it('should claim step 6 (no totem needed, large essence reward)', async () => {
      dbClient.getItem.mockResolvedValueOnce(null);
      dbClient.addEssence.mockResolvedValueOnce({ success: true, newBalance: 1250 });

      const result = await claimTutorialReward('usr_test123', 6);

      expect(result.success).toBe(true);
      expect(result.reward.step).toBe(6);
      expect(result.reward.essenceReward).toBe(250);
      expect(result.reward.experienceReward).toBe(0);
      expect(result.newBalance).toBe(1250);
      expect(result.totemExperience).toBeNull();
      expect(dbClient.updateTotem).not.toHaveBeenCalled();
    });
  });

  describe('isTutorialStepClaimed', () => {
    it('should return false when step is not claimed', async () => {
      dbClient.getItem.mockResolvedValueOnce(null);

      const result = await isTutorialStepClaimed('usr_test123', 1);

      expect(result).toBe(false);
      expect(dbClient.getItem).toHaveBeenCalledWith(
        'TotemBound-RewardsClaims',
        { pk: 'USER#usr_test123', sk: 'TUTORIAL#1' }
      );
    });

    it('should return true when step is claimed', async () => {
      dbClient.getItem.mockResolvedValueOnce({
        pk: 'USER#usr_test123',
        sk: 'TUTORIAL#3',
        step: 3,
        claimedAt: new Date().toISOString(),
      });

      const result = await isTutorialStepClaimed('usr_test123', 3);

      expect(result).toBe(true);
    });
  });

  // =============================================================================
  // getRewardStatus - exception handling (coverage for lines 700-703)
  // =============================================================================

  describe('getRewardStatus - exception handling', () => {
    it('should handle exception gracefully', async () => {
      dbClient.getUser.mockRejectedValueOnce(new Error('DB connection lost'));

      const result = await getRewardStatus('usr_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to get reward status');
    });
  });
});
