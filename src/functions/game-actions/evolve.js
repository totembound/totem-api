/**
 * Evolve Action Handler
 *
 * POST /api/game-actions/evolve
 *
 * Evolves a totem to the next stage if requirements are met:
 * - Sufficient experience
 * - Sufficient happiness
 *
 * Stages:
 * 0: Hatchling -> 1: Chick -> 2: Juvenile -> 3: Adult -> 4: Wise Elder
 */

const { getTotem, updateTotem } = require('../../common/db-client');
const {
  checkEvolutionRequirements,
  getStageName,
  MAX_STAGE,
} = require('./helpers');
const { onTotemEvolved } = require('../../services/achievements-service');
const { emitQuestProgress } = require('../../services/daily-quests-service');

/**
 * Evolve a totem to the next stage
 *
 * @param {object} user - Authenticated user { userId }
 * @param {string} totemId - The totem to evolve
 * @returns {object} - Evolution result
 */
async function evolve(user, totemId) {
  const userId = user.userId;

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

  // 3. Check if already at max stage
  const currentStage = totem.stage || 0;
  if (currentStage >= MAX_STAGE) {
    return {
      success: false,
      error: {
        code: 'MAX_STAGE',
        message: 'Totem is already at maximum evolution stage (Wise Elder)',
      },
    };
  }

  // 4. Check evolution requirements
  const evolutionCheck = checkEvolutionRequirements(totem);

  if (!evolutionCheck.canEvolve) {
    return {
      success: false,
      error: {
        code: 'REQUIREMENTS_NOT_MET',
        message: evolutionCheck.reason,
        requirements: evolutionCheck.requirements,
      },
    };
  }

  // 5. Perform evolution
  const newStage = currentStage + 1;
  const speciesId = totem.speciesId;
  const oldStageName = getStageName(speciesId, currentStage);
  const newStageName = getStageName(speciesId, newStage);

  // Scaling stat boost on evolution (+1/+2/+3/+4 for stages 1/2/3/4)
  const evolutionStatBoost = newStage;

  const updates = {
    stage: newStage,
    // Display name is computed dynamically by frontend from species cache
    // Only 'nickname' (user-set) is stored in DB
    // Boost all stats slightly on evolution
    'stats.strength': Math.min(100, (totem.stats?.strength || 5) + evolutionStatBoost),
    'stats.agility': Math.min(100, (totem.stats?.agility || 5) + evolutionStatBoost),
    'stats.wisdom': Math.min(100, (totem.stats?.wisdom || 5) + evolutionStatBoost),
    // Happiness boost from evolving
    'stats.happiness': Math.min(100, (totem.stats?.happiness || 50) + 10),
  };

  await updateTotem(userId, totemId, updates);

  // 6. Trigger evolution achievement
  let achievements = [];
  try {
    const achResults = await onTotemEvolved(userId, {
      newStage,
      totemId,
      rarityId: totem.rarityId,
      speciesId: totem.speciesId,
      colorId: totem.colorId,
    });
    achievements = (achResults || []).filter(a => a.unlocked).map(a => ({
      achievementId: a.achievementId,
      milestone: a.milestone,
      rewards: a.rewards,
    }));
  }
  catch (achievementErr) {
    console.error('Failed to process evolution achievement:', achievementErr);
  }

  // 7. Build response
  return {
    success: true,
    data: {
      action: 'evolve',
      totemId: totem.id,
      evolution: {
        previousStage: currentStage,
        previousStageName: oldStageName,
        newStage,
        newStageName,
      },
      statBoosts: {
        strength: evolutionStatBoost,
        agility: evolutionStatBoost,
        wisdom: evolutionStatBoost,
        happiness: 10,
      },
      message: `Your totem evolved from ${oldStageName} to ${newStageName}!`,
      achievements,
      quests: await emitQuestProgress(userId, 'ACTION_EVOLVE', { totemId, newStage }),
    },
  };
}

/**
 * Get evolution status for a totem
 *
 * GET /api/game-actions/evolution-status/:totemId
 */
async function getEvolutionStatus(user, totemId) {
  const userId = user.userId;

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

  // 3. Check evolution requirements
  const currentStage = totem.stage || 0;
  const evolutionCheck = checkEvolutionRequirements(totem);

  const speciesId = totem.speciesId;

  return {
    success: true,
    data: {
      totemId: totem.id,
      currentStage,
      currentStageName: getStageName(speciesId, currentStage),
      isMaxStage: currentStage >= MAX_STAGE,
      canEvolve: evolutionCheck.canEvolve,
      requirements: evolutionCheck.requirements,
      nextStage: currentStage < MAX_STAGE ? currentStage + 1 : null,
      nextStageName: currentStage < MAX_STAGE ? getStageName(speciesId, currentStage + 1) : null,
    },
  };
}

module.exports = { evolve, getEvolutionStatus };
