/**
 * Claim Daily Reward Handler
 *
 * POST /api/rewards/daily
 *
 * Allows users to claim their daily login reward.
 * Consecutive daily claims build a streak for bonus rewards.
 */

const rewardsService = require('../../services/rewards-service');

/**
 * Claim daily reward for authenticated user
 *
 * @param {object} user - Authenticated user { userId, tier }
 * @returns {object} - Claim result
 *
 * @example Success Response:
 * {
 *   success: true,
 *   data: {
 *     reward: { essence: 100, gems: 0, bonusMultiplier: 1.5 },
 *     newStreak: 5,
 *     nextClaimAt: "2024-01-16T00:00:00.000Z",
 *     message: "Daily reward claimed! +100 Essence"
 *   }
 * }
 */
async function claimDaily(user) {
  // 1. Validate user authentication
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
    // 2. Call rewards service to claim daily reward
    const result = await rewardsService.claimDailyReward(userId);

    // 3. Handle service errors
    if (!result.success) {
      return {
        success: false,
        error: {
          code: result.errorCode || 'CLAIM_FAILED',
          message: result.error || 'Failed to claim daily reward',
          ...(result.nextClaimAt && { nextClaimAt: result.nextClaimAt }),
          ...(result.remainingMs && { remainingMs: result.remainingMs }),
        },
      };
    }

    // 4. Return success response (format expected by frontend)
    return {
      success: true,
      data: {
        reward: {
          amount: result.reward.totalAmount || result.reward.essence || 0,
          streakDays: result.newStreak,
          streakBonus: result.reward.bonusAmount || 0,
        },
        newStreak: result.newStreak,
        nextClaimAt: result.nextClaimTime,
        message: `Daily reward claimed! +${result.reward.totalAmount || result.reward.essence} Essence`,
        achievements: result.achievements || [],
      },
    };
  }
  catch (error) {
    console.error('[claimDaily] Error:', error);
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while claiming daily reward',
      },
    };
  }
}

module.exports = { claimDaily };
