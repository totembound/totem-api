/**
 * Cognito Client
 *
 * Dual-mode authentication:
 * - Local (IS_LOCAL=true): In-memory simulation with JWT tokens for development
 * - AWS (Lambda): AWS Cognito SDK for real user pool operations
 *
 * Both modes export identical function signatures so callers (auth/index.js,
 * app.js) work the same in both environments.
 */

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { generateId } = require('./id-utils');

// ============================================
// Configuration
// ============================================

const isLocal = process.env.IS_LOCAL === 'true' || process.env.NODE_ENV === 'development';
const _USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'local_user_pool';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || 'local_client_id';
const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-key-change-in-prod';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';

// ============================================
// AWS Cognito SDK (lazy-loaded, only on Lambda)
// ============================================

let cognitoClient;
function getCognitoClient() {
  if (!cognitoClient) {
    const { CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');
    cognitoClient = new CognitoIdentityProviderClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return cognitoClient;
}

// ============================================
// Local Development - In-Memory Simulation
// ============================================

const localTokenStore = new Map();
const localUserStore = new Map();

function hashPassword(password) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(password + JWT_SECRET).digest('hex');
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

// Pre-populate test users
const testUsers = [
  {
    id: 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    email: 'testplayer1@example.com',
    passwordHash: hashPassword('TestPassword123!'),
    displayName: 'TestPlayer1',
    emailVerified: true,
  },
  {
    id: 'usr_b2c3d4e5-f6a7-8901-bcde-f12345678901',
    email: 'premiumplayer@example.com',
    passwordHash: hashPassword('PremiumPass456!'),
    displayName: 'PremiumPlayer',
    emailVerified: true,
  },
  {
    id: 'usr_c3d4e5f6-a7b8-9012-cdef-123456789012',
    email: 'vipplayer@example.com',
    passwordHash: hashPassword('VIPSecure789!'),
    displayName: 'VIPPlayer',
    emailVerified: true,
  },
  {
    id: 'usr_d4e5f6a7-b8c9-0123-defa-234567890123',
    email: 'admin@example.com',
    passwordHash: hashPassword('AdminPass123!'),
    displayName: 'AdminUser',
    emailVerified: true,
  },
];

testUsers.forEach((user) => {
  localUserStore.set(user.email.toLowerCase(), user);
});

// --- Local Token Operations ---

function localGenerateTokens(userId, email, role) {
  const accessToken = jwt.sign(
    { sub: userId, email, role: role || 'user', token_use: 'access', iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  const refreshToken = jwt.sign(
    { sub: userId, email, token_use: 'refresh', jti: uuidv4(), iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );

  const idToken = jwt.sign(
    { sub: userId, email, email_verified: true, role: role || 'user', token_use: 'id', iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  localTokenStore.set(refreshToken, { userId, email, createdAt: Date.now() });

  return { accessToken, refreshToken, idToken, expiresIn: 86400, tokenType: 'Bearer' };
}

function localVerifyAccessToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.token_use !== 'access') {
      throw new Error('Invalid token type');
    }
    return { valid: true, userId: decoded.sub, email: decoded.email };
  }
  catch (error) {
    return { valid: false, error: error.message };
  }
}

function localRefreshTokens(refreshToken) {
  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    if (decoded.token_use !== 'refresh') {
      throw new Error('Invalid token type');
    }

    const stored = localTokenStore.get(refreshToken);
    if (!stored) {
      throw new Error('Refresh token has been revoked');
    }

    const newTokens = localGenerateTokens(decoded.sub, decoded.email);
    localTokenStore.delete(refreshToken);

    return { success: true, ...newTokens };
  }
  catch (error) {
    return { success: false, error: error.message };
  }
}

function localRevokeRefreshToken(refreshToken) {
  localTokenStore.delete(refreshToken);
  return { success: true };
}

// --- Local Auth Operations ---

async function localSignUp({ email, password, displayName }) {
  const normalizedEmail = email.toLowerCase();

  if (localUserStore.has(normalizedEmail)) {
    throw new Error('User already exists with this email');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const userId = generateId('user');
  const user = {
    id: userId,
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    displayName: displayName || email.split('@')[0],
    emailVerified: false, // Requires verification
    verificationCode: '123456', // Fixed code for local dev
    createdAt: new Date().toISOString(),
  };

  localUserStore.set(normalizedEmail, user);

  // Send verification code email via MailHog
  try {
    const { sendVerificationEmail } = require('./email');
    await sendVerificationEmail(normalizedEmail, user.displayName, user.verificationCode);
  }
  catch (err) {
    console.warn('[Cognito-Local] Failed to send verification email:', err.message);
  }

  return {
    success: true,
    userId,
    email: normalizedEmail,
    displayName: user.displayName,
    emailVerified: false,
    needsVerification: true,
  };
}

async function localConfirmSignUp({ email, code }) {
  const normalizedEmail = email.toLowerCase();
  const user = localUserStore.get(normalizedEmail);

  if (!user) {
    throw new Error('User not found');
  }

  if (user.emailVerified) {
    return { success: true, message: 'Email already verified' };
  }

  if (code !== user.verificationCode) {
    throw new Error('Invalid verification code');
  }

  user.emailVerified = true;
  delete user.verificationCode;

  return { success: true, message: 'Email verified successfully' };
}

async function localResendConfirmationCode({ email }) {
  const normalizedEmail = email.toLowerCase();
  const user = localUserStore.get(normalizedEmail);

  if (!user) {
    throw new Error('User not found');
  }

  if (user.emailVerified) {
    throw new Error('Email already verified');
  }

  // Reset code (always 123456 for local dev)
  user.verificationCode = '123456';

  // Resend verification code email via MailHog
  try {
    const { sendVerificationEmail } = require('./email');
    await sendVerificationEmail(user.email, user.displayName, user.verificationCode);
  }
  catch (err) {
    console.warn('[Cognito-Local] Failed to resend verification email:', err.message);
  }

  return { success: true, message: 'Verification code sent' };
}

async function localForgotPassword({ email }) {
  const normalizedEmail = email.toLowerCase();
  const user = localUserStore.get(normalizedEmail);

  if (!user) {
    // Don't reveal whether user exists — always return success
    return { success: true, message: 'If an account exists, a reset code has been sent' };
  }

  // Set a fixed reset code for local dev
  user.resetCode = '123456';
  user.resetCodeExpiry = Date.now() + 60 * 60 * 1000; // 1 hour

  // Send reset code email via MailHog
  try {
    const { sendPasswordResetEmail } = require('./email');
    await sendPasswordResetEmail(normalizedEmail, user.displayName, user.resetCode);
  }
  catch (err) {
    console.warn('[Cognito-Local] Failed to send password reset email:', err.message);
  }

  return { success: true, message: 'If an account exists, a reset code has been sent' };
}

async function localConfirmForgotPassword({ email, code, newPassword }) {
  const normalizedEmail = email.toLowerCase();
  const user = localUserStore.get(normalizedEmail);

  if (!user) {
    throw new Error('Invalid reset code');
  }

  if (!user.resetCode || code !== user.resetCode) {
    throw new Error('Invalid reset code');
  }

  if (user.resetCodeExpiry && Date.now() > user.resetCodeExpiry) {
    delete user.resetCode;
    delete user.resetCodeExpiry;
    throw new Error('Reset code has expired. Please request a new one.');
  }

  if (newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  user.passwordHash = hashPassword(newPassword);
  delete user.resetCode;
  delete user.resetCodeExpiry;

  return { success: true, message: 'Password reset successfully' };
}

async function localSignIn({ email, password }) {
  const normalizedEmail = email.toLowerCase();
  const user = localUserStore.get(normalizedEmail);

  if (!user) {
    throw new Error('User not found');
  }
  if (!verifyPassword(password, user.passwordHash)) {
    throw new Error('Incorrect password');
  }
  if (!user.emailVerified) {
    throw new Error('Email not verified');
  }

  const tokens = localGenerateTokens(user.id, user.email);

  return {
    success: true,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    ...tokens,
  };
}

function localGetUserById(userId) {
  for (const user of localUserStore.values()) {
    if (user.id === userId) {
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerified,
      };
    }
  }
  return null;
}

// ============================================
// AWS Cognito SDK Implementation
// ============================================

async function awsSignUp({ email, password, displayName }) {
  const {
    SignUpCommand,
  } = require('@aws-sdk/client-cognito-identity-provider');

  const normalizedEmail = email.toLowerCase();
  const name = displayName || email.split('@')[0];

  try {
    // Create user in Cognito User Pool (sends verification email automatically)
    const signUpResult = await getCognitoClient().send(new SignUpCommand({
      ClientId: CLIENT_ID,
      Username: normalizedEmail,
      Password: password,
      UserAttributes: [
        { Name: 'email', Value: normalizedEmail },
        { Name: 'custom:displayName', Value: name },
      ],
    }));

    return {
      success: true,
      userId: signUpResult.UserSub,
      email: normalizedEmail,
      displayName: name,
      emailVerified: false,
      needsVerification: true,
    };
  }
  catch (error) {
    // Translate Cognito SDK errors to user-friendly messages
    if (error.name === 'UsernameExistsException') {
      throw new Error('User already exists with this email');
    }
    if (error.name === 'InvalidPasswordException') {
      throw new Error('Password does not meet requirements: at least 8 characters with a lowercase letter and a number');
    }
    if (error.name === 'InvalidParameterException') {
      throw new Error('Invalid email format');
    }
    throw error;
  }
}

async function awsConfirmSignUp({ email, code }) {
  const { ConfirmSignUpCommand } = require('@aws-sdk/client-cognito-identity-provider');

  const normalizedEmail = email.toLowerCase();

  try {
    await getCognitoClient().send(new ConfirmSignUpCommand({
      ClientId: CLIENT_ID,
      Username: normalizedEmail,
      ConfirmationCode: code,
    }));
    return { success: true, message: 'Email verified successfully' };
  }
  catch (error) {
    if (error.name === 'CodeMismatchException') {
      throw new Error('Invalid verification code');
    }
    if (error.name === 'ExpiredCodeException') {
      throw new Error('Verification code has expired. Please request a new one.');
    }
    if (error.name === 'NotAuthorizedException') {
      throw new Error('User is already verified');
    }
    throw error;
  }
}

async function awsResendConfirmationCode({ email }) {
  const { ResendConfirmationCodeCommand } = require('@aws-sdk/client-cognito-identity-provider');

  const normalizedEmail = email.toLowerCase();

  try {
    await getCognitoClient().send(new ResendConfirmationCodeCommand({
      ClientId: CLIENT_ID,
      Username: normalizedEmail,
    }));
    return { success: true, message: 'Verification code sent' };
  }
  catch (error) {
    if (error.name === 'LimitExceededException') {
      throw new Error('Too many attempts. Please try again later.');
    }
    throw error;
  }
}

async function awsSignIn({ email, password }) {
  const { InitiateAuthCommand } = require('@aws-sdk/client-cognito-identity-provider');

  const normalizedEmail = email.toLowerCase();

  try {
    const result = await getCognitoClient().send(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        USERNAME: normalizedEmail,
        PASSWORD: password,
      },
    }));

    const auth = result.AuthenticationResult;
    // Decode ID token to get user claims (sub, email, custom attributes)
    const decoded = jwt.decode(auth.IdToken);

    return {
      success: true,
      userId: decoded.sub,
      email: decoded.email || normalizedEmail,
      displayName: decoded['custom:displayName'] || normalizedEmail.split('@')[0],
      accessToken: auth.AccessToken,
      refreshToken: auth.RefreshToken,
      idToken: auth.IdToken,
      expiresIn: auth.ExpiresIn,
      tokenType: 'Bearer',
    };
  }
  catch (error) {
    if (error.name === 'NotAuthorizedException') {
      throw new Error('Incorrect email or password');
    }
    if (error.name === 'UserNotConfirmedException') {
      throw new Error('Email not verified');
    }
    if (error.name === 'UserNotFoundException') {
      throw new Error('Incorrect email or password');
    }
    throw error;
  }
}

async function awsRefreshTokens(refreshToken) {
  const { InitiateAuthCommand } = require('@aws-sdk/client-cognito-identity-provider');

  try {
    const result = await getCognitoClient().send(new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    }));

    const auth = result.AuthenticationResult;

    return {
      success: true,
      accessToken: auth.AccessToken,
      refreshToken: refreshToken, // Cognito doesn't rotate refresh tokens
      idToken: auth.IdToken,
      expiresIn: auth.ExpiresIn,
      tokenType: 'Bearer',
    };
  }
  catch (error) {
    return { success: false, error: error.message };
  }
}

