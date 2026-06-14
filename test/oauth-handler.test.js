/**
 * OAuth Callback Handler Tests
 *
 * Covers: input validation, returning user lookup, account linking,
 * new user creation, token generation, and login guard for OAuth-only accounts.
 */

// Mocks — must be before requires
jest.mock('../src/common/oauth-providers', () => ({
  getSupportedProviders: jest.fn().mockReturnValue(['google']),
  exchangeCodeForToken: jest.fn(),
  fetchUserProfile: jest.fn(),
}));

jest.mock('../src/common/db-client', () => ({
  getUserByProviderId: jest.fn().mockResolvedValue(null),
  getUserByEmail: jest.fn().mockResolvedValue(null),
  getUser: jest.fn().mockResolvedValue(null),
  createUser: jest.fn().mockResolvedValue({}),
  updateUser: jest.fn().mockResolvedValue({}),
  logTransaction: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/common/cognito-client', () => ({
  adminGetTokensForOAuth: jest.fn(),
  createOAuthUser: jest.fn(),
  signIn: jest.fn(),
  verifyAccessToken: jest.fn(),
  refreshTokens: jest.fn(),
  revokeRefreshToken: jest.fn(),
  signUp: jest.fn(),
  confirmSignUp: jest.fn(),
  resendConfirmationCode: jest.fn(),
  forgotPassword: jest.fn(),
  confirmForgotPassword: jest.fn(),
}));

jest.mock('../src/common/email', () => ({
  sendNewUserWelcomeEmail: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/services/achievements-service', () => ({
  onLoginStreak: jest.fn().mockResolvedValue([]),
  onGameAction: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/loot-service', () => ({
  grantLootItem: jest.fn().mockResolvedValue(null),
}));

const { handleOAuthCallback } = require('../src/auth/oauth');
const { handleLogin } = require('../src/auth/index');
const { exchangeCodeForToken, fetchUserProfile } = require('../src/common/oauth-providers');
const { getUserByProviderId, getUserByEmail, getUser, createUser, updateUser, logTransaction } = require('../src/common/db-client');
const { adminGetTokensForOAuth, createOAuthUser, signIn } = require('../src/common/cognito-client');
const { grantLootItem } = require('../src/services/loot-service');

// ============================================================================
// Helpers
// ============================================================================

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockReq = (body = {}) => ({ body });

const googleProfile = {
  email: 'dave@example.com',
  displayName: 'Dave',
  providerId: 'google_12345',
  avatarUrl: 'https://lh3.google.com/photo.jpg',
};

const existingUser = {
  id: 'usr_abc123',
  email: 'dave@example.com',
  displayName: 'Dave',
  tier: 'free',
  currencies: { essence: 2000, gems: 0 },
  stats: { totalTotems: 0, totalChallengesCompleted: 0, loginStreak: 1, lastLoginDate: '2026-03-31' },
  settings: { notifications: true, darkMode: 'dark' },
  oauthProvider: 'google',
  oauthProviderId: 'google_12345',
};

const mockTokens = {
  accessToken: 'access_xxx',
  refreshToken: 'refresh_xxx',
  idToken: 'id_xxx',
  expiresIn: 86400,
  tokenType: 'Bearer',
};

// ============================================================================
// OAuth Callback Tests
// ============================================================================

