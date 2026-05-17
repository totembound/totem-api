/**
 * Totem Forge Handler
 *
 * POST /v1/totems/forge
 *
 * Fuses 3 totems of the same rarity into 1 totem of the next rarity.
 * Two modes:
 *   - Pure Fusion: all 3 same species → result keeps that species
 *   - Wild Fusion: mixed species → result gets random species
 *
 * Request body: { totemIds: [string, string, string] }
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     action: 'forge',
 *     fusionType: 'pure' | 'wild',
 *     consumedTotemIds: [...],
 *     newTotem: { ... },
 *     newEssenceBalance: number,
 *     achievements: [...]
 *   }
 * }
 */

const {
  getTotem,
  getUserTotems,
  updateItem,
  transactWrite,
  getUser,
  updateUser,
  logTransaction,
  TABLES,
} = require('../../common/db-client');

const {
  createTotem,
  selectRandomSpecies,
  RARITIES,
} = require('../../services/totem-creation');

const {
  SPECIES_DISPLAY_NAMES,
  getTotemImageUrl,
} = require('../../config/totem-config');

const { getActiveExpeditions } = require('../../services/expeditions-service');
const { onTotemFused } = require('../../services/achievements-service');
const { emitQuestProgress } = require('../../services/daily-quests-service');

// Max forgeable rarity (Legendary = 4)
const MAX_FORGE_RARITY = 3; // Epic is the highest input rarity (produces Legendary)
const EXCLUDED_RARITY = 5;  // Limited totems are never consumed

/**
 * Forge (fuse) 3 totems into 1 of the next rarity
 *
 * @param {object} user - Authenticated user from JWT middleware
 * @param {object} body - Request body
 * @param {string[]} body.totemIds - Array of exactly 3 totem IDs to fuse
 * @returns {object} Forge result
 */
