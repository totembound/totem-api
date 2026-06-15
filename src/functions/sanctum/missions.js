/**
 * Get Council Missions Handler
 *
 * GET /v1/sanctum/missions
 *
 * Returns all available council missions grouped by tier.
 */

const sanctumService = require('../../services/sanctum-service');

/**
 * Get available council missions
 *
 * @param {object} user - Authenticated user { userId }
 * @returns {object} - Missions grouped by tier
 */
async function getCouncilMissions(user) {
  try {
    const missions = sanctumService.getCouncilMissions();
    return { success: true, data: missions };
  }
  catch (error) {
    console.error('Failed to get council missions:', error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    };
  }
}

module.exports = { getCouncilMissions };