describe('handleOAuthCallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    exchangeCodeForToken.mockResolvedValue({ access_token: 'goog_token' });
    fetchUserProfile.mockResolvedValue(googleProfile);
    adminGetTokensForOAuth.mockResolvedValue(mockTokens);
  });

  // --------------------------------------------------------------------------
  // Input validation
  // --------------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects unsupported provider', async () => {
      const req = mockReq({ provider: 'facebook', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();
      await handleOAuthCallback(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('unsupported provider'),
      }));
    });

    it('rejects missing provider', async () => {
      const req = mockReq({ code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();
      await handleOAuthCallback(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects missing code', async () => {
      const req = mockReq({ provider: 'google', redirectUri: 'http://localhost:3000' });
      const res = mockRes();
      await handleOAuthCallback(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Authorization code is required',
      }));
    });

    it('rejects missing redirectUri', async () => {
      const req = mockReq({ provider: 'google', code: 'xxx' });
      const res = mockRes();
      await handleOAuthCallback(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Redirect URI is required',
      }));
    });

    it('returns 400 when provider returns no email', async () => {
      fetchUserProfile.mockResolvedValue({ displayName: 'Dave', providerId: 'g_123' });
      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();
      await handleOAuthCallback(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('Email is required'),
      }));
    });
  });

  // --------------------------------------------------------------------------
  // Provider errors
  // --------------------------------------------------------------------------

  describe('provider errors', () => {
    it('returns 401 when token exchange fails', async () => {
      exchangeCodeForToken.mockRejectedValue(new Error('invalid_grant'));
      const req = mockReq({ provider: 'google', code: 'bad_code', redirectUri: 'http://localhost:3000' });
      const res = mockRes();
      await handleOAuthCallback(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('Failed to authenticate'),
      }));
    });

    it('returns 401 when profile fetch fails', async () => {
      fetchUserProfile.mockRejectedValue(new Error('invalid_token'));
      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();
      await handleOAuthCallback(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('Failed to get profile'),
      }));
    });
  });

  // --------------------------------------------------------------------------
  // Returning OAuth user
  // --------------------------------------------------------------------------

  describe('returning OAuth user', () => {
    it('finds existing user by provider+providerId and returns tokens', async () => {
      getUserByProviderId.mockResolvedValue(existingUser);
      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();

      await handleOAuthCallback(req, res);

      expect(getUserByProviderId).toHaveBeenCalledWith('google', 'google_12345');
      expect(createOAuthUser).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.isNewUser).toBe(false);
      expect(body.tokens.accessToken).toBe('access_xxx');
      expect(body.user.email).toBe('dave@example.com');
    });

    it('calls adminGetTokensForOAuth with email', async () => {
      getUserByProviderId.mockResolvedValue(existingUser);
      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();

      await handleOAuthCallback(req, res);

      expect(adminGetTokensForOAuth).toHaveBeenCalledWith(
        'dave@example.com', 'google', 'google_12345', 'usr_abc123', 'user',
      );
    });
  });

  // --------------------------------------------------------------------------
  // Account linking (existing email/password user signs in with Google)
  // --------------------------------------------------------------------------

  describe('account linking', () => {
    it('links OAuth to existing email/password account', async () => {
      getUserByProviderId.mockResolvedValue(null);
      const emailUser = { ...existingUser, oauthProvider: undefined, oauthProviderId: undefined };
      getUserByEmail.mockResolvedValue(emailUser);

      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();

      await handleOAuthCallback(req, res);

      expect(updateUser).toHaveBeenCalledWith('usr_abc123', {
        oauthProvider: 'google',
        oauthProviderId: 'google_12345',
        avatarUrl: 'https://lh3.google.com/photo.jpg',
      });
      expect(createOAuthUser).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0].isNewUser).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // New user creation
  // --------------------------------------------------------------------------

  describe('new user creation', () => {
    beforeEach(() => {
      getUserByProviderId.mockResolvedValue(null);
      getUserByEmail.mockResolvedValue(null);
      createOAuthUser.mockResolvedValue({ userId: 'usr_new456', email: 'dave@example.com', displayName: 'Dave' });
      getUser.mockResolvedValue({ ...existingUser, id: 'usr_new456' });
      createUser.mockResolvedValue({});
      logTransaction.mockResolvedValue({});
      grantLootItem.mockResolvedValue({
        id: 'loot_1', boxId: 'uncommon_totem_box',
        box: { name: 'Uncommon Box', description: 'A box', rarity: 'uncommon', icon: 'box.png' },
      });
    });

    it('creates Cognito user and DynamoDB record', async () => {
      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();

      await handleOAuthCallback(req, res);

      expect(createOAuthUser).toHaveBeenCalledWith({
        email: 'dave@example.com',
        displayName: 'Dave',
        provider: 'google',
        providerId: 'google_12345',
      });
      expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
        id: 'usr_new456',
        email: 'dave@example.com',
        signupMethod: 'oauth',
        oauthProvider: 'google',
        currencies: { essence: 2000, gems: 0 },
      }));
    });

    it('sets isNewUser true and includes lootItem', async () => {
      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();

      await handleOAuthCallback(req, res);

      const body = res.json.mock.calls[0][0];
      expect(body.isNewUser).toBe(true);
      expect(body.lootItem).toBeDefined();
      expect(body.lootItem.boxId).toBe('uncommon_totem_box');
    });

    it('grants starter loot box and logs signup transaction', async () => {
      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();

      await handleOAuthCallback(req, res);

      expect(grantLootItem).toHaveBeenCalledWith('usr_new456', 'uncommon_totem_box', 'signup');
      expect(logTransaction).toHaveBeenCalledWith('usr_new456', expect.objectContaining({
        type: 'reward_signup',
        currency: 'essence',
        amount: 2000,
      }));
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 on unexpected error', async () => {
      getUserByProviderId.mockRejectedValue(new Error('DynamoDB timeout'));
      const req = mockReq({ provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000' });
      const res = mockRes();

      await handleOAuthCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'OAuth authentication failed. Please try again.',
      }));
    });
  });
});

// ============================================================================
// Login Guard Tests (password login blocked for OAuth-only accounts)
// ============================================================================

