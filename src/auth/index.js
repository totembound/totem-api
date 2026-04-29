/**
 * Auth API Handlers
 *
 * Handles user authentication:
 * - POST /auth/signup - Create new account
 * - POST /auth/login - Sign in
 * - POST /auth/logout - Sign out (revoke refresh token)
 * - POST /auth/refresh - Refresh access token
 * - GET /auth/me - Get current user
 */

const {
  signUp,
  signIn,
  confirmSignUp,
  resendConfirmationCode,
  forgotPassword,
  confirmForgotPassword,
  verifyAccessToken,
  refreshTokens,
  revokeRefreshToken,
} = require('../common/cognito-client');

const {
  createUser,
  getUser,
  getUserByEmail,
  updateUser,
} = require('../common/db-client');

const { sendNewUserWelcomeEmail } = require('../common/email');
const { onLoginStreak, onPersistenceCheck } = require('../services/achievements-service');
const { grantLootItem } = require('../services/loot-service');

// ============================================
// Validation Helpers
// ============================================

function validateEmail(email) {
  // RFC 5321 caps addresses at 254 chars; enforcing before regex prevents polynomial backtracking.
  if (typeof email !== 'string' || email.length > 254) {
    return false;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePassword(password) {
  // At least 8 characters, 1 uppercase, 1 lowercase, 1 number
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one lowercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' };
  }
  return { valid: true };
}

// ============================================
// Handlers
// ============================================

/**
 * POST /auth/signup
 *
 * Create a new user account with email and password.
 * Also creates initial DynamoDB records and starter totem.
 */
async function handleSignup(req, res) {
  try {
    const { email, password, displayName } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format',
      });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        error: passwordValidation.error,
      });
    }

    // Create Cognito user
    const cognitoResult = await signUp({ email, password, displayName });

    // Create DynamoDB user record
    const userData = {
      id: cognitoResult.userId,
      email: cognitoResult.email,
      displayName: cognitoResult.displayName,
      tier: 'free',
      currencies: { essence: 2000, gems: 0 }, // Starter currency (same as old TOTEM amount)
      stats: {
        totalTotems: 0, // No totem yet - user opens loot box to choose species
        totalChallengesCompleted: 0,
        loginStreak: 0, // Starts at 0, increments when daily reward is claimed
        lastLoginDate: new Date().toISOString().split('T')[0],
      },
      settings: { notifications: true, darkMode: 'dark' },
      role: 'user',
    };

    await createUser(userData);

    // Grant an Uncommon Totem Box (user opens it to choose species)
    const lootItem = await grantLootItem(cognitoResult.userId, 'uncommon_totem_box', 'signup');

    // Log initial Essence bonus as transaction
    const { logTransaction } = require('../common/db-client');
    await logTransaction(cognitoResult.userId, {
      type: 'reward_signup',
      currency: 'essence',
      amount: 2000,
      balanceBefore: 0,
      balanceAfter: 2000,
      refType: 'reward',
      refName: 'Welcome Bonus',
    });

    // Send welcome email (await to ensure Lambda doesn't freeze before send completes)
    try {
      await sendNewUserWelcomeEmail(email, cognitoResult.displayName, null);
    }
    catch (err) {
      console.error('Failed to send welcome email:', err);
    }

    // NOTE: Do NOT fire onUserSignup with totemCount=1 here — user has no totem yet.
    // The collector achievement fires when user opens their loot box (onTotemAcquired).

    // Return success with verification required (no auto-login)
    return res.status(201).json({
      success: true,
      message: 'Account created. Please verify your email to continue.',
      needsVerification: true,
      user: {
        id: cognitoResult.userId,
        email: cognitoResult.email,
        displayName: cognitoResult.displayName,
      },
      lootItem: {
        id: lootItem.id,
        boxId: lootItem.boxId,
        boxName: lootItem.box.name,
        boxDescription: lootItem.box.description,
        boxRarity: lootItem.box.rarity,
        boxIcon: lootItem.box.icon,
      },
    });
  }
  catch (error) {
    console.error('Signup error:', error);
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * POST /auth/login
 *
 * Sign in with email and password.
 * Returns access token, refresh token, and user info.
 */
async function handleLogin(req, res) {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    // Block password login for OAuth-only accounts (no email/password signup)
    const existingUser = await getUserByEmail(email);
    if (existingUser && existingUser.oauthProvider && existingUser.signupMethod === 'oauth') {
      return res.status(400).json({
        success: false,
        error: `This account uses ${existingUser.oauthProvider} sign-in. Please use the "${existingUser.oauthProvider}" button to log in.`,
      });
    }

    // Authenticate with Cognito
    const result = await signIn({ email, password });

    // Get full user profile from DynamoDB (including currencies)
    let userProfile = null;
    try {
      const today = new Date().toISOString().split('T')[0];
      userProfile = await getUser(result.userId);

      // If user doesn't exist in DynamoDB (e.g., test user), create them
      if (!userProfile) {
        console.log(`[Login] Creating DynamoDB user record for ${result.userId}`);
        userProfile = await createUser({
          id: result.userId,
          email: result.email,
          displayName: result.displayName,
          tier: 'free',
          role: 'user',
          currencies: { essence: 5000, gems: 500 },
          stats: {
            totalTotems: 0,
            totalChallengesCompleted: 0,
            loginStreak: 1,
            lastLoginDate: today,
          },
          settings: { notifications: true, darkMode: 'system' },
        });
      }

      // Block banned users
      if (userProfile && userProfile.status === 'banned') {
        return res.status(403).json({
          success: false,
          error: 'ACCOUNT_BANNED',
          message: 'Your account has been suspended. Contact support for assistance.',
        });
      }

      if (userProfile) {
        // Calculate login streak
        const lastLogin = userProfile.stats?.lastLoginDate;
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        let newStreak = 1;
        if (lastLogin === yesterdayStr) {
          newStreak = (userProfile.stats?.loginStreak || 0) + 1;
        }
        else if (lastLogin === today) {
          newStreak = userProfile.stats?.loginStreak || 1;
        }

        // Update login stats
        const updatedProfile = await updateUser(result.userId, {
          'stats.lastLoginDate': today,
          'stats.loginStreak': newStreak,
        });

        // Use updated stats if available
        if (updatedProfile) {
          userProfile = updatedProfile;
        }
        else {
          userProfile.stats.lastLoginDate = today;
          userProfile.stats.loginStreak = newStreak;
        }

        // Process login streak + persistence achievements in background.
        // Both are cheap: LOGIN_STREAK is one trigger; PERSISTENCE_CHECK reads
        // the user record we already loaded, so zero extra DB reads.
        onLoginStreak(result.userId, newStreak)
          .catch(err => console.error('Background login streak achievement error:', err));
        onPersistenceCheck(result.userId, userProfile?.createdAt)
          .catch(err => console.error('Background persistence achievement error:', err));
      }
    }
    catch (dbError) {
      console.warn('Failed to get/update user profile:', dbError.message);
    }

    // Generate tokens with role included (local mode only — Cognito uses custom:role attribute)
    const userRole = userProfile?.role || 'user';
    let tokens = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      idToken: result.idToken,
      expiresIn: result.expiresIn,
      tokenType: result.tokenType,
    };

    // In local mode, re-generate tokens with role claim
    if (process.env.IS_LOCAL === 'true') {
      const { generateTokensWithRole } = require('../common/cognito-client');
      if (generateTokensWithRole) {
        tokens = { ...tokens, ...generateTokensWithRole(result.userId, result.email, userRole) };
      }
    }

    // Return full user profile with currencies
    return res.status(200).json({
      success: true,
      user: {
        id: result.userId,
        email: result.email,
        displayName: result.displayName,
        tier: userProfile?.tier || 'free',
        role: userRole,
        currencies: userProfile?.currencies || { essence: 0, gems: 0 },
        stats: userProfile?.stats || { totalTotems: 0, totalChallengesCompleted: 0, loginStreak: 1 },
        settings: userProfile?.settings || { notifications: true, darkMode: 'dark' },
      },
      tokens,
    });
  }
  catch (error) {
    console.error('Login error:', error);

    // Return specific error for unverified email
    if (error.message === 'Email not verified') {
      return res.status(403).json({
        success: false,
        error: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before logging in.',
      });
    }

    // Generic error for security
    return res.status(401).json({
      success: false,
      error: 'Invalid email or password',
    });
  }
}

