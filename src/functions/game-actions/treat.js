/**
 * Treat Action Handler
 *
 * POST /api/game-actions/treat
 *
 * CONTRACT RULES (from phase-6-game-logic-setup.ts):
 * - Cost: 20 Essence
 * - Cooldown: 14400 seconds (4 hours)
 * - Max Daily: 0 (unlimited, cooldown-limited)
 * - Min Happiness: 0 (no requirement)
 * - Happiness Change: +10 (increases happiness)
 * - Experience Gain: 0 (no XP from treating)
 */

const { getTotem, deductEssence, getUser, updateUser } = require('../../common/db-client');
const {
  ACTION_CONFIGS,
  checkCooldown,
  formatCooldownRemaining,
  getXpGain,
  calculateStatChanges,
  buildActionResult,
} = require('./helpers');
const { onGameAction, checkBalancedCare } = require('../../services/achievements-service');
const { addTotemXp } = require('../../services/totem-xp');

/**
 * Give a totem a treat
 *
 * @param {object} user - Authenticated user { userId }
 * @param {string} totemId - The totem to treat
 * @returns {object} - Action result
 */
async function treat(user, totemId) {
  const userId = user.userId;
  const actionType = 'treat';
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

  // 4. Check cooldown (treat has 4-hour cooldown)
  const cooldownStatus = checkCooldown(totem.cooldowns?.treat, actionType);

  if (cooldownStatus.onCooldown) {
    return {
      success: false,
      error: {
        code: 'ON_COOLDOWN',
        message: `Treat is on cooldown. Ready in ${formatCooldownRemaining(cooldownStatus.remainingMs)}`,
        readyAt: cooldownStatus.readyAt.toISOString(),
        remainingMs: cooldownStatus.remainingMs,
      },
    };
  }

  // 4. Deduct Essence cost
  const cost = config.cost;
  const balanceResult = await deductEssence(userId, cost, { type: 'action_treat', ref: totemId, refType: 'totem' });
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

  // 5. Calculate XP gain - FIXED value from contract (0 XP for treat)
  const xpGained = getXpGain(actionType);

  // 5. Calculate stat changes - FIXED happiness change from contract (+10)
  const statChanges = calculateStatChanges(actionType, totem);

  // 6. Update totem in database (chokepoint applies XP + prestige check atomically)
  const now = new Date().toISOString();
  const todayUTC = now.slice(0, 10);
  const newLastActionDates = { ...(totem.lastActionDates || {}), treat: todayUTC };
  const xpResult = await addTotemXp(userId, totem, xpGained, {
    extraUpdates: {
      'stats.happiness': statChanges.happiness,
      'cooldowns.treat': now,
      lastActionDates: newLastActionDates,
    },
  });

  // 8. Update user's total treat count and trigger achievement check
  let totalTreatCount;
  // Prestige unlocks (if any) come from the XP chokepoint.
  let achievements = [...(xpResult.achievements || [])];
  try {
    const userRecord = await getUser(userId);
    totalTreatCount = (userRecord?.stats?.totalTreatCount || 0) + 1;
    await updateUser(userId, { 'stats.totalTreatCount': totalTreatCount });
    const achResults = await onGameAction(userId, 'treat', totalTreatCount, totemId);
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
    console.error('Failed to process treat achievement:', achievementErr);
  }

  // Balanced-care (Daily Trifecta).
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

  // 9. Build response
  const result = buildActionResult(actionType, totem, statChanges, xpGained);

  return {
    success: true,
    data: {
      ...result,
      message: `Gave your totem a treat! +${statChanges.happinessChange} happiness`,
      essenceSpent: cost,
      newEssenceBalance: balanceResult.newBalance,
      achievements,
    },
  };
}

module.exports = { treat };
