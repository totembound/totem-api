/**
 * Listings Handler
 *
 * GET /api/shop/listings
 *
 * Returns paginated marketplace listings with optional filters.
 *
 * Query Parameters:
 * - rarity: Filter by rarity ID (0-5)
 * - minPrice: Minimum asking price
 * - maxPrice: Maximum asking price
 * - species: Filter by species ID
 * - sortBy: 'price_asc', 'price_desc', 'newest', 'oldest' (default: 'newest')
 * - limit: Number of results (default: 20, max: 100)
 * - cursor: Pagination cursor for next page
 */

const shopService = require('../../services/shop-service');
const { calculateSellPrice } = require('../../services/shop-service');

// Default and maximum page sizes
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Valid sort options
const VALID_SORT_OPTIONS = ['price_asc', 'price_desc', 'newest', 'oldest'];

/**
 * Get marketplace listings
 *
 * @param {object} user - Authenticated user { userId } (optional - public endpoint could work without)
 * @param {object} queryParams - Query parameters for filtering
 * @returns {object} - Paginated listings
 */
async function getListings(user, queryParams = {}) {
  const {
    rarity,
    minPrice,
    maxPrice,
    species,
    sortBy = 'newest',
    limit: limitParam,
    cursor,
  } = queryParams;

  // 1. Validate and parse limit
  let limit = parseInt(limitParam, 10) || DEFAULT_LIMIT;
  if (limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // 2. Validate sort option
  const sort = VALID_SORT_OPTIONS.includes(sortBy) ? sortBy : 'newest';

  // 3. Build filters
  const filters = {};

  if (rarity !== undefined) {
    const rarityId = parseInt(rarity, 10);
    if (!isNaN(rarityId) && rarityId >= 0 && rarityId <= 5) {
      filters.rarityId = rarityId;
    }
  }

  if (species !== undefined) {
    const speciesId = parseInt(species, 10);
    if (!isNaN(speciesId) && speciesId >= 0 && speciesId <= 11) {
      filters.speciesId = speciesId;
    }
  }

  if (minPrice !== undefined) {
    const min = parseInt(minPrice, 10);
    if (!isNaN(min) && min >= 0) {
      filters.minPrice = min;
    }
  }

  if (maxPrice !== undefined) {
    const max = parseInt(maxPrice, 10);
    if (!isNaN(max) && max >= 0) {
      filters.maxPrice = max;
    }
  }

  // Validate min/max price range
  if (filters.minPrice !== undefined && filters.maxPrice !== undefined) {
    if (filters.minPrice > filters.maxPrice) {
      return {
        success: false,
        error: { code: 'INVALID_RANGE', message: 'minPrice cannot be greater than maxPrice' },
      };
    }
  }

  // 4. Get listings from shop service
  try {
    // Map sort option to shop service format
    let sortBy = 'listedAt';
    let sortOrder = 'desc';
    if (sort === 'price_asc') {
      sortBy = 'price'; sortOrder = 'asc'; 
    }
    else if (sort === 'price_desc') {
      sortBy = 'price'; sortOrder = 'desc'; 
    }
    else if (sort === 'newest') {
      sortBy = 'listedAt'; sortOrder = 'desc'; 
    }
    else if (sort === 'oldest') {
      sortBy = 'listedAt'; sortOrder = 'asc'; 
    }

    // Parse cursor to offset (simple offset-based pagination)
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;

    const result = await shopService.getUnboundListings({
      speciesId: filters.speciesId,
      rarityId: filters.rarityId,
      minPrice: filters.minPrice,
      maxPrice: filters.maxPrice,
      sortBy,
      sortOrder,
      limit,
      offset,
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to fetch listings');
    }

    // 5. Transform listings for API response
    // Always recalculate price to ensure current formula is used
    const listings = result.listings.map((listing) => {
      const stage = listing.totemData?.stage || 0;
      const rarityId = listing.totemData?.rarityId || 0;
      const currentPrice = calculateSellPrice(stage, rarityId);

      return {
        listingId: listing.id,
        totemId: listing.totemId,
        originalOwnerId: listing.originalOwnerId,
        seller: {
          id: listing.originalOwnerId,
          displayName: listing.sellerDisplayName || 'Anonymous',
        },
        totem: {
          name: listing.totemData?.name,
          speciesId: listing.totemData?.speciesId,
          colorId: listing.totemData?.colorId,
          rarityId: listing.totemData?.rarityId,
          stage: listing.totemData?.stage,
          experience: listing.totemData?.experience,
          stats: listing.totemData?.stats,
          traits: listing.totemData?.traits || null,
        },
        askingPrice: currentPrice,
        sellPrice: currentPrice,
        listedAt: listing.listedAt,
      };
    });

    // Calculate next cursor for pagination
    const nextCursor = result.hasMore ? String(offset + limit) : null;

    return {
      success: true,
      data: {
        listings,
        total: result.total,
        hasMore: result.hasMore,
        pagination: {
          count: listings.length,
          total: result.total,
          hasMore: result.hasMore,
          nextCursor,
        },
        filters: {
          rarity: filters.rarityId,
          species: filters.speciesId,
          minPrice: filters.minPrice,
          maxPrice: filters.maxPrice,
          sortBy: sort,
        },
      },
    };
  }
  catch (error) {
    console.error('Failed to fetch listings:', error);

    return {
      success: false,
      error: {
        code: 'FETCH_FAILED',
        message: 'Failed to fetch listings. Please try again.',
      },
    };
  }
}

module.exports = { getListings, DEFAULT_LIMIT, MAX_LIMIT, VALID_SORT_OPTIONS };
