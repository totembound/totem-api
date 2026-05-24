const { getUser } = require('../../common/db-client');
const {
  getOrCreateTodayQuests,
  getDailyTheme,
  getNextUTCMidnight,
} = require('../../services/daily-quests-service');

async function getDailyQuests(user) {
  if (!user || !user.userId) {
    return { success: false, error: { code: 'UNAUTHORIZED', message: 'User authentication required' } };
  }
  try {
    const fullUser = await getUser(user.userId);
    if (!fullUser) {
      return { success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } };
    }

    const now = new Date();
    const record = await getOrCreateTodayQuests(user.userId, fullUser, now);

    const enrichedQuests = record.quests.map(q => ({
      ...q,
      completed: q.progress >= q.goal,
    }));

    const bonusUnlocked = enrichedQuests.length === 5 && enrichedQuests.every(q => q.claimed);

    return {
      success: true,
      data: {
        date: record.date,
        theme: record.theme || getDailyTheme(now),
        nextResetAt: getNextUTCMidnight(now),
        quests: enrichedQuests,
        bonus: {
          reward: record.bonus.reward,
          claimed: record.bonus.claimed,
          unlocked: bonusUnlocked,
        },
      },
    };
  }
  catch (err) {
    console.error('[getDailyQuests] Error:', err);
    return { success: false, error: { code: 'INTERNAL_ERROR', message: err.message } };
  }
}

module.exports = { getDailyQuests };
