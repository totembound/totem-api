/**
 * Achievements — Collection group
 *
 * Achievements driven by acquiring totems (TOTEM_ACQUIRED):
 *   - ach_affinity-specialist  (progression: per-affinity Map, milestones at 6/12/24)
 *   - ach_domain-specialist    (progression: per-domain Map, milestones at 6/12/24)
 *   - ach_species-mastery      (one-time: collect all 12 species)
 *   - ach_affinity-diversity   (one-time: rare+ from each affinity, set size 3)
 *   - ach_domain-diversity     (one-time: rare+ from each domain, set size 3)
 *
 * All hook into onTotemAcquired with rarityId + speciesId, look up affinity/domain
 * via static species config, and use atomic ADD semantics (no read-modify-write race).
 */

jest.mock('../src/common/db-client', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  updateItem: jest.fn(),
  rawUpdate: jest.fn(),
  queryItems: jest.fn(),
  getUser: jest.fn(),
  getTotem: jest.fn(),
  updateTotem: jest.fn(),
  addEssence: jest.fn(),
  logTransaction: jest.fn(),
  TABLES: {
    USERS: 'TotemBound-Users',
    TOTEMS: 'TotemBound-Totems',
    ACHIEVEMENT_PROGRESS: 'TotemBound-AchievementProgress',
    TRANSACTIONS: 'TotemBound-Transactions',
  },
}));

const dbClient = require('../src/common/db-client');
const {
  ACHIEVEMENT_IDS,
  ACHIEVEMENT_MILESTONES,
  ONETIME_ACHIEVEMENTS,
  onTotemAcquired,
} = require('../src/services/achievements-service');

const userId = 'usr_b2test';
const totemId = 'ttm_b2test';

beforeEach(() => {
  jest.clearAllMocks();
  dbClient.getItem.mockResolvedValue(null);
  dbClient.putItem.mockResolvedValue({});
  dbClient.updateItem.mockResolvedValue({});
  dbClient.queryItems.mockResolvedValue([]);
  dbClient.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
  dbClient.logTransaction.mockResolvedValue({});
  dbClient.getTotem.mockResolvedValue({ experience: 100 });
  dbClient.updateTotem.mockResolvedValue({});
  dbClient.rawUpdate.mockResolvedValue({ Attributes: {} });
});

// =============================================================================
// CONSTANTS
// =============================================================================

describe('Collection: achievement constants', () => {
  it('defines all 5 new IDs', () => {
    expect(ACHIEVEMENT_IDS.AFFINITY_SPECIALIST).toBe('ach_affinity-specialist');
    expect(ACHIEVEMENT_IDS.AFFINITY_DIVERSITY).toBe('ach_affinity-diversity');
    expect(ACHIEVEMENT_IDS.DOMAIN_SPECIALIST).toBe('ach_domain-specialist');
    expect(ACHIEVEMENT_IDS.DOMAIN_DIVERSITY).toBe('ach_domain-diversity');
    expect(ACHIEVEMENT_IDS.SPECIES_MASTERY).toBe('ach_species-mastery');
  });

  it('marks the 3 diversity / mastery achievements as one-time', () => {
    expect(ONETIME_ACHIEVEMENTS).toContain('ach_affinity-diversity');
    expect(ONETIME_ACHIEVEMENTS).toContain('ach_domain-diversity');
    expect(ONETIME_ACHIEVEMENTS).toContain('ach_species-mastery');
  });

  it('defines specialist progression milestones at 6/12/24 matching frontend config', () => {
    expect(ACHIEVEMENT_MILESTONES['ach_affinity-specialist']).toEqual([6, 12, 24]);
    expect(ACHIEVEMENT_MILESTONES['ach_domain-specialist']).toEqual([6, 12, 24]);
  });
});

// =============================================================================
// affinity-specialist (progression, per-affinity counter)
// =============================================================================

describe('affinity-specialist', () => {
  it('uses atomic ADD on affinityCounts.<affinity>', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { affinityCounts: { Wisdom: 1 } },
    });

    await onTotemAcquired(userId, { rarityId: 0, totalTotemCount: 1, totemId, speciesId: 0 }); // Goose=Wisdom

    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_affinity-specialist' }),
      expect.objectContaining({
        UpdateExpression: expect.stringMatching(/ADD affinityCounts/),
      })
    );
  });

  it('does NOT unlock milestone 0 below 6 of any single affinity', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { affinityCounts: { Wisdom: 5, Strength: 3 } },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 5, totemId, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_affinity-specialist' && r.unlocked))
      .toBeUndefined();
  });

  it('unlocks milestone 0 (Affinity Student) when ANY affinity hits 6', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { affinityCounts: { Wisdom: 6, Strength: 1 } },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 7, totemId, speciesId: 0,
    });
    const r = results.find(r => r.achievementId === 'ach_affinity-specialist' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(0);
  });

  it('unlocks milestone 1 at 12 of one affinity', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { affinityCounts: { Strength: 12 } },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 12, totemId, speciesId: 2, // Wolf=Strength
    });
    const r = results.find(r => r.achievementId === 'ach_affinity-specialist' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(1);
  });
});

// =============================================================================
// domain-specialist (progression, per-domain counter)
// =============================================================================

