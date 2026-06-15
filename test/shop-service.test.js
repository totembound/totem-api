/**
 * Shop Service Tests
 *
 * Tests for marketplace operations: listing, purchasing, cancelling,
 * price calculations, and query filtering.
 */

// Mock @aws-sdk/lib-dynamodb (extends global setup with QueryCommand/ScanCommand)
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: jest.fn() }) },
  GetCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  ScanCommand: jest.fn(),
  QueryCommand: jest.fn(),
}));

// Mock db-client before requiring the service
jest.mock('../src/common/db-client', () => {
  const mockDocClient = { send: jest.fn() };
  return {
    getItem: jest.fn(),
    putItem: jest.fn(),
    updateItem: jest.fn(),
    deleteItem: jest.fn(),
    queryItems: jest.fn(),
    transactWrite: jest.fn(),
    getUser: jest.fn(),
    getTotem: jest.fn(),
    updateUser: jest.fn(),
    getUserTotems: jest.fn(),
    addEssence: jest.fn(),
    deductEssence: jest.fn(),
    logTransaction: jest.fn(),
    docClient: mockDocClient,
    userPK: jest.fn((userId) => `USER#${userId}`),
    totemSK: jest.fn((totemId) => `TOTEM#${totemId}`),
    TABLES: {
      USERS: 'TotemBound-Users',
      TOTEMS: 'TotemBound-Totems',
      SHOP: 'TotemBound-Shop',
      TRANSACTIONS: 'TotemBound-Transactions',
    },
  };
});

// Mock achievements service
jest.mock('../src/services/achievements-service', () => ({
  onTotemAcquired: jest.fn().mockResolvedValue([]),
}));

// Mock id-utils
const mockListingId = 'sls_01TEST000000000000000000TEST';
jest.mock('../src/common/id-utils', () => ({
  generateId: jest.fn(() => mockListingId),
}));

const dbClient = require('../src/common/db-client');
const achievementsService = require('../src/services/achievements-service');
const {
  calculateSellPrice,
  PURCHASE_FEE,
  shopUnboundPK,
  shopTotemSK,
  listTotemForSale,
  purchaseUnboundTotem,
  getUnboundListings,
  getListing,
} = require('../src/services/shop-service');

// =============================================================================
// TEST DATA
// =============================================================================

const testUserId = 'usr_seller123';
const testBuyerId = 'usr_buyer456';
const testTotemId = 'ttm_totem789';

function makeMockTotem(overrides = {}) {
  return {
    id: testTotemId,
    userId: testUserId,
    speciesId: 2,
    colorId: 8,
    rarityId: 2,
    name: 'Shadow Wolf',
    nickname: 'Fang',
    stage: 2,
    experience: 1500,
    prestigeLevel: 0,
    stats: { strength: 12, agility: 9, wisdom: 6 },
    ...overrides,
  };
}

