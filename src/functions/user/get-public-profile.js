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
 * - stats.totalTotems, stats.totalChallengesCompleted, stats.bestDailyStreak,
 *   stats.highestStageReached, stats.highestPrestigeReached
 * - mastery.tiersEarned / gold / platinum / diamond / grandmaster /
 *   challenges[{id, tier}] — gameplay accomplishment (Challenge Mastery),
 *   derived from the same ChallengeProgress records already fetched for
 *   totalChallengesCompleted (zero extra reads, not PII)
 *
 * Explicitly excluded: email, currencies, settings, OAuth fields,
 * lastLoginDate (privacy — would reveal when they were online), role, status.
 * Tier IS exposed because the frontend renders a Free/Premium/VIP badge on
 * the public profile (intended user-visible signal, not PII).
 *
 * bestDailyStreak comes from the rewards-service streak record
 * (RewardsClaims STREAK#daily.longestStreak), which already persists
 * Math.max(prev, newStreak) on every claim. NOT from login activity.
 */

const { getUser, getUserTotems } = require('../../common/db-client');
const { getAllChallengeProgress, tierForCompletions, CHALLENGES } = require('../../services/challenges-service');
const { getStreakState } = require('../../services/rewards-service');

async function getPublicProfile(userId) {
  // Accept both local-format ids (`usr_*`) and Cognito sub UUIDs. A raw UUID
  // is what awsSignIn returns on staging/prod, so a strict `usr_` check would
  // reject every legitimate Cognito-authed player. getUser() returns null for
  // anything that doesn't exist, so this guard only needs to fend off obviously
  // malformed strings.
  const ID_PATTERN = /^(usr_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  if (typeof userId !== 'string' || !ID_PATTERN.test(userId)) {
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

  // Live totem count, highest stage, and highest prestige. Stage 4 (Ascended)
  // totems can accumulate XP beyond 7500 — each PRESTIGE_XP_REQUIREMENT (2500)
  // earns one prestige level. Matches TotemDetailView formula so the public
  // tile shows the same "P{n}" as the totem detail HUD.
  const PRESTIGE_XP_REQUIREMENT = 2500;
  const BASE_ELDER_XP = 7500;
  let totemCount = user.stats?.totalTotems || 0;
  let highestStage = 0;
  let highestPrestige = 0;
  try {
    const totems = await getUserTotems(userId);
    totemCount = totems.length;
    for (const t of totems) {
      const stage = t.stage ?? 0;
      if (stage > highestStage) highestStage = stage;
      if (stage >= 4) {
        const xp = t.experience ?? 0;
        const prestige = xp > BASE_ELDER_XP
          ? Math.floor((xp - BASE_ELDER_XP) / PRESTIGE_XP_REQUIREMENT)
          : 0;
        if (prestige > highestPrestige) highestPrestige = prestige;
      }
    }
  }
  catch (err) {
    console.warn('[getPublicProfile] Failed to count totems:', err.message);
  }

  // Live challenge completion total — sum completionCount across all
  // CHALLENGE_PROGRESS records (≤10 per user, one per challenge id). Same
  // source completeChallenge feeds to achievements, so it's the ground truth.
  // Falls back to the (currently never-written) stat field if the query fails.
  let totalChallengesCompleted = user.stats?.totalChallengesCompleted || 0;
  // Challenge Mastery summary — derived from the same progress records, so it
  // costs no extra reads. `challenges` lists only trials with a tier above
  // Novice; the frontend renders the full medal strip from its own config.
  const mastery = {
    tiersEarned: 0,
    gold: 0,
    platinum: 0,
    diamond: 0,
    grandmaster: false,
    challenges: [],
  };
  try {
    const progress = await getAllChallengeProgress(userId);
    totalChallengesCompleted = progress.reduce(
      (sum, p) => sum + (p.completionCount || 0),
      0,
    );
    for (const p of progress) {
      const tier = tierForCompletions(p.masteryCount ?? p.completionCount ?? 0);
      if (tier > 0) mastery.challenges.push({ id: p.challengeId, tier });
      mastery.tiersEarned += tier;
      if (tier === 3) mastery.gold += 1;
      else if (tier === 4) mastery.platinum += 1;
      else if (tier === 5) mastery.diamond += 1;
    }
    mastery.grandmaster = mastery.diamond >= CHALLENGES.length;
  }
  catch (err) {
    console.warn('[getPublicProfile] Failed to sum challenge progress:', err.message);
  }

  // Best daily streak — RewardsClaims STREAK#daily.longestStreak is the
  // ground truth (updateStreakState writes Math.max(prev, newStreak)).
  // Defaults to 0 for users who've never claimed, so the tile always has
  // a number to display (was rendering empty when undefined leaked through).
  let bestDailyStreak = 0;
  try {
    const streak = await getStreakState(userId, 'daily');
    bestDailyStreak = streak?.longestStreak || 0;
  }
  catch (err) {
    console.warn('[getPublicProfile] Failed to read daily streak:', err.message);
  }

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
        totalChallengesCompleted,
        bestDailyStreak,
        highestStageReached: highestStage,
        highestPrestigeReached: highestPrestige,
      },
      mastery,
    },
  };
}

module.exports = { getPublicProfile };
