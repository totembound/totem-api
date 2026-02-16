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

const { completeChallenge } = require('../../services/challenges-service');

/**
 * Complete a challenge with a totem
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId, challengeId, score }
 * @returns {object} - Challenge completion result
 */
async function attemptChallenge(user, body) {
  const userId = user.userId;
  const { totemId, challengeId, score } = body || {};

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

  // 4. Delegate to service - completeChallenge awards XP to totem
  const result = await completeChallenge(userId, challengeId, totemId, numericScore);

  // 5. Transform response to include totem stats
  if (result.success && result.data) {
    const { getTotem } = require('../../common/db-client');
    const totem = await getTotem(userId, totemId);

    return {
      success: true,
      data: {
        ...result.data,
        totemStats: totem?.stats || {},
      },
    };
  }

  return result;
}

module.exports = { attemptChallenge };