function makeMockListing(overrides = {}) {
  return {
    pk: 'SHOP#UNBOUND',
    sk: `TOTEM#${testTotemId}`,
    id: mockListingId,
    totemId: testTotemId,
    originalOwnerId: testUserId,
    sellPrice: 360,
    status: 'active',
    totemData: {
      speciesId: 2,
      colorId: 8,
      rarityId: 2,
      name: 'Shadow Wolf',
      stage: 2,
      experience: 1500,
      prestigeLevel: 0,
      stats: { strength: 12, agility: 9, wisdom: 6 },
    },
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Shop Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.getUser.mockResolvedValue({
      id: testUserId,
      currencies: { essence: 2000, gems: 0 },
    });
    dbClient.getTotem.mockResolvedValue(makeMockTotem());
    dbClient.getItem.mockResolvedValue(null);
    dbClient.transactWrite.mockResolvedValue({});
    dbClient.logTransaction.mockResolvedValue({});
    dbClient.getUserTotems.mockResolvedValue([makeMockTotem()]);
    dbClient.updateUser.mockResolvedValue({});
  });

  // =============================================================================
  // PRICE CALCULATION TESTS
  // =============================================================================

  describe('calculateSellPrice', () => {
    it('should calculate base price for stage 0, common (rarity 0)', () => {
      // 300 + (0 * 30) + (0 * 20) = 300
      expect(calculateSellPrice(0, 0)).toBe(300);
    });

    it('should add stage bonus', () => {
      // 300 + (2 * 30) + (0 * 20) = 360
      expect(calculateSellPrice(2, 0)).toBe(360);
    });

    it('should add rarity bonus', () => {
      // 300 + (0 * 30) + (2 * 20) = 340
      expect(calculateSellPrice(0, 2)).toBe(340);
    });

    it('should calculate combined stage + rarity bonus', () => {
      // 300 + (2 * 30) + (2 * 20) = 400
      expect(calculateSellPrice(2, 2)).toBe(400);
    });

    it('should calculate max stage 4 + legendary price', () => {
      // 300 + (4 * 30) + (4 * 20) = 500
      expect(calculateSellPrice(4, 4)).toBe(500);
    });

    it('should calculate limited rarity price', () => {
      // 300 + (0 * 30) + (5 * 20) = 400
      expect(calculateSellPrice(0, 5)).toBe(400);
    });

    it('should match contract formula: 300 + (stage * 30) + (rarityId * 20)', () => {
      for (let stage = 0; stage <= 4; stage++) {
        for (let rarity = 0; rarity <= 5; rarity++) {
          const expected = 300 + (stage * 30) + (rarity * 20);
          expect(calculateSellPrice(stage, rarity)).toBe(expected);
        }
      }
    });
  });

  describe('PURCHASE_FEE', () => {
    it('should be 100 Essence', () => {
      expect(PURCHASE_FEE).toBe(100);
    });
  });

  // =============================================================================
  // KEY HELPER TESTS
  // =============================================================================

  describe('Key helpers', () => {
    it('shopUnboundPK should return SHOP#UNBOUND', () => {
      expect(shopUnboundPK()).toBe('SHOP#UNBOUND');
    });

    it('shopTotemSK should return TOTEM#{totemId}', () => {
      expect(shopTotemSK('ttm_abc')).toBe('TOTEM#ttm_abc');
    });
  });

  // =============================================================================
  // LIST TOTEM FOR SALE TESTS
  // =============================================================================

  describe('listTotemForSale', () => {
    it('should successfully list a totem', async () => {
      const result = await listTotemForSale(testUserId, testTotemId, 0);

      expect(result.success).toBe(true);
      expect(result.listing).toBeDefined();
      expect(result.sellPrice).toBe(400); // stage 2 + rarity 2: 300 + 60 + 40
      expect(result.newBalance).toBe(2400); // 2000 + 400
      expect(dbClient.transactWrite).toHaveBeenCalled();
      expect(dbClient.logTransaction).toHaveBeenCalledWith(testUserId, expect.objectContaining({
        type: 'shop_sale',
        amount: 400,
      }));
    });

    it('should calculate price server-side (ignoring askingPrice param)', async () => {
      const result = await listTotemForSale(testUserId, testTotemId, 99999);

      // Price should be calculated from stage/rarity, not the askingPrice
      expect(result.sellPrice).toBe(400);
    });

    it('should fail if user not found', async () => {
      dbClient.getUser.mockResolvedValue(null);

      const result = await listTotemForSale(testUserId, testTotemId, 0);

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });

    it('should fail if totem not found', async () => {
      dbClient.getTotem.mockResolvedValue(null);

      const result = await listTotemForSale(testUserId, testTotemId, 0);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Totem not found or not owned by user');
    });

    it('should fail if totem is already listed', async () => {
      dbClient.getItem.mockResolvedValue({ status: 'active' });

      const result = await listTotemForSale(testUserId, testTotemId, 0);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Totem is already listed for sale');
    });

    it('should allow re-listing after cancelled listing', async () => {
      dbClient.getItem.mockResolvedValue({ status: 'cancelled' });

      const result = await listTotemForSale(testUserId, testTotemId, 0);

      expect(result.success).toBe(true);
    });

    it('should snapshot totem data in the listing', async () => {
      const result = await listTotemForSale(testUserId, testTotemId, 0);

      expect(result.listing.totemData.speciesId).toBe(2);
      expect(result.listing.totemData.rarityId).toBe(2);
      expect(result.listing.totemData.stage).toBe(2);
      expect(result.listing.totemData.stats).toEqual({ strength: 12, agility: 9, wisdom: 6 });
    });

    it('should handle transaction errors', async () => {
      dbClient.transactWrite.mockRejectedValue(new Error('Transaction failed'));

      const result = await listTotemForSale(testUserId, testTotemId, 0);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Transaction failed');
    });
  });

  // =============================================================================
  // PURCHASE UNBOUND TOTEM TESTS
  // =============================================================================

  describe('purchaseUnboundTotem', () => {
    beforeEach(() => {
      dbClient.getItem.mockResolvedValue(makeMockListing());
      dbClient.getUser.mockResolvedValue({
        id: testBuyerId,
        currencies: { essence: 1000, gems: 0 },
      });
    });

    it('should successfully purchase a listed totem', async () => {
      const result = await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(result.success).toBe(true);
      expect(result.totem).toBeDefined();
      expect(result.totem.userId).toBe(testBuyerId);
      expect(result.totalPaid).toBe(460); // 360 + 100 fee
      expect(result.purchaseFee).toBe(100);
      expect(result.newBalance).toBe(540); // 1000 - 460
      expect(dbClient.transactWrite).toHaveBeenCalled();
    });

    it('should trigger achievements for buyer', async () => {
      await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(achievementsService.onTotemAcquired).toHaveBeenCalledWith(testBuyerId, expect.objectContaining({
        rarityId: 2,
        totemId: testTotemId,
      }));
    });

    it('should fail if listing not found', async () => {
      dbClient.getItem.mockResolvedValue(null);

      const result = await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Listing not found');
    });

    it('should fail if listing is not active', async () => {
      dbClient.getItem.mockResolvedValue(makeMockListing({ status: 'sold' }));

      const result = await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Listing is no longer available');
    });

    it('should fail if buyer not found', async () => {
      dbClient.getUser.mockResolvedValue(null);

      const result = await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Buyer not found');
    });

    it('should fail if buyer has insufficient Essence', async () => {
      dbClient.getUser.mockResolvedValue({
        id: testBuyerId,
        currencies: { essence: 100, gems: 0 },
      });

      const result = await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient Essence');
      expect(result.required).toBe(460);
      expect(result.available).toBe(100);
    });

    it('should handle double-purchase race condition', async () => {
      const error = new Error('Transaction cancelled');
      error.name = 'TransactionCanceledException';
      dbClient.transactWrite.mockRejectedValue(error);

      const result = await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('This totem has already been sold');
    });

    it('should recreate totem with correct keys for buyer', async () => {
      const result = await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(result.totem.pk).toBe(`USER#${testBuyerId}`);
      expect(result.totem.sk).toBe(`TOTEM#${testTotemId}`);
      expect(result.totem.speciesId).toBe(2);
      expect(result.totem.cooldowns).toEqual({ feed: null, train: null, treat: null });
    });

    it('should log purchase transaction', async () => {
      await purchaseUnboundTotem(testBuyerId, testTotemId);

      expect(dbClient.logTransaction).toHaveBeenCalledWith(testBuyerId, expect.objectContaining({
        type: 'shop_purchase',
        amount: -460,
        balanceBefore: 1000,
        balanceAfter: 540,
      }));
    });
  });

  // =============================================================================
  // QUERY TESTS
  // =============================================================================

  describe('getUnboundListings', () => {
    const mockListings = [
      makeMockListing({ sellPrice: 300, totemData: { stage: 0 }, listedAt: '2024-01-01' }),
      makeMockListing({ sellPrice: 400, totemData: { stage: 2 }, listedAt: '2024-01-02' }),
      makeMockListing({ sellPrice: 500, totemData: { stage: 4 }, listedAt: '2024-01-03' }),
    ];

    beforeEach(() => {
      dbClient.docClient.send.mockResolvedValue({ Items: mockListings });
    });

    it('should return active listings', async () => {
      const result = await getUnboundListings();

      expect(result.success).toBe(true);
      expect(result.listings).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('should filter by minPrice', async () => {
      const result = await getUnboundListings({ minPrice: 350 });

      expect(result.listings).toHaveLength(2);
    });

    it('should filter by maxPrice', async () => {
      const result = await getUnboundListings({ maxPrice: 400 });

      expect(result.listings).toHaveLength(2);
    });

    it('should filter by minStage', async () => {
      const result = await getUnboundListings({ minStage: 2 });

      expect(result.listings).toHaveLength(2);
    });

    it('should paginate results', async () => {
      const result = await getUnboundListings({ limit: 2, offset: 0 });

      expect(result.listings).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it('should respect offset for pagination', async () => {
      const result = await getUnboundListings({ limit: 2, offset: 2 });

      expect(result.listings).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it('should handle empty results', async () => {
      dbClient.docClient.send.mockResolvedValue({ Items: [] });

      const result = await getUnboundListings();

      expect(result.success).toBe(true);
      expect(result.listings).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should handle errors', async () => {
      dbClient.docClient.send.mockRejectedValue(new Error('Query failed'));

      const result = await getUnboundListings();

      expect(result.success).toBe(false);
    });
  });

  describe('getListing', () => {
    it('should return a specific listing', async () => {
      dbClient.getItem.mockResolvedValue(makeMockListing());

      const result = await getListing(testTotemId);

      expect(result.success).toBe(true);
      expect(result.listing.totemId).toBe(testTotemId);
    });

    it('should fail if listing not found', async () => {
      dbClient.getItem.mockResolvedValue(null);

      const result = await getListing('ttm_nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Listing not found');
    });
  });
});
