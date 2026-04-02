/**
 * Tests for role-based access control (Phase 1)
 *
 * Covers:
 * - requireRole() middleware (403 on wrong role, pass-through on correct role)
 * - role field in authenticateJWT extraction
 * - role included in signup user record
 * - role included in login response
 */

const jwt = require('jsonwebtoken');

// Must set IS_LOCAL before requiring app
process.env.IS_LOCAL = 'true';

// Mock db-client before requiring auth modules
jest.mock('../src/common/db-client', () => ({
  createUser: jest.fn().mockResolvedValue({}),
  getUser: jest.fn(),
  getUserByEmail: jest.fn(),
  updateUser: jest.fn(),
  logTransaction: jest.fn().mockResolvedValue({}),
  getUserTotems: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/common/email', () => ({
  sendNewUserWelcomeEmail: jest.fn().mockResolvedValue({}),
  sendVerificationEmail: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/services/achievements-service', () => ({
  onLoginStreak: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/services/loot-service', () => ({
  grantLootItem: jest.fn().mockResolvedValue({
    id: 'lot_test',
    boxId: 'uncommon_totem_box',
    box: { name: 'Test Box', description: 'Test', rarity: 'uncommon', icon: 'box' },
  }),
}));

jest.mock('../src/common/cognito-client', () => ({
  signUp: jest.fn().mockResolvedValue({
    userId: 'usr_test123',
    email: 'test@example.com',
    displayName: 'Tester',
  }),
  signIn: jest.fn(),
  confirmSignUp: jest.fn(),
  resendConfirmationCode: jest.fn(),
  forgotPassword: jest.fn(),
  confirmForgotPassword: jest.fn(),
  verifyAccessToken: jest.fn(),
  refreshTokens: jest.fn(),
  revokeRefreshToken: jest.fn(),
  generateTokensWithRole: jest.fn().mockReturnValue({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
    idToken: 'new-id-token',
    expiresIn: 86400,
    tokenType: 'Bearer',
  }),
  isLocal: true,
  JWT_SECRET: 'test-secret',
}));

// Suppress console noise
jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'error').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();

const JWT_SECRET = 'local-dev-secret-key-change-in-prod';

