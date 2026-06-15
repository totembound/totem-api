/**
 * Admin Messaging Handler Tests
 *
 * Covers:
 * - POST /v1/admin/broadcast/notification
 * - POST /v1/admin/broadcast/app-reload
 * - POST /v1/admin/broadcast/force-logout
 * - POST /v1/admin/users/:id/notification
 * - POST /v1/admin/users/:id/force-logout
 *
 * Focuses on purposeful, load-bearing behavior:
 *   1. Validation gates (can't publish with bad input).
 *   2. 404 on unknown user for per-user routes (no publishes to ghosts).
 *   3. Correct publisher routing (global vs per-user force-logout must not swap).
 *   4. Degraded delivery branch (user has no iotIdentityId).
 *   5. Command envelope shape for the inline global-notification path
 *      (there is no publishGlobalNotification wrapper, so the handler builds
 *      the envelope itself — this test prevents regressions there).
 *   6. Audit log carries the acting admin's id.
 *   7. Targeted routes address the path param, not the admin user.
 */

// Mock db-client before requiring handler under test
jest.mock('../src/common/db-client', () => ({
  getUser: jest.fn(),
}));

// Mock iot-publisher — we care about what the handler asks it to do,
// not what IoT actually sends over the wire.
jest.mock('../src/common/iot-publisher', () => ({
  buildCommand: jest.fn((type, payload) => ({
    type,
    id: 'msg_fixed',
    timestamp: '2026-04-05T00:00:00.000Z',
    payload,
  })),
  publishToGlobal: jest.fn(),
  publishNotification: jest.fn(),
  publishForceLogout: jest.fn(),
  publishAppReload: jest.fn(),
  publishGlobalForceLogout: jest.fn(),
}));

const db = require('../src/common/db-client');
const iot = require('../src/common/iot-publisher');
const messaging = require('../src/functions/admin/messaging');

// Suppress console noise, but capture audit log lines for assertions
const logSpy = jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'error').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const adminUser = { userId: 'usr_admin', email: 'admin@example.com', role: 'admin' };

const playerRecord = {
  id: 'usr_player1',
  email: 'player1@example.com',
  iotIdentityId: 'identity-123',
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: publishers report successful delivery
  iot.publishToGlobal.mockResolvedValue(true);
  iot.publishNotification.mockResolvedValue(true);
  iot.publishForceLogout.mockResolvedValue(true);
  iot.publishAppReload.mockResolvedValue(true);
  iot.publishGlobalForceLogout.mockResolvedValue(true);
});

