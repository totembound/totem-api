/**
 * Challenge Attempt Handler
 *
 * POST /api/challenges/attempt
 *
 * Body: { totemId, challengeId, score }
 *
 * Validates totem meets requirements, processes challenge completion,
 * awards XP to the totem AND Essence to the user, and triggers achievement hook.
 */

const { completeChallenge, CHALLENGES_MAP } = require('../../services/challenges-service');
const { emitQuestProgress } = require('../../services/daily-quests-service');

/**
 * Complete a challenge with a totem
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId, challengeId, score, difficulty? }
 * @returns {object} - Challenge completion result
 */
async function attemptChallenge(user, body) {
  const userId = user.userId;
  const { totemId, challengeId, score, difficulty } = body || {};

  // 1. Validate required parameters
  if (!totemId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'totemId is required' },
    };
  }

  if (!challengeId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'challengeId is required' },
    };
  }

  if (score === undefined || score === null) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'score is required' },
    };
  }

  // 2. Validate totemId format
  if (!totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 3. Validate score is a number
  const numericScore = Number(score);
  if (isNaN(numericScore) || numericScore < 0) {
    return {
      success: false,
      error: { code: 'INVALID_SCORE', message: 'score must be a non-negative number' },
    };
  }

  // 4. Delegate to service - completeChallenge awards XP to totem.
  //    Difficulty is optional and clamped server-side (lower always ok; raise
  //    above stage-lock needs Gold+ mastery). Omitted/invalid => stage-derived auto.
  const numericDifficulty = difficulty === undefined || difficulty === null
    ? undefined
    : Number(difficulty);
  const result = await completeChallenge(
    userId,
    challengeId,
    totemId,
    numericScore,
    numericDifficulty,
  );

  // 5. Transform response to include totem stats
  if (result.success && result.data) {
    const { getTotem } = require('../../common/db-client');
    const totem = await getTotem(userId, totemId);

    const challenge = CHALLENGES_MAP && CHALLENGES_MAP[challengeId];
    const quests = await emitQuestProgress(userId, 'CHALLENGE_COMPLETED', {
      challengeId,
      affinity: challenge?.affinity || null,
    });

    return {
      success: true,
      data: {
        ...result.data,
        totemStats: totem?.stats || {},
        quests,
      },
    };
  }

  return result;
}

module.exports = { attemptChallenge };
