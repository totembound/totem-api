/**
 * Cancel Listing Handler
 *
 * POST /api/shop/cancel
 *
 * Cancels an active listing and returns the totem to the seller.
 *
 * Business Rules:
 * - Only the seller can cancel their listing
 * - Listing must be active (not sold or already cancelled)
 * - Listing fee is NOT refunded
 * - Totem remains in seller's inventory (never actually moved)
 */

const { getTotem } = require('../../common/db-client');
const shopService = require('../../services/shop-service');

/**
 * Cancel a listing
 *
 * @param {object} user - Authenticated user { userId, email, displayName, tier }
 * @param {object} body - Request body { totemId }
 * @returns {object} - Result confirming cancellation
 */
async function cancel(user, body) {
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

  // 3. Get the listing
  const listingResult = await shopService.getListing(totemId);

  if (!listingResult.success || !listingResult.listing) {
    return {
      success: false,
      error: { code: 'NOT_LISTED', message: 'This totem is not listed for sale' },
    };
  }

  const listing = listingResult.listing;

  // 4. Verify user is the seller
  if (listing.originalOwnerId !== userId) {
    return {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'You can only cancel your own listings' },
    };
  }

  // 5. Check listing status
  if (listing.status !== 'active') {
    return {
      success: false,
      error: {
        code: 'INVALID_STATUS',
        message: `Cannot cancel listing with status: ${listing.status}`,
        currentStatus: listing.status,
      },
    };
  }

  // 6. Cancel the listing
  try {
    await shopService.cancelListing(userId, totemId);

    // Verify totem is still in seller's inventory
    const totem = await getTotem(userId, totemId);

    return {
      success: true,
      data: {
        message: 'Listing cancelled successfully',
        totemId,
        totemName: listing.totemData?.name || totem?.name,
        note: 'Listing fee is non-refundable',
      },
    };
  }
  catch (error) {
    console.error('Failed to cancel listing:', error);

    return {
      success: false,
      error: {
        code: 'CANCEL_FAILED',
        message: 'Failed to cancel listing. Please try again.',
      },
    };
  }
}

module.exports = { cancel };
