/**
 * Unseat Totem Handler
 *
 * POST /v1/sanctum/unseat
 *
 * Body: { totemId }
 *
 * Removes a totem from the Elder Sanctum. The totem must not be on a
 * council mission. Any unclaimed earnings are forfeited.
 */

const sanctumService = require('../../services/sanctum-service');

/**
 * Unseat a totem from the sanctum
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId }
 * @returns {object} - Result with updated sanctum state
 */
async function unseatTotem(user, body) {
  const { totemId } = body || {};

  // Validate required params
  if (!totemId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'totemId is required' },
    };
  }

  if (!totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  try {
    const result = await sanctumService.unseatTotem(user.userId, totemId);
    return result;
  }
  catch (error) {
    console.error('Failed to unseat totem:', error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    };
  }
}

module.exports = { unseatTotem };
