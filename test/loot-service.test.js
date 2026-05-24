/**
 * Loot Service Tests
 *
 * Tests for loot box granting, claiming, and inventory queries.
 * Covers totem box + essence box types, double-claim prevention,
 * and achievement integration.
 */

// Mock db-client before requiring the service
jest.mock('../src/common/db-client', () => {
  const mockDocClient = { send: jest.fn() };
  return {
    getItem: jest.fn(),
    putItem: jest.fn(),
    updateItem: jest.fn(),
    queryItems: jest.fn(),
    getUser: jest.fn(),
    getTotem: jest.fn(),
    updateUser: jest.fn(),
    addEssence: jest.fn(),
    logTransaction: jest.fn(),
    docClient: mockDocClient,
    userPK: jest.fn((userId) => `USER#${userId}`),
    TABLES: {
      REWARD_STATE: 'TotemBound-RewardState',
      TOTEMS: 'TotemBound-Totems',
      USERS: 'TotemBound-Users',
    },
  };
});

// Mock achievements service
jest.mock('../src/services/achievements-service', () => ({
  onTotemAcquired: jest.fn().mockResolvedValue([]),
}));

// Mock id-utils
const mockLootId = 'loot_01TEST000000000000000000TEST';
jest.mock('../src/common/id-utils', () => ({
  generateId: jest.fn(() => mockLootId),
}));

// Mock totem-creation (used by claimTotemBox)
jest.mock('../src/services/totem-creation', () => {
  const actual = jest.requireActual('../src/services/totem-creation');
  return {
    ...actual,
    createTotem: jest.fn((opts) => ({
      pk: `USER#${opts.userId}`,
      sk: `TOTEM#ttm_created`,
      id: 'ttm_created',
      userId: opts.userId,
      speciesId: opts.speciesId || 0,
      colorId: 8,
      rarityId: 1,
      stage: 0,
      experience: 0,
      stats: { strength: 9, agility: 7, wisdom: 11, happiness: 50, hunger: 100 },
      cooldowns: { feed: null, train: null, treat: null },
      traits: { innate: 'trt_brave', learned: null, awakened: null },
    })),
  };
});

const dbClient = require('../src/common/db-client');
const achievementsService = require('../src/services/achievements-service');
const {
  grantLootItem,
  getUnclaimedLoot,
  claimLootItem,
  getBoxDefinition,
  getAllBoxDefinitions,
} = require('../src/services/loot-service');

// =============================================================================
// TEST DATA
// =============================================================================

const testUserId = 'usr_test123';

// =============================================================================
// TESTS
// =============================================================================

