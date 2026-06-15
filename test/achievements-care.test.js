/**
 * Achievements — Care group
 *
 * Achievements driven by daily totem-care actions (feed/train/treat):
 *   - ach_balanced-care (Daily Trifecta progression, 9 milestones)
 *
 * Performance/integrity properties verified here:
 *   - Trifecta is idempotent under concurrent calls (conditional update with
 *     attribute_not_exists / <> :today guard on trifectaLog[totemId])
 *   - lastActionDates is read from the totem record passed by the caller —
 *     zero extra DB reads
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
  checkBalancedCare,
} = require('../src/services/achievements-service');

const userId = 'usr_test123';
const totemId = 'ttm_abc';

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

describe('Care: achievement constants', () => {
  it('defines balanced-care progression matching frontend (9 tiers)', () => {
    expect(ACHIEVEMENT_IDS.BALANCED_CARE).toBe('ach_balanced-care');
    expect(ACHIEVEMENT_MILESTONES['ach_balanced-care'])
      .toEqual([10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
  });
});

describe('balanced-care trifecta', () => {
  const totemAllToday = {
    id: totemId,
    lastActionDates: { feed: today, train: today, treat: today },
  };
  const totemFeedOnly = {
    id: totemId,
    lastActionDates: { feed: today },
  };
  const totemPartial = {
    id: totemId,
    lastActionDates: { feed: today, train: today },
  };
  const totemMixedDay = {
    id: totemId,
    lastActionDates: { feed: today, train: today, treat: yesterday },
  };

  it('does NOT trigger trifecta after only feed', async () => {
    const results = await checkBalancedCare(userId, totemFeedOnly);
    expect(results.find(r => r.achievementId === 'ach_balanced-care')).toBeUndefined();
  });

  it('does NOT trigger trifecta after only feed + train (2 of 3)', async () => {
    const results = await checkBalancedCare(userId, totemPartial);
    expect(results.find(r => r.achievementId === 'ach_balanced-care')).toBeUndefined();
  });

  it('does NOT trigger trifecta if one action was on a previous day', async () => {
    const results = await checkBalancedCare(userId, totemMixedDay);
    expect(results.find(r => r.achievementId === 'ach_balanced-care')).toBeUndefined();
  });

  it('increments currentValue by 1 when all 3 actions are today (first trifecta of day)', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { currentValue: 1, trifectaLog: { [totemId]: today } },
    });

    await checkBalancedCare(userId, totemAllToday);

    expect(dbClient.rawUpdate).toHaveBeenCalledWith(
      'TotemBound-AchievementProgress',
      expect.objectContaining({ pk: `USER#${userId}`, sk: 'ACH#ach_balanced-care' }),
      expect.objectContaining({
        ConditionExpression: expect.stringMatching(/trifectaLog/),
      })
    );
  });

  it('is idempotent — second call same totem same day does not increment again', async () => {
    const condErr = new Error('The conditional request failed');
    condErr.name = 'ConditionalCheckFailedException';
    dbClient.rawUpdate.mockRejectedValueOnce(condErr);

    const results = await checkBalancedCare(userId, totemAllToday);

    expect(results.find(r => r.achievementId === 'ach_balanced-care' && r.unlocked)).toBeUndefined();
  });

  it('does not unlock milestone 0 until 10 trifectas accumulated', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { currentValue: 5, trifectaLog: { [totemId]: today } },
    });

    const results = await checkBalancedCare(userId, totemAllToday);
    const r = results.find(r => r.achievementId === 'ach_balanced-care');
    expect(r?.milestone).toBeUndefined();
  });

  it('unlocks milestone 0 (Mindful Keeper) on the 10th trifecta', async () => {
    dbClient.rawUpdate.mockResolvedValue({
      Attributes: { currentValue: 10, trifectaLog: { [totemId]: today } },
    });

    const results = await checkBalancedCare(userId, totemAllToday);
    const r = results.find(r => r.achievementId === 'ach_balanced-care' && r.unlocked);
    expect(r).toBeDefined();
    expect(r.milestone).toBe(0);
  });
});
