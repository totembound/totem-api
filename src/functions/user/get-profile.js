/**
 * Get User Profile Handler
 *
 * GET /api/user/profile
 *
 * Returns the authenticated user's full profile including:
 * - Basic info (id, email, displayName)
 * - Account tier (free/premium)
 * - Currencies (essence, gems)
 * - Stats (totems, challenges, login streak)
 * - Settings (notifications, darkMode)
 */

const { getUser, getUserTotems } = require('../../common/db-client');
const { SKIP_COST: DISPLAY_NAME_SKIP_COST } = require('./update-display-name');

/**
 * Get user profile
 *
 * @param {Object} user - Authenticated user from JWT middleware
 * @param {string} user.userId - User's unique ID
 * @returns {Object} Profile data with success flag
 */
async function getProfile(user) {
  try {
    const userId = user.userId;
    console.log('[getProfile] userId:', userId);

    // Get user from DynamoDB
    const userRecord = await getUser(userId);

    if (!userRecord) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' },
      };
    }

    // Get totem count for stats accuracy
    let totemCount = userRecord.stats?.totalTotems || 0;
    try {
      const totems = await getUserTotems(userId);
      totemCount = totems.length;
    }
    catch (err) {
      console.warn('Failed to get totem count:', err.message);
    }

    // Build profile response
    const profile = {
      id: userRecord.id,
      email: userRecord.email,
      displayName: userRecord.displayName,
      tier: userRecord.tier || 'free',
      role: userRecord.role || 'user',
      currencies: {
        essence: userRecord.currencies?.essence || 0,
        gems: userRecord.currencies?.gems || 0,
        runes: {
          lesser: userRecord.currencies?.runes?.lesser || 0,
          greater: userRecord.currencies?.runes?.greater || 0,
          ancient: userRecord.currencies?.runes?.ancient || 0,
        },
      },
      stats: {
        totalTotems: totemCount,
        totalChallengesCompleted: userRecord.stats?.totalChallengesCompleted || 0,
        loginStreak: userRecord.stats?.loginStreak || 0,
        lastLoginDate: userRecord.stats?.lastLoginDate || null,
        bestLoginStreak: userRecord.stats?.bestLoginStreak || userRecord.stats?.loginStreak || 0,
      },
      settings: {
        notifications: userRecord.settings?.notifications !== false,
        darkMode: userRecord.settings?.darkMode || 'dark',
        soundEffects: userRecord.settings?.soundEffects !== false,
        language: userRecord.settings?.language || 'en',
      },
      displayNameCooldown: {
        readyAt: userRecord.displayNameChangeReadyAt || null,
        skipCost: DISPLAY_NAME_SKIP_COST,
      },
      createdAt: userRecord.createdAt,
    };

    return {
      success: true,
      data: profile,
    };
  }
  catch (error) {
    console.error('Error fetching user profile:', error);
    throw error;
  }
}

module.exports = { getProfile };
