/**
 * Admin API Handler Tests
 *
 * Covers:
 * - GET  /v1/admin/users          (list, pagination, search)
 * - GET  /v1/admin/users/:id      (detail + totems + transactions)
 * - PUT  /v1/admin/users/:id/currencies (grant/deduct with ledger)
 * - PUT  /v1/admin/users/:id/status     (ban/unban + login enforcement)
 * - GET  /v1/admin/stats          (dashboard metrics)
 * - GET  /v1/admin/transactions   (filtered transaction log)
 */

// Mock db-client before any requires
jest.mock('../src/common/db-client', () => ({
  listUsers: jest.fn(),
  scanAllUsers: jest.fn(),
  getUser: jest.fn(),
  updateUser: jest.fn(),
  getUserTotems: jest.fn(),
  getTransactionHistory: jest.fn(),
  logTransaction: jest.fn().mockResolvedValue({}),
  addEssence: jest.fn(),
  deductEssence: jest.fn(),
  addGems: jest.fn(),
  deductGems: jest.fn(),
  countTotems: jest.fn(),
  listAllTransactions: jest.fn(),
  aggregateTransactions: jest.fn(),
  queryStatsTrends: jest.fn(),
  getLatestSnapshot: jest.fn(),
}));

const EMPTY_AGG = { count: 0, byType: {}, essenceVolume: 0, gemsVolume: 0, capped: false };

const db = require('../src/common/db-client');
const { list, getDetail, adjustCurrencies, setStatus } = require('../src/functions/admin/users');
const { get: getStats } = require('../src/functions/admin/stats');
const { list: listTransactions } = require('../src/functions/admin/transactions');

// Suppress console noise
jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'error').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();

// =============================================================================
// Helpers
// =============================================================================

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const adminUser = { userId: 'usr_admin', email: 'admin@example.com', role: 'admin' };

const testUserRecord = {
  id: 'usr_player1',
  email: 'player1@example.com',
  displayName: 'Player1',
  role: 'user',
  tier: 'free',
  currencies: { essence: 2000, gems: 50 },
  stats: { loginStreak: 3, lastLoginDate: '2026-04-01', totalTotems: 2, totalChallengesCompleted: 1 },
  settings: { notifications: true, darkMode: 'dark' },
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
};

const testUserRecord2 = {
  id: 'usr_player2',
  email: 'player2@example.com',
  displayName: 'Player2',
  role: 'user',
  tier: 'free',
  currencies: { essence: 500, gems: 0 },
  stats: { loginStreak: 1, lastLoginDate: '2026-03-20', totalTotems: 0, totalChallengesCompleted: 0 },
  settings: {},
  createdAt: '2026-03-15T00:00:00.000Z',
  updatedAt: '2026-03-20T00:00:00.000Z',
};

const testTotem = {
  id: 'ttm_abc',
  speciesId: 0,
  colorId: 2,
  rarityId: 1,
  nickname: 'Honkers',
  stage: 2,
  experience: 1800,
  stats: { strength: 8, agility: 6, wisdom: 10, happiness: 70, hunger: 90 },
  createdAt: '2026-03-02T00:00:00.000Z',
};

