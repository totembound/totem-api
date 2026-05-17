/**
 * Feed Action Handler
 *
 * POST /api/game-actions/feed
 *
 * CONTRACT RULES (from phase-6-game-logic-setup.ts):
 * - Cost: 10 Essence
 * - Cooldown: 0 (uses time windows instead)
 * - Max Daily: 3 (one per 8-hour window)
 * - Min Happiness: 0 (no requirement)
 * - Happiness Change: +10 (increases happiness)
 * - Experience Gain: 0 (no XP from feeding)
 *
 * Time Windows (8-hour UTC slots):
 * - Window 1: 00:00 - 08:00 UTC
 * - Window 2: 08:00 - 16:00 UTC
 * - Window 3: 16:00 - 24:00 UTC
 */

const { getTotem, deductEssence, getUser, updateUser } = require('../../common/db-client');
const {
  ACTION_CONFIGS,
  checkFeedTimeWindow,
  getXpGain,
  calculateStatChanges,
  buildActionResult,
} = require('./helpers');
const { onGameAction, checkBalancedCare } = require('../../services/achievements-service');
const { emitQuestProgress } = require('../../services/daily-quests-service');
const { addTotemXp } = require('../../services/totem-xp');

/**
 * Feed a totem
 *
 * @param {object} user - Authenticated user { userId }
 * @param {string} totemId - The totem to feed
 * @returns {object} - Action result
 */
async function feed(user, totemId) {
  const userId = user.userId;
  const actionType = 'feed';
  const config = ACTION_CONFIGS[actionType];

  // 1. Validate totemId format
  if (!totemId || !totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 2. Get totem from database
  const totem = await getTotem(userId, totemId);

  if (!totem) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Totem not found' },
    };
  }

  // 3. Check totem availability (blocks if on Council Mission)
  const { checkActionAvailability } = require('../../common/totem-utils');
  const availability = checkActionAvailability(totem);
  if (!availability.available) {
    return { success: false, error: availability.error };
  }

  // 4. Check time window (feed uses 8-hour UTC windows, not cooldown)
  const feedHistory = totem.feedHistory || [];
  const windowStatus = checkFeedTimeWindow(feedHistory);

  if (!windowStatus.canFeed) {
    return {
      success: false,
      error: {
        code: 'TIME_WINDOW',
        message: windowStatus.reason,
        remainingMs: windowStatus.remainingMs,
        currentWindow: windowStatus.currentWindow,
        feedsToday: windowStatus.feedsToday,
        maxDaily: windowStatus.maxDaily,
      },
    };
  }

  // 4. Deduct Essence cost
  const cost = config.cost;
  const balanceResult = await deductEssence(userId, cost, { type: 'action_feed', ref: totemId, refType: 'totem' });
  if (!balanceResult.success) {
    return {
      success: false,
      error: {
        code: 'INSUFFICIENT_BALANCE',
        message: `Not enough Essence. Need ${cost}, have ${balanceResult.available || 0}`,
        required: cost,
        available: balanceResult.available || 0,
      },
    };
  }

  // 5. Calculate XP gain - FIXED value from contract (0 XP for feed)
  const xpGained = getXpGain(actionType);

  // 5. Calculate stat changes - FIXED happiness change from contract (+10)
  const statChanges = calculateStatChanges(actionType, totem);

  // 6. Update totem in database (chokepoint applies XP + prestige check atomically)
  const now = new Date().toISOString();

  // Add to feed history for time window tracking
  const newFeedHistory = [...feedHistory, { timestamp: now, window: windowStatus.currentWindow }];
  // Keep only last 7 days of history
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const prunedHistory = newFeedHistory.filter((f) => new Date(f.timestamp).getTime() > sevenDaysAgo);

  const todayUTC = now.slice(0, 10);
  const newLastActionDates = { ...(totem.lastActionDates || {}), feed: todayUTC };
  const xpResult = await addTotemXp(userId, totem, xpGained, {
    extraUpdates: {
      'stats.happiness': statChanges.happiness,
      'stats.hunger': statChanges.hunger || 100,
      feedHistory: prunedHistory,
      lastActionDates: newLastActionDates,
    },
  });

  // 7. Update user's total feed count and trigger achievement check
  let totalFeedCount;
  let userRecord;
  // Prestige unlocks (if any) come from the XP chokepoint.
  let achievements = [...(xpResult.achievements || [])];
  try {
    userRecord = await getUser(userId);
    totalFeedCount = (userRecord?.stats?.totalFeedCount || 0) + 1;
    await updateUser(userId, { 'stats.totalFeedCount': totalFeedCount });
    const achResults = await onGameAction(userId, 'feed', totalFeedCount, totemId);
    for (const a of (achResults || [])) {
      if (a.unlocked) {
        achievements.push({
          achievementId: a.achievementId,
          milestone: a.milestone,
          rewards: a.rewards,
        });
      }
    }
  }
  catch (achievementErr) {
    console.error('Failed to process feed achievement:', achievementErr);
  }

  // 7b. Balanced-care (Daily Trifecta) — uses merged in-memory totem state.
  try {
    const mergedTotem = { ...totem, lastActionDates: newLastActionDates };
    const trifectaResults = await checkBalancedCare(userId, mergedTotem);
    for (const a of (trifectaResults || [])) {
      if (a.unlocked) {
        achievements.push({ achievementId: a.achievementId, milestone: a.milestone, rewards: a.rewards });
      }
    }
  }
  catch (achievementErr) {
    console.error('Failed to process balanced-care:', achievementErr);
  }

  // 8. Build response
  const result = buildActionResult(actionType, totem, statChanges, xpGained);

  return {
    success: true,
    data: {
      ...result,
      message: `Fed your totem! +${statChanges.happinessChange} happiness`,
      feedsToday: windowStatus.feedsToday + 1,
      maxDaily: windowStatus.maxDaily,
      essenceSpent: cost,
      newEssenceBalance: balanceResult.newBalance,
      achievements,
      quests: await emitQuestProgress(userId, 'ACTION_FEED', { totemId }, { user: userRecord }),
    },
  };
}

module.exports = { feed };
