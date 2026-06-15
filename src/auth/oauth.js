/**
 * OAuth Callback Handler
 *
 * POST /v1/auth/oauth/callback
 * Provider-agnostic — works for any provider in oauth-providers.js.
 *
 * Flow:
 * 1. Exchange authorization code for access token
 * 2. Fetch user profile from provider
 * 3. Find or create user in DynamoDB
 * 4. Generate JWT tokens
 * 5. Return same shape as /auth/login
 */

const {
  getSupportedProviders,
  exchangeCodeForToken,
  fetchUserProfile,
} = require('../common/oauth-providers');

const {
  createUser,
  getUser,
  updateUser,
  getUserByEmail,
  getUserByProviderId,
  logTransaction,
} = require('../common/db-client');

const { adminGetTokensForOAuth, createOAuthUser } = require('../common/cognito-client');
const { sendNewUserWelcomeEmail } = require('../common/email');
const { onLoginStreak } = require('../services/achievements-service');
const { grantLootItem } = require('../services/loot-service');

/**
 * POST /v1/auth/oauth/callback
 * Body: { provider: 'google', code: 'xxx', redirectUri: 'http://localhost:3000/auth/callback' }
 */
async function handleOAuthCallback(req, res) {
  try {
    const { provider, code, redirectUri } = req.body;

    // Validate provider
    if (!provider || !getSupportedProviders().includes(provider)) {
      return res.status(400).json({
        success: false,
        error: `Invalid or unsupported provider. Supported: ${getSupportedProviders().join(', ')}`,
      });
    }

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Authorization code is required',
      });
    }

    if (!redirectUri) {
      return res.status(400).json({
        success: false,
        error: 'Redirect URI is required',
      });
    }

    // 1. Exchange code for access token
    let tokenResult;
    try {
      tokenResult = await exchangeCodeForToken(provider, code, redirectUri);
    }
    catch (err) {
      console.error(`[OAuth] Token exchange error for ${provider}:`, err.message);
      return res.status(401).json({
        success: false,
        error: 'Failed to authenticate with provider. Please try again.',
      });
    }

    // 2. Fetch user profile from provider
    let profile;
    try {
      profile = await fetchUserProfile(provider, tokenResult.access_token);
    }
    catch (err) {
      console.error(`[OAuth] Profile fetch error for ${provider}:`, err.message);
      return res.status(401).json({
        success: false,
        error: 'Failed to get profile from provider.',
      });
    }

    // 3. Require email
    if (!profile.email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required. Please grant email permission and try again.',
      });
    }

    // 4. Find or create user
    let userProfile = null;
    let isNewUser = false;
    let lootItem = null;

    // Check if returning OAuth user (by provider + providerId)
    userProfile = await getUserByProviderId(provider, profile.providerId);

    if (!userProfile) {
      // Check if existing email/password user
      userProfile = await getUserByEmail(profile.email);

      if (userProfile) {
        // Link OAuth to existing account
        console.log(`[OAuth] Linking ${provider} to existing user ${userProfile.id}`);
        await updateUser(userProfile.id, {
          oauthProvider: provider,
          oauthProviderId: profile.providerId,
          avatarUrl: profile.avatarUrl || userProfile.avatarUrl || null,
        });
      }
      else {
        // Create new user
        isNewUser = true;
        console.log(`[OAuth] Creating new user from ${provider}: ${profile.email}`);

        // Coerce inherited name into our format so signup never fails on a
        // malformed (long, accented, profane) external display name.
        const { sanitizeInboundDisplayName } = require('../common/display-name');
        const safeDisplayName = sanitizeInboundDisplayName(
          profile.displayName,
          profile.email ? profile.email.split('@')[0] : 'Player',
        );

        // Create Cognito user (passwordless)
        const cognitoResult = await createOAuthUser({
          email: profile.email,
          displayName: safeDisplayName,
          provider,
          providerId: profile.providerId,
        });

        // Create DynamoDB user record
        const userData = {
          id: cognitoResult.userId,
          email: profile.email,
          displayName: safeDisplayName,
          tier: 'free',
          currencies: { essence: 2000, gems: 0 },
          stats: {
            totalTotems: 0,
            totalChallengesCompleted: 0,
            loginStreak: 0,
            lastLoginDate: new Date().toISOString(),
          },
          settings: { notifications: true, darkMode: 'dark' },
          role: 'user',
          signupMethod: 'oauth',
          oauthProvider: provider,
          oauthProviderId: profile.providerId,
          avatarUrl: profile.avatarUrl,
        };

        await createUser(userData);
        userProfile = await getUser(cognitoResult.userId);

        // Grant starter loot box
        lootItem = await grantLootItem(cognitoResult.userId, 'uncommon_totem_box', 'signup');

        // Log signup bonus transaction
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
          await sendNewUserWelcomeEmail(profile.email, profile.displayName, null);
        }
        catch (err) {
          console.error('Failed to send welcome email:', err);
        }
      }
    }

    // Block banned users
    if (userProfile.status === 'banned') {
      return res.status(403).json({
        success: false,
        error: 'ACCOUNT_BANNED',
        message: 'Your account has been suspended. Contact support for assistance.',
      });
    }

    // 5. Generate tokens (admin auth — no user password needed for OAuth)
    const userRole = userProfile.role || 'user';
    const tokens = await adminGetTokensForOAuth(
      userProfile.email, provider, profile.providerId, userProfile.id, userRole,
    );

    // 6. Update login streak (fire-and-forget)
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    const lastLoginDay = (userProfile.stats?.lastLoginDate || '').slice(0, 10);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let newStreak = 1;
    if (lastLoginDay === yesterdayStr) {
      newStreak = (userProfile.stats?.loginStreak || 0) + 1;
    }
    else if (lastLoginDay === today) {
      newStreak = userProfile.stats?.loginStreak || 1;
    }

    updateUser(userProfile.id, {
      'stats.lastLoginDate': nowIso,
      'stats.loginStreak': newStreak,
    }).catch(err => console.error('Failed to update login streak:', err));

    onLoginStreak(userProfile.id, newStreak)
      .catch(err => console.error('Background login streak achievement error:', err));

    // 7. Return response — same shape as /auth/login
    const response = {
      success: true,
      isNewUser,
      user: {
        id: userProfile.id,
        email: userProfile.email,
        displayName: userProfile.displayName,
        tier: userProfile.tier || 'free',
        role: userRole,
        currencies: userProfile.currencies || { essence: 0, gems: 0 },
        stats: userProfile.stats || { totalTotems: 0, totalChallengesCompleted: 0, loginStreak: 1 },
        settings: userProfile.settings || { notifications: true, darkMode: 'dark' },
      },
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        expiresIn: tokens.expiresIn,
        tokenType: tokens.tokenType,
      },
    };

    if (lootItem) {
      response.lootItem = {
        id: lootItem.id,
        boxId: lootItem.boxId,
        boxName: lootItem.box.name,
        boxDescription: lootItem.box.description,
        boxRarity: lootItem.box.rarity,
        boxIcon: lootItem.box.icon,
      };
    }

    return res.status(200).json(response);
  }
  catch (error) {
    console.error('[OAuth] Callback error:', error);
    return res.status(500).json({
      success: false,
      error: 'OAuth authentication failed. Please try again.',
    });
  }
}

module.exports = {
  handleOAuthCallback,
};
