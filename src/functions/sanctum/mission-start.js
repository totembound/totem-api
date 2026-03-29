/**
 * Start Council Mission Handler
 *
 * POST /v1/sanctum/missions/start
 *
 * Body: { totemId, missionType }
 *
 * Starts a council mission for a seated totem. Deducts Essence and
 * happiness costs, creates a timed mission record.
 */

const sanctumService = require('../../services/sanctum-service');

/**
 * Start a council mission
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId, missionType }
 * @returns {object} - Mission start result
 */
async function startCouncilMission(user, body) {
  const { totemId, missionType } = body || {};

  if (!totemId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'totemId is required' },
    };
  }

  if (!missionType) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'missionType is required' },
    };
  }

  try {
    const result = await sanctumService.startCouncilMission(user.userId, totemId, missionType);
    return result;
  } catch (error) {
    console.error('Failed to start council mission:', error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    };
  }
}

module.exports = { startCouncilMission };