// =============================================================================
// POST /v1/admin/broadcast/notification
// =============================================================================
describe('POST /v1/admin/broadcast/notification', () => {
  it('publishes a global notification command envelope and returns 200', async () => {
    const req = {
      body: { title: 'Server maintenance', message: 'Brief downtime in 10 min', priority: 'high' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.broadcastNotification(req, res);

    // buildCommand → publishToGlobal is the critical routing for this endpoint
    // (there is no publishGlobalNotification wrapper, so the handler builds it).
    expect(iot.buildCommand).toHaveBeenCalledWith('notification', expect.objectContaining({
      title: 'Server maintenance',
      message: 'Brief downtime in 10 min',
      priority: 'high',
      sound: true,
    }));
    expect(iot.publishToGlobal).toHaveBeenCalledTimes(1);
    const publishedCommand = iot.publishToGlobal.mock.calls[0][0];
    expect(publishedCommand.type).toBe('notification');
    expect(publishedCommand.id).toBe('msg_fixed');
    expect(publishedCommand.payload.title).toBe('Server maintenance');

    // Per-user publishers must NOT be called
    expect(iot.publishNotification).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toEqual({
      success: true,
      data: {
        delivered: true,
        topic: 'global',
        commandId: 'msg_fixed',
        type: 'notification',
      },
    });
  });

  it('trims title and message before publishing', async () => {
    const req = {
      body: { title: '  Padded title  ', message: '   Padded body   ' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.broadcastNotification(req, res);

    const payload = iot.buildCommand.mock.calls[0][1];
    expect(payload.title).toBe('Padded title');
    expect(payload.message).toBe('Padded body');
  });

  it('defaults priority to medium and sound to true when omitted', async () => {
    const req = { body: { title: 'x', message: 'y' }, user: adminUser };
    const res = mockRes();

    await messaging.broadcastNotification(req, res);

    const payload = iot.buildCommand.mock.calls[0][1];
    expect(payload.priority).toBe('medium');
    expect(payload.sound).toBe(true);
  });

  it('returns 400 and does not publish when title is missing', async () => {
    const req = { body: { message: 'no title' }, user: adminUser };
    const res = mockRes();

    await messaging.broadcastNotification(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_TITLE');
    expect(iot.publishToGlobal).not.toHaveBeenCalled();
  });

  it('returns 400 and does not publish when message is missing', async () => {
    const req = { body: { title: 'hi' }, user: adminUser };
    const res = mockRes();

    await messaging.broadcastNotification(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_MESSAGE');
    expect(iot.publishToGlobal).not.toHaveBeenCalled();
  });

  it('returns 400 for title longer than 80 characters', async () => {
    const req = {
      body: { title: 'x'.repeat(81), message: 'ok' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.broadcastNotification(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_TITLE');
  });

  it('returns 400 for invalid priority value', async () => {
    const req = {
      body: { title: 'x', message: 'y', priority: 'URGENT' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.broadcastNotification(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_PRIORITY');
  });

  it('audit-logs the acting admin id and title', async () => {
    const req = { body: { title: 'Audit me', message: 'hi' }, user: adminUser };
    const res = mockRes();

    await messaging.broadcastNotification(req, res);

    const auditLines = logSpy.mock.calls.map(c => c[0]).filter(l => typeof l === 'string' && l.startsWith('[Admin]'));
    expect(auditLines.some(l => l.includes('usr_admin') && l.includes('notification') && l.includes('global') && l.includes('Audit me'))).toBe(true);
  });
});

// =============================================================================
// POST /v1/admin/broadcast/app-reload
// =============================================================================
describe('POST /v1/admin/broadcast/app-reload', () => {
  it('calls publishAppReload with trimmed reason and returns 200', async () => {
    const req = { body: { reason: '  deploy v2.3.1  ' }, user: adminUser };
    const res = mockRes();

    await messaging.broadcastAppReload(req, res);

    expect(iot.publishAppReload).toHaveBeenCalledWith('deploy v2.3.1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({
      delivered: true,
      topic: 'global',
      type: 'app_reload',
      reason: 'deploy v2.3.1',
    });
  });

  it('returns 400 and does not publish when reason is missing', async () => {
    const req = { body: {}, user: adminUser };
    const res = mockRes();

    await messaging.broadcastAppReload(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_REASON');
    expect(iot.publishAppReload).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /v1/admin/broadcast/force-logout
// =============================================================================
describe('POST /v1/admin/broadcast/force-logout', () => {
  it('routes to publishGlobalForceLogout, NOT publishForceLogout', async () => {
    const req = { body: { reason: 'key rotation' }, user: adminUser };
    const res = mockRes();

    await messaging.broadcastForceLogout(req, res);

    // Critical routing distinction: global endpoint must use the global
    // publisher, otherwise it would silently no-op (no userId) or target
    // the wrong scope.
    expect(iot.publishGlobalForceLogout).toHaveBeenCalledWith('key rotation');
    expect(iot.publishForceLogout).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.topic).toBe('global');
    expect(res.json.mock.calls[0][0].data.type).toBe('force_logout');
  });

  it('returns 400 for missing reason', async () => {
    const req = { body: {}, user: adminUser };
    const res = mockRes();

    await messaging.broadcastForceLogout(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(iot.publishGlobalForceLogout).not.toHaveBeenCalled();
  });

  it('returns 400 for reason over 200 characters', async () => {
    const req = { body: { reason: 'x'.repeat(201) }, user: adminUser };
    const res = mockRes();

    await messaging.broadcastForceLogout(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(iot.publishGlobalForceLogout).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /v1/admin/users/:id/notification
// =============================================================================
describe('POST /v1/admin/users/:id/notification', () => {
  it('publishes to the target user (not the admin) and returns 200', async () => {
    db.getUser.mockResolvedValue(playerRecord);

    const req = {
      params: { id: 'usr_player1' },
      body: { title: 'Hi', message: 'Welcome back' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.userNotification(req, res);

    // The critical invariant: target is the path param, NOT the admin
    expect(iot.publishNotification).toHaveBeenCalledWith('usr_player1', expect.objectContaining({
      title: 'Hi',
      message: 'Welcome back',
    }));
    // Global publishers must NOT fire on a per-user route
    expect(iot.publishToGlobal).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({
      delivered: true,
      topic: 'user:usr_player1',
      type: 'notification',
    });
  });

  it('returns 404 and does not publish when target user does not exist', async () => {
    db.getUser.mockResolvedValue(null);

    const req = {
      params: { id: 'usr_ghost' },
      body: { title: 'Hi', message: 'Welcome' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.userNotification(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].error.code).toBe('NOT_FOUND');
    expect(iot.publishNotification).not.toHaveBeenCalled();
  });

  it('returns delivered=false with undeliveredReason when user not registered for IoT', async () => {
    db.getUser.mockResolvedValue(playerRecord);
    iot.publishNotification.mockResolvedValue(false); // publisher degraded path

    const req = {
      params: { id: 'usr_player1' },
      body: { title: 'x', message: 'y' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.userNotification(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({
      delivered: false,
      topic: 'user:usr_player1',
      type: 'notification',
      undeliveredReason: 'user_not_registered',
    });
  });

  it('returns 400 before even hitting the database when title is missing', async () => {
    const req = {
      params: { id: 'usr_player1' },
      body: { message: 'no title' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.userNotification(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.getUser).not.toHaveBeenCalled();
    expect(iot.publishNotification).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /v1/admin/users/:id/force-logout
// =============================================================================
describe('POST /v1/admin/users/:id/force-logout', () => {
  it('routes to publishForceLogout (per-user), NOT publishGlobalForceLogout', async () => {
    db.getUser.mockResolvedValue(playerRecord);

    const req = {
      params: { id: 'usr_player1' },
      body: { reason: 'ToS violation' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.userForceLogout(req, res);

    // Critical routing distinction: per-user endpoint must not broadcast globally.
    expect(iot.publishForceLogout).toHaveBeenCalledWith('usr_player1', 'ToS violation');
    expect(iot.publishGlobalForceLogout).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toMatchObject({
      delivered: true,
      topic: 'user:usr_player1',
      type: 'force_logout',
      reason: 'ToS violation',
    });
  });

  it('returns 404 and does not publish when target user does not exist', async () => {
    db.getUser.mockResolvedValue(null);

    const req = {
      params: { id: 'usr_ghost' },
      body: { reason: 'test' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.userForceLogout(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(iot.publishForceLogout).not.toHaveBeenCalled();
  });

  it('preserves the original reason on the response and sets undeliveredReason when degraded', async () => {
    db.getUser.mockResolvedValue(playerRecord);
    iot.publishForceLogout.mockResolvedValue(false);

    const req = {
      params: { id: 'usr_player1' },
      body: { reason: 'Account cleanup' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.userForceLogout(req, res);

    const body = res.json.mock.calls[0][0];
    // The original reason stays in `reason`; the undelivered info lives in a
    // distinct field so consumers can tell the two apart.
    expect(body.data.reason).toBe('Account cleanup');
    expect(body.data.undeliveredReason).toBe('user_not_registered');
    expect(body.data.delivered).toBe(false);
  });

  it('audit-logs admin id, target user id, and reason', async () => {
    db.getUser.mockResolvedValue(playerRecord);

    const req = {
      params: { id: 'usr_player1' },
      body: { reason: 'security incident 42' },
      user: adminUser,
    };
    const res = mockRes();

    await messaging.userForceLogout(req, res);

    const auditLines = logSpy.mock.calls.map(c => c[0]).filter(l => typeof l === 'string' && l.startsWith('[Admin]'));
    expect(auditLines.some(l =>
      l.includes('usr_admin') &&
      l.includes('force_logout') &&
      l.includes('user:usr_player1') &&
      l.includes('security incident 42')
    )).toBe(true);
  });
});
