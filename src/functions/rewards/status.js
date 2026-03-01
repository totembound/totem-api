/**
 * Rewards Status Handler
 *
 * GET /api/rewards/status
 *
 * Returns the current reward status for a user including
 * daily/weekly streaks and claim availability.
 */

const rewardsService = require('../../services/rewards-service');
const { getAchievementProgress } = require('../../services/achievements-service');
const { getItem, TABLES } = require('../../common/db-client');

const REWARDS_CLAIMS_TABLE = TABLES.REWARDS_CLAIMS;

/**
 * Check if a user has active protection for a reward type
 */
async function getProtectionStatus(userId, rewardType) {
  const streakKey = {
    pk: `USER#${userId}`,
    sk: `STREAK#${rewardType}`,
  };
  const streakState = await getItem(REWARDS_CLAIMS_TABLE, streakKey);

  if (!streakState || !streakState.protectionExpiry) {
    return { isProtected: false, protectionExpiry: null };
  }

  const expiryTime = new Date(streakState.protectionExpiry).getTime();
  const isProtected = expiryTime > Date.now();

  return {
    isProtected,
    protectionExpiry: isProtected ? streakState.protectionExpiry : null,
  };
}

/**
 * Check if weekly rewards are unlocked (requires Week Warrior achievement = 7-day login streak)
 * Achievement ID: ach_login-progression, first milestone at 7 days
 */
async function isWeeklyUnlocked(userId) {
  try {
    const progress = await getAchievementProgress(userId, 'ach_login-progression');
    if (!progress) return false;

    // milestoneIndex tracks the highest unlocked milestone (0 = Week Warrior at 7 days).
    // It never resets, so this correctly reflects permanent unlock even if the streak resets.
    return (progress.milestoneIndex ?? -1) >= 0;
  }
  catch (error) {
    console.error(`[Status] Error checking weekly unlock for ${userId}:`, error.message);
    return false;
  }
}

/**
 * Get current reward status for authenticated user
 */
async function getStatus(user) {
  if (!user || !user.userId) {
    return {
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'User authentication required',
      },
    };
  }

  const userId = user.userId;

  try {
    // Get reward status, protection status, and weekly unlock in parallel
    const [status, dailyProtection, weeklyProtection, weeklyUnlocked] = await Promise.all([
      rewardsService.getRewardStatus(userId),
      getProtectionStatus(userId, 'daily'),
      getProtectionStatus(userId, 'weekly'),
      isWeeklyUnlocked(userId),
    ]);

    if (!status.success) {
      return {
        success: false,
        error: {
          code: status.errorCode || 'STATUS_FAILED',
          message: status.error || 'Failed to retrieve reward status',
        },
      };
    }

    return {
      success: true,
      data: {
        daily: {
          canClaim: status.daily?.canClaim || false,
          streakDays: status.daily?.currentStreak || 0,
          bestStreak: status.daily?.longestStreak || 0,
          nextClaimTime: status.daily?.nextClaimTime || null,
          isProtected: dailyProtection.isProtected,
          protectionExpiry: dailyProtection.protectionExpiry,
        },
        weekly: {
          canClaim: status.weekly?.canClaim || false,
          weeklyStreak: status.weekly?.currentStreak || 0,
          bestStreak: status.weekly?.longestStreak || 0,
          nextClaimTime: status.weekly?.nextClaimTime || null,
          isProtected: weeklyProtection.isProtected,
          protectionExpiry: weeklyProtection.protectionExpiry,
          isUnlocked: weeklyUnlocked,
        },
      },
    };
  }
  catch (error) {
    console.error('[getStatus] Error:', error);
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while retrieving reward status',
      },
    };
  }
}

module.exports = { getStatus };
