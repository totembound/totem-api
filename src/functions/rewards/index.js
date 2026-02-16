/**
 * Rewards API Handlers
 *
 * Routes:
 * - POST /api/rewards/daily - Claim daily reward
 * - POST /api/rewards/weekly - Claim weekly reward
 * - GET /api/rewards/status - Get current reward status
 * - POST /api/rewards/tutorial - Claim tutorial reward
 * - GET /api/rewards/tutorial/progress - Get tutorial progress
 * - POST /api/rewards/:type/protection - Purchase streak protection
 */

const { claimDaily } = require('./claim-daily');
const { claimWeekly } = require('./claim-weekly');
const { getStatus } = require('./status');
const { claimTutorial, getTutorialProgress } = require('./claim-tutorial');
const { purchaseProtection } = require('./purchase-protection');

module.exports = {
  claimDaily,
  claimWeekly,
  getStatus,
  claimTutorial,
  getTutorialProgress,
  purchaseProtection,
};
