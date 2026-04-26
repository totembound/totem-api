/**
 * Train Action Handler
 *
 * POST /api/game-actions/train
 *
 * CONTRACT RULES (from phase-6-game-logic-setup.ts):
 * - Cost: 20 Essence
 * - Cooldown: 0 (no cooldown)
 * - Min Happiness: 20 (must have at least 20 happiness)
 * - Happiness Change: -10 (decreases happiness)
 * - Experience Gain: 50 (main XP source)
 */

const { getTotem, deductEssence, getUser, updateUser } = require('../../common/db-client');
const {
  ACTION_CONFIGS,
  checkCooldown,
  formatCooldownRemaining,
  getXpGain,
  getMinHappiness,
  calculateStatChanges,
  buildActionResult,
} = require('./helpers');
const { onGameAction, checkBalancedCare } = require('../../services/achievements-service');
const { addTotemXp } = require('../../services/totem-xp');

/**
 * Train a totem
 *
 * @param {object} user - Authenticated user { userId }
 * @param {string} totemId - The totem to train
 * @returns {object} - Action result
 */
async function train(user, totemId) {
  const userId = user.userId;
  const actionType = 'train';
  const config = ACTION_CONFIGS[actionType];

  // 1. Validate totemId format
  if (!totemId || !totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 2. Get totem from database
  console.log('[train] Looking up totem:', { userId, totemId, pk: `USER#${userId}`, sk: `TOTEM#${totemId}` });
  const totem = await getTotem(userId, totemId);
  console.log('[train] getTotem result:', totem ? 'found' : 'NOT FOUND');

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

  // 4. Check cooldown (train has cooldown: 0, so this should always pass)
  const cooldownStatus = checkCooldown(totem.cooldowns?.train, actionType);

  if (cooldownStatus.onCooldown) {
    return {
      success: false,
      error: {
        code: 'ON_COOLDOWN',
        message: `Train is on cooldown. Ready in ${formatCooldownRemaining(cooldownStatus.remainingMs)}`,
        readyAt: cooldownStatus.readyAt.toISOString(),
        remainingMs: cooldownStatus.remainingMs,
      },
    };
  }

  // 4. Check minimum happiness requirement (train requires 20+)
  const currentHappiness = totem.stats?.happiness || 50;
  const minHappiness = getMinHappiness(actionType);

  if (currentHappiness < minHappiness) {
    return {
      success: false,
      error: {
        code: 'LOW_HAPPINESS',
        message: `Totem needs at least ${minHappiness} happiness to train (current: ${currentHappiness})`,
        required: minHappiness,
        current: currentHappiness,
      },
    };
  }

  // 5. Deduct Essence cost
  const cost = config.cost;
  const balanceResult = await deductEssence(userId, cost, { type: 'action_train', ref: totemId, refType: 'totem' });
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

  // 6. Calculate XP gain - FIXED value from contract (50 XP)
  const xpGained = getXpGain(actionType);

  // 6. Calculate stat changes - FIXED happiness change from contract (-10)
  const statChanges = calculateStatChanges(actionType, totem);

  // 7. Update totem in database (chokepoint applies XP + prestige check atomically)
  const now = new Date().toISOString();
  const todayUTC = now.slice(0, 10);
  const newLastActionDates = { ...(totem.lastActionDates || {}), train: todayUTC };
  const extraUpdates = {
    'stats.happiness': statChanges.happiness,
    lastActionDates: newLastActionDates,
  };
  if (config.cooldown > 0) {
    extraUpdates['cooldowns.train'] = now;
  }
  const xpResult = await addTotemXp(userId, totem, xpGained, { extraUpdates });

  // 9. Update user's total train count and trigger achievement check
  let totalTrainCount;
  // Prestige unlocks (if any) come from the XP chokepoint.
  let achievements = [...(xpResult.achievements || [])];
  try {
    const userRecord = await getUser(userId);
    totalTrainCount = (userRecord?.stats?.totalTrainCount || 0) + 1;
    await updateUser(userId, { 'stats.totalTrainCount': totalTrainCount });
    const achResults = await onGameAction(userId, 'train', totalTrainCount, totemId);
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
    console.error('Failed to process train achievement:', achievementErr);
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

  // 10. Build response
  const result = buildActionResult(actionType, totem, statChanges, xpGained);

  return {
    success: true,
    data: {
      ...result,
      message: `Trained your totem! +${xpGained} XP, ${statChanges.happinessChange} happiness`,
      essenceSpent: cost,
      newEssenceBalance: balanceResult.newBalance,
      achievements,
    },
  };
}

module.exports = { train };
