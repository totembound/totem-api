/**
 * handleVerify — email verification endpoint.
 *
 * Regression coverage for the fix that requires `password` UP-FRONT: verify
 * both confirms the signup AND auto-signs-in, so a missing password must 400
 * BEFORE confirmSignUp (otherwise the account is left CONFIRMED but the call
 * still errors on the login half).
 */

jest.mock('../src/common/cognito-client', () => ({
  signUp: jest.fn(),
  signIn: jest.fn(),
  confirmSignUp: jest.fn(),
  resendConfirmationCode: jest.fn(),
  forgotPassword: jest.fn(),
  confirmForgotPassword: jest.fn(),
  verifyAccessToken: jest.fn(),
  refreshTokens: jest.fn(),
  revokeRefreshToken: jest.fn(),
}));

jest.mock('../src/common/db-client', () => ({
  createUser: jest.fn(),
  getUser: jest.fn(),
  getUserByEmail: jest.fn(),
  updateUser: jest.fn(),
}));

jest.mock('../src/common/email', () => ({
  sendNewUserWelcomeEmail: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/services/achievements-service', () => ({
  onLoginStreak: jest.fn(),
  onPersistenceCheck: jest.fn(),
}));

jest.mock('../src/services/loot-service', () => ({
  grantLootItem: jest.fn(),
}));

const cognito = require('../src/common/cognito-client');
const db = require('../src/common/db-client');
const auth = require('../src/auth/index');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const validBody = { email: 'user@test.local', code: '123456', password: 'Pass123!' };

describe('handleVerify — password required + confirm-before-login', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cognito.confirmSignUp.mockResolvedValue({});
    cognito.signIn.mockResolvedValue({
      userId: 'usr_1',
      email: 'user@test.local',
      displayName: 'Tester',
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      expiresIn: 3600,
      tokenType: 'Bearer',
    });
    db.getUser.mockResolvedValue(null);
  });

  it('400s and does NOT confirm when password is missing (the fix)', async () => {
    const res = mockRes();
    await auth.handleVerify({ body: { email: 'user@test.local', code: '123456' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cognito.confirmSignUp).not.toHaveBeenCalled(); // must fail BEFORE confirming
    expect(cognito.signIn).not.toHaveBeenCalled();
  });

  it('400s when code is missing (and does not confirm)', async () => {
    const res = mockRes();
    await auth.handleVerify({ body: { email: 'user@test.local', password: 'Pass123!' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cognito.confirmSignUp).not.toHaveBeenCalled();
  });

  it('400s when email is missing (and does not confirm)', async () => {
    const res = mockRes();
    await auth.handleVerify({ body: { code: '123456', password: 'Pass123!' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cognito.confirmSignUp).not.toHaveBeenCalled();
  });

  it('confirms then auto signs-in with the password and returns 200 + tokens', async () => {
    const res = mockRes();
    await auth.handleVerify({ body: validBody }, res);

    expect(cognito.confirmSignUp).toHaveBeenCalledWith({ email: 'user@test.local', code: '123456' });
    expect(cognito.signIn).toHaveBeenCalledWith({ email: 'user@test.local', password: 'Pass123!' });
    expect(res.status).toHaveBeenCalledWith(200);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.tokens.accessToken).toBe('a');
  });

  it('returns 400 if confirmSignUp rejects (e.g. bad/expired code), without signing in', async () => {
    cognito.confirmSignUp.mockRejectedValue(new Error('Invalid verification code'));
    const res = mockRes();
    await auth.handleVerify({ body: validBody }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cognito.signIn).not.toHaveBeenCalled();
  });
});