async function awsRevokeRefreshToken(refreshToken) {
  const { RevokeTokenCommand } = require('@aws-sdk/client-cognito-identity-provider');

  try {
    await getCognitoClient().send(new RevokeTokenCommand({
      Token: refreshToken,
      ClientId: CLIENT_ID,
    }));
  }
  catch (error) {
    // Don't fail logout even if revocation fails
    console.error('Failed to revoke token:', error.message);
  }
  return { success: true };
}

function awsVerifyAccessToken(token) {
  // On Lambda, API Gateway Cognito Authorizer already validated the token.
  // This just decodes for extracting claims (backwards compatibility).
  try {
    const decoded = jwt.decode(token);
    if (!decoded) {
      throw new Error('Invalid token');
    }
    return {
      valid: true,
      userId: decoded.sub,
      email: decoded.email || decoded.username || '',
    };
  }
  catch (error) {
    return { valid: false, error: error.message };
  }
}

async function awsForgotPassword({ email }) {
  const { ForgotPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');

  const normalizedEmail = email.toLowerCase();

  try {
    await getCognitoClient().send(new ForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: normalizedEmail,
    }));
  }
  catch (error) {
    // Don't reveal whether user exists — swallow UserNotFoundException
    if (error.name === 'UserNotFoundException') {
      console.log('[Cognito] ForgotPassword for non-existent user:', normalizedEmail);
    }
    else if (error.name === 'LimitExceededException') {
      throw new Error('Too many attempts. Please try again later.');
    }
    else {
      throw error;
    }
  }

  return { success: true, message: 'If an account exists, a reset code has been sent' };
}