const testTransaction = {
  id: 'txn_abc',
  userId: 'usr_player1',
  type: 'action_feed',
  currency: 'essence',
  amount: -10,
  balanceBefore: 2010,
  balanceAfter: 2000,
  refType: null,
  refName: null,
  ts: '2026-04-01T12:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// GET /v1/admin/users
// =============================================================================
describe('GET /v1/admin/users (list)', () => {
  it('returns a page of users with cursor pagination metadata', async () => {
    db.listUsers.mockResolvedValue({
      items: [testUserRecord, testUserRecord2],
      nextCursor: null,
    });

    const req = { query: {} };
    const res = mockRes();

    await list(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.users).toHaveLength(2);
    expect(body.pagination).toEqual({ limit: 25, count: 2, nextCursor: null, hasMore: false });
  });

  it('threads cursor and limit into listUsers and surfaces nextCursor', async () => {
    db.listUsers.mockResolvedValue({
      items: [testUserRecord],
      nextCursor: 'eyJwayI6Iks5In0=',
    });

    const req = { query: { limit: '50', cursor: 'eyJwayI6Iks4In0=' } };
    const res = mockRes();

    await list(req, res);

    expect(db.listUsers).toHaveBeenCalledWith({
      limit: 50,
      cursor: 'eyJwayI6Iks4In0=',
      search: null,
    });
    const body = res.json.mock.calls[0][0];
    expect(body.pagination).toEqual({
      limit: 50,
      count: 1,
      nextCursor: 'eyJwayI6Iks5In0=',
      hasMore: true,
    });
  });

  it('passes search param to listUsers', async () => {
    db.listUsers.mockResolvedValue({ items: [], nextCursor: null });

    const req = { query: { search: 'player1' } };
    const res = mockRes();

    await list(req, res);

    expect(db.listUsers).toHaveBeenCalledWith({
      limit: 25,
      cursor: null,
      search: 'player1',
    });
  });

  it('clamps limit to max 100', async () => {
    db.listUsers.mockResolvedValue({ items: [], nextCursor: null });

    const req = { query: { limit: '999' } };
    const res = mockRes();

    await list(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.pagination.limit).toBe(100);
    expect(db.listUsers).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('returns correct fields for each user', async () => {
    db.listUsers.mockResolvedValue({ items: [testUserRecord], nextCursor: null });

    const req = { query: {} };
    const res = mockRes();

    await list(req, res);

    const user = res.json.mock.calls[0][0].data.users[0];
    expect(user).toEqual({
      id: 'usr_player1',
      email: 'player1@example.com',
      displayName: 'Player1',
      role: 'user',
      tier: 'free',
      essence: 2000,
      gems: 50,
      loginStreak: 3,
      lastLoginDate: '2026-04-01',
      createdAt: '2026-03-01T00:00:00.000Z',
    });
  });
});

// =============================================================================
// GET /v1/admin/users/:id
// =============================================================================
describe('GET /v1/admin/users/:id (getDetail)', () => {
  it('returns full user detail with totems and transactions', async () => {
    db.getUser.mockResolvedValue(testUserRecord);
    db.getUserTotems.mockResolvedValue([testTotem]);
    db.getTransactionHistory.mockResolvedValue([testTransaction]);

    const req = { params: { id: 'usr_player1' } };
    const res = mockRes();

    await getDetail(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.user.id).toBe('usr_player1');
    expect(body.data.user.currencies).toEqual({ essence: 2000, gems: 50 });
    expect(body.data.totems).toHaveLength(1);
    expect(body.data.totems[0].id).toBe('ttm_abc');
    expect(body.data.recentTransactions).toHaveLength(1);
    expect(body.data.recentTransactions[0].type).toBe('action_feed');
  });

  it('returns 404 for non-existent user', async () => {
    db.getUser.mockResolvedValue(null);

    const req = { params: { id: 'usr_nonexistent' } };
    const res = mockRes();

    await getDetail(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].error.code).toBe('NOT_FOUND');
  });

  it('fetches totems and transactions in parallel', async () => {
    db.getUser.mockResolvedValue(testUserRecord);
    db.getUserTotems.mockResolvedValue([]);
    db.getTransactionHistory.mockResolvedValue([]);

    const req = { params: { id: 'usr_player1' } };
    const res = mockRes();

    await getDetail(req, res);

    expect(db.getUserTotems).toHaveBeenCalledWith('usr_player1');
    expect(db.getTransactionHistory).toHaveBeenCalledWith('usr_player1', 20);
  });
});

// =============================================================================
// PUT /v1/admin/users/:id/currencies
// =============================================================================
describe('PUT /v1/admin/users/:id/currencies (adjustCurrencies)', () => {
  it('grants essence with ledger entry', async () => {
    db.getUser.mockResolvedValue(testUserRecord);
    db.addEssence.mockResolvedValue({ success: true, newBalance: 2500, added: 500 });

    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'essence', amount: 500, reason: 'CS refund for bug' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.newBalance).toBe(2500);
    expect(body.data.currency).toBe('essence');
    expect(body.data.amount).toBe(500);
    expect(db.addEssence).toHaveBeenCalledWith('usr_player1', 500, expect.objectContaining({
      type: 'admin_grant',
      refType: 'admin',
    }));
  });

  it('deducts gems with ledger entry', async () => {
    db.getUser.mockResolvedValue(testUserRecord);
    db.deductGems.mockResolvedValue({ success: true, newBalance: 30, deducted: 20 });

    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'gems', amount: -20, reason: 'Abuse correction' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.deductGems).toHaveBeenCalledWith('usr_player1', 20, expect.objectContaining({
      type: 'admin_deduct',
    }));
  });

  it('returns 400 for invalid currency', async () => {
    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'gold', amount: 100, reason: 'test' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_CURRENCY');
  });

  it('returns 400 for zero amount', async () => {
    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'essence', amount: 0, reason: 'test' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_AMOUNT');
  });

  it('returns 400 for non-integer amount', async () => {
    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'essence', amount: 10.5, reason: 'test' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_AMOUNT');
  });

  it('returns 400 for missing reason', async () => {
    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'essence', amount: 100 },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('REASON_REQUIRED');
  });

  it('returns 400 for reason under 3 characters', async () => {
    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'essence', amount: 100, reason: 'ab' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('REASON_REQUIRED');
  });

  it('returns 404 for non-existent user', async () => {
    db.getUser.mockResolvedValue(null);

    const req = {
      params: { id: 'usr_nonexistent' },
      body: { currency: 'essence', amount: 100, reason: 'test grant' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when deduct fails due to insufficient balance', async () => {
    db.getUser.mockResolvedValue(testUserRecord);
    db.deductEssence.mockResolvedValue({ success: false, error: 'Insufficient Essence' });

    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'essence', amount: -99999, reason: 'penalty' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('ADJUSTMENT_FAILED');
  });

  it('includes admin ID in the refName for audit', async () => {
    db.getUser.mockResolvedValue(testUserRecord);
    db.addGems.mockResolvedValue({ success: true, newBalance: 150, added: 100 });

    const req = {
      params: { id: 'usr_player1' },
      body: { currency: 'gems', amount: 100, reason: 'Promotional bonus' },
      user: adminUser,
    };
    const res = mockRes();

    await adjustCurrencies(req, res);

    const callArgs = db.addGems.mock.calls[0][2];
    expect(callArgs.refName).toContain('usr_admin');
    expect(callArgs.refName).toContain('Promotional bonus');
  });
});

// =============================================================================
// PUT /v1/admin/users/:id/status (ban/unban)
// =============================================================================
describe('PUT /v1/admin/users/:id/status (setStatus)', () => {
  it('bans a user', async () => {
    db.getUser.mockResolvedValue({ ...testUserRecord, status: 'active' });
    db.updateUser.mockResolvedValue({});

    const req = {
      params: { id: 'usr_player1' },
      body: { status: 'banned', reason: 'Exploiting bug' },
      user: adminUser,
    };
    const res = mockRes();

    await setStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.updateUser).toHaveBeenCalledWith('usr_player1', { status: 'banned' });
    expect(db.logTransaction).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.status).toBe('banned');
  });

  it('unbans a user', async () => {
    db.getUser.mockResolvedValue({ ...testUserRecord, status: 'banned' });
    db.updateUser.mockResolvedValue({});

    const req = {
      params: { id: 'usr_player1' },
      body: { status: 'active', reason: 'Appeal approved' },
      user: adminUser,
    };
    const res = mockRes();

    await setStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.updateUser).toHaveBeenCalledWith('usr_player1', { status: 'active' });
    expect(db.logTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid status value', async () => {
    const req = {
      params: { id: 'usr_player1' },
      body: { status: 'suspended', reason: 'test' },
      user: adminUser,
    };
    const res = mockRes();

    await setStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_STATUS');
  });

  it('returns 400 for missing reason', async () => {
    const req = {
      params: { id: 'usr_player1' },
      body: { status: 'banned' },
      user: adminUser,
    };
    const res = mockRes();

    await setStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('REASON_REQUIRED');
  });

  it('returns 404 for non-existent user', async () => {
    db.getUser.mockResolvedValue(null);

    const req = {
      params: { id: 'usr_ghost' },
      body: { status: 'banned', reason: 'test ban' },
      user: adminUser,
    };
    const res = mockRes();

    await setStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when user is already in the requested status', async () => {
    db.getUser.mockResolvedValue({ ...testUserRecord, status: 'banned' });

    const req = {
      params: { id: 'usr_player1' },
      body: { status: 'banned', reason: 'double ban' },
      user: adminUser,
    };
    const res = mockRes();

    await setStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('NO_CHANGE');
  });

  it('prevents admin from banning themselves', async () => {
    db.getUser.mockResolvedValue({ ...testUserRecord, id: 'usr_admin', status: 'active' });

    const req = {
      params: { id: 'usr_admin' },
      body: { status: 'banned', reason: 'self test' },
      user: adminUser,
    };
    const res = mockRes();

    await setStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('SELF_BAN');
  });

  it('treats user with no status field as active', async () => {
    // testUserRecord has no status field
    db.getUser.mockResolvedValue(testUserRecord);
    db.updateUser.mockResolvedValue({});
    db.logTransaction.mockResolvedValue({});

    const req = {
      params: { id: 'usr_player1' },
      body: { status: 'banned', reason: 'test' },
      user: adminUser,
    };
    const res = mockRes();

    await setStatus(req, res);

    // Should succeed because current status defaults to 'active'
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// =============================================================================
// GET /v1/admin/stats
// =============================================================================
describe('GET /v1/admin/stats', () => {
  // Pin a fixed mid-day UTC clock for the whole stats suite. The today/thisWeek
  // rollup keys boundary hours by the current/previous UTC hour and overwrites any
  // slice at those keys with live aggregates (admin-stats-service computeTransactions).
  // The fixtures below hardcode a stored slice at 01:00 UTC, so on a real clock these
  // tests fail when run during the 01:00–02:59 UTC window (hour-key collision). Noon
  // is safely clear of every hardcoded boundary, making the suite time-independent.
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    // Default: no precomputed snapshot → endpoint computes live.
    db.getLatestSnapshot.mockResolvedValue(null);
    // Default transaction rollup inputs: empty boundary hours + no stored slices.
    db.aggregateTransactions.mockResolvedValue({ ...EMPTY_AGG });
    db.queryStatsTrends.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns aggregated dashboard metrics (live compute when no snapshot)', async () => {
    const today = new Date().toISOString().split('T')[0];
    const users = [
      // activeToday is keyed off updatedAt (any activity today), not lastLoginDate.
      { ...testUserRecord, updatedAt: `${today}T11:00:00.000Z`, createdAt: `${today}T10:00:00.000Z` },
      { ...testUserRecord2, status: 'banned' },
    ];

    db.scanAllUsers.mockResolvedValue(users);
    db.countTotems.mockResolvedValue(5);
    // computeTransactions reads two boundary hours via aggregateTransactions
    // (prev completed hour, then current partial hour). Put today's activity in
    // the current-hour read so it rolls into today + thisWeek.
    db.aggregateTransactions
      .mockResolvedValueOnce({ ...EMPTY_AGG })
      .mockResolvedValueOnce({
        count: 1,
        byType: { action_feed: { count: 1, essenceVolume: 10, gemsVolume: 0 } },
        essenceVolume: 10,
        gemsVolume: 0,
        capped: false,
      });

    const req = { query: {} };
    const res = mockRes();

    await getStats(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0].data;
    expect(data.source).toBe('live');
    expect(data.users.total).toBe(2);
    expect(data.users.activeToday).toBe(1);
    expect(data.users.newToday).toBe(1);
    expect(data.users.banned).toBe(1);
    expect(data.totems.total).toBe(5);
    expect(data.transactions.today.count).toBe(1);
    expect(data.transactions.thisWeek.count).toBe(1);
    expect(data.transactions.byType.action_feed).toBeDefined();
    // The internal rollup unit must never leak into the API response.
    expect(data.txWindow).toBeUndefined();
    expect(data.generatedAt).toBeDefined();
  });

  it('rolls up today/thisWeek from stored hourly slices', async () => {
    const today = new Date().toISOString().split('T')[0];
    db.scanAllUsers.mockResolvedValue([]);
    db.countTotems.mockResolvedValue(0);
    // A stored HOURLY slice earlier today + empty boundary hours → counted once.
    db.queryStatsTrends.mockResolvedValue([
      {
        txWindow: {
          count: 3,
          byType: { action_train: { count: 3, essenceVolume: 30, gemsVolume: 0 } },
          essenceVolume: 30,
          gemsVolume: 0,
          fromTs: `${today}T01:00:00.000Z`,
          toTs: `${today}T02:00:00.000Z`,
        },
      },
    ]);

    const req = { query: {} };
    const res = mockRes();
    await getStats(req, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.transactions.today.count).toBe(3);
    expect(data.transactions.thisWeek.count).toBe(3);
    expect(data.transactions.byType.action_train.count).toBe(3);
  });

  it('handles empty database', async () => {
    db.scanAllUsers.mockResolvedValue([]);
    db.countTotems.mockResolvedValue(0);

    const req = { query: {} };
    const res = mockRes();

    await getStats(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0].data;
    expect(data.source).toBe('live');
    expect(data.users.total).toBe(0);
    expect(data.totems.total).toBe(0);
    expect(data.transactions.today.count).toBe(0);
  });

  it('serves the latest snapshot when it is fresh (no live scan)', async () => {
    const snapshot = {
      users: { total: 99, activeToday: 7, activeThisWeek: 20, newToday: 3, banned: 1, byTier: { free: 99 } },
      totems: { total: 123 },
      transactions: { today: { count: 4 }, thisWeek: { count: 30 }, byType: {}, essenceVolume: 5000, gemsVolume: 0 },
      economy: { essenceInCirculation: 250000, gemsInCirculation: 9999 },
      generatedAt: new Date().toISOString(), // fresh
    };
    db.getLatestSnapshot.mockResolvedValue(snapshot);

    const req = { query: {} };
    const res = mockRes();

    await getStats(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0].data;
    expect(data.source).toBe('snapshot');
    expect(data.users.total).toBe(99);
    expect(data.economy.essenceInCirculation).toBe(250000);
    // The expensive scans must NOT run when a fresh snapshot is served.
    expect(db.scanAllUsers).not.toHaveBeenCalled();
    expect(db.countTotems).not.toHaveBeenCalled();
  });

  it('falls back to live compute when the latest snapshot is stale', async () => {
    const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // 4h old
    db.getLatestSnapshot.mockResolvedValue({ users: { total: 1 }, generatedAt: stale });
    db.scanAllUsers.mockResolvedValue([]);
    db.countTotems.mockResolvedValue(0);

    const req = { query: {} };
    const res = mockRes();

    await getStats(req, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.source).toBe('live');
    expect(db.scanAllUsers).toHaveBeenCalled();
  });

  it('bypasses the snapshot with ?fresh=1', async () => {
    db.getLatestSnapshot.mockResolvedValue({ users: { total: 99 }, generatedAt: new Date().toISOString() });
    db.scanAllUsers.mockResolvedValue([]);
    db.countTotems.mockResolvedValue(0);

    const req = { query: { fresh: '1' } };
    const res = mockRes();

    await getStats(req, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.source).toBe('live');
    expect(db.getLatestSnapshot).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GET /v1/admin/transactions
// =============================================================================
describe('GET /v1/admin/transactions', () => {
  it('returns a page of transactions with cursor pagination metadata', async () => {
    const txns = [testTransaction, { ...testTransaction, id: 'txn_def', type: 'reward_signup' }];
    db.listAllTransactions.mockResolvedValue({ items: txns, nextCursor: null });

    const req = { query: { userId: 'usr_player1' } };
    const res = mockRes();

    await listTransactions(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.transactions).toHaveLength(2);
    expect(body.pagination).toEqual({ limit: 25, count: 2, nextCursor: null, hasMore: false });
  });

  it('rejects 400 when neither userId nor type is given (no unbounded scans)', async () => {
    const req = { query: {} };
    const res = mockRes();

    await listTransactions(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(db.listAllTransactions).not.toHaveBeenCalled();
  });

  it('rejects 400 on invalid currency filter', async () => {
    const req = { query: { userId: 'usr_player1', currency: 'doubloons' } };
    const res = mockRes();

    await listTransactions(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_CURRENCY');
    expect(db.listAllTransactions).not.toHaveBeenCalled();
  });

  it('passes all filter params (incl. cursor + currency) to listAllTransactions', async () => {
    db.listAllTransactions.mockResolvedValue({ items: [], nextCursor: null });

    const req = {
      query: {
        userId: 'usr_player1',
        type: 'admin_grant',
        currency: 'essence',
        startTime: '2026-04-01T00:00:00.000Z',
        endTime: '2026-04-02T00:00:00.000Z',
        cursor: 'eyJwayI6Iks0In0=',
        limit: '50',
      },
    };
    const res = mockRes();

    await listTransactions(req, res);

    expect(db.listAllTransactions).toHaveBeenCalledWith({
      userId: 'usr_player1',
      type: 'admin_grant',
      currency: 'essence',
      startTime: '2026-04-01T00:00:00.000Z',
      endTime: '2026-04-02T00:00:00.000Z',
      cursor: 'eyJwayI6Iks0In0=',
      limit: 50,
    });
  });

  it('surfaces nextCursor + hasMore when more pages exist', async () => {
    db.listAllTransactions.mockResolvedValue({
      items: [testTransaction],
      nextCursor: 'eyJwayI6Iks1In0=',
    });

    const req = { query: { type: 'reward_daily' } };
    const res = mockRes();

    await listTransactions(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.pagination).toEqual({
      limit: 25,
      count: 1,
      nextCursor: 'eyJwayI6Iks1In0=',
      hasMore: true,
    });
  });

  it('returns correct fields including refId for each transaction', async () => {
    db.listAllTransactions.mockResolvedValue({
      items: [{ ...testTransaction, refId: 'ttm_abc' }],
      nextCursor: null,
    });

    const req = { query: { userId: 'usr_player1' } };
    const res = mockRes();

    await listTransactions(req, res);

    const txn = res.json.mock.calls[0][0].data.transactions[0];
    expect(txn).toEqual({
      id: 'txn_abc',
      userId: 'usr_player1',
      type: 'action_feed',
      currency: 'essence',
      amount: -10,
      balanceBefore: 2010,
      balanceAfter: 2000,
      refType: null,
      refId: 'ttm_abc',
      refName: null,
      ts: '2026-04-01T12:00:00.000Z',
    });
  });
});