/**
 * POST /auth/logout
 *
 * Revoke the refresh token to sign out.
 */
async function handleLogout(req, res) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token is required',
      });
    }

    await revokeRefreshToken(refreshToken);

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  }
  catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to logout',
    });
  }
}

/**
 * POST /auth/refresh
 *
 * Refresh the access token using a refresh token.
 */
async function handleRefresh(req, res) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token is required',
      });
    }

    const result = await refreshTokens(refreshToken);

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired refresh token',
      });
    }

    return res.status(200).json({
      success: true,
      tokens: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        idToken: result.idToken,
        expiresIn: result.expiresIn,
        tokenType: result.tokenType,
      },
    });
  }
  catch (error) {
    console.error('Refresh error:', error);
    return res.status(401).json({
      success: false,
      error: 'Failed to refresh token',
    });
  }
}

/**
 * GET /auth/me
 *
 * Get the current authenticated user's profile.
 * Requires valid access token in Authorization header.
 */
async function handleGetMe(req, res) {
  try {
    // User attached by authenticateJWT (req.user) or authMiddleware (req.userId)
    const userId = req.user?.userId || req.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
    }

    // Get full user from DynamoDB
    const user = await getUser(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const { SKIP_COST: DISPLAY_NAME_SKIP_COST } = require('../functions/user/update-display-name');
    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        tier: user.tier,
        role: user.role || 'user',
        currencies: user.currencies,
        stats: user.stats,
        settings: user.settings,
        displayNameCooldown: {
          readyAt: user.displayNameChangeReadyAt || null,
          skipCost: DISPLAY_NAME_SKIP_COST,
        },
        profile: {
          bio: user.profile?.bio ?? null,
          avatar: user.profile?.avatar ?? null,
          banner: user.profile?.banner ?? null,
        },
        createdAt: user.createdAt,
      },
    });
  }
  catch (error) {
    console.error('Get me error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get user',
    });
  }
}

