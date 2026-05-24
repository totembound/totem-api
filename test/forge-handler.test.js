/**
 * Forge Handler Tests
 *
 * Tests for totem fusion (functions/totems/forge.js)
 */

// Mock db-client
jest.mock('../src/common/db-client', () => ({
  getTotem: jest.fn(),
  getUserTotems: jest.fn().mockResolvedValue([]),
  getUser: jest.fn().mockResolvedValue({ currencies: { essence: 1500 } }),
  putItem: jest.fn(),
  updateItem: jest.fn(),
  updateUser: jest.fn(),
  transactWrite: jest.fn(),
  logTransaction: jest.fn().mockResolvedValue({ pk: 'TXN#test', sk: 'USER#test' }),
  TABLES: {
    TOTEMS: 'TotemBound-Totems',
    TRANSACTIONS: 'TotemBound-Transactions',
    USERS: 'TotemBound-Users',
  },
}));

// Mock totem-creation
jest.mock('../src/services/totem-creation', () => {
  const actual = jest.requireActual('../src/services/totem-creation');
  return {
    ...actual,
    createTotem: jest.fn((opts) => ({
      pk: `USER#${opts.userId}`,
      sk: 'TOTEM#ttm_forged',
      id: 'ttm_forged',
      userId: opts.userId,
      speciesId: opts.speciesId ?? 2,
      colorId: 5,
      rarityId: opts.forcedRarityId ?? 1,
      stage: 0,
      experience: 0,
      nickname: null,
      stats: { strength: 10, agility: 8, wisdom: 12, happiness: 50, hunger: 100 },
      cooldowns: { feed: null, train: null, treat: null },
      traits: { innate: 'trt_brave', learned: null, awakened: null },
      createdAt: '2024-01-01T00:00:00.000Z',
    })),
    selectRandomSpecies: jest.fn(() => ({
      speciesId: 5,
      speciesName: 'Wolf',
      baseStats: { strength: 8, agility: 6, wisdom: 4 },
    })),
  };
});

// Mock expeditions-service
jest.mock('../src/services/expeditions-service', () => ({
  getActiveExpeditions: jest.fn().mockResolvedValue([]),
}));

// Mock achievements-service
jest.mock('../src/services/achievements-service', () => ({
  onTotemFused: jest.fn().mockResolvedValue([]),
  onTotemAcquired: jest.fn().mockResolvedValue([]),
  getAchievementProgress: jest.fn().mockResolvedValue(null),
}));

const dbClient = require('../src/common/db-client');
const totemCreation = require('../src/services/totem-creation');
const expeditionsService = require('../src/services/expeditions-service');
const achievementsService = require('../src/services/achievements-service');
const { forgeTotem } = require('../src/functions/totems/forge');

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123' };

const makeTotem = (id, rarityId = 0, speciesId = 2) => ({
  pk: `USER#${testUser.userId}`,
  sk: `TOTEM#${id}`,
  id,
  userId: testUser.userId,
  speciesId,
  colorId: 1,
  rarityId,
  stage: 2,
  experience: 500,
  nickname: null,
  stats: { strength: 7, agility: 5, wisdom: 9, happiness: 60, hunger: 80 },
  cooldowns: { feed: null, train: null, treat: null },
  createdAt: '2024-01-01T00:00:00.000Z',
});

beforeEach(() => {
  jest.clearAllMocks();

  // Default: all 3 totems exist with same rarity
  dbClient.getTotem.mockImplementation((userId, totemId) => {
    if (['ttm_a', 'ttm_b', 'ttm_c'].includes(totemId)) {
      return Promise.resolve(makeTotem(totemId, 0, 2));
    }
    return Promise.resolve(null);
  });

  dbClient.getUser.mockResolvedValue({ currencies: { essence: 1500 } });
  dbClient.getUserTotems.mockResolvedValue([makeTotem('ttm_forged')]);
  dbClient.logTransaction.mockResolvedValue({ pk: 'TXN#test', sk: 'USER#usr_test123' });
  expeditionsService.getActiveExpeditions.mockResolvedValue([]);
  achievementsService.onTotemFused.mockResolvedValue([]);
  achievementsService.getAchievementProgress.mockResolvedValue(null);
});

// =============================================================================
// VALIDATION TESTS
// =============================================================================