async function awsConfirmForgotPassword({ email, code, newPassword }) {
  const { ConfirmForgotPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');

  const normalizedEmail = email.toLowerCase();

  try {
    await getCognitoClient().send(new ConfirmForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: normalizedEmail,
      ConfirmationCode: code,
      Password: newPassword,
    }));
    return { success: true, message: 'Password reset successfully' };
  }
  catch (error) {
    if (error.name === 'CodeMismatchException') {
      throw new Error('Invalid reset code');
    }
    if (error.name === 'ExpiredCodeException') {
      throw new Error('Reset code has expired. Please request a new one.');
    }
    if (error.name === 'InvalidPasswordException') {
      throw new Error('Password does not meet requirements: at least 8 characters with a lowercase letter and a number');
    }
    if (error.name === 'LimitExceededException') {
      throw new Error('Too many attempts. Please try again later.');
    }
    throw error;
  }
}

function awsGetUserById() {
  // On AWS, user data comes from DynamoDB (db-client.getUser), not Cognito
  return null;
}

// ============================================
// OAuth User Creation (passwordless)
// ============================================

async function localCreateOAuthUser({ email, displayName, provider, providerId }) {
  const normalizedEmail = email.toLowerCase();

  // Check if user already exists by email
  const existing = localUserStore.get(normalizedEmail);
  if (existing) {
    return {
      userId: existing.id,
      email: existing.email,
      displayName: existing.displayName,
    };
  }

  const userId = generateId('user');
  const user = {
    id: userId,
    email: normalizedEmail,
    passwordHash: hashPassword(uuidv4()), // Random password — user never needs it
    displayName: displayName || email.split('@')[0],
    emailVerified: true, // OAuth emails are pre-verified
    oauthProvider: provider,
    oauthProviderId: providerId,
    createdAt: new Date().toISOString(),
  };

  localUserStore.set(normalizedEmail, user);

  return {
    userId,
    email: normalizedEmail,
    displayName: user.displayName,
  };
}

