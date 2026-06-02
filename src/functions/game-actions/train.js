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
  HUNGER,
} = require('./helpers');
const { onGameAction, checkBalancedCare } = require('../../services/achievements-service');
const { emitQuestProgress } = require('../../services/daily-quests-service');
const { addTotemXp } = require('../../services/totem-xp');
const { resolveTraitBonuses } = require('../../config/trait-effects');

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

  // 4b. Hunger gate — too hungry to train. `totem.stats.hunger` is already the
  // decayed value (the read boundary decayed it). Checked BEFORE deductEssence so
  // a blocked train never charges the player.
  const currentHunger = totem.stats?.hunger ?? HUNGER.max;
  if (currentHunger < HUNGER.trainMin) {
    return {
      success: false,
      error: {
        code: 'TOO_HUNGRY',
        message: `Your totem is too hungry to train (need ${HUNGER.trainMin}, have ${currentHunger}). Feed it first.`,
        required: HUNGER.trainMin,
        current: currentHunger,
      },
    };
  }

  // 5. Resolve trait bonuses (self-scope) and deduct Essence cost.
  // Thrifty: ×0.90 cost; Quick Learner: ×1.10 XP; Gentle: +2 to happinessChange.
  const bonuses = resolveTraitBonuses(totem, { action: actionType });
  const cost = Math.floor(config.cost * bonuses.essenceCostMultiplier);
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

  // 6. Calculate XP gain — base 50 × trait xpMultiplier (Quick Learner).
  const xpGained = Math.round(getXpGain(actionType) * bonuses.xpMultiplier);

  // 6. Calculate stat changes — happinessFlat folds in here. In the "cranky" band
  // (trainMin ≤ hunger < happinessPenaltyBelow) training is allowed but costs 2×
  // happiness. Below trainMin it's already blocked above, so this never stacks.
  const hungerMultiplier = currentHunger < HUNGER.happinessPenaltyBelow ? 2 : 1;
  const statChanges = calculateStatChanges(actionType, totem, bonuses, hungerMultiplier);

  // 7. Update totem in database (chokepoint applies XP + prestige check atomically)
  const now = new Date().toISOString();
  const todayUTC = now.slice(0, 10);
  const newLastActionDates = { ...(totem.lastActionDates || {}), train: todayUTC };
  const extraUpdates = {
    'stats.happiness': statChanges.happiness,
    // Persist the decayed hunger + advanced anchor together so the (value, clock)
    // pair stays consistent (the read boundary decayed hunger in-memory only).
    'stats.hunger': currentHunger,
    hungerUpdatedAt: totem.hungerUpdatedAt,
    lastActionDates: newLastActionDates,
  };
  if (config.cooldown > 0) {
    extraUpdates['cooldowns.train'] = now;
  }
  const xpResult = await addTotemXp(userId, totem, xpGained, { extraUpdates });

  // 9. Update user's total train count and trigger achievement check
  let totalTrainCount;
  let userRecord;
  // Prestige unlocks (if any) come from the XP chokepoint.
  const achievements = [...(xpResult.achievements || [])];
  try {
    userRecord = await getUser(userId);
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
      quests: await emitQuestProgress(userId, 'ACTION_TRAIN', { totemId }, { user: userRecord }),
    },
  };
}

module.exports = { train };