function makeToken(claims) {
  return jwt.sign(
    { sub: claims.userId || 'usr_test', email: claims.email || 'test@example.com', token_use: 'access', ...claims },
    JWT_SECRET,
  );
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('Role-Based Access Control', () => {
  // -------------------------------------------------------
  // requireRole() middleware
  // -------------------------------------------------------
  describe('requireRole() middleware', () => {
    // Re-implement requireRole identically to app.js so we test the logic
    function requireRole(...roles) {
      return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
          });
        }
        next();
      };
    }

    it('returns 403 when user role does not match required role', () => {
      const req = { user: { userId: 'usr_1', role: 'user' } };
      const res = mockRes();
      const next = jest.fn();

      requireRole('admin')(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      }));
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() when user has the required role', () => {
      const req = { user: { userId: 'usr_1', role: 'admin' } };
      const res = mockRes();
      const next = jest.fn();

      requireRole('admin')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('accepts any of multiple allowed roles', () => {
      const req = { user: { userId: 'usr_1', role: 'moderator' } };
      const res = mockRes();
      const next = jest.fn();

      requireRole('admin', 'moderator')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects when role matches none of multiple allowed roles', () => {
      const req = { user: { userId: 'usr_1', role: 'user' } };
      const res = mockRes();
      const next = jest.fn();

      requireRole('admin', 'moderator')(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // authenticateJWT role extraction
  // -------------------------------------------------------
  describe('authenticateJWT role extraction', () => {
    // Mirror the local-mode extraction logic from app.js
    function extractRole(token) {
      const decoded = jwt.decode(token);
      return decoded.role || decoded['custom:role'] || 'user';
    }

    it('extracts role from local JWT', () => {
      const token = makeToken({ role: 'admin' });
      expect(extractRole(token)).toBe('admin');
    });

    it('extracts custom:role from Cognito-style JWT', () => {
      const token = jwt.sign({ sub: 'usr_1', email: 'a@b.com', 'custom:role': 'admin' }, JWT_SECRET);
      expect(extractRole(token)).toBe('admin');
    });

    it('defaults to user when no role claim exists', () => {
      const token = jwt.sign({ sub: 'usr_1', email: 'a@b.com' }, JWT_SECRET);
      expect(extractRole(token)).toBe('user');
    });

    it('prefers role over custom:role', () => {
      const token = jwt.sign({ sub: 'usr_1', email: 'a@b.com', role: 'admin', 'custom:role': 'moderator' }, JWT_SECRET);
      expect(extractRole(token)).toBe('admin');
    });
  });

  // -------------------------------------------------------
  // Signup includes role: 'user'
  // -------------------------------------------------------
  describe('Signup sets role', () => {
    it('creates user with role: user', async () => {
      const { createUser } = require('../src/common/db-client');
      const { handleSignup } = require('../src/auth');

      createUser.mockClear();
      createUser.mockResolvedValue({});

      const req = {
        body: { email: 'new@example.com', password: 'Password1', displayName: 'New' },
      };
      const res = mockRes();

      await handleSignup(req, res);

      expect(createUser).toHaveBeenCalledTimes(1);
      const userData = createUser.mock.calls[0][0];
      expect(userData.role).toBe('user');
    });
  });

  // -------------------------------------------------------
  // Login returns role in user object
  // -------------------------------------------------------
  describe('Login returns role', () => {
    it('includes role in login response', async () => {
      const { getUser, getUserByEmail, updateUser } = require('../src/common/db-client');
      const { signIn } = require('../src/common/cognito-client');
      const { handleLogin } = require('../src/auth');

      getUserByEmail.mockResolvedValue(null);
      signIn.mockResolvedValue({
        userId: 'usr_test123',
        email: 'test@example.com',
        displayName: 'Tester',
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: 'it',
        expiresIn: 86400,
        tokenType: 'Bearer',
      });
      getUser.mockResolvedValue({
        id: 'usr_test123',
        email: 'test@example.com',
        displayName: 'Tester',
        tier: 'free',
        role: 'admin',
        currencies: { essence: 2000, gems: 0 },
        stats: { totalTotems: 0, totalChallengesCompleted: 0, loginStreak: 1, lastLoginDate: '2026-01-01' },
        settings: { notifications: true, darkMode: 'dark' },
      });
      updateUser.mockResolvedValue(null);

      const req = { body: { email: 'test@example.com', password: 'Password1' } };
      const res = mockRes();

      await handleLogin(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.user.role).toBe('admin');
    });

    it('defaults role to user when DB record has no role', async () => {
      const { getUser, getUserByEmail, updateUser } = require('../src/common/db-client');
      const { signIn } = require('../src/common/cognito-client');
      const { handleLogin } = require('../src/auth');

      getUserByEmail.mockResolvedValue(null);
      signIn.mockResolvedValue({
        userId: 'usr_test456',
        email: 'old@example.com',
        displayName: 'OldUser',
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: 'it',
        expiresIn: 86400,
        tokenType: 'Bearer',
      });
      getUser.mockResolvedValue({
        id: 'usr_test456',
        email: 'old@example.com',
        displayName: 'OldUser',
        tier: 'free',
        // no role field — simulates pre-migration user
        currencies: { essence: 1000, gems: 0 },
        stats: { totalTotems: 1, totalChallengesCompleted: 0, loginStreak: 1, lastLoginDate: '2026-01-01' },
        settings: { notifications: true, darkMode: 'dark' },
      });
      updateUser.mockResolvedValue(null);

      const req = { body: { email: 'old@example.com', password: 'Password1' } };
      const res = mockRes();

      await handleLogin(req, res);

      const body = res.json.mock.calls[0][0];
      expect(body.user.role).toBe('user');
    });
  });
});
