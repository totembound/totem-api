/**
 * Cancel Council Mission Handler
 *
 * POST /v1/sanctum/missions/cancel
 *
 * Body: { totemId }
 *
 * Cancels an active council mission. No refund is given and no rewards
 * are earned. The totem is freed from the mission.
 */

const sanctumService = require('../../services/sanctum-service');

/**
 * Cancel an active council mission
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId }
 * @returns {object} - Cancellation result
 */
async function cancelCouncilMission(user, body) {
  const { totemId } = body || {};

  if (!totemId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'totemId is required' },
    };
  }

  try {
    const result = await sanctumService.cancelCouncilMission(user.userId, totemId);
    return result;
  }
  catch (error) {
    console.error('Failed to cancel council mission:', error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    };
  }
}

module.exports = { cancelCouncilMission };
