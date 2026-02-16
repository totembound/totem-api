/**
 * Available Challenges Handler
 *
 * GET /api/challenges/available/:totemId
 *
 * Returns challenges the totem qualifies for based on stage and stats.
 */

const { getTotem } = require('../../common/db-client');
const {
  getAvailableChallenges: getAvailableChallengesService,
  getUnavailableChallenges,
  getChallengeStatus: getChallengeStatusService,
  getAllChallenges,
} = require('../../services/challenges-service');

/**
 * Get challenges available for a specific totem
 *
 * @param {object} user - Authenticated user { userId }
 * @param {string} totemId - The totem ID to check
 * @returns {object} - Available challenges for the totem
 */
async function getAvailableChallenges(user, totemId) {
  const userId = user.userId;

  // 1. Validate totemId format
  if (!totemId || !totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 2. Get totem from database
  const totem = await getTotem(userId, totemId);
  if (!totem) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Totem not found' },
    };
  }

  // 3. Get available and unavailable challenges (pass full totem object)
  const available = getAvailableChallengesService(totem);
  const locked = getUnavailableChallenges(totem);

  // 4. Get challenge statuses for daily attempt info
  const statuses = await getChallengeStatusService(userId, totemId);
  const statusMap = statuses.reduce((acc, s) => {
    acc[s.challengeId] = s;
    return acc;
  }, {});

  // 5. Enrich available challenges with attempt status
  const availableChallenges = available.map((challenge) => {
    const status = statusMap[challenge.id];

    return {
      id: challenge.id,
      name: challenge.name,
      description: challenge.description,
      type: challenge.type,
      affinity: challenge.affinity,
      requirements: challenge.requirements,
      maxScore: challenge.maxScore,
      xpReward: challenge.xpReward,
      maxDailyAttempts: challenge.maxDailyAttempts,
      difficulty: getDifficultyFromStage(challenge.requirements.stage),
      // Attempt status
      attemptsToday: status?.attemptsToday || 0,
      attemptsRemaining: status?.attemptsRemaining || challenge.maxDailyAttempts,
      canAttempt: status?.canAttempt !== false,
      status: (status?.canAttempt === false) ? 'daily_limit' : 'ready',
      // Progress
      completionCount: status?.completionCount || 0,
      totalXpEarned: status?.totalXpEarned || 0,
      highScore: status?.highScore || 0,
    };
  });

  // 6. Enrich locked challenges with missing requirement info
  const lockedChallenges = locked.map((challenge) => {
    const status = statusMap[challenge.id];

    return {
      id: challenge.id,
      name: challenge.name,
      description: challenge.description,
      type: challenge.type,
      affinity: challenge.affinity,
      requirements: challenge.requirements,
      maxScore: challenge.maxScore,
      xpReward: challenge.xpReward,
      maxDailyAttempts: challenge.maxDailyAttempts,
      difficulty: getDifficultyFromStage(challenge.requirements.stage),
      canAttempt: false,
      status: 'locked',
      lockReason: challenge.reason,
      unmetRequirement: challenge.unmetRequirement,
      // Progress (can still have progress if requirements changed)
      completionCount: status?.completionCount || 0,
      totalXpEarned: status?.totalXpEarned || 0,
      highScore: status?.highScore || 0,
    };
  });

  // 7. Sort available challenges: ready first, then by stage requirement
  availableChallenges.sort((a, b) => {
    // Ready challenges first
    if (a.canAttempt !== b.canAttempt) {
      return a.canAttempt ? -1 : 1;
    }
    // Then by stage requirement (lower first)
    return a.requirements.stage - b.requirements.stage;
  });

  // 8. Sort locked challenges by stage requirement (closest to unlocking first)
  lockedChallenges.sort((a, b) => a.requirements.stage - b.requirements.stage);

  const allChallenges = getAllChallenges();
  const totemStats = totem.stats || {};
  const effectiveStage = (totem.stage || 0) + 1;

  return {
    success: true,
    data: {
      totemId,
      totemName: totem.name || totem.nickname,
      totemStats,
      totemStage: effectiveStage,
      available: availableChallenges,
      locked: lockedChallenges,
      summary: {
        totalChallenges: allChallenges.length,
        availableCount: availableChallenges.length,
        readyCount: availableChallenges.filter((c) => c.canAttempt).length,
        lockedCount: lockedChallenges.length,
      },
    },
  };
}

/**
 * Get difficulty level from stage requirement
 */
function getDifficultyFromStage(stage) {
  if (stage <= 1) return 'beginner';
  if (stage <= 2) return 'easy';
  if (stage <= 3) return 'medium';
  return 'hard';
}

module.exports = { getAvailableChallenges };
