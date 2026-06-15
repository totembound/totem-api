/**
 * Active Expeditions Handler
 *
 * GET /api/expeditions/active
 *
 * Returns all active expeditions for the authenticated user with time remaining.
 */

const {
  getActiveExpeditions,
  getExpeditionDefinition,
} = require('../../services/expeditions-service');

/**
 * Get all active expeditions for a user
 *
 * @param {object} user - Authenticated user { userId }
 * @returns {object} - List of active expeditions with status
 */
async function getActiveExpeditionsHandler(user) {
  const userId = user.userId;
  const now = new Date();

  try {
    // 1. Get all active expeditions
    const activeExpeditions = await getActiveExpeditions(userId);

    // 2. Enrich with expedition details and time calculations
    const expeditionsWithDetails = activeExpeditions.map((exp) => {
      const definition = getExpeditionDefinition(exp.expeditionId);
      const endsAt = new Date(exp.endsAt);
      const startedAt = new Date(exp.startedAt);
      const isComplete = now >= endsAt;

      // Calculate progress percentage
      const totalDurationMs = definition ? definition.durationMinutes * 60 * 1000 : 0;
      const elapsedMs = now.getTime() - startedAt.getTime();
      const progress = isComplete ? 100 : Math.min(100, Math.floor((elapsedMs / totalDurationMs) * 100));

      // Calculate remaining time
      const remainingMs = isComplete ? 0 : endsAt.getTime() - now.getTime();
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      return {
        id: exp.id,
        expeditionId: exp.expeditionId,
        name: definition?.name || exp.expeditionId,
        description: definition?.description || '',
        totemId: exp.totemId,
        totemIds: exp.totemIds || [exp.totemId],
        startedAt: exp.startedAt,
        endsAt: exp.endsAt,
        durationMinutes: definition?.durationMinutes || 0,
        status: isComplete ? 'completed' : 'in_progress',
        canClaim: isComplete && !exp.claimed,
        progress,
        remainingMinutes,
        remainingMs,
        rewardRange: definition
          ? { min: definition.rewardMin, max: definition.rewardMax }
          : null,
        bonusChance: definition?.bonusChance || 0,
      };
    });

    // 3. Separate into in-progress and claimable
    const inProgress = expeditionsWithDetails.filter((e) => e.status === 'in_progress');
    const claimable = expeditionsWithDetails.filter((e) => e.canClaim);

    // 4. Sort: claimable first, then by time remaining
    expeditionsWithDetails.sort((a, b) => {
      if (a.canClaim !== b.canClaim) {
        return a.canClaim ? -1 : 1;
      }
      return a.remainingMs - b.remainingMs;
    });

    return {
      success: true,
      data: {
        expeditions: expeditionsWithDetails,
        summary: {
          total: expeditionsWithDetails.length,
          inProgress: inProgress.length,
          claimable: claimable.length,
        },
      },
    };
  }
  catch (err) {
    console.error('Failed to get active expeditions:', err);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve active expeditions' },
    };
  }
}

module.exports = { getActiveExpeditionsHandler };