describe('domain-specialist', () => {
  it('uses atomic ADD on domainCounts.<domain>', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { domainCounts: { Water: 1 } },
    });
    await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 1, totemId, speciesId: 0, // Goose=Water
    });
    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_domain-specialist' }),
      expect.objectContaining({
        UpdateExpression: expect.stringMatching(/ADD domainCounts/),
      })
    );
  });

  it('unlocks milestone 0 at 6 of one domain', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { domainCounts: { Water: 6 } },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 6, totemId, speciesId: 1, // Otter=Water
    });
    const r = results.find(r => r.achievementId === 'ach_domain-specialist' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(0);
  });
});

// =============================================================================
// species-mastery (one-time, 12 species)
// =============================================================================

describe('species-mastery', () => {
  it('atomically adds species id to seenSpecies set', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenSpecies: new Set(['0']) },
    });
    await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 1, totemId, speciesId: 0,
    });
    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_species-mastery' }),
      expect.objectContaining({
        UpdateExpression: expect.stringMatching(/ADD seenSpecies/),
      })
    );
  });

  it('does NOT unlock until all 12 species seen', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenSpecies: new Set(['0', '1', '2', '3']) },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 4, totemId, speciesId: 3,
    });
    expect(results.find(r => r.achievementId === 'ach_species-mastery' && r.unlocked))
      .toBeUndefined();
  });

  it('unlocks when 12 unique species collected', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: {
        seenSpecies: new Set(['0','1','2','3','4','5','6','7','8','9','10','11']),
      },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 12, totemId, speciesId: 11,
    });
    const r = results.find(r => r.achievementId === 'ach_species-mastery' && r.unlocked);
    expect(r).toBeDefined();
  });

  it('idempotent — collecting a duplicate species does not re-fire', async () => {
    // The set ADD is a no-op; size remains 11, achievement stays locked.
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenSpecies: new Set(['0','1','2','3','4','5','6','7','8','9','10']) },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 13, totemId, speciesId: 0, // duplicate
    });
    expect(results.find(r => r.achievementId === 'ach_species-mastery' && r.unlocked))
      .toBeUndefined();
  });
});

// =============================================================================
// affinity-diversity (one-time, rare+ from each of 3 affinities)
// =============================================================================

describe('affinity-diversity', () => {
  it('does NOT progress for common totems (rarity < Rare)', async () => {
    await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 1, totemId, speciesId: 0,
    });
    expect(dbClient.rawUpdate).not.toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_affinity-diversity' }),
      expect.anything()
    );
  });

  it('does NOT progress for uncommon totems (rarity 1)', async () => {
    await onTotemAcquired(userId, {
      rarityId: 1, totalTotemCount: 1, totemId, speciesId: 0,
    });
    expect(dbClient.rawUpdate).not.toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_affinity-diversity' }),
      expect.anything()
    );
  });

  it('adds to seenAffinitiesRare set when rarity >= Rare', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenAffinitiesRare: new Set(['Wisdom']) },
    });
    await onTotemAcquired(userId, {
      rarityId: 2, totalTotemCount: 1, totemId, speciesId: 0,
    });
    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_affinity-diversity' }),
      expect.objectContaining({
        UpdateExpression: expect.stringMatching(/ADD seenAffinitiesRare/),
      })
    );
  });

  it('unlocks when rare+ from all 3 affinities collected', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenAffinitiesRare: new Set(['Wisdom', 'Agility', 'Strength']) },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 2, totalTotemCount: 3, totemId, speciesId: 2, // Wolf=Strength rare
    });
    const r = results.find(r => r.achievementId === 'ach_affinity-diversity' && r.unlocked);
    expect(r).toBeDefined();
  });

  it('does NOT unlock with only 2 rare affinities', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenAffinitiesRare: new Set(['Wisdom', 'Agility']) },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 2, totalTotemCount: 2, totemId, speciesId: 1,
    });
    expect(results.find(r => r.achievementId === 'ach_affinity-diversity' && r.unlocked))
      .toBeUndefined();
  });
});

// =============================================================================
// domain-diversity (one-time, rare+ from each of 3 domains)
// =============================================================================

describe('domain-diversity', () => {
  it('does NOT progress for common totems', async () => {
    await onTotemAcquired(userId, {
      rarityId: 0, totalTotemCount: 1, totemId, speciesId: 0,
    });
    expect(dbClient.rawUpdate).not.toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_domain-diversity' }),
      expect.anything()
    );
  });

  it('adds to seenDomainsRare set when rarity >= Rare', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenDomainsRare: new Set(['Water']) },
    });
    await onTotemAcquired(userId, {
      rarityId: 2, totalTotemCount: 1, totemId, speciesId: 0, // Goose=Water
    });
    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_domain-diversity' }),
      expect.objectContaining({
        UpdateExpression: expect.stringMatching(/ADD seenDomainsRare/),
      })
    );
  });

  it('unlocks when rare+ from all 3 domains (Water, Earth, Air)', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenDomainsRare: new Set(['Water', 'Earth', 'Air']) },
    });
    const results = await onTotemAcquired(userId, {
      rarityId: 2, totalTotemCount: 3, totemId, speciesId: 3, // Falcon=Air rare
    });
    const r = results.find(r => r.achievementId === 'ach_domain-diversity' && r.unlocked);
    expect(r).toBeDefined();
  });
});
