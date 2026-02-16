/**
 * Purchase Handler
 *
 * POST /api/shop/purchase
 *
 * Purchases a listed totem from the marketplace.
 *
 * Business Rules:
 * - Totem must be actively listed
 * - Buyer cannot be the seller
 * - Buyer pays: sellPrice + purchase fee (100 Essence)
 * - Seller receives: sellPrice (they already paid listing fee)
 * - Totem ownership transfers to buyer
 * - Listing is marked as sold
 */

const shopService = require('../../services/shop-service');

/**
 * Purchase a listed totem
 *
 * @param {object} user - Authenticated user { userId, email, displayName, tier }
 * @param {object} body - Request body { totemId }
 * @returns {object} - Result with purchase details
 */
async function purchase(user, body) {
  const buyerId = user.userId;
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

  // 3. Use the shop service to handle the purchase
  const result = await shopService.purchaseUnboundTotem(buyerId, totemId);

  if (!result.success) {
    return {
      success: false,
      error: {
        code: result.error === 'Listing not found' ? 'NOT_LISTED' :
          result.error === 'Listing is no longer available' ? 'LISTING_UNAVAILABLE' :
            result.error === 'Cannot purchase your own listing' ? 'SELF_PURCHASE' :
              result.error === 'Insufficient Essence' ? 'INSUFFICIENT_BALANCE' :
                'PURCHASE_FAILED',
        message: result.error,
        required: result.required,
        available: result.available,
      },
    };
  }

  // 4. Return success response
  return {
    success: true,
    data: {
      message: 'Purchase successful!',
      totem: {
        id: result.totem.id,
        name: result.totem.name,
        speciesId: result.totem.speciesId,
        colorId: result.totem.colorId,
        rarityId: result.totem.rarityId,
        stage: result.totem.stage,
      },
      transaction: {
        totalPaid: result.totalPaid,
        purchaseFee: result.purchaseFee,
      },
      newEssenceBalance: result.newBalance,
      achievements: result.achievements || [],
    },
  };
}

module.exports = { purchase };
