/**
 * Expedition Status Handler
 *
 * GET /api/expeditions/status/:totemId
 *
 * Returns the expedition status for a specific totem.
 */

const { checkExpeditionStatus } = require('../../services/expeditions-service');

/**
 * Get expedition status for a specific totem
 *
 * @param {object} user - Authenticated user { userId }
 * @param {string} totemId - The totem ID to check
 * @returns {object} - Expedition status for the totem
 */
async function getExpeditionStatusHandler(user, totemId) {
  const userId = user.userId;

  // 1. Validate totemId parameter
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

  try {
    // 3. Get expedition status from service
    const status = await checkExpeditionStatus(userId, totemId);

    // 4. Build response
    return {
      success: true,
      data: {
        totemId,
        hasActiveExpedition: status.hasActiveExpedition,
        status: status.status,
        canClaim: status.canClaim || false,
        expedition: status.expedition || null,
      },
    };
  }
  catch (err) {
    console.error('Failed to get expedition status:', err);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve expedition status' },
    };
  }
}

module.exports = { getExpeditionStatusHandler };
