const { getUser } = require('../../common/db-client');
const {
  getOrCreateTodayQuests,
  getDailyTheme,
  getNextUTCMidnight,
} = require('../../services/daily-quests-service');
const { getTierMultiplier } = require('../../services/tier-bonuses');

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

    // Subscription tier scales the ESSENCE shown (steps + bonus) so the UI matches
    // what batchClaim awards. Stored record stays at base; rune bonus is unscaled.
    const tierMultiplier = getTierMultiplier(fullUser.tier || 'free');
    const scaleEssence = (reward) => ({ ...reward, essence: (reward.essence || 0) * tierMultiplier });

    const enrichedQuests = record.quests.map(q => ({
      ...q,
      reward: scaleEssence(q.reward),
      completed: q.progress >= q.goal,
    }));

    const bonusUnlocked = enrichedQuests.length === 5 && enrichedQuests.every(q => q.claimed);

    return {
      success: true,
      data: {
        date: record.date,
        theme: record.theme || getDailyTheme(now),
        nextResetAt: getNextUTCMidnight(now),
        tierMultiplier,
        quests: enrichedQuests,
        bonus: {
          reward: scaleEssence(record.bonus.reward),
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
