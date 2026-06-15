/**
 * Challenge List Handler
 *
 * GET /api/challenges/list
 *
 * Returns all 10 challenges with their requirements and user's completion counts.
 */

const { getChallengeStatus: getChallengeStatusService, getAllChallenges } = require('../../services/challenges-service');

/**
 * Get all challenges with user's completion counts
 *
 * @param {object} user - Authenticated user { userId }
 * @returns {object} - List of all challenges with progress
 */
async function listChallenges(user) {
  const userId = user.userId;

  // 1. Get all challenge statuses (includes progress)
  const statuses = await getChallengeStatusService(userId);

  // 2. Get all challenge definitions for complete info
  const challenges = getAllChallenges();

  // 3. Build response with challenges and progress
  const challengesWithProgress = statuses.map((status) => ({
    id: status.challengeId,
    name: status.name,
    description: status.description,
    type: status.type,
    affinity: status.affinity,
    requirements: status.requirements,
    maxScore: status.maxScore,
    xpReward: status.xpReward,
    maxDailyAttempts: status.maxDailyAttempts,
    difficulty: getDifficultyFromStage(status.requirements.stage),
    // Mastery block (tier, multiplier, difficulty unlock — frontend contract)
    mastery: status.mastery,
    // User's progress
    progress: {
      completionCount: status.completionCount,
      totalAttempts: status.totalAttempts,
      totalXpEarned: status.totalXpEarned,
      highScore: status.highScore,
      lastScore: status.lastScore,
      lastAttemptAt: status.lastAttemptAt,
      firstCompletedAt: status.firstCompletedAt,
    },
    // Daily attempt status
    daily: {
      attemptsToday: status.attemptsToday,
      attemptsRemaining: status.attemptsRemaining,
      canAttempt: status.canAttempt,
    },
  }));

  // 4. Calculate summary stats
  const totalCompletions = challengesWithProgress.reduce(
    (sum, c) => sum + c.progress.completionCount,
    0
  );
  const uniqueChallengesCompleted = challengesWithProgress.filter(
    (c) => c.progress.completionCount > 0
  ).length;
  const totalXpEarned = challengesWithProgress.reduce(
    (sum, c) => sum + c.progress.totalXpEarned,
    0
  );

  // 5. Group by type
  const byType = challengesWithProgress.reduce((acc, challenge) => {
    if (!acc[challenge.type]) {
      acc[challenge.type] = [];
    }
    acc[challenge.type].push(challenge);
    return acc;
  }, {});

  return {
    success: true,
    data: {
      challenges: challengesWithProgress,
      byType,
      summary: {
        totalChallenges: challenges.length,
        uniqueChallengesCompleted,
        totalCompletions,
        totalXpEarned,
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

module.exports = { listChallenges };
