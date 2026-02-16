/**
 * Claim Weekly Reward Handler
 *
 * POST /api/rewards/weekly
 *
 * Allows users to claim their weekly bonus reward.
 * Requires completing 7 consecutive daily claims.
 */

const rewardsService = require('../../services/rewards-service');

/**
 * Claim weekly reward for authenticated user
 *
 * @param {object} user - Authenticated user { userId, tier }
 * @returns {object} - Claim result
 *
 * @example Success Response:
 * {
 *   success: true,
 *   data: {
 *     reward: { essence: 500, gems: 10, bonusMultiplier: 2.0 },
 *     weekStreak: 3,
 *     nextClaimAt: "2024-01-22T00:00:00.000Z",
 *     message: "Weekly reward claimed! +500 Essence +10 Gems"
 *   }
 * }
 */
async function claimWeekly(user) {
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
    // 2. Call rewards service to claim weekly reward
    const result = await rewardsService.claimWeeklyReward(userId);

    // 3. Handle service errors
    if (!result.success) {
      return {
        success: false,
        error: {
          code: result.errorCode || 'CLAIM_FAILED',
          message: result.error || 'Failed to claim weekly reward',
          ...(result.nextClaimAt && { nextClaimAt: result.nextClaimAt }),
          ...(result.remainingMs && { remainingMs: result.remainingMs }),
          ...(result.dailyStreakRequired && { dailyStreakRequired: result.dailyStreakRequired }),
          ...(result.currentDailyStreak && { currentDailyStreak: result.currentDailyStreak }),
        },
      };
    }

    // 4. Return success response
    return {
      success: true,
      data: {
        reward: result.reward,
        newStreak: result.newStreak,
        newBalance: result.newBalance,
        nextClaimTime: result.nextClaimTime,
        message: `Weekly reward claimed! +${result.reward.totalAmount} Essence`,
      },
    };
  }
  catch (error) {
    console.error('[claimWeekly] Error:', error);
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while claiming weekly reward',
      },
    };
  }
}

module.exports = { claimWeekly };