describe('Loot Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbClient.putItem.mockResolvedValue({});
    dbClient.updateItem.mockResolvedValue({});
    dbClient.queryItems.mockResolvedValue([]);
    dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 2500 });
    dbClient.getUser.mockResolvedValue({ stats: { totalTotems: 2 } });
    dbClient.updateUser.mockResolvedValue({});
    dbClient.docClient.send.mockResolvedValue({});
  });

  // =============================================================================
  // BOX DEFINITION TESTS
  // =============================================================================

  describe('getBoxDefinition', () => {
    it('should return uncommon_totem_box definition', () => {
      const box = getBoxDefinition('uncommon_totem_box');
      expect(box).toBeDefined();
      expect(box.type).toBe('totem_box');
      expect(box.config.rarityId).toBe(1);
    });

    it('should return rare_totem_box definition', () => {
      const box = getBoxDefinition('rare_totem_box');
      expect(box).toBeDefined();
      expect(box.type).toBe('totem_box');
      expect(box.config.rarityId).toBe(2);
    });

    it('should return essence_box_small definition', () => {
      const box = getBoxDefinition('essence_box_small');
      expect(box).toBeDefined();
      expect(box.type).toBe('essence_box');
      expect(box.config.minAmount).toBe(200);
      expect(box.config.maxAmount).toBe(500);
    });

    it('should return essence_box_large definition', () => {
      const box = getBoxDefinition('essence_box_large');
      expect(box).toBeDefined();
      expect(box.config.minAmount).toBe(1000);
      expect(box.config.maxAmount).toBe(2500);
    });

    it('should return null for unknown box ID', () => {
      expect(getBoxDefinition('nonexistent_box')).toBeNull();
    });
  });

  describe('getAllBoxDefinitions', () => {
    it('should return all 4 box types', () => {
      const boxes = getAllBoxDefinitions();
      expect(Object.keys(boxes)).toHaveLength(4);
      expect(boxes).toHaveProperty('uncommon_totem_box');
      expect(boxes).toHaveProperty('rare_totem_box');
      expect(boxes).toHaveProperty('essence_box_small');
      expect(boxes).toHaveProperty('essence_box_large');
    });
  });

  // =============================================================================
  // GRANT LOOT ITEM TESTS
  // =============================================================================

  describe('grantLootItem', () => {
    it('should create an unclaimed loot item record', async () => {
      const result = await grantLootItem(testUserId, 'uncommon_totem_box', 'signup');

      expect(result.id).toBe(mockLootId);
      expect(result.boxId).toBe('uncommon_totem_box');
      expect(result.source).toBe('signup');
      expect(result.status).toBe('unclaimed');
      expect(result.grantedAt).toBeDefined();
      expect(result.box).toBeDefined();
    });

    it('should save to RewardState table with LOOT# SK prefix', async () => {
      await grantLootItem(testUserId, 'rare_totem_box', 'achievement');

      expect(dbClient.putItem).toHaveBeenCalledWith(
        'TotemBound-RewardState',
        expect.objectContaining({
          pk: `USER#${testUserId}`,
          sk: `LOOT#${mockLootId}`,
          status: 'unclaimed',
          boxId: 'rare_totem_box',
          source: 'achievement',
        })
      );
    });

    it('should throw for unknown box type', async () => {
      await expect(grantLootItem(testUserId, 'fake_box', 'test'))
        .rejects.toThrow('Unknown loot box type: fake_box');
    });

    it('should include box definition in response', async () => {
      const result = await grantLootItem(testUserId, 'essence_box_small', 'reward');

      expect(result.box.name).toBe('Small Essence Box');
      expect(result.box.type).toBe('essence_box');
    });
  });

  // =============================================================================
  // GET UNCLAIMED LOOT TESTS
  // =============================================================================

  describe('getUnclaimedLoot', () => {
    it('should query with LOOT# prefix and unclaimed filter', async () => {
      dbClient.queryItems.mockResolvedValue([]);

      await getUnclaimedLoot(testUserId);

      expect(dbClient.queryItems).toHaveBeenCalledWith(
        'TotemBound-RewardState',
        'pk',
        `USER#${testUserId}`,
        expect.objectContaining({
          skPrefix: 'LOOT#',
          filterExpression: '#status = :unclaimed',
        })
      );
    });

    it('should return empty array when no unclaimed loot', async () => {
      dbClient.queryItems.mockResolvedValue([]);

      const result = await getUnclaimedLoot(testUserId);
      expect(result).toEqual([]);
    });

    it('should enrich items with box definitions', async () => {
      dbClient.queryItems.mockResolvedValue([
        { id: 'loot_1', boxId: 'uncommon_totem_box', source: 'signup', status: 'unclaimed', grantedAt: '2024-01-01' },
        { id: 'loot_2', boxId: 'essence_box_small', source: 'reward', status: 'unclaimed', grantedAt: '2024-01-02' },
      ]);

      const result = await getUnclaimedLoot(testUserId);

      expect(result).toHaveLength(2);
      expect(result[0].box.type).toBe('totem_box');
      expect(result[1].box.type).toBe('essence_box');
    });
  });

  // =============================================================================
  // CLAIM LOOT ITEM TESTS
  // =============================================================================

  describe('claimLootItem', () => {
    describe('Totem box claim', () => {
      beforeEach(() => {
        dbClient.queryItems.mockResolvedValue([{
          pk: `USER#${testUserId}`,
          sk: `LOOT#${mockLootId}`,
          id: mockLootId,
          boxId: 'uncommon_totem_box',
          status: 'unclaimed',
        }]);
      });

      it('should claim a totem box with species choice', async () => {
        const result = await claimLootItem(testUserId, mockLootId, { speciesId: 2 });

        expect(result.lootItemId).toBe(mockLootId);
        expect(result.boxId).toBe('uncommon_totem_box');
        expect(result.type).toBe('totem_box');
        expect(result.result.type).toBe('totem');
        expect(result.result.totem).toBeDefined();
        // Innate trait is surfaced so the claim celebration can show the born-trait badge.
        expect(result.result.totem.traits).toEqual({ innate: 'trt_brave', learned: null, awakened: null });
      });

      it('should throw when species not selected for totem box', async () => {
        await expect(claimLootItem(testUserId, mockLootId, {}))
          .rejects.toThrow('Species selection required for totem boxes');
      });

      it('should throw when unavailable species selected', async () => {
        await expect(claimLootItem(testUserId, mockLootId, { speciesId: 9 })) // Raven - unavailable
          .rejects.toThrow('Selected species is not available');
      });

      it('should trigger achievement check after totem box claim', async () => {
        await claimLootItem(testUserId, mockLootId, { speciesId: 0 });

        expect(achievementsService.onTotemAcquired).toHaveBeenCalledWith(
          testUserId,
          expect.objectContaining({ rarityId: expect.any(Number) })
        );
      });

      it('should update totalTotems stat', async () => {
        await claimLootItem(testUserId, mockLootId, { speciesId: 0 });

        expect(dbClient.updateUser).toHaveBeenCalledWith(testUserId, {
          'stats.totalTotems': 3, // was 2, +1
        });
      });
    });

    describe('Essence box claim', () => {
      beforeEach(() => {
        dbClient.queryItems.mockResolvedValue([{
          pk: `USER#${testUserId}`,
          sk: `LOOT#${mockLootId}`,
          id: mockLootId,
          boxId: 'essence_box_small',
          status: 'unclaimed',
        }]);
      });

      it('should claim an essence box', async () => {
        const result = await claimLootItem(testUserId, mockLootId);

        expect(result.result.type).toBe('essence');
        expect(result.result.amount).toBeGreaterThanOrEqual(200);
        expect(result.result.amount).toBeLessThanOrEqual(500);
        expect(result.result.newBalance).toBe(2500);
      });

      it('should call addEssence with random amount in range', async () => {
        await claimLootItem(testUserId, mockLootId);

        const call = dbClient.addEssence.mock.calls[0];
        expect(call[0]).toBe(testUserId);
        expect(call[1]).toBeGreaterThanOrEqual(200);
        expect(call[1]).toBeLessThanOrEqual(500);
      });

      it('should throw if addEssence fails', async () => {
        dbClient.addEssence.mockResolvedValue({ success: false, error: 'DB error' });

        await expect(claimLootItem(testUserId, mockLootId))
          .rejects.toThrow('Failed to add essence: DB error');
      });
    });

    describe('Error handling', () => {
      it('should throw if loot item not found', async () => {
        dbClient.queryItems.mockResolvedValue([]);

        await expect(claimLootItem(testUserId, 'loot_nonexistent'))
          .rejects.toThrow('Loot item not found');
      });

      it('should throw if loot item already claimed', async () => {
        dbClient.queryItems.mockResolvedValue([{
          id: mockLootId,
          boxId: 'uncommon_totem_box',
          status: 'claimed',
        }]);

        await expect(claimLootItem(testUserId, mockLootId, { speciesId: 0 }))
          .rejects.toThrow('Loot item already claimed');
      });

      it('should prevent double-claim via ConditionalCheckFailedException', async () => {
        dbClient.queryItems.mockResolvedValue([{
          id: mockLootId,
          boxId: 'uncommon_totem_box',
          status: 'unclaimed',
        }]);

        const error = new Error('Condition not met');
        error.name = 'ConditionalCheckFailedException';
        dbClient.docClient.send.mockRejectedValue(error);

        await expect(claimLootItem(testUserId, mockLootId, { speciesId: 0 }))
          .rejects.toThrow('Loot item already claimed');
      });

      it('should revert claim status if reward creation fails', async () => {
        dbClient.queryItems.mockResolvedValue([{
          pk: `USER#${testUserId}`,
          sk: `LOOT#${mockLootId}`,
          id: mockLootId,
          boxId: 'essence_box_small',
          status: 'unclaimed',
        }]);

        // Let the atomic claim succeed but addEssence fail
        dbClient.addEssence.mockResolvedValue({ success: false, error: 'Transient error' });

        await expect(claimLootItem(testUserId, mockLootId))
          .rejects.toThrow();

        // Should have called updateItem to revert status to unclaimed
        expect(dbClient.updateItem).toHaveBeenCalledWith(
          'TotemBound-RewardState',
          { pk: `USER#${testUserId}`, sk: `LOOT#${mockLootId}` },
          { status: 'unclaimed' }
        );
      });
    });

    describe('Finalization', () => {
      it('should mark item as claimed with result data', async () => {
        dbClient.queryItems.mockResolvedValue([{
          pk: `USER#${testUserId}`,
          sk: `LOOT#${mockLootId}`,
          id: mockLootId,
          boxId: 'essence_box_small',
          status: 'unclaimed',
        }]);

        await claimLootItem(testUserId, mockLootId);

        // The second updateItem call should finalize with claimed status
        const finalizeCalls = dbClient.updateItem.mock.calls.filter(
          call => call[2]?.status === 'claimed'
        );
        expect(finalizeCalls).toHaveLength(1);
      });
    });
  });
});