async function awsCreateOAuthUser({ email, displayName, _provider, _providerId }) {
  const {
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
  } = require('@aws-sdk/client-cognito-identity-provider');

  const normalizedEmail = email.toLowerCase();
  const name = displayName || email.split('@')[0];
  const tempPassword = `Temp${uuidv4().replace(/-/g, '').slice(0, 16)}!1`;

  // Create user with suppressed welcome message
  const createResult = await getCognitoClient().send(new AdminCreateUserCommand({
    UserPoolId: _USER_POOL_ID,
    Username: normalizedEmail,
    UserAttributes: [
      { Name: 'email', Value: normalizedEmail },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'custom:displayName', Value: name },
    ],
    MessageAction: 'SUPPRESS',
    TemporaryPassword: tempPassword,
  }));

  const userId = createResult.User?.Attributes?.find(a => a.Name === 'sub')?.Value || createResult.User?.Username;

  // Set permanent password (so user isn't in FORCE_CHANGE_PASSWORD state)
  await getCognitoClient().send(new AdminSetUserPasswordCommand({
    UserPoolId: _USER_POOL_ID,
    Username: normalizedEmail,
    Password: tempPassword,
    Permanent: true,
  }));

  return {
    userId,
    email: normalizedEmail,
    displayName: name,
  };
}

