/**
 * List Totem Handler
 *
 * POST /api/shop/list
 *
 * Lists a totem for sale in the marketplace.
 *
 * Business Rules:
 * - User must own the totem
 * - Totem must not already be listed
 * - Sell price calculated server-side: 300 + (stage * 30) + (rarityId * 20)
 * - Seller receives full sellPrice immediately
 * - Creates an "Unbound" listing (totem becomes available for purchase)
 */

const shopService = require('../../services/shop-service');

/**
 * List a totem for sale
 *
 * @param {object} user - Authenticated user { userId, email, displayName, tier }
 * @param {object} body - Request body { totemId }
 * @returns {object} - Result with listing details
 */
async function listTotem(user, body) {
  const userId = user.userId;
  const { totemId } = body || {};

  // 1. Validate required fields
  if (!totemId) {
    return {
      success: false,
      error: { code: 'MISSING_FIELD', message: 'totemId is required' },
    };
  }

  // 2. Validate totemId format
  if (!totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 3. Use shop-service to handle listing
  // Price is calculated server-side based on totem's stage and rarity
  // Seller receives: sellPrice - listingFee immediately
  try {
    const result = await shopService.listTotemForSale(userId, totemId);
    return result;
  }
  catch (error) {
    console.error('Failed to list totem:', error);
    return {
      success: false,
      error: {
        code: 'LISTING_FAILED',
        message: error.message || 'Failed to create listing. Please try again.',
      },
    };
  }
}

module.exports = { listTotem };
