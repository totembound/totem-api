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
}));

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
  it('returns paginated user list', async () => {
    db.listUsers.mockResolvedValue([testUserRecord, testUserRecord2]);

    const req = { query: {} };
    const res = mockRes();

    await list(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.users).toHaveLength(2);
    expect(body.pagination).toEqual({ page: 1, limit: 25, total: 2, totalPages: 1 });
  });

  it('respects page and limit params', async () => {
    db.listUsers.mockResolvedValue([testUserRecord, testUserRecord2]);

    const req = { query: { page: '2', limit: '1' } };
    const res = mockRes();

    await list(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.users).toHaveLength(1);
    expect(body.data.users[0].id).toBe('usr_player2');
    expect(body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
  });

  it('passes search param to listUsers', async () => {
    db.listUsers.mockResolvedValue([]);

    const req = { query: { search: 'player1' } };
    const res = mockRes();

    await list(req, res);

    expect(db.listUsers).toHaveBeenCalledWith({ search: 'player1' });
  });

  it('clamps limit to max 100', async () => {
    db.listUsers.mockResolvedValue([]);

    const req = { query: { limit: '999' } };
    const res = mockRes();

    await list(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.pagination.limit).toBe(100);
  });

  it('returns correct fields for each user', async () => {
    db.listUsers.mockResolvedValue([testUserRecord]);

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
  it('returns aggregated dashboard metrics', async () => {
    const today = new Date().toISOString().split('T')[0];
    const users = [
      { ...testUserRecord, stats: { ...testUserRecord.stats, lastLoginDate: today }, createdAt: `${today}T10:00:00.000Z` },
      { ...testUserRecord2, status: 'banned' },
    ];

    db.listUsers.mockResolvedValue(users);
    db.countTotems.mockResolvedValue(5);
    db.listAllTransactions.mockResolvedValue([
      { ...testTransaction, ts: `${today}T12:00:00.000Z` },
    ]);

    const req = { query: {} };
    const res = mockRes();

    await getStats(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0].data;
    expect(data.users.total).toBe(2);
    expect(data.users.activeToday).toBe(1);
    expect(data.users.newToday).toBe(1);
    expect(data.users.banned).toBe(1);
    expect(data.totems.total).toBe(5);
    expect(data.transactions.today.count).toBe(1);
    expect(data.transactions.byType.action_feed).toBeDefined();
    expect(data.generatedAt).toBeDefined();
  });

  it('handles empty database', async () => {
    db.listUsers.mockResolvedValue([]);
    db.countTotems.mockResolvedValue(0);
    db.listAllTransactions.mockResolvedValue([]);

    const req = { query: {} };
    const res = mockRes();

    await getStats(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0].data;
    expect(data.users.total).toBe(0);
    expect(data.totems.total).toBe(0);
    expect(data.transactions.today.count).toBe(0);
  });
});

// =============================================================================
// GET /v1/admin/transactions
// =============================================================================
describe('GET /v1/admin/transactions', () => {
  it('returns paginated transaction list', async () => {
    const txns = [testTransaction, { ...testTransaction, id: 'txn_def', type: 'reward_signup' }];
    db.listAllTransactions.mockResolvedValue(txns);

    const req = { query: {} };
    const res = mockRes();

    await listTransactions(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.transactions).toHaveLength(2);
    expect(body.pagination).toEqual({ page: 1, limit: 25, total: 2, totalPages: 1 });
  });

  it('passes filter params to listAllTransactions', async () => {
    db.listAllTransactions.mockResolvedValue([]);

    const req = {
      query: {
        userId: 'usr_player1',
        type: 'admin_grant',
        startTime: '2026-04-01T00:00:00.000Z',
        endTime: '2026-04-02T00:00:00.000Z',
      },
    };
    const res = mockRes();

    await listTransactions(req, res);

    expect(db.listAllTransactions).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'usr_player1',
      type: 'admin_grant',
      startTime: '2026-04-01T00:00:00.000Z',
      endTime: '2026-04-02T00:00:00.000Z',
    }));
  });

  it('respects page and limit params', async () => {
    const txns = Array.from({ length: 5 }, (_, i) => ({
      ...testTransaction,
      id: `txn_${i}`,
    }));
    db.listAllTransactions.mockResolvedValue(txns);

    const req = { query: { page: '2', limit: '2' } };
    const res = mockRes();

    await listTransactions(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.transactions).toHaveLength(2);
    expect(body.data.transactions[0].id).toBe('txn_2');
    expect(body.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });

  it('returns correct fields for each transaction', async () => {
    db.listAllTransactions.mockResolvedValue([testTransaction]);

    const req = { query: {} };
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
      refName: null,
      ts: '2026-04-01T12:00:00.000Z',
    });
  });
});
