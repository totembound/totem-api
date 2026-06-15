const { batchClaim, getTodayUTCDateString, getNextUTCMidnight } = require('../../services/daily-quests-service');

async function claimDailyQuests(user) {
  if (!user || !user.userId) {
    return { success: false, error: { code: 'UNAUTHORIZED', message: 'User authentication required' } };
  }
  try {
    const now = new Date();
    const date = getTodayUTCDateString(now);
    const result = await batchClaim(user.userId, date, now);

    return {
      success: true,
      data: {
        claimed: result.claimed,
        bonusClaimed: result.bonusClaimed,
        totalEssenceAwarded: result.totalEssenceAwarded,
        newEssenceBalance: result.newBalance,
        nextResetAt: getNextUTCMidnight(now),
        runesAwarded: result.runesAwarded || null,
        achievements: result.achievements || [],
      },
    };
  }
  catch (err) {
    console.error('[claimDailyQuests] Error:', err);
    return { success: false, error: { code: 'INTERNAL_ERROR', message: err.message } };
  }
}

module.exports = { claimDailyQuests };
