/**
 * Claim Council Mission Handler
 *
 * POST /v1/sanctum/missions/claim
 *
 * Body: { totemId }
 *
 * Claims rewards from a completed council mission. Awards XP and Essence.
 */

const sanctumService = require('../../services/sanctum-service');

/**
 * Claim council mission rewards
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId }
 * @returns {object} - Claim result with rewards
 */
async function claimCouncilMission(user, body) {
  const { totemId } = body || {};

  if (!totemId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'totemId is required' },
    };
  }

  try {
    const result = await sanctumService.claimCouncilMission(user.userId, totemId);
    return result;
  }
  catch (error) {
    console.error('Failed to claim council mission:', error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    };
  }
}

module.exports = { claimCouncilMission };
