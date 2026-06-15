/**
 * Achievements — Progression group
 *
 * Time-based and streak-based achievements (lazy evaluation):
 *   - ach_login-progression  (5 tiers: 7/30/90/180/365 day streak)
 *   - ach_persistence-reward (3 tiers: 30/90/365 days since signup, lazy on login)
 *   - ach_tenure-master      (3 tiers: max seat tenure 7/14/30 days, lazy on sanctum claim)
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
  onLoginStreak,
  onPersistenceCheck,
  onTenureCheck,
} = require('../src/services/achievements-service');

const userId = 'usr_b3test';

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

describe('Progression: achievement constants', () => {
  it('defines persistence-reward ID + 3-tier milestones (30/90/365)', () => {
    expect(ACHIEVEMENT_IDS.PERSISTENCE_REWARD).toBe('ach_persistence-reward');
    expect(ACHIEVEMENT_MILESTONES['ach_persistence-reward']).toEqual([30, 90, 365]);
  });

  it('keeps existing login + tenure milestones (verify untouched)', () => {
    expect(ACHIEVEMENT_MILESTONES['ach_login-progression']).toEqual([7, 30, 90, 180, 365]);
    expect(ACHIEVEMENT_MILESTONES['ach_tenure-master']).toEqual([7, 14, 30]);
  });
});

describe('login-progression', () => {
  it('does NOT unlock at streak 6 (below first milestone)', async () => {
    const r = await onLoginStreak(userId, 6);
    expect(r.find(x => x.achievementId === 'ach_login-progression' && x.unlocked)).toBeUndefined();
  });

  it('unlocks Week Warrior at streak 7', async () => {
    const r = await onLoginStreak(userId, 7);
    const u = r.find(x => x.achievementId === 'ach_login-progression' && x.unlocked);
    expect(u).toBeDefined();
    expect(u.milestone).toBe(0);
  });

  it('unlocks 30-day Monthly Master at streak 30', async () => {
    const r = await onLoginStreak(userId, 30);
    const u = r.find(x => x.achievementId === 'ach_login-progression' && x.unlocked);
    expect(u.milestone).toBe(1);
  });

  it('unlocks all 5 milestones at streak 365', async () => {
    const r = await onLoginStreak(userId, 365);
    const u = r.find(x => x.achievementId === 'ach_login-progression' && x.unlocked);
    expect(u.newMilestones).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('persistence-reward', () => {
  it('returns empty when createdAt missing', async () => {
    const r = await onPersistenceCheck(userId, null);
    expect(r).toEqual([]);
  });

  it('returns empty for invalid date string', async () => {
    const r = await onPersistenceCheck(userId, 'not-a-date');
    expect(r).toEqual([]);
  });

  it('does NOT unlock for accounts younger than 30 days', async () => {
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const r = await onPersistenceCheck(userId, recent);
    expect(r.find(x => x.achievementId === 'ach_persistence-reward' && x.unlocked)).toBeUndefined();
  });

  it('unlocks First Moon at exactly 30 days', async () => {
    const days30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000 - 1000).toISOString();
    const r = await onPersistenceCheck(userId, days30);
    const u = r.find(x => x.achievementId === 'ach_persistence-reward' && x.unlocked);
    expect(u).toBeDefined();
    expect(u.milestone).toBe(0);
  });

  it('unlocks Cycle Master at 90 days', async () => {
    const days90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000 - 1000).toISOString();
    const r = await onPersistenceCheck(userId, days90);
    const u = r.find(x => x.achievementId === 'ach_persistence-reward' && x.unlocked);
    expect(u.milestone).toBe(1);
  });

  it('unlocks Eternal Spirit at 365 days', async () => {
    const days365 = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000 - 1000).toISOString();
    const r = await onPersistenceCheck(userId, days365);
    const u = r.find(x => x.achievementId === 'ach_persistence-reward' && x.unlocked);
    expect(u.milestone).toBe(2);
  });

  it('idempotent — re-running on same day does not double-award', async () => {
    // Simulate already-unlocked state for milestone 0
    dbClient.getItem.mockImplementation(async (table, key) => {
      if (key.sk === 'ACH#ach_persistence-reward') {
        return {
          currentValue: 35,
          milestoneIndex: 0,
          milestones: [{ index: 0, unlockedAt: 'past' }],
          isComplete: false,
        };
      }
      return null;
    });
    const days40 = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const r = await onPersistenceCheck(userId, days40);
    // No new milestone (M0 already unlocked, days < 90 for M1)
    expect(r.find(x => x.achievementId === 'ach_persistence-reward' && x.unlocked)).toBeUndefined();
  });
});

describe('tenure-master', () => {
  it('returns empty when no seats', async () => {
    expect(await onTenureCheck(userId, [])).toEqual([]);
    expect(await onTenureCheck(userId, null)).toEqual([]);
  });

  it('returns empty when seats have no seatedAt', async () => {
    const r = await onTenureCheck(userId, [{}, { seatedAt: null }]);
    expect(r).toEqual([]);
  });

  it('does NOT unlock for under 7 days seated', async () => {
    const seats = [{ seatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() }];
    const r = await onTenureCheck(userId, seats);
    expect(r.find(x => x.achievementId === 'ach_tenure-master' && x.unlocked)).toBeUndefined();
  });

  it('unlocks Week Watch at 7 days', async () => {
    const seats = [{ seatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }];
    const r = await onTenureCheck(userId, seats);
    const u = r.find(x => x.achievementId === 'ach_tenure-master' && x.unlocked);
    expect(u.milestone).toBe(0);
  });

  it('uses MAX tenure across multiple seats', async () => {
    // Seat 1 = 5 days, Seat 2 = 15 days (passes M0=7 and M1=14)
    const seats = [
      { seatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
      { seatedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    const r = await onTenureCheck(userId, seats);
    const u = r.find(x => x.achievementId === 'ach_tenure-master' && x.unlocked);
    expect(u.newMilestones).toEqual([0, 1]); // both 7 and 14 unlock
  });

  it('unlocks all 3 milestones at 30+ days', async () => {
    const seats = [{ seatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() }];
    const r = await onTenureCheck(userId, seats);
    const u = r.find(x => x.achievementId === 'ach_tenure-master' && x.unlocked);
    expect(u.newMilestones).toEqual([0, 1, 2]);
  });
});
