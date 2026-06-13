/**
 * Challenge Status Handler
 *
 * GET /api/challenges/status
 * GET /api/challenges/status/:totemId
 *
 * Get user's overall challenge progress including daily attempts and completion stats.
 */

const { getChallengeStatus: getChallengeStatusService, getAllChallenges, MASTERY } = require('../../services/challenges-service');
const { getUser } = require('../../common/db-client');

/**
 * Get user's challenge progress status
 *
 * @param {object} user - Authenticated user { userId }
 * @param {string} [totemId] - Optional totem ID for requirement checking
 * @returns {object} - Challenge progress status
 */
async function getChallengeStatus(user, totemId = null) {
  const userId = user.userId;

  // 1. Get all challenge statuses from service (with optional totem for requirements)
  const statuses = await getChallengeStatusService(userId, totemId);

  // 2. Get all challenge definitions
  const challenges = getAllChallenges();

  // 3. Get user's total challenge stats
  let userStats = {};
  try {
    const userRecord = await getUser(userId);
    userStats = userRecord?.stats || {};
  }
  catch (err) {
    console.error('Failed to fetch user stats:', err);
  }

  // 4. Build status for each challenge
  const challengeStatuses = statuses.map((status) => ({
    challengeId: status.challengeId,
    challengeName: status.name,
    description: status.description,
    type: status.type,
    affinity: status.affinity,
    requirements: status.requirements,
    maxScore: status.maxScore,
    xpReward: status.xpReward,
    maxDailyAttempts: status.maxDailyAttempts,
    // Progress data
    completionCount: status.completionCount,
    totalAttempts: status.totalAttempts,
    totalXpEarned: status.totalXpEarned,
    highScore: status.highScore,
    lastScore: status.lastScore,
    lastAttemptAt: status.lastAttemptAt,
    firstCompletedAt: status.firstCompletedAt,
    // Daily attempt tracking
    attemptsToday: status.attemptsToday,
    attemptsRemaining: status.attemptsRemaining,
    canAttempt: status.canAttempt,
    // Mastery block (tier, multiplier, difficulty unlock — frontend contract)
    mastery: status.mastery,
    // Requirement status (if totem provided)
    requirementStatus: status.requirementStatus,
  }));

  // 5. Calculate summary
  const totalCompletions = challengeStatuses.reduce(
    (sum, s) => sum + s.completionCount,
    0
  );
  const totalAttempts = challengeStatuses.reduce(
    (sum, s) => sum + s.totalAttempts,
    0
  );
  const totalXpEarned = challengeStatuses.reduce(
    (sum, s) => sum + s.totalXpEarned,
    0
  );
  const challengesAtDailyLimit = challengeStatuses.filter(
    (s) => !s.canAttempt
  ).length;
  const challengesReady = challenges.length - challengesAtDailyLimit;

  // Mastery summary: total tiers earned + challenges at each tier.
  // Tier indices come from the MASTERY config (raiseTier = Gold, last tier =
  // Diamond) — never hardcoded literals.
  const topTier = MASTERY.tiers.length - 1;
  const totalTiersEarned = challengeStatuses.reduce(
    (sum, s) => sum + (s.mastery?.tier || 0),
    0
  );
  const challengesAtGold = challengeStatuses.filter(
    (s) => (s.mastery?.tier || 0) >= MASTERY.raiseTier
  ).length;
  const challengesAtDiamond = challengeStatuses.filter(
    (s) => (s.mastery?.tier || 0) >= topTier
  ).length;

  // 6. Group by type
  const byType = challengeStatuses.reduce((acc, status) => {
    if (!acc[status.type]) {
      acc[status.type] = [];
    }
    acc[status.type].push(status);
    return acc;
  }, {});

  return {
    success: true,
    data: {
      challenges: challengeStatuses,
      byType,
      summary: {
        totalChallenges: challenges.length,
        totalCompletions,
        totalAttempts,
        totalXpEarned,
        totalChallengeCount: userStats.totalChallengeCount || totalCompletions,
        challengesReady,
        challengesAtDailyLimit,
        // Mastery summary
        totalTiersEarned,
        challengesAtGold,
        challengesAtDiamond,
      },
    },
  };
}

module.exports = { getChallengeStatus };
