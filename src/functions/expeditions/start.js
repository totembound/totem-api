/**
 * Start Expedition Handler
 *
 * POST /api/expeditions/start
 *
 * Body: { totemId, expeditionId }
 *
 * Starts an expedition for a totem. Validates totem ownership, stage requirements,
 * and checks if totem is already on an expedition.
 */

const { startExpedition, getExpeditionDefinition } = require('../../services/expeditions-service');
const { emitQuestProgress } = require('../../services/daily-quests-service');

const DOMAIN_NAMES = ['air', 'earth', 'water'];

/**
 * Start a new expedition for a totem
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { totemId, expeditionId }
 * @returns {object} - Expedition start result
 */
async function startExpeditionHandler(user, body) {
  const userId = user.userId;
  const { totemId, totemIds, expeditionId } = body || {};

  // 1. Validate required parameters
  if (!totemId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'totemId is required' },
    };
  }

  if (!expeditionId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'expeditionId is required' },
    };
  }

  // 2. Validate totemId format
  if (!totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 3. Validate expeditionId format (expedition IDs are kebab-case like 'meadow-stroll')
  if (typeof expeditionId !== 'string' || expeditionId.length === 0) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid expedition ID format' },
    };
  }

  // 4. Start the expedition via service
  try {
    const result = await startExpedition(userId, totemId, expeditionId, totemIds);

    if (!result.success) {
      // Map service errors to API error codes
      let errorCode = 'START_FAILED';
      if (result.error === 'Invalid expedition') {
        errorCode = 'NOT_FOUND';
      }
      else if (result.error === 'Totem not found') {
        errorCode = 'NOT_FOUND';
      }
      else if (result.error === 'Not enough totems') {
        errorCode = 'NOT_ENOUGH_TOTEMS';
      }
      else if (result.error === 'Totem stage too low') {
        errorCode = 'STAGE_REQUIREMENT_NOT_MET';
      }
      else if (result.error === 'Totem is busy') {
        errorCode = 'TOTEM_BUSY';
      }
      else if (result.error === 'Insufficient happiness') {
        errorCode = 'INSUFFICIENT_HAPPINESS';
      }

      return {
        success: false,
        error: {
          code: errorCode,
          message: result.message,
          activeExpedition: result.activeExpedition,
        },
      };
    }

    const def = getExpeditionDefinition(expeditionId);
    const domain = def ? DOMAIN_NAMES[def.domain] : null;
    const duration = def ? def.durationMinutes * 60 : null;

    return {
      success: true,
      data: {
        expedition: result.expedition,
        message: `Expedition "${result.expedition.name}" started! Returns in ${result.expedition.durationMinutes} minutes.`,
        quests: await emitQuestProgress(userId, 'EXPEDITION_STARTED', { expeditionId, domain, duration }),
      },
    };
  }
  catch (err) {
    console.error('Failed to start expedition:', err);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to start expedition' },
    };
  }
}

module.exports = { startExpeditionHandler };
