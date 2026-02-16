/**
 * Shop Handler Tests
 *
 * Tests for shop listing, purchase, cancel, marketplace, my-listings,
 * exchange-gems, and shop config handlers.
 */

// Mock db-client
jest.mock('../src/common/db-client', () => ({
  getTotem: jest.fn(),
  getUser: jest.fn(),
  logTransaction: jest.fn().mockResolvedValue({}),
  docClient: { send: jest.fn() },
  TABLES: {
    USERS: 'TotemBound-Users',
    TOTEMS: 'TotemBound-Totems',
    SHOP: 'TotemBound-Shop',
    TRANSACTIONS: 'TotemBound-Transactions',
  },
  KEY_PREFIX: { USER: 'USER#' },
}));

// Mock shop-service
jest.mock('../src/services/shop-service', () => ({
  listTotemForSale: jest.fn(),
  cancelListing: jest.fn(),
  getListing: jest.fn(),
  purchaseUnboundTotem: jest.fn(),
  getUnboundListings: jest.fn(),
  getUserListings: jest.fn(),
  countUserListings: jest.fn(),
  calculateSellPrice: jest.fn((stage, rarityId) => 300 + (stage * 30) + (rarityId * 20)),
}));

const dbClient = require('../src/common/db-client');
const shopService = require('../src/services/shop-service');

const { listTotem } = require('../src/functions/shop/list-totem');
const { cancel } = require('../src/functions/shop/cancel');
const { purchase } = require('../src/functions/shop/purchase');
const { getListings } = require('../src/functions/shop/listings');
const { getMyListings } = require('../src/functions/shop/my-listings');

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123', email: 'test@example.com', displayName: 'Tester' };

const makeListing = (overrides = {}) => ({
  id: 'lst_abc',
  totemId: 'ttm_abc',
  originalOwnerId: testUser.userId,
  status: 'active',
  askingPrice: 350,
  sellerDisplayName: 'Tester',
  listedAt: '2024-01-01T00:00:00.000Z',
  totemData: {
    name: 'Wolfie',
    speciesId: 2,
    colorId: 4,
    rarityId: 1,
    stage: 1,
    experience: 600,
    stats: { strength: 10, agility: 8, wisdom: 6, happiness: 50 },
  },
  ...overrides,
});

// =============================================================================
// TESTS
// =============================================================================