function awsGenerateTokens() {
  throw new Error('generateTokens not available in AWS mode - use adminGetTokensForOAuth()');
}

/**
 * Get Cognito tokens for an OAuth user using admin auth flow.
 * Generates a cryptographically random password each time (never stored,
 * never deterministic) — set it, sign in, done. The password is ephemeral
 * and cannot be reconstructed from source code or env vars.
 */
async function awsAdminGetTokensForOAuth(email) {
  const crypto = require('crypto');
  const {
    AdminSetUserPasswordCommand,
    AdminInitiateAuthCommand,
  } = require('@aws-sdk/client-cognito-identity-provider');

  const normalizedEmail = email.toLowerCase();

  // Random password — used once, never stored, not computable
  const password = `Oa!${crypto.randomBytes(24).toString('base64url')}`;

  // Set the ephemeral password
  await getCognitoClient().send(new AdminSetUserPasswordCommand({
    UserPoolId: _USER_POOL_ID,
    Username: normalizedEmail,
    Password: password,
    Permanent: true,
  }));

  // Sign in immediately to get real Cognito tokens
  const result = await getCognitoClient().send(new AdminInitiateAuthCommand({
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    UserPoolId: _USER_POOL_ID,
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: normalizedEmail,
      PASSWORD: password,
    },
  }));

  const auth = result.AuthenticationResult;
  const decoded = jwt.decode(auth.IdToken);

  return {
    userId: decoded.sub,
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken,
    idToken: auth.IdToken,
    expiresIn: auth.ExpiresIn,
    tokenType: 'Bearer',
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Token operations
  generateTokens: isLocal ? localGenerateTokens : awsGenerateTokens,
  verifyAccessToken: isLocal ? localVerifyAccessToken : awsVerifyAccessToken,
  refreshTokens: isLocal ? localRefreshTokens : awsRefreshTokens,
  revokeRefreshToken: isLocal ? localRevokeRefreshToken : awsRevokeRefreshToken,

  // Auth operations
  signUp: isLocal ? localSignUp : awsSignUp,
  signIn: isLocal ? localSignIn : awsSignIn,
  confirmSignUp: isLocal ? localConfirmSignUp : awsConfirmSignUp,
  resendConfirmationCode: isLocal ? localResendConfirmationCode : awsResendConfirmationCode,
  forgotPassword: isLocal ? localForgotPassword : awsForgotPassword,
  confirmForgotPassword: isLocal ? localConfirmForgotPassword : awsConfirmForgotPassword,
  getUserById: isLocal ? localGetUserById : awsGetUserById,

  // OAuth user creation (passwordless)
  createOAuthUser: isLocal ? localCreateOAuthUser : awsCreateOAuthUser,

  // OAuth token generation (admin auth flow — no user password needed)
  adminGetTokensForOAuth: isLocal
    ? (email, _provider, _providerId, userId, role) => Promise.resolve(localGenerateTokens(userId, email, role))
    : (email) => awsAdminGetTokensForOAuth(email),

  // Re-generate tokens with role claim (local dev only)
  generateTokensWithRole: isLocal ? localGenerateTokens : null,

  // Password utilities (local only)
  hashPassword,
  verifyPassword,

  // Config
  isLocal,
  JWT_SECRET,
};
