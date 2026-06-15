/**
 * OAuth Provider Registry
 *
 * Provider-agnostic module for OAuth social login.
 * Adding a new provider = add an entry to PROVIDERS with URLs + normalizeUser.
 * No if/else chains — exchangeCodeForToken and fetchUserProfile read from config.
 */

const { getSecret } = require('./ssm-loader');

// ============================================
// Provider Configurations
// ============================================

const PROVIDERS = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scopes: 'openid email profile',
    getClientId: () => getSecret('GOOGLE_CLIENT_ID'),
    getClientSecret: () => getSecret('GOOGLE_CLIENT_SECRET'),
    // Google accepts JSON for token exchange
    tokenContentType: 'json',
    // No extra headers needed for userinfo
    userInfoHeaders: null,
    normalizeUser: (data) => ({
      providerId: data.sub,
      email: data.email || null,
      emailVerified: data.email_verified || false,
      displayName: data.name || data.given_name || (data.email ? data.email.split('@')[0] : 'Player'),
      avatarUrl: data.picture || null,
    }),
  },

  twitch: {
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    userInfoUrl: 'https://api.twitch.tv/helix/users',
    scopes: 'user:read:email',
    getClientId: () => getSecret('TWITCH_CLIENT_ID'),
    getClientSecret: () => getSecret('TWITCH_CLIENT_SECRET'),
    // Twitch accepts form-encoded or JSON for token exchange; form is safest
    tokenContentType: 'form',
    // Twitch Helix API requires Client-Id header alongside Bearer token
    userInfoHeaders: async (config) => ({ 'Client-Id': await config.getClientId() }),
    normalizeUser: (data) => {
      const user = data && data.data && data.data[0];
      if (!user) {
        throw new Error('Twitch returned no user data');
      }
      return {
        providerId: user.id,
        email: user.email || null,
        // Twitch only returns email for users who have verified it
        emailVerified: !!user.email,
        displayName: user.display_name || user.login,
        avatarUrl: user.profile_image_url || null,
      };
    },
  },

  discord: {
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userInfoUrl: 'https://discord.com/api/users/@me',
    scopes: 'identify email',
    getClientId: () => getSecret('DISCORD_CLIENT_ID'),
    getClientSecret: () => getSecret('DISCORD_CLIENT_SECRET'),
    // Discord requires form-encoded token exchange
    tokenContentType: 'form',
    userInfoHeaders: null,
    normalizeUser: (data) => ({
      providerId: data.id,
      email: data.email || null,
      emailVerified: data.verified || false,
      displayName: data.global_name || data.username,
      avatarUrl: data.avatar
        ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
        : null,
    }),
  },

  // --- Add future providers here ---
};

// ============================================
// Public API
// ============================================

/**
 * Get list of supported provider names
 */
function getSupportedProviders() {
  return Object.keys(PROVIDERS);
}

/**
 * Exchange authorization code for access token
 * @param {string} provider - Provider name (google, discord, twitch)
 * @param {string} code - Authorization code from OAuth redirect
 * @param {string} redirectUri - The redirect URI used in the authorize request
 * @returns {Promise<{ access_token: string, token_type: string }>}
 */
async function exchangeCodeForToken(provider, code, redirectUri) {
  const config = PROVIDERS[provider];
  if (!config) {
    throw new Error(`Unsupported OAuth provider: ${provider}`);
  }

  const clientId = await config.getClientId();
  const clientSecret = await config.getClientSecret();

  if (!clientId || !clientSecret) {
    throw new Error(`OAuth not configured for provider: ${provider}`);
  }

  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  };

  let fetchOptions;
  if (config.tokenContentType === 'form') {
    fetchOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    };
  }
  else {
    fetchOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  const response = await fetch(config.tokenUrl, fetchOptions);
  const data = await response.json();

  if (!response.ok || data.error) {
    const errorDesc = data.error_description || data.error || 'Token exchange failed';
    console.error(`[OAuth] Token exchange failed for ${provider}:`, data);
    throw new Error(errorDesc);
  }

  return {
    access_token: data.access_token,
    token_type: data.token_type || 'Bearer',
  };
}

/**
 * Fetch user profile from provider API and normalize to common shape
 * @param {string} provider - Provider name
 * @param {string} accessToken - Access token from token exchange
 * @returns {Promise<{ providerId: string, email: string|null, emailVerified: boolean, displayName: string, avatarUrl: string|null }>}
 */
async function fetchUserProfile(provider, accessToken) {
  const config = PROVIDERS[provider];
  if (!config) {
    throw new Error(`Unsupported OAuth provider: ${provider}`);
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  // Some providers (Twitch) need extra headers
  if (config.userInfoHeaders) {
    Object.assign(headers, await config.userInfoHeaders(config));
  }

  const response = await fetch(config.userInfoUrl, { headers });
  const data = await response.json();

  if (!response.ok) {
    console.error(`[OAuth] User profile fetch failed for ${provider}:`, data);
    throw new Error('Failed to fetch user profile from provider');
  }

  return config.normalizeUser(data);
}

module.exports = {
  getSupportedProviders,
  exchangeCodeForToken,
  fetchUserProfile,
  PROVIDERS,
};
