/**
 * Get Sanctum Handler
 *
 * GET /v1/sanctum
 *
 * Returns the user's full Elder Sanctum state including all seats,
 * pending earnings, and max seat count.
 */

const sanctumService = require('../../services/sanctum-service');

/**
 * Get the user's sanctum state
 *
 * @param {object} user - Authenticated user { userId }
 * @returns {object} - Sanctum state
 */
async function getSanctum(user) {
  try {
    const result = await sanctumService.getSanctum(user.userId);
    return { success: true, data: result };
  } catch (error) {
    console.error('Failed to get sanctum:', error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    };
  }
}

module.exports = { getSanctum };