describe('Shop Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // LIST TOTEM
  // ===========================================================================

  describe('listTotem', () => {
    it('should list a totem successfully', async () => {
      shopService.listTotemForSale.mockResolvedValue({
        success: true,
        data: { listingId: 'lst_new', sellPrice: 350 },
      });
      const result = await listTotem(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(shopService.listTotemForSale).toHaveBeenCalledWith(testUser.userId, 'ttm_abc');
    });

    it('should require totemId', async () => {
      const result = await listTotem(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_FIELD');
    });

    it('should require totemId when body is null', async () => {
      const result = await listTotem(testUser, null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_FIELD');
    });

    it('should reject invalid totemId format', async () => {
      const result = await listTotem(testUser, { totemId: 'bad_id' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should handle service error gracefully', async () => {
      shopService.listTotemForSale.mockRejectedValue(new Error('DB error'));
      const result = await listTotem(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('LISTING_FAILED');
    });
  });

  // ===========================================================================
  // CANCEL LISTING
  // ===========================================================================

  describe('cancel', () => {
    beforeEach(() => {
      shopService.getListing.mockResolvedValue({
        success: true,
        listing: makeListing(),
      });
      shopService.cancelListing.mockResolvedValue({});
      dbClient.getTotem.mockResolvedValue({ id: 'ttm_abc', name: 'Wolfie' });
    });

    it('should cancel a listing successfully', async () => {
      const result = await cancel(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(result.data.totemId).toBe('ttm_abc');
      expect(result.data.note).toContain('non-refundable');
    });

    it('should require totemId', async () => {
      const result = await cancel(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_FIELD');
    });

    it('should reject invalid totemId format', async () => {
      const result = await cancel(testUser, { totemId: 'bad_id' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_LISTED when listing not found', async () => {
      shopService.getListing.mockResolvedValue({ success: false });
      const result = await cancel(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_LISTED');
    });

    it('should return UNAUTHORIZED when not the seller', async () => {
      shopService.getListing.mockResolvedValue({
        success: true,
        listing: makeListing({ originalOwnerId: 'usr_other' }),
      });
      const result = await cancel(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('UNAUTHORIZED');
    });

    it('should return INVALID_STATUS when listing is sold', async () => {
      shopService.getListing.mockResolvedValue({
        success: true,
        listing: makeListing({ status: 'sold' }),
      });
      const result = await cancel(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_STATUS');
    });

    it('should handle cancel service error', async () => {
      shopService.cancelListing.mockRejectedValue(new Error('fail'));
      const result = await cancel(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('CANCEL_FAILED');
    });
  });

  // ===========================================================================
  // PURCHASE
  // ===========================================================================

  describe('purchase', () => {
    it('should purchase a listed totem successfully', async () => {
      shopService.purchaseUnboundTotem.mockResolvedValue({
        success: true,
        totem: { id: 'ttm_abc', name: 'Wolfie', speciesId: 2, colorId: 4, rarityId: 1, stage: 1 },
        totalPaid: 450,
        purchaseFee: 100,
        newBalance: 1550,
        achievements: [],
      });
      const result = await purchase(testUser, { totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(result.data.totem.id).toBe('ttm_abc');
      expect(result.data.transaction.totalPaid).toBe(450);
      expect(result.data.newEssenceBalance).toBe(1550);
    });

    it('should require totemId', async () => {
      const result = await purchase(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_FIELD');
    });

    it('should reject invalid totemId format', async () => {
      const result = await purchase(testUser, { totemId: 'bad' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should map NOT_LISTED error', async () => {
      shopService.purchaseUnboundTotem.mockResolvedValue({
        success: false, error: 'Listing not found',
      });
      const result = await purchase(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('NOT_LISTED');
    });

    it('should map SELF_PURCHASE error', async () => {
      shopService.purchaseUnboundTotem.mockResolvedValue({
        success: false, error: 'Cannot purchase your own listing',
      });
      const result = await purchase(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('SELF_PURCHASE');
    });

    it('should map INSUFFICIENT_BALANCE error', async () => {
      shopService.purchaseUnboundTotem.mockResolvedValue({
        success: false, error: 'Insufficient Essence', required: 450, available: 100,
      });
      const result = await purchase(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(result.error.required).toBe(450);
    });

    it('should map LISTING_UNAVAILABLE error', async () => {
      shopService.purchaseUnboundTotem.mockResolvedValue({
        success: false, error: 'Listing is no longer available',
      });
      const result = await purchase(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('LISTING_UNAVAILABLE');
    });

    it('should map unknown error to PURCHASE_FAILED', async () => {
      shopService.purchaseUnboundTotem.mockResolvedValue({
        success: false, error: 'Something weird happened',
      });
      const result = await purchase(testUser, { totemId: 'ttm_abc' });
      expect(result.error.code).toBe('PURCHASE_FAILED');
    });
  });

  // ===========================================================================
  // GET LISTINGS (MARKETPLACE)
  // ===========================================================================

  describe('getListings', () => {
    const mockListingsResult = {
      success: true,
      listings: [makeListing()],
      total: 1,
      hasMore: false,
    };

    beforeEach(() => {
      shopService.getUnboundListings.mockResolvedValue(mockListingsResult);
    });

    it('should return listings with default params', async () => {
      const result = await getListings(testUser, {});
      expect(result.success).toBe(true);
      expect(result.data.listings).toHaveLength(1);
      expect(result.data.pagination.count).toBe(1);
    });

    it('should apply rarity filter', async () => {
      await getListings(testUser, { rarity: '2' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.objectContaining({ rarityId: 2 })
      );
    });

    it('should ignore invalid rarity', async () => {
      await getListings(testUser, { rarity: 'abc' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.not.objectContaining({ rarityId: expect.anything() })
      );
    });

    it('should apply species filter', async () => {
      await getListings(testUser, { species: '3' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.objectContaining({ speciesId: 3 })
      );
    });

    it('should apply price range filters', async () => {
      await getListings(testUser, { minPrice: '100', maxPrice: '500' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.objectContaining({ minPrice: 100, maxPrice: 500 })
      );
    });

    it('should reject minPrice > maxPrice', async () => {
      const result = await getListings(testUser, { minPrice: '500', maxPrice: '100' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_RANGE');
    });

    it('should apply sort options', async () => {
      await getListings(testUser, { sortBy: 'price_asc' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: 'price', sortOrder: 'asc' })
      );
    });

    it('should default invalid sort to newest', async () => {
      await getListings(testUser, { sortBy: 'invalid_sort' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: 'listedAt', sortOrder: 'desc' })
      );
    });

    it('should cap limit at MAX_LIMIT (100)', async () => {
      await getListings(testUser, { limit: '999' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 })
      );
    });

    it('should default negative limit to DEFAULT_LIMIT', async () => {
      await getListings(testUser, { limit: '-5' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20 })
      );
    });

    it('should use cursor for pagination', async () => {
      shopService.getUnboundListings.mockResolvedValue({ ...mockListingsResult, hasMore: true });
      const result = await getListings(testUser, { cursor: '20' });
      expect(shopService.getUnboundListings).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 20 })
      );
      expect(result.data.pagination.nextCursor).toBe('40');
    });

    it('should handle service error', async () => {
      shopService.getUnboundListings.mockResolvedValue({ success: false, error: 'DB error' });
      const result = await getListings(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('FETCH_FAILED');
    });
  });

  // ===========================================================================
  // GET MY LISTINGS
  // ===========================================================================

  describe('getMyListings', () => {
    beforeEach(() => {
      shopService.getUserListings.mockResolvedValue({
        listings: [makeListing()],
        hasMore: false,
        nextCursor: null,
      });
      shopService.countUserListings.mockResolvedValue(1);
    });

    it('should return user listings with default params', async () => {
      const result = await getMyListings(testUser, {});
      expect(result.success).toBe(true);
      expect(result.data.listings).toHaveLength(1);
      expect(result.data.summary).toBeDefined();
    });

    it('should filter by status', async () => {
      await getMyListings(testUser, { status: 'sold' });
      expect(shopService.getUserListings).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({ status: 'sold' })
      );
    });

    it('should pass null status for "all"', async () => {
      await getMyListings(testUser, { status: 'all' });
      expect(shopService.getUserListings).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({ status: null })
      );
    });

    it('should default invalid status to active', async () => {
      await getMyListings(testUser, { status: 'bogus' });
      expect(shopService.getUserListings).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({ status: 'active' })
      );
    });

    it('should cap limit at MAX_LIMIT (100)', async () => {
      await getMyListings(testUser, { limit: '999' });
      expect(shopService.getUserListings).toHaveBeenCalledWith(
        testUser.userId,
        expect.objectContaining({ limit: 100 })
      );
    });

    it('should include sale info for sold listings', async () => {
      shopService.getUserListings.mockResolvedValue({
        listings: [makeListing({
          status: 'sold',
          sale: { buyerId: 'usr_buyer', price: 350, fee: 100, completedAt: '2024-01-02T00:00:00.000Z' },
        })],
        hasMore: false,
      });
      const result = await getMyListings(testUser, { status: 'sold' });
      expect(result.data.listings[0].sale).toBeDefined();
      expect(result.data.listings[0].sale.buyerId).toBe('usr_buyer');
    });

    it('should handle service error', async () => {
      shopService.getUserListings.mockRejectedValue(new Error('fail'));
      const result = await getMyListings(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('FETCH_FAILED');
    });
  });

  // ===========================================================================
  // SHOP CONFIG (index.js)
  // ===========================================================================

  describe('getConfig', () => {
    it('should return shop configuration', async () => {
      const { getConfig } = require('../src/functions/shop/index');
      const result = await getConfig(testUser);
      expect(result.success).toBe(true);
      expect(result.data.listing).toBeDefined();
      expect(result.data.purchase).toBeDefined();
      expect(result.data.pagination).toBeDefined();
      expect(result.data.filters).toBeDefined();
    });
  });

  describe('getItems (legacy)', () => {
    it('should delegate to getListings with limit 20', async () => {
      shopService.getUnboundListings.mockResolvedValue({
        success: true,
        listings: [],
        total: 0,
        hasMore: false,
      });
      const { getItems } = require('../src/functions/shop/index');
      const result = await getItems(testUser);
      expect(result.success).toBe(true);
    });
  });
});
