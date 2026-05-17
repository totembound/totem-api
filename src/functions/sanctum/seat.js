/**
 * Seat Totem Handler
 *
 * POST /v1/sanctum/seat
 *
 * Body: { totemId, seatIndex? }
 *
 * Seats a Stage 4 totem in the Elder Sanctum. If seatIndex is omitted,
 * auto-assigns the first available seat.
 */

const sanctumService = require('../../services/sanctum-service');

/**
 * Seat a totem in the sanctum
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId, seatIndex? }
 * @returns {object} - Result with updated sanctum state
 */
async function seatTotem(user, body) {
  const { totemId, seatIndex } = body || {};

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

  // Validate seatIndex if provided
  if (seatIndex !== undefined && seatIndex !== null) {
    const idx = Number(seatIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx > 2) {
      return {
        success: false,
        error: { code: 'INVALID_PARAM', message: 'seatIndex must be 0, 1, or 2' },
      };
    }
  }

  try {
    const result = await sanctumService.seatTotem(
      user.userId,
      totemId,
      seatIndex !== undefined && seatIndex !== null ? Number(seatIndex) : undefined,
    );
    return result;
  }
  catch (error) {
    console.error('Failed to seat totem:', error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    };
  }
}

module.exports = { seatTotem };