async function forgeTotem(user, body = {}) {
  const userId = user.userId;
  const { totemIds } = body;

  // ── Validate totemIds array ──
  if (!Array.isArray(totemIds) || totemIds.length !== 3) {
    return {
      success: false,
      error: { code: 'INVALID_IDS', message: 'Must provide exactly 3 totem IDs' },
    };
  }

  // Check all are strings starting with ttm_
  for (const id of totemIds) {
    if (typeof id !== 'string' || !id.startsWith('ttm_')) {
      return {
        success: false,
        error: { code: 'INVALID_IDS', message: `Invalid totem ID format: ${id}` },
      };
    }
  }

  // Check all unique
  const uniqueIds = new Set(totemIds);
  if (uniqueIds.size !== 3) {
    return {
      success: false,
      error: { code: 'INVALID_IDS', message: 'All 3 totem IDs must be unique' },
    };
  }

  // ── Fetch all 3 totems ──
  const totems = await Promise.all(
    totemIds.map(id => getTotem(userId, id))
  );

  // Check all exist and belong to user
  for (let i = 0; i < 3; i++) {
    if (!totems[i]) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Totem ${totemIds[i]} not found or not owned by you` },
      };
    }
  }

  // ── Check none are on active expeditions ──
  // This check MUST succeed — if the expedition service is down, block the forge
  // to prevent consuming totems that are on active expeditions.
  let activeExpeditions;
  try {
    activeExpeditions = await getActiveExpeditions(userId);
  } catch (err) {
    console.error('[forge] Expedition check failed — blocking forge for safety:', err.message);
    return {
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Unable to verify expedition status. Please try again.' },
    };
  }

  const expeditionTotemIds = new Set();
  for (const exp of activeExpeditions) {
    if (exp.totemId) expeditionTotemIds.add(exp.totemId);
    if (exp.totemIds) {
      for (const tid of exp.totemIds) expeditionTotemIds.add(tid);
    }
  }

  for (const id of totemIds) {
    if (expeditionTotemIds.has(id)) {
      return {
        success: false,
        error: { code: 'ON_EXPEDITION', message: `Totem ${id} is currently on an expedition` },
      };
    }
  }

  // ── Validate rarity ──
  const rarityId = totems[0].rarityId;

  // Check all same rarity
  for (const totem of totems) {
    if (totem.rarityId !== rarityId) {
      return {
        success: false,
        error: { code: 'RARITY_MISMATCH', message: 'All 3 totems must be the same rarity' },
      };
    }
  }

  // Check rarity is valid and forgeable
  if (rarityId < 0 || rarityId > MAX_FORGE_RARITY || rarityId === EXCLUDED_RARITY) {
    return {
      success: false,
      error: { code: 'MAX_RARITY', message: 'Cannot forge Legendary or Limited totems' },
    };
  }

  // ── Determine fusion type ──
  const allSameSpecies = totems[0].speciesId === totems[1].speciesId
    && totems[1].speciesId === totems[2].speciesId;
  const fusionType = allSameSpecies ? 'pure' : 'wild';

  // ── Determine new totem species ──
  const newRarityId = rarityId + 1;
  let speciesId;
  if (allSameSpecies) {
    speciesId = totems[0].speciesId;
  } else {
    const randomSpecies = selectRandomSpecies();
    speciesId = randomSpecies.speciesId;
  }

  // ── Create new totem with forced rarity ──
  const newTotemData = createTotem({
    userId,
    speciesId,
    forcedRarityId: newRarityId,
  });

  // ── Atomic transaction: delete 3 old + create 1 new ──
  const transactItems = [
    // Create new totem
    {
      Put: {
        TableName: TABLES.TOTEMS,
        Item: newTotemData,
      },
    },
    // Delete the 3 input totems
    ...totemIds.map(id => ({
      Delete: {
        TableName: TABLES.TOTEMS,
        Key: {
          pk: `USER#${userId}`,
          sk: `TOTEM#${id}`,
        },
        ConditionExpression: 'attribute_exists(pk)',
      },
    })),
  ];

  try {
    await transactWrite(transactItems);
  } catch (err) {
    console.error('[forge] Transaction failed:', err.message);
    if (err.name === 'TransactionCanceledException') {
      return {
        success: false,
        error: { code: 'TRANSACTION_FAILED', message: 'Fusion failed — one or more totems may have been modified. Please try again.' },
      };
    }
    throw err;
  }

  // ── Log transaction with enriched analytics fields ──
  // Uses logTransaction for consistent PK/SK/ID generation, then updateItem for forge-specific fields
  try {
    const txn = await logTransaction(userId, {
      type: 'totem_forge',
      currency: 'essence',
      amount: 0,
      balanceBefore: 0,
      balanceAfter: 0,
      ref: newTotemData.id,
      refType: 'forge',
      refName: `${fusionType}_fusion_${RARITIES[rarityId]?.name || rarityId}_to_${RARITIES[newRarityId]?.name || newRarityId}`,
      quantity: 3,
    });

    // Enrich with forge-specific analytics (schemaless DynamoDB — extra fields for queries)
    await updateItem(TABLES.TRANSACTIONS, { pk: txn.pk, sk: txn.sk }, {
      fusionType,
      inputRarityId: rarityId,
      outputRarityId: newRarityId,
      consumedTotemIds: totemIds,
      inputSpeciesIds: totems.map(t => t.speciesId),
      outputSpeciesId: newTotemData.speciesId,
      outputColorId: newTotemData.colorId,
      essenceValueBurned: totemIds.length * 500,
    });
  } catch (err) {
    console.warn('[forge] Failed to log transaction:', err.message);
  }

  // ── Get updated totem count and Essence balance ──
  let totalTotemCount = 1;
  let essenceBalance = 0;
  try {
    const [allTotems, userData] = await Promise.all([
      getUserTotems(userId),
      getUser(userId),
    ]);
    totalTotemCount = allTotems.length;
    essenceBalance = userData?.currencies?.essence || 0;

    // Update stats.totalTotems
    await updateUser(userId, { 'stats.totalTotems': totalTotemCount });
  } catch (err) {
    console.warn('[forge] Failed to update stats:', err.message);
  }

  // ── Trigger achievements ──
  let achievements = [];
  try {
    // Get user's fusion stats from existing achievement progress
    let totalFusionCount = 1;
    let totalPureFusionCount = fusionType === 'pure' ? 1 : 0;
    let totalWildFusionCount = fusionType === 'wild' ? 1 : 0;

    const { getAchievementProgress } = require('../../services/achievements-service');
    const fusionProgress = await getAchievementProgress(userId, 'ach_fusion-progression');
    if (fusionProgress) {
      totalFusionCount = (fusionProgress.currentValue || 0) + 1;
    }
    const pureProgress = await getAchievementProgress(userId, 'ach_pure-fusion');
    if (pureProgress && fusionType === 'pure') {
      totalPureFusionCount = (pureProgress.currentValue || 0) + 1;
    }
    const wildProgress = await getAchievementProgress(userId, 'ach_wild-fusion');
    if (wildProgress && fusionType === 'wild') {
      totalWildFusionCount = (wildProgress.currentValue || 0) + 1;
    }

    const achResults = await onTotemFused(userId, {
      isPureFusion: allSameSpecies,
      newRarityId,
      totalFusionCount,
      totalPureFusionCount,
      totalWildFusionCount,
      totalTotemCount,
      totemId: newTotemData.id,
    });
    achievements = achResults.filter(a => a.unlocked);
  } catch (err) {
    console.error('[forge] Failed to process achievements:', err.message);
  }

  // ── Build response ──
  return {
    success: true,
    data: {
      action: 'forge',
      fusionType,
      consumedTotemIds: totemIds,
      newTotem: {
        id: newTotemData.id,
        speciesId: newTotemData.speciesId,
        speciesName: SPECIES_DISPLAY_NAMES[newTotemData.speciesId] || 'Unknown',
        colorId: newTotemData.colorId,
        rarityId: newTotemData.rarityId,
        nickname: newTotemData.nickname || null,
        stage: newTotemData.stage,
        experience: newTotemData.experience,
        stats: newTotemData.stats,
        image: getTotemImageUrl(newTotemData.speciesId, newTotemData.colorId, 0),
        createdAt: newTotemData.createdAt,
      },
      newEssenceBalance: essenceBalance,
      achievements: achievements.map(a => ({
        achievementId: a.achievementId,
        milestone: a.milestone,
        rewards: a.rewards,
      })),
      quests: await emitQuestProgress(userId, 'TOTEM_FORGED', { fusionType, newRarityId }),
    },
  };
}

module.exports = {
  forgeTotem,
};
