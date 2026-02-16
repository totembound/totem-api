/**
 * Challenges API Handlers
 *
 * Routes:
 * - POST /api/challenges/attempt - Attempt a challenge with a totem
 * - POST /api/challenges/:id/complete - Complete a challenge (alias for attempt)
 * - GET /api/challenges - Get all challenges with user status
 * - GET /api/challenges/list - Get all challenges with user's completion counts
 * - GET /api/challenges/status - Get user's challenge progress and cooldowns
 * - GET /api/challenges/available/:totemId - Get challenges a totem qualifies for
 */

const { attemptChallenge } = require('./attempt');
const { listChallenges } = require('./list');
const { getChallengeStatus } = require('./status');
const { getAvailableChallenges } = require('./available');

/**
 * Get all challenges (wrapper for local-server.js compatibility)
 * Maps to GET /api/challenges
 */
async function getChallenges(user) {
  return listChallenges(user);
}

/**
 * Get user status (wrapper for local-server.js compatibility)
 * Maps to GET /api/challenges/status
 */
async function getStatus(user) {
  return getChallengeStatus(user);
}

/**
 * Complete a challenge (wrapper for local-server.js compatibility)
 * Maps to POST /api/challenges/:id/complete
 *
 * @param {object} user - Authenticated user
 * @param {string} challengeId - Challenge ID from URL params
 * @param {object} body - Request body { totemId, score }
 */
async function complete(user, challengeId, body = {}) {
  // Merge challengeId from URL params into body
  const mergedBody = {
    ...body,
    challengeId: challengeId,
  };
  return attemptChallenge(user, mergedBody);
}

module.exports = {
  // Wrappers for local-server.js compatibility
  getChallenges,
  getStatus,
  complete,

  // Original handlers
  attemptChallenge,
  listChallenges,
  getChallengeStatus,
  getAvailableChallenges,
};
