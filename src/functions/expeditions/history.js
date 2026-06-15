/**
 * Expedition History Handler
 *
 * GET /api/expeditions/history
 *
 * Query params: limit (optional, default 50)
 *
 * Returns past completed expeditions for the authenticated user.
 */

const { getExpeditionHistory } = require('../../services/expeditions-service');

/**
 * Get expedition history for a user
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} query - Query parameters { limit }
 * @returns {object} - List of past completed expeditions
 */
async function getExpeditionHistoryHandler(user, query) {
  const userId = user.userId;
  const limit = parseInt(query?.limit, 10) || 50;

  // Validate limit
  if (limit < 1 || limit > 100) {
    return {
      success: false,
      error: {
        code: 'INVALID_PARAM',
        message: 'Limit must be between 1 and 100',
      },
    };
  }

  try {
    // 1. Get expedition history from service
    const history = await getExpeditionHistory(userId, limit);

    // 2. Calculate summary statistics
    const totalEssence = history.reduce(
      (sum, exp) => sum + (exp.essenceEarned || 0),
      0
    );
    const totalBonusItems = history.reduce(
      (sum, exp) => sum + (exp.bonusItems?.length || 0),
      0
    );

    // Group by expedition type
    const byExpedition = history.reduce((acc, exp) => {
      const key = exp.expeditionId;
      if (!acc[key]) {
        acc[key] = {
          expeditionId: key,
          expeditionName: exp.expeditionName,
          count: 0,
          totalEssence: 0,
        };
      }
      acc[key].count += 1;
      acc[key].totalEssence += exp.essenceEarned || 0;
      return acc;
    }, {});

    // 3. Format history records
    const formattedHistory = history.map((exp) => ({
      id: exp.id,
      expeditionId: exp.expeditionId,
      expeditionName: exp.expeditionName,
      totemId: exp.totemId,
      startedAt: exp.startedAt,
      completedAt: exp.completedAt,
      durationMinutes: exp.durationMinutes,
      essenceEarned: exp.essenceEarned,
      bonusItems: exp.bonusItems || [],
    }));

    return {
      success: true,
      data: {
        history: formattedHistory,
        byExpedition: Object.values(byExpedition),
        summary: {
          totalExpeditions: history.length,
          totalEssenceEarned: totalEssence,
          totalBonusItems,
          averageEssence:
            history.length > 0 ? Math.round(totalEssence / history.length) : 0,
        },
        pagination: {
          limit,
          count: history.length,
          hasMore: history.length === limit,
        },
      },
    };
  }
  catch (err) {
    console.error('Failed to get expedition history:', err);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve expedition history' },
    };
  }
}

module.exports = { getExpeditionHistoryHandler };
