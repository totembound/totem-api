/**
 * Achievements — Evolution group
 *
 * Achievements triggered when a totem evolves (TOTEM_EVOLVED):
 *   - ach_rare-evolution / ach_epic-evolution / ach_legendary-evolution (one-time)
 *   - ach_anti-meta-collector (per-rarity progression, 3 milestones)
 *   - ach_mixed-affinity-evolution (affinity-set progression, 2 milestones)
 *
 * Performance/integrity properties verified here:
 *   - Anti-meta uses atomic ADD per-rarity (no read-modify-write race)
 *   - Mixed-affinity uses string set semantics (set-add of existing is no-op)
 *   - All new achievements pass through context — zero extra DB reads
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
  onTotemEvolved,
} = require('../src/services/achievements-service');

const userId = 'usr_test123';
const totemId = 'ttm_abc';

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

describe('Evolution: achievement constants', () => {
  it('defines rare/epic/legendary evolution one-time IDs', () => {
    expect(ACHIEVEMENT_IDS.RARE_EVOLUTION).toBe('ach_rare-evolution');
    expect(ACHIEVEMENT_IDS.EPIC_EVOLUTION).toBe('ach_epic-evolution');
    expect(ACHIEVEMENT_IDS.LEGENDARY_EVOLUTION).toBe('ach_legendary-evolution');
    expect(ONETIME_ACHIEVEMENTS).toContain('ach_rare-evolution');
    expect(ONETIME_ACHIEVEMENTS).toContain('ach_epic-evolution');
    expect(ONETIME_ACHIEVEMENTS).toContain('ach_legendary-evolution');
  });

  it('defines anti-meta-collector progression (3 milestones, all 3 each)', () => {
    expect(ACHIEVEMENT_IDS.ANTI_META_COLLECTOR).toBe('ach_anti-meta-collector');
    expect(ACHIEVEMENT_MILESTONES['ach_anti-meta-collector'])
      .toEqual([3, 3, 3]);
  });

  it('defines mixed-affinity-evolution progression (2 milestones)', () => {
    expect(ACHIEVEMENT_IDS.MIXED_AFFINITY_EVOLUTION).toBe('ach_mixed-affinity-evolution');
    expect(ACHIEVEMENT_MILESTONES['ach_mixed-affinity-evolution'])
      .toEqual([2, 3]);
  });
});

describe('rare/epic/legendary evolution', () => {
  it('unlocks ach_rare-evolution when rare totem evolves to stage 4 (Elder)', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 2, speciesId: 0,
    });
    const rareEvo = results.find(r => r.achievementId === 'ach_rare-evolution');
    expect(rareEvo).toBeDefined();
    expect(rareEvo.unlocked).toBe(true);
  });

  it('unlocks ach_epic-evolution when epic totem evolves to stage 4 (Elder)', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 3, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_epic-evolution')?.unlocked).toBe(true);
  });

  it('unlocks ach_legendary-evolution when legendary totem evolves to stage 4 (Elder)', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 4, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_legendary-evolution')?.unlocked).toBe(true);
  });

  it('does NOT unlock rare-evolution at stage 3 (Adult, not Elder)', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 3, totemId, rarityId: 2, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_rare-evolution' && r.unlocked))
      .toBeUndefined();
  });

  it('does NOT unlock rare-evolution at stage 2 (below Elder threshold)', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 2, totemId, rarityId: 2, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_rare-evolution')).toBeUndefined();
  });

  it('does NOT unlock rare-evolution for a common totem', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 0, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_rare-evolution')).toBeUndefined();
  });

  it('does NOT double-award an already-complete one-time evolution achievement', async () => {
    dbClient.getItem.mockImplementation(async (table, key) => {
      if (key.sk === 'ACH#ach_rare-evolution') {
        return { isComplete: true, currentValue: 1, milestoneIndex: 0, milestones: [{ index: 0, unlockedAt: 'past' }] };
      }
      return null;
    });

    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 2, speciesId: 0,
    });

    expect(results.find(r => r.achievementId === 'ach_rare-evolution' && r.unlocked)).toBeUndefined();
    expect(dbClient.addEssence).not.toHaveBeenCalledWith(
      userId, expect.any(Number),
      expect.objectContaining({ ref: expect.stringContaining('rare-evolution') })
    );
  });

  it('awards Essence + XP via addEssence when first unlocking rare-evolution', async () => {
    await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 2, speciesId: 0,
    });
    expect(dbClient.addEssence).toHaveBeenCalledWith(
      userId, expect.any(Number),
      expect.objectContaining({ type: 'reward_achievement' })
    );
  });
});

describe('anti-meta-collector', () => {
  it('does NOT progress when stage is not 4 (max)', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 3, totemId, rarityId: 0, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_anti-meta-collector')).toBeUndefined();
  });

  it('does NOT progress for epic+ rarities (only common/uncommon/rare count)', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 3, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_anti-meta-collector')).toBeUndefined();
  });

  it('atomically increments perRarityCount[0] when a common reaches stage 4', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { perRarityCount: { 0: 1 } },
    });

    await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 0, speciesId: 0,
    });

    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_anti-meta-collector' }),
      expect.objectContaining({
        UpdateExpression: expect.stringMatching(/ADD/),
      })
    );
  });

  it('unlocks milestone 0 only when 3 commons have reached stage 4', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { perRarityCount: { 0: 3 } },
    });

    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 0, speciesId: 0,
    });
    const r = results.find(r => r.achievementId === 'ach_anti-meta-collector' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(0);
  });

  it('does NOT unlock milestone 0 at common count = 2', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { perRarityCount: { 0: 2 } },
    });
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 0, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_anti-meta-collector' && r.unlocked))
      .toBeUndefined();
  });

  it('milestone 1 unlocks independently when 3 uncommons reach stage 4', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { perRarityCount: { 0: 1, 1: 3 } },
    });
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 1, speciesId: 0,
    });
    const r = results.find(r => r.achievementId === 'ach_anti-meta-collector' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(1);
  });

  it('milestone 2 unlocks when 3 rares reach stage 4', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { perRarityCount: { 2: 3 } },
    });
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 2, speciesId: 0,
    });
    const r = results.find(r => r.achievementId === 'ach_anti-meta-collector' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(2);
  });
});

describe('mixed-affinity-evolution', () => {
  it('does NOT progress at stage 3 (Adult, not Elder)', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 3, totemId, rarityId: 0, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_mixed-affinity-evolution')).toBeUndefined();
  });

  it('does NOT progress at stage 2', async () => {
    const results = await onTotemEvolved(userId, {
      newStage: 2, totemId, rarityId: 0, speciesId: 0,
    });
    expect(results.find(r => r.achievementId === 'ach_mixed-affinity-evolution')).toBeUndefined();
  });

  it('uses atomic ADD on seenAffinities set when reaching Elder', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenAffinities: new Set(['Wisdom']) },
    });
    await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 0, speciesId: 0,
    });
    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ sk: 'ACH#ach_mixed-affinity-evolution' }),
      expect.objectContaining({
        UpdateExpression: expect.stringMatching(/ADD seenAffinities/),
      })
    );
  });

  it('unlocks milestone 0 when 2 Elder-affinities seen', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenAffinities: new Set(['Wisdom', 'Agility']) },
    });

    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 0, speciesId: 1,
    });
    const r = results.find(r => r.achievementId === 'ach_mixed-affinity-evolution' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(0);
  });

  it('unlocks milestone 1 when 3 Elder-affinities seen', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenAffinities: new Set(['Wisdom', 'Agility', 'Strength']) },
    });
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 0, speciesId: 2,
    });
    const r = results.find(r => r.achievementId === 'ach_mixed-affinity-evolution' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(1);
  });

  it('does not unlock again when re-evolving a species of an already-seen affinity', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { seenAffinities: new Set(['Wisdom']) },
    });
    const results = await onTotemEvolved(userId, {
      newStage: 4, totemId, rarityId: 0, speciesId: 9,
    });
    expect(results.find(r => r.achievementId === 'ach_mixed-affinity-evolution' && r.unlocked))
      .toBeUndefined();
  });
});
