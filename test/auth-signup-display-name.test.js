/**
 * Signup display-name validation
 *
 * handleSignup used to pass req.body.displayName straight to Cognito +
 * DynamoDB, so signups could store names a rename would reject (trailing
 * spaces, profanity, 200 chars, markup). Signup now applies the same
 * validateDisplayName rules as PUT /v1/user/displayName.
 */

process.env.IS_LOCAL = 'true';

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
  // Echo the name back the way the real signUp does, so we can assert on what
  // reached both Cognito and createUser.
  signUp: jest.fn(async ({ email, displayName }) => ({
    userId: 'usr_test123',
    email,
    displayName,
  })),
  signIn: jest.fn(),
  confirmSignUp: jest.fn(),
  resendConfirmationCode: jest.fn(),
  forgotPassword: jest.fn(),
  confirmForgotPassword: jest.fn(),
  verifyAccessToken: jest.fn(),
  refreshTokens: jest.fn(),
  revokeRefreshToken: jest.fn(),
  isLocal: true,
}));

jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'error').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();

const { createUser } = require('../src/common/db-client');
const { signUp } = require('../src/common/cognito-client');
const { handleSignup } = require('../src/auth');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

async function signup(body) {
  const res = mockRes();
  await handleSignup({ body: { email: 'new.player@example.com', password: 'Password1', ...body } }, res);
  return res;
}

describe('POST /auth/signup display name', () => {
  beforeEach(() => {
    createUser.mockClear();
    signUp.mockClear();
  });

  it('trims surrounding whitespace before storing', async () => {
    await signup({ displayName: '  Brittney ' });

    expect(signUp.mock.calls[0][0].displayName).toBe('Brittney');
    expect(createUser.mock.calls[0][0].displayName).toBe('Brittney');
  });

  it.each([
    ['too short', 'Jo', /3.20 characters/],
    ['too long', 'A'.repeat(21), /3.20 characters/],
    ['disallowed characters', '<script>x</script>', /can only contain/],
    ['consecutive spaces', 'Dave  Patten', /consecutive spaces/],
  ])('rejects %s with 400 and creates nothing', async (_label, displayName, message) => {
    const res = await signup({ displayName });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toMatch(message);
    expect(signUp).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', '   '])('falls back to a sanitized email prefix when name is %p', async (displayName) => {
    await signup({ displayName });

    // 'new.player' → '.' stripped by the sanitizer
    expect(signUp.mock.calls[0][0].displayName).toBe('newplayer');
    expect(createUser.mock.calls[0][0].displayName).toBe('newplayer');
  });

  it('accepts a valid name unchanged', async () => {
    await signup({ displayName: 'Dave Patten' });

    expect(createUser.mock.calls[0][0].displayName).toBe('Dave Patten');
  });
});
