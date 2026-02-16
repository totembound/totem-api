/**
 * Claim Expedition Reward Handler
 *
 * POST /api/expeditions/claim
 *
 * Body: { totemId }
 *
 * Claims the reward for a completed expedition. The totem must have finished
 * its expedition (time elapsed) and not already claimed the reward.
 */

const { claimExpeditionReward } = require('../../services/expeditions-service');

/**
 * Claim reward for a completed expedition
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId }
 * @returns {object} - Claim result with rewards
 */
async function claimExpeditionHandler(user, body) {
  const userId = user.userId;
  const { totemId } = body || {};

  // 1. Validate required parameters
  if (!totemId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'totemId is required' },
    };
  }

  // 2. Validate totemId format
  if (!totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 3. Claim the expedition reward via service
  try {
    const result = await claimExpeditionReward(userId, totemId);

    if (!result.success) {
      // Map service errors to API error codes
      let errorCode = 'CLAIM_FAILED';
      if (result.error === 'No active expedition') {
        errorCode = 'NO_EXPEDITION';
      }
      else if (result.error === 'Already claimed') {
        errorCode = 'ALREADY_CLAIMED';
      }
      else if (result.error === 'Expedition in progress') {
        errorCode = 'NOT_COMPLETE';
      }
      else if (result.error === 'Invalid expedition') {
        errorCode = 'INVALID_EXPEDITION';
      }
      else if (result.error === 'Failed to add reward') {
        errorCode = 'REWARD_FAILED';
      }

      return {
        success: false,
        error: {
          code: errorCode,
          message: result.message,
          remainingMinutes: result.remainingMinutes,
          endsAt: result.endsAt,
        },
      };
    }

    return {
      success: true,
      data: {
        rewards: result.rewards,
        expedition: result.expedition,
        totalExpeditions: result.totalExpeditions,
        achievements: result.achievements,
        message: `Expedition "${result.expedition.name}" complete! +${result.rewards.essence} Essence`,
      },
    };
  }
  catch (err) {
    console.error('Failed to claim expedition reward:', err);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to claim expedition reward' },
    };
  }
}

module.exports = { claimExpeditionHandler };