describe('handleLogin — OAuth guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks password login for OAuth-only accounts', async () => {
    getUserByEmail.mockResolvedValue({
      id: 'usr_oauth1',
      email: 'oauth@example.com',
      oauthProvider: 'google',
      signupMethod: 'oauth',
    });
    const req = mockReq({ email: 'oauth@example.com', password: 'anything' });
    const res = mockRes();

    await handleLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('google'),
    }));
    expect(signIn).not.toHaveBeenCalled();
  });

  it('allows password login for email/password user who linked OAuth', async () => {
    getUserByEmail.mockResolvedValue({
      id: 'usr_linked1',
      email: 'linked@example.com',
      oauthProvider: 'google',
      signupMethod: 'email',
    });
    signIn.mockResolvedValue({
      userId: 'usr_linked1',
      email: 'linked@example.com',
      displayName: 'Linked User',
      accessToken: 'at', refreshToken: 'rt', idToken: 'it',
      expiresIn: 86400, tokenType: 'Bearer',
    });
    getUser.mockResolvedValue({
      id: 'usr_linked1',
      email: 'linked@example.com',
      displayName: 'Linked User',
      tier: 'free',
      currencies: { essence: 2000, gems: 0 },
      stats: { loginStreak: 1, lastLoginDate: '2026-03-30' },
      settings: {},
    });
    const req = mockReq({ email: 'linked@example.com', password: 'realpassword' });
    const res = mockRes();

    await handleLogin(req, res);

    expect(signIn).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows password login when no OAuth provider set', async () => {
    getUserByEmail.mockResolvedValue({
      id: 'usr_email1',
      email: 'normal@example.com',
      signupMethod: 'email',
    });
    signIn.mockResolvedValue({
      userId: 'usr_email1',
      email: 'normal@example.com',
      displayName: 'Normal User',
      accessToken: 'at', refreshToken: 'rt', idToken: 'it',
      expiresIn: 86400, tokenType: 'Bearer',
    });
    getUser.mockResolvedValue({
      id: 'usr_email1',
      email: 'normal@example.com',
      displayName: 'Normal User',
      tier: 'free',
      currencies: { essence: 2000, gems: 0 },
      stats: { loginStreak: 1, lastLoginDate: '2026-03-30' },
      settings: {},
    });
    const req = mockReq({ email: 'normal@example.com', password: 'mypassword' });
    const res = mockRes();

    await handleLogin(req, res);

    expect(signIn).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows login when user does not exist in DB yet (new Cognito user)', async () => {
    getUserByEmail.mockResolvedValue(null);
    signIn.mockResolvedValue({
      userId: 'usr_brand_new',
      email: 'new@example.com',
      displayName: 'New User',
      accessToken: 'at', refreshToken: 'rt', idToken: 'it',
      expiresIn: 86400, tokenType: 'Bearer',
    });
    getUser.mockResolvedValue(null);
    createUser.mockResolvedValue({});

    const req = mockReq({ email: 'new@example.com', password: 'password123' });
    const res = mockRes();

    await handleLogin(req, res);

    expect(signIn).toHaveBeenCalled();
  });
});

// ============================================================================
// Login Streak Tests (lastLoginDate is a full ISO timestamp; day comparison
// must slice the date portion before comparing calendar days)
// ============================================================================

describe('handleLogin — login streak', () => {
  const isoDaysAgo = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString();
  };

  const loginAs = async (stats) => {
    getUserByEmail.mockResolvedValue(null);
    signIn.mockResolvedValue({
      userId: 'usr_streak1',
      email: 'streak@example.com',
      displayName: 'Streak User',
      accessToken: 'at', refreshToken: 'rt', idToken: 'it',
      expiresIn: 86400, tokenType: 'Bearer',
    });
    getUser.mockResolvedValue({
      id: 'usr_streak1',
      email: 'streak@example.com',
      displayName: 'Streak User',
      tier: 'free',
      currencies: { essence: 2000, gems: 0 },
      stats,
      settings: {},
    });
    updateUser.mockResolvedValue(null);
    const res = mockRes();
    await handleLogin(mockReq({ email: 'streak@example.com', password: 'pw' }), res);
    return res;
  };

  beforeEach(() => jest.clearAllMocks());

  it('extends the streak when the last login was yesterday', async () => {
    await loginAs({ loginStreak: 4, lastLoginDate: isoDaysAgo(1) });
    expect(updateUser).toHaveBeenCalledWith('usr_streak1', expect.objectContaining({
      'stats.loginStreak': 5,
    }));
  });

  it('keeps the streak when already logged in today', async () => {
    await loginAs({ loginStreak: 4, lastLoginDate: isoDaysAgo(0) });
    expect(updateUser).toHaveBeenCalledWith('usr_streak1', expect.objectContaining({
      'stats.loginStreak': 4,
    }));
  });

  it('resets the streak to 1 after a gap of several days', async () => {
    await loginAs({ loginStreak: 9, lastLoginDate: isoDaysAgo(3) });
    expect(updateUser).toHaveBeenCalledWith('usr_streak1', expect.objectContaining({
      'stats.loginStreak': 1,
    }));
  });

  it('writes lastLoginDate back as a full ISO timestamp, not a bare date', async () => {
    await loginAs({ loginStreak: 1, lastLoginDate: isoDaysAgo(1) });
    const written = updateUser.mock.calls[0][1]['stats.lastLoginDate'];
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
