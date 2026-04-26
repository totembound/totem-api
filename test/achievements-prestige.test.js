/**
 * Achievements — Prestige group
 *
 * Achievement triggered when a totem's XP crosses a prestige threshold:
 *   - ach_prestige-progression (7 milestones at 1/3/5/10/25/50/100 total prestige)
 *
 * Prestige is XP-derived (no rebirth/reset action). Once a totem reaches
 * Wise Elder (data stage 4 == 7500 XP), every additional 2500 XP grants
 * +1 prestige level. Frontend already displays this from XP. The backend
 * detects threshold crossings at every XP-add site (train, expedition,
 * sanctum mission) via the totem-xp.addTotemXp chokepoint.
 *
 * Performance/integrity properties verified here:
 *   - Atomic SET prestigeByTotem.<tid> + ADD currentValue in one DDB call
 *   - Conditional update — replays / lower values are no-ops
 *   - Multi-totem sums correctly across the prestigeByTotem map
 *   - Multi-level jumps (e.g. P0 -> P3 from a sanctum reward) credit delta
 *     all at once and unlock multiple milestones in a single call
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
  onTotemPrestiged,
} = require('../src/services/achievements-service');
const { calculatePrestigeLevel } = require('../src/functions/game-actions/helpers');

const userId = 'usr_prestige';
const totemId = 'ttm_p1';

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
  dbClient.rawUpdate.mockResolvedValue({ Attributes: { currentValue: 0 } });
});

describe('Prestige: achievement constants', () => {
  it('defines prestige-progression ID + 7 milestones (1/3/5/10/25/50/100)', () => {
    expect(ACHIEVEMENT_IDS.PRESTIGE_PROGRESSION).toBe('ach_prestige-progression');
    expect(ACHIEVEMENT_MILESTONES['ach_prestige-progression'])
      .toEqual([1, 3, 5, 10, 25, 50, 100]);
  });
});

describe('calculatePrestigeLevel formula', () => {
  it('returns 0 for pre-Elder XP', () => {
    expect(calculatePrestigeLevel(0)).toBe(0);
    expect(calculatePrestigeLevel(7400)).toBe(0);
    expect(calculatePrestigeLevel(7499)).toBe(0);
  });

  it('returns 0 at exactly Elder threshold (7500 XP = P0)', () => {
    expect(calculatePrestigeLevel(7500)).toBe(0);
  });

  it('returns 1 at first prestige threshold (10000 XP)', () => {
    expect(calculatePrestigeLevel(10000)).toBe(1);
    expect(calculatePrestigeLevel(9999)).toBe(0);
  });

  it('returns 2 at 12500 XP, 6 at 22500 XP', () => {
    expect(calculatePrestigeLevel(12500)).toBe(2);
    expect(calculatePrestigeLevel(22500)).toBe(6);
  });

  it('handles undefined / null / negative gracefully', () => {
    expect(calculatePrestigeLevel(undefined)).toBe(0);
    expect(calculatePrestigeLevel(null)).toBe(0);
    expect(calculatePrestigeLevel(-100)).toBe(0);
  });
});

describe('onTotemPrestiged', () => {
  it('returns [] when totemId is missing', async () => {
    const r = await onTotemPrestiged(userId, { totemId: null, oldPrestige: 0, newPrestige: 1 });
    expect(r).toEqual([]);
    expect(dbClient.rawUpdate).not.toHaveBeenCalled();
  });

  it('returns [] when newPrestige <= oldPrestige (no-op replay)', async () => {
    const r = await onTotemPrestiged(userId, { totemId, oldPrestige: 2, newPrestige: 2 });
    expect(r).toEqual([]);
    expect(dbClient.rawUpdate).not.toHaveBeenCalled();
  });

  it('writes prestigeByTotem.<tid> = newP and ADDs delta to currentValue', async () => {
    dbClient.rawUpdate.mockResolvedValueOnce({
      Attributes: { currentValue: 1, prestigeByTotem: { [totemId]: 1 } },
    });

    await onTotemPrestiged(userId, { totemId, oldPrestige: 0, newPrestige: 1 });

    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ pk: `USER#${userId}`, sk: 'ACH#ach_prestige-progression' }),
      expect.objectContaining({
        UpdateExpression: expect.stringMatching(/SET prestigeByTotem.*ADD currentValue/),
        ConditionExpression: expect.stringMatching(/prestigeByTotem.*<\s*:newP/),
        ExpressionAttributeNames: { '#tid': totemId },
        ExpressionAttributeValues: expect.objectContaining({ ':newP': 1, ':delta': 1 }),
      })
    );
  });

  it('credits multi-level delta when XP jumps multiple thresholds at once', async () => {
    // Sanctum mission grants huge XP — totem goes P0 -> P3 in one shot.
    dbClient.rawUpdate.mockResolvedValueOnce({
      Attributes: { currentValue: 3, prestigeByTotem: { [totemId]: 3 } },
    });

    const r = await onTotemPrestiged(userId, { totemId, oldPrestige: 0, newPrestige: 3 });

    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({ ':newP': 3, ':delta': 3 }),
      })
    );
    // currentValue=3 unlocks M0 (req=1) and M1 (req=3)
    const unlocked = r.find(x => x.achievementId === 'ach_prestige-progression' && x.unlocked);
    expect(unlocked).toBeDefined();
  });

  it('unlocks first milestone (M0) when total prestige reaches 1', async () => {
    dbClient.rawUpdate.mockResolvedValueOnce({
      Attributes: { currentValue: 1, prestigeByTotem: { [totemId]: 1 } },
    });

    const r = await onTotemPrestiged(userId, { totemId, oldPrestige: 0, newPrestige: 1 });
    const u = r.find(x => x.achievementId === 'ach_prestige-progression' && x.unlocked);
    expect(u).toBeDefined();
    expect(u.milestone).toBe(0);
  });

  it('does NOT unlock M1 at total prestige 2 (M1 requires 3)', async () => {
    // Two totems each at P1 -> currentValue=2, M0 unlocked from prior call,
    // this call should NOT unlock M1.
    dbClient.rawUpdate.mockResolvedValueOnce({
      Attributes: { currentValue: 2, prestigeByTotem: { [totemId]: 1, ttm_p2: 1 } },
    });
    // simulate getAchievementProgress returning M0 already unlocked
    dbClient.getItem.mockImplementation(async (table, key) => {
      if (key.sk === 'ACH#ach_prestige-progression') {
        return {
          currentValue: 1,
          milestoneIndex: 0,
          milestones: [{ index: 0, unlockedAt: 'past' }],
          isComplete: false,
          prestigeByTotem: { [totemId]: 1 },
        };
      }
      return null;
    });

    const r = await onTotemPrestiged(userId, { totemId: 'ttm_p2', oldPrestige: 0, newPrestige: 1 });
    // No new milestone (M0 already unlocked, M1 needs 3)
    expect(r.find(x => x.unlocked && x.milestone === 1)).toBeUndefined();
  });

  it('is idempotent — ConditionalCheckFailedException returns []', async () => {
    const condErr = new Error('The conditional request failed');
    condErr.name = 'ConditionalCheckFailedException';
    dbClient.rawUpdate.mockRejectedValueOnce(condErr);

    const r = await onTotemPrestiged(userId, { totemId, oldPrestige: 0, newPrestige: 1 });
    expect(r).toEqual([]);
  });

  it('rethrows non-conditional errors', async () => {
    const fatal = new Error('DDB connection lost');
    fatal.name = 'NetworkError';
    dbClient.rawUpdate.mockRejectedValueOnce(fatal);

    await expect(
      onTotemPrestiged(userId, { totemId, oldPrestige: 0, newPrestige: 1 })
    ).rejects.toThrow('DDB connection lost');
  });

  it('initializes prestigeByTotem on the achievement record at first call', async () => {
    dbClient.rawUpdate.mockResolvedValueOnce({
      Attributes: { currentValue: 1, prestigeByTotem: { [totemId]: 1 } },
    });

    await onTotemPrestiged(userId, { totemId, oldPrestige: 0, newPrestige: 1 });

    // ensureAchievementRecord puts the seed record with prestigeByTotem: {}
    expect(dbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({
        sk: 'ACH#ach_prestige-progression',
        prestigeByTotem: {},
      })
    );
  });
});