// ============================================
// Auth Middleware
// ============================================

/**
 * Middleware to verify access token and attach user to request.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: 'No token provided',
    });
  }

  // Accept both raw token and Bearer-prefixed token
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  const result = verifyAccessToken(token);

  if (!result.valid) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }

  // Attach user info to request
  req.userId = result.userId;
  req.userEmail = result.email;
  req.userRole = result.role || 'user';

  next();
}

/**
 * Optional auth middleware - doesn't fail if no token
 */
function optionalAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    // Accept both raw token and Bearer-prefixed token
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const result = verifyAccessToken(token);

    if (result.valid) {
      req.userId = result.userId;
      req.userEmail = result.email;
    }
  }

  next();
}

/**
 * POST /auth/verify
 *
 * Verify email with code sent during signup.
 * On success, auto-signs the user in and returns tokens.
 */
async function handleVerify(req, res) {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        error: 'Email and verification code are required',
      });
    }

    // Confirm the signup
    await confirmSignUp({ email, code });

    // Auto sign-in after verification
    const loginResult = await signIn({ email, password: req.body.password });

    // Get the user from DB for full profile
    const user = await getUser(loginResult.userId);

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully',
      user: user ? {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        tier: user.tier,
        role: user.role || 'user',
        currencies: user.currencies,
        stats: user.stats,
        settings: user.settings,
      } : {
        id: loginResult.userId,
        email: loginResult.email,
        displayName: loginResult.displayName,
        role: 'user',
      },
      tokens: {
        accessToken: loginResult.accessToken,
        refreshToken: loginResult.refreshToken,
        idToken: loginResult.idToken,
        expiresIn: loginResult.expiresIn,
        tokenType: loginResult.tokenType,
      },
    });
  }
  catch (error) {
    console.error('Verify error:', error);
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * POST /auth/resend-verification
 *
 * Resend the email verification code.
 */
async function handleResendVerification(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
      });
    }

    await resendConfirmationCode({ email });

    return res.status(200).json({
      success: true,
      message: 'Verification code sent to your email',
    });
  }
  catch (error) {
    console.error('Resend verification error:', error);
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * POST /auth/forgot-password
 *
 * Request a password reset code. Always returns success to prevent user enumeration.
 */
async function handleForgotPassword(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format',
      });
    }

    const result = await forgotPassword({ email });

    // Always return success to prevent user enumeration
    return res.status(200).json({
      success: true,
      message: result.message,
    });
  }
  catch (error) {
    console.error('Forgot password error:', error);
    // Rate limit errors should be surfaced
    if (error.message.includes('Too many attempts')) {
      return res.status(429).json({
        success: false,
        error: error.message,
      });
    }
    // All other errors: generic success to prevent enumeration
    return res.status(200).json({
      success: true,
      message: 'If an account exists, a reset code has been sent',
    });
  }
}

/**
 * POST /auth/reset-password
 *
 * Reset password using code from forgot-password email.
 */
async function handleResetPassword(req, res) {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Email, code, and new password are required',
      });
    }

    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        error: passwordValidation.error,
      });
    }

    const result = await confirmForgotPassword({ email, code, newPassword });

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  }
  catch (error) {
    console.error('Reset password error:', error);
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
}

// ============================================
// Exports
// ============================================

module.exports = {
  handleSignup,
  handleLogin,
  handleLogout,
  handleRefresh,
  handleGetMe,
  handleVerify,
  handleResendVerification,
  handleForgotPassword,
  handleResetPassword,
  authMiddleware,
  optionalAuthMiddleware,
};
