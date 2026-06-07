/**
 * handleResetPassword — password-changed security confirmation email (Slice 2).
 *
 * Verifies that completing a password reset sends the "your password was changed"
 * email, that an email failure never fails the reset, and that the email is NOT sent
 * when the reset itself fails.
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
  sendPasswordChangedEmail: jest.fn().mockResolvedValue({}),
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
const email = require('../src/common/email');
const auth = require('../src/auth/index');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const validBody = { email: 'user@test.local', code: '123456', newPassword: 'NewPass123!' };

describe('handleResetPassword — password-changed email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cognito.confirmForgotPassword.mockResolvedValue({ message: 'Password reset successful' });
    db.getUserByEmail.mockResolvedValue({ email: 'user@test.local', displayName: 'Tester' });
    email.sendPasswordChangedEmail.mockResolvedValue({});
  });

  it('sends a password-changed confirmation after a successful reset', async () => {
    const res = mockRes();
    await auth.handleResetPassword({ body: validBody }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(email.sendPasswordChangedEmail).toHaveBeenCalledWith('user@test.local', 'Tester', expect.any(Date));
  });

  it('still returns 200 if the confirmation email throws (non-blocking)', async () => {
    email.sendPasswordChangedEmail.mockRejectedValue(new Error('SMTP down'));
    const res = mockRes();
    await auth.handleResetPassword({ body: validBody }, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('tolerates a missing user record (no displayName) without failing the reset', async () => {
    db.getUserByEmail.mockResolvedValue(null);
    const res = mockRes();
    await auth.handleResetPassword({ body: validBody }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(email.sendPasswordChangedEmail).toHaveBeenCalledWith('user@test.local', undefined, expect.any(Date));
  });

  it('does NOT send the email when the reset itself fails', async () => {
    cognito.confirmForgotPassword.mockRejectedValue(new Error('Invalid code'));
    const res = mockRes();
    await auth.handleResetPassword({ body: validBody }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(email.sendPasswordChangedEmail).not.toHaveBeenCalled();
  });

  it('rejects when required fields are missing (and sends no email)', async () => {
    const res = mockRes();
    await auth.handleResetPassword({ body: { email: 'user@test.local' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cognito.confirmForgotPassword).not.toHaveBeenCalled();
    expect(email.sendPasswordChangedEmail).not.toHaveBeenCalled();
  });
});
