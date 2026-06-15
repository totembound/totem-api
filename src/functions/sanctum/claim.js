/**
 * Claim Sanctum Earnings Handler
 *
 * POST /v1/sanctum/claim
 *
 * Claims accumulated Essence from all seated totems. Uses atomic
 * transaction to prevent double-claiming.
 */

const sanctumService = require('../../services/sanctum-service');

/**
 * Claim sanctum earnings
 *
 * @param {object} user - Authenticated user { userId }
 * @returns {object} - Claim result with earnings breakdown
 */
async function claimSanctum(user) {
  try {
    const result = await sanctumService.claimSanctum(user.userId);
    return result;
  }
  catch (error) {
    console.error('Failed to claim sanctum earnings:', error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    };
  }
}

module.exports = { claimSanctum };
