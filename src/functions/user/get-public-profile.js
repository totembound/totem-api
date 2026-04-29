/**
 * Get Public Player Profile Handler
 *
 * GET /v1/players/:userId/public
 *
 * Returns the public-safe subset of a user's profile, viewable by anyone
 * (with or without authentication). Today's only entry point: clicking a
 * seller's displayName on a marketplace listing.
 *
 * Whitelist (and ONLY this whitelist):
 * - id, displayName, createdAt, tier
 * - profile.bio, profile.avatar, profile.banner
 * - stats.totalTotems, stats.totalChallengesCompleted, stats.bestLoginStreak,
 *   stats.highestStageReached
 *
 * Explicitly excluded: email, currencies, settings, OAuth fields,
 * lastLoginDate (privacy — would reveal when they were online), role, status.
 * Tier IS exposed because the frontend renders a Free/Premium/VIP badge on
 * the public profile (intended user-visible signal, not PII).
 *
 * Why bestLoginStreak is OK to expose: it's a milestone count, not a recent
 * timestamp — it doesn't reveal recent presence and matches engagement-stat
 * conventions on most game profiles.
 */

const { getUser, getUserTotems } = require('../../common/db-client');

async function getPublicProfile(userId) {
  if (typeof userId !== 'string' || !userId.startsWith('usr_')) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Player not found' },
    };
  }

  const user = await getUser(userId);
  if (!user) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Player not found' },
    };
  }

  // Live totem count + highest stage, mirroring get-profile.js. Falls back to
  // stored count on error.
  let totemCount = user.stats?.totalTotems || 0;
  let highestStage = 0;
  try {
    const totems = await getUserTotems(userId);
    totemCount = totems.length;
    highestStage = totems.reduce((max, t) => Math.max(max, t.stage ?? 0), 0);
  }
  catch (err) {
    console.warn('[getPublicProfile] Failed to count totems:', err.message);
  }

  const bestStreak = user.stats?.bestLoginStreak
    ?? user.stats?.loginStreak
    ?? 0;

  return {
    success: true,
    data: {
      id: user.id,
      displayName: user.displayName,
      createdAt: user.createdAt,
      tier: user.tier || 'free',
      profile: {
        bio: user.profile?.bio ?? null,
        avatar: user.profile?.avatar ?? null,
        banner: user.profile?.banner ?? null,
      },
      stats: {
        totalTotems: totemCount,
        totalChallengesCompleted: user.stats?.totalChallengesCompleted || 0,
        bestLoginStreak: bestStreak,
        highestStageReached: highestStage,
      },
    },
  };
}

module.exports = { getPublicProfile };
