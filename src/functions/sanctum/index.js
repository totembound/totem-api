/**
 * Sanctum API Handlers
 *
 * Routes:
 * - GET  /v1/sanctum                - Get sanctum state (seats, earnings, max seats)
 * - POST /v1/sanctum/seat           - Seat a Stage 4 totem
 * - POST /v1/sanctum/unseat         - Remove a totem from the sanctum
 * - POST /v1/sanctum/claim          - Claim accumulated Essence earnings
 * - GET  /v1/sanctum/missions       - Get available council missions
 * - POST /v1/sanctum/missions/start - Start a council mission
 * - POST /v1/sanctum/missions/claim - Claim council mission rewards
 * - POST /v1/sanctum/missions/cancel - Cancel a council mission
 */

const { getSanctum } = require('./get-sanctum');
const { seatTotem } = require('./seat');
const { unseatTotem } = require('./unseat');
const { claimSanctum } = require('./claim');
const { getCouncilMissions } = require('./missions');
const { startCouncilMission } = require('./mission-start');
const { claimCouncilMission } = require('./mission-claim');
const { cancelCouncilMission } = require('./mission-cancel');

module.exports = {
  getSanctum,
  seatTotem,
  unseatTotem,
  claimSanctum,
  getCouncilMissions,
  startCouncilMission,
  claimCouncilMission,
  cancelCouncilMission,
};
