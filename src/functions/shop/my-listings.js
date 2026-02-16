/**
 * My Listings Handler
 *
 * GET /api/shop/my-listings
 *
 * Returns the authenticated user's active listings.
 *
 * Query Parameters:
 * - status: Filter by status ('active', 'sold', 'cancelled', 'all') - default: 'active'
 * - limit: Number of results (default: 50, max: 100)
 * - cursor: Pagination cursor for next page
 */

const shopService = require('../../services/shop-service');

// Default and maximum page sizes
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Valid status filters
const VALID_STATUS_FILTERS = ['active', 'sold', 'cancelled', 'all'];

/**
 * Get user's listings
 *
 * @param {object} user - Authenticated user { userId, email, displayName, tier }
 * @param {object} queryParams - Query parameters
 * @returns {object} - User's listings
 */
async function getMyListings(user, queryParams = {}) {
  const userId = user.userId;
  const {
    status = 'active',
    limit: limitParam,
    cursor,
  } = queryParams;

  // 1. Validate and parse limit
  let limit = parseInt(limitParam, 10) || DEFAULT_LIMIT;
  if (limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // 2. Validate status filter
  const statusFilter = VALID_STATUS_FILTERS.includes(status) ? status : 'active';

  // 3. Get user's listings
  try {
    const result = await shopService.getUserListings(userId, {
      status: statusFilter === 'all' ? null : statusFilter,
      limit,
      cursor,
    });

    // 4. Transform listings for API response
    const listings = result.listings.map((listing) => ({
      listingId: listing.id,
      totemId: listing.totemId,
      totem: {
        name: listing.totemData?.name,
        speciesId: listing.totemData?.speciesId,
        colorId: listing.totemData?.colorId,
        rarityId: listing.totemData?.rarityId,
        stage: listing.totemData?.stage,
        experience: listing.totemData?.experience,
        stats: listing.totemData?.stats,
      },
      askingPrice: listing.askingPrice,
      status: listing.status,
      listedAt: listing.createdAt,
      updatedAt: listing.updatedAt,
      // Include sale info if sold
      ...(listing.status === 'sold' && listing.sale && {
        sale: {
          buyerId: listing.sale.buyerId,
          price: listing.sale.price,
          fee: listing.sale.fee,
          soldAt: listing.sale.completedAt,
        },
      }),
    }));

    // 5. Calculate summary stats
    const summary = {
      total: listings.length,
      active: listings.filter((l) => l.status === 'active').length,
      sold: listings.filter((l) => l.status === 'sold').length,
      cancelled: listings.filter((l) => l.status === 'cancelled').length,
    };

    // If showing all statuses, get actual totals from service
    if (statusFilter === 'all' || statusFilter === 'active') {
      const activeCount = await shopService.countUserListings(userId, 'active');
      summary.activeTotal = activeCount;
    }

    return {
      success: true,
      data: {
        listings,
        summary,
        pagination: {
          count: listings.length,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        },
        filter: {
          status: statusFilter,
        },
      },
    };
  }
  catch (error) {
    console.error('Failed to fetch user listings:', error);

    return {
      success: false,
      error: {
        code: 'FETCH_FAILED',
        message: 'Failed to fetch your listings. Please try again.',
      },
    };
  }
}

module.exports = { getMyListings, DEFAULT_LIMIT, MAX_LIMIT, VALID_STATUS_FILTERS };
