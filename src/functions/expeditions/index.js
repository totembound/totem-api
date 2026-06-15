/**
 * Expeditions API Handlers
 *
 * Routes:
 * - GET  /api/expeditions         - Get all available and active expeditions (combined view)
 * - GET  /api/expeditions/list    - Get all 15 expedition definitions
 * - GET  /api/expeditions/active  - Get all active expeditions for the user
 * - GET  /api/expeditions/history - Get past completed expeditions
 * - GET  /api/expeditions/status/:totemId - Get expedition status for a totem
 * - POST /api/expeditions/start   - Start a new expedition for a totem
 * - POST /api/expeditions/claim   - Claim reward for a completed expedition
 *
 * Expedition durations and rewards:
 * - 30 min:  10-20 Essence  (Meadow Stroll, Creek Splash, Sunbeam Rest)
 * - 3 hr:    50-100 Essence (Forest Trail, Hill Climb, Cave Peek)
 * - 6 hr:    100-200 Essence (Mountain Path, River Journey, Jungle Trek)
 * - 12 hr:   200-400 Essence (Desert Crossing, Tundra March, Volcano Rim)
 * - 24 hr:   500-1000 Essence (Ocean Voyage, Sky Ascent, Spirit Realm)
 */

const { startExpeditionHandler } = require('./start');
const { claimExpeditionHandler } = require('./claim');
const { getActiveExpeditionsHandler } = require('./active');
const { listExpeditionsHandler } = require('./list');
const { getExpeditionHistoryHandler } = require('./history');
const { getExpeditionStatusHandler } = require('./status');

/**
 * Get all expeditions (combines list and active for main page view)
 *
 * GET /api/expeditions
 *
 * @param {object} user - Authenticated user { userId }
 * @returns {object} - Available and active expeditions
 */
async function getExpeditions(user) {
  try {
    // Get both available expeditions and active expeditions in parallel
    const [listResult, activeResult] = await Promise.all([
      listExpeditionsHandler(user),
      getActiveExpeditionsHandler(user),
    ]);

    return {
      success: true,
      data: {
        available: listResult.success ? listResult.data.expeditions : [],
        byTier: listResult.success ? listResult.data.byTier : {},
        active: activeResult.success ? activeResult.data.expeditions : [],
        activeCount: activeResult.success ? activeResult.data.summary?.total : 0,
        readyToClaim: activeResult.success ? activeResult.data.summary?.claimable : 0,
      },
    };
  }
  catch (err) {
    console.error('Failed to get expeditions overview:', err);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get expeditions' },
    };
  }
}

/**
 * Start an expedition (wrapper for local-server.js compatibility)
 *
 * POST /api/expeditions/:id/start
 *
 * @param {object} user - Authenticated user
 * @param {string} expeditionId - Expedition ID from URL params (optional, can be in body)
 * @param {object} body - Request body { totemId, expeditionId }
 */
async function start(user, expeditionId, body = {}) {
  // Merge expeditionId from URL params into body if provided
  const mergedBody = {
    ...body,
    expeditionId: body.expeditionId || expeditionId,
  };
  return startExpeditionHandler(user, mergedBody);
}

/**
 * Claim expedition rewards (wrapper for local-server.js compatibility)
 *
 * POST /api/expeditions/:id/claim
 *
 * @param {object} user - Authenticated user
 * @param {string} totemId - Totem ID from URL params (optional, can be in body)
 * @param {object} body - Request body { totemId }
 */
async function claim(user, totemId, body = {}) {
  // Merge totemId from URL params into body if provided
  const mergedBody = {
    ...body,
    totemId: body.totemId || totemId,
  };
  return claimExpeditionHandler(user, mergedBody);
}

/**
 * Get list of all available expeditions (wrapper)
 * @param {object} user - Authenticated user
 */
async function list(user) {
  return listExpeditionsHandler(user);
}

/**
 * Get active expeditions (wrapper)
 * @param {object} user - Authenticated user
 */
async function active(user) {
  return getActiveExpeditionsHandler(user);
}

/**
 * Get expedition history (wrapper)
 * @param {object} user - Authenticated user
 * @param {object} queryParams - Query parameters { limit }
 */
async function history(user, queryParams = {}) {
  return getExpeditionHistoryHandler(user, queryParams);
}

/**
 * Get status for a specific totem (wrapper)
 * @param {object} user - Authenticated user
 * @param {string} totemId - Totem ID
 */
async function status(user, totemId) {
  return getExpeditionStatusHandler(user, totemId);
}

module.exports = {
  // Combined endpoint for main expedition page
  getExpeditions,

  // Simplified wrappers for local-server.js compatibility
  start,
  claim,
  list,
  active,
  history,
  status,

  // Original handlers (for direct use and testing)
  startExpeditionHandler,
  claimExpeditionHandler,
  getActiveExpeditionsHandler,
  listExpeditionsHandler,
  getExpeditionHistoryHandler,
  getExpeditionStatusHandler,
};