describe('forgeTotem - validation', () => {
  test('rejects missing totemIds', async () => {
    const result = await forgeTotem(testUser, {});
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects non-array totemIds', async () => {
    const result = await forgeTotem(testUser, { totemIds: 'ttm_a' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects fewer than 3 IDs', async () => {
    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects more than 3 IDs', async () => {
    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c', 'ttm_d'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects invalid ID format', async () => {
    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'invalid'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects numeric IDs', async () => {
    const result = await forgeTotem(testUser, { totemIds: [123, 456, 789] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects null IDs in array', async () => {
    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', null, 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects empty body', async () => {
    const result = await forgeTotem(testUser);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects duplicate IDs', async () => {
    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_a', 'ttm_b'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_IDS');
  });

  test('rejects if totem not found', async () => {
    dbClient.getTotem.mockImplementation((userId, id) => {
      if (id === 'ttm_c') return Promise.resolve(null);
      return Promise.resolve(makeTotem(id));
    });

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

// =============================================================================
// EXPEDITION CHECK TESTS
// =============================================================================

describe('forgeTotem - expedition checks', () => {
  test('rejects totem on active expedition (single totemId)', async () => {
    expeditionsService.getActiveExpeditions.mockResolvedValue([
      { totemId: 'ttm_b', status: 'in_progress' },
    ]);

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('ON_EXPEDITION');
  });

  test('rejects totem on active expedition (totemIds array)', async () => {
    expeditionsService.getActiveExpeditions.mockResolvedValue([
      { totemIds: ['ttm_x', 'ttm_c', 'ttm_y'], status: 'in_progress' },
    ]);

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('ON_EXPEDITION');
  });

  test('blocks forge when expedition service is unavailable', async () => {
    expeditionsService.getActiveExpeditions.mockRejectedValue(new Error('Service unavailable'));

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

// =============================================================================
// RARITY VALIDATION TESTS
// =============================================================================

describe('forgeTotem - rarity validation', () => {
  test('rejects mismatched rarities', async () => {
    dbClient.getTotem.mockImplementation((userId, id) => {
      if (id === 'ttm_c') return Promise.resolve(makeTotem(id, 1, 2)); // Uncommon
      return Promise.resolve(makeTotem(id, 0, 2)); // Common
    });

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('RARITY_MISMATCH');
  });

  test('rejects Legendary (4) totems', async () => {
    dbClient.getTotem.mockImplementation((userId, id) =>
      Promise.resolve(makeTotem(id, 4, 2))
    );

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('MAX_RARITY');
  });

  test('rejects negative rarityId totems', async () => {
    dbClient.getTotem.mockImplementation((userId, id) =>
      Promise.resolve(makeTotem(id, -1, 2))
    );

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('MAX_RARITY');
  });

  test('rejects Limited (5) totems', async () => {
    dbClient.getTotem.mockImplementation((userId, id) =>
      Promise.resolve(makeTotem(id, 5, 2))
    );

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('MAX_RARITY');
  });
});

// =============================================================================
// SUCCESSFUL FUSION TESTS
// =============================================================================

describe('forgeTotem - successful fusion', () => {
  test('pure fusion: 3 same species → same species at next rarity', async () => {
    // All 3 are Common (0), species 2
    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
    expect(result.data.action).toBe('forge');
    expect(result.data.fusionType).toBe('pure');
    expect(result.data.consumedTotemIds).toEqual(['ttm_a', 'ttm_b', 'ttm_c']);
    expect(result.data.newTotem.id).toBe('ttm_forged');
    // Response surfaces the forged totem's traits (innate auto-assigned by createTotem)
    // so the client can show the born-trait badge without an extra fetch.
    expect(result.data.newTotem.traits).toEqual({ innate: 'trt_brave', learned: null, awakened: null });

    // createTotem called with forced rarity = 1 (Uncommon) and speciesId = 2
    expect(totemCreation.createTotem).toHaveBeenCalledWith({
      userId: testUser.userId,
      speciesId: 2,
      forcedRarityId: 1,
    });

    // Transaction should include 1 Put + 3 Deletes
    expect(dbClient.transactWrite).toHaveBeenCalledTimes(1);
    const transactItems = dbClient.transactWrite.mock.calls[0][0];
    expect(transactItems).toHaveLength(4);
    expect(transactItems[0].Put).toBeDefined();
    expect(transactItems[1].Delete).toBeDefined();
    expect(transactItems[2].Delete).toBeDefined();
    expect(transactItems[3].Delete).toBeDefined();
  });

  test('wild fusion: mixed species → random species at next rarity', async () => {
    // Mix species: ttm_a=species2, ttm_b=species3, ttm_c=species4
    dbClient.getTotem.mockImplementation((userId, id) => {
      const speciesMap = { ttm_a: 2, ttm_b: 3, ttm_c: 4 };
      return Promise.resolve(makeTotem(id, 0, speciesMap[id]));
    });

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
    expect(result.data.fusionType).toBe('wild');

    // selectRandomSpecies should be called for wild fusion
    expect(totemCreation.selectRandomSpecies).toHaveBeenCalled();
  });

  test('Uncommon fusion produces Rare', async () => {
    dbClient.getTotem.mockImplementation((userId, id) =>
      Promise.resolve(makeTotem(id, 1, 2)) // Uncommon
    );

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
    expect(totemCreation.createTotem).toHaveBeenCalledWith(
      expect.objectContaining({ forcedRarityId: 2 })
    );
  });

  test('Rare fusion produces Epic', async () => {
    dbClient.getTotem.mockImplementation((userId, id) =>
      Promise.resolve(makeTotem(id, 2, 2)) // Rare
    );

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
    expect(totemCreation.createTotem).toHaveBeenCalledWith(
      expect.objectContaining({ forcedRarityId: 3 })
    );
  });

  test('Epic fusion produces Legendary', async () => {
    dbClient.getTotem.mockImplementation((userId, id) =>
      Promise.resolve(makeTotem(id, 3, 2)) // Epic
    );

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
    expect(totemCreation.createTotem).toHaveBeenCalledWith(
      expect.objectContaining({ forcedRarityId: 4 })
    );
  });

  test('returns newEssenceBalance in response', async () => {
    dbClient.getUser.mockResolvedValue({ currencies: { essence: 2500 } });

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
    expect(result.data.newEssenceBalance).toBe(2500);
  });

  test('logs enriched transaction after successful forge', async () => {
    await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    // Step 1: logTransaction called with core fields
    expect(dbClient.logTransaction).toHaveBeenCalledWith(
      testUser.userId,
      expect.objectContaining({
        type: 'totem_forge',
        ref: 'ttm_forged',
        refType: 'forge',
        quantity: 3,
      })
    );

    // Step 2: updateItem called with forge analytics fields
    expect(dbClient.updateItem).toHaveBeenCalledWith(
      'TotemBound-Transactions',
      { pk: 'TXN#test', sk: 'USER#usr_test123' },
      expect.objectContaining({
        fusionType: 'pure',
        inputRarityId: 0,
        outputRarityId: 1,
        consumedTotemIds: ['ttm_a', 'ttm_b', 'ttm_c'],
        inputSpeciesIds: [2, 2, 2],
        outputSpeciesId: 2,
        essenceValueBurned: 1500,
      })
    );
  });

  test('triggers achievement checks after forge', async () => {
    await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(achievementsService.onTotemFused).toHaveBeenCalledWith(
      testUser.userId,
      expect.objectContaining({
        isPureFusion: true,
        newRarityId: 1,
      })
    );
  });

  test('Common fusion produces Uncommon', async () => {
    // Default mocks use rarity 0 (Common)
    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
    expect(totemCreation.createTotem).toHaveBeenCalledWith(
      expect.objectContaining({ forcedRarityId: 1 })
    );
  });

  test('succeeds even if achievements service throws', async () => {
    achievementsService.onTotemFused.mockRejectedValue(new Error('Achievement error'));

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
    expect(result.data.achievements).toEqual([]);
  });

  test('succeeds even if logTransaction fails', async () => {
    dbClient.logTransaction.mockRejectedValue(new Error('Log error'));

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.success).toBe(true);
  });

  test('returns unlocked achievements', async () => {
    achievementsService.onTotemFused.mockResolvedValue([
      { unlocked: true, achievementId: 'ach_fusion-progression', milestone: 0, rewards: { essence: 100, xp: 150 } },
    ]);

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });

    expect(result.data.achievements).toHaveLength(1);
    expect(result.data.achievements[0].achievementId).toBe('ach_fusion-progression');
  });
});

// =============================================================================
// TRANSACTION FAILURE TESTS
// =============================================================================

describe('forgeTotem - transaction failures', () => {
  test('handles TransactionCanceledException gracefully', async () => {
    const err = new Error('Transaction cancelled');
    err.name = 'TransactionCanceledException';
    dbClient.transactWrite.mockRejectedValue(err);

    const result = await forgeTotem(testUser, { totemIds: ['ttm_a', 'ttm_b', 'ttm_c'] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TRANSACTION_FAILED');
  });
});
