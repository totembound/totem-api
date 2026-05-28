/**
 * Shop API Handlers
 *
 * Routes:
 * - POST /api/shop/list - List a totem for sale
 * - POST /api/shop/purchase - Purchase a listed totem
 * - POST /api/shop/cancel - Cancel a listing
 * - GET /api/shop/listings - Browse marketplace listings
 */

const { listTotem, LISTING_FEE, MIN_ASKING_PRICE, MAX_ASKING_PRICE } = require('./list-totem');
const { purchase, calculateTransactionFee, TRANSACTION_FEE_PERCENT } = require('./purchase');
const { cancel } = require('./cancel');
const { getListings, DEFAULT_LIMIT, MAX_LIMIT, VALID_SORT_OPTIONS } = require('./listings');
const { purchaseBundle, getSpecialOfferBundles, SPECIAL_OFFER_BUNDLES } = require('./purchase-bundle');

/**
 * Get shop configuration (for frontend to display fees, limits, etc.)
 *
 * @param {object} user - Authenticated user
 * @returns {object} - Shop configuration
 */
async function getConfig(_user) {
  return {
    success: true,
    data: {
      listing: {
        fee: LISTING_FEE,
        minPrice: MIN_ASKING_PRICE,
        maxPrice: MAX_ASKING_PRICE,
      },
      purchase: {
        feePercent: TRANSACTION_FEE_PERCENT,
      },
      pagination: {
        defaultLimit: DEFAULT_LIMIT,
        maxLimit: MAX_LIMIT,
      },
      filters: {
        sortOptions: VALID_SORT_OPTIONS,
      },
    },
  };
}

/**
 * Get shop items (legacy endpoint - maps to getListings)
 * Kept for backward compatibility with existing frontend
 */
async function getItems(user) {
  return getListings(user, { limit: 20 });
}

module.exports = {
  // Main handlers
  listTotem,
  purchase,
  cancel,
  getListings,
  getConfig,

  // Bundle purchase handlers
  purchaseBundle,
  getSpecialOfferBundles,

  // Legacy/alias
  getItems,

  // Constants (exported for testing and documentation)
  LISTING_FEE,
  MIN_ASKING_PRICE,
  MAX_ASKING_PRICE,
  TRANSACTION_FEE_PERCENT,
  calculateTransactionFee,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  VALID_SORT_OPTIONS,
  SPECIAL_OFFER_BUNDLES,
};
