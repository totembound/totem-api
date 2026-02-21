/**
 * Totem Purchase Handler
 *
 * POST /api/totems/purchase
 *
 * Creates a new totem for the user by:
 * 1. Validating user has enough Essence (500 cost per migration rules)
 * 2. Deducting Essence from user balance
 * 3. Creating totem with random species/rarity
 * 4. Saving to DynamoDB
 * 5. Triggering achievement updates
 *
 * Request body:
 * {
 *   speciesId?: number,  // Optional: specific species (must be available)
 *   name?: string        // Optional: custom name
 * }
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     totem: { ... },           // Created totem data
 *     newBalance: number,       // New Essence balance
 *     cost: number,             // Cost deducted
 *     achievements: [...]       // Any achievements unlocked
 *   }
 * }
 */

const {
  deductEssence,
  putItem,
  updateUser,
  TABLES,
  getUserTotems,
} = require('../../common/db-client');

const {
  createTotem,
  isSpeciesAvailable,
  SPECIES,
} = require('../../services/totem-creation');

const {
  SPECIES_DISPLAY_NAMES,
  getTotemImageUrl,
} = require('../../config/totem-config');

const { onTotemAcquired } = require('../../services/achievements-service');

// Totem purchase cost (from migration rules)
const TOTEM_PURCHASE_COST = 500;

/**
 * Purchase a new totem
 *
 * @param {Object} user - Authenticated user from JWT middleware
 * @param {Object} body - Request body
 * @param {number} [body.speciesId] - Optional specific species
 * @param {string} [body.name] - Optional custom name
 * @returns {Object} Purchase result with totem data
 */
async function purchaseTotem(user, body = {}) {
  const userId = user.userId;
  const { speciesId, name } = body;

  console.log('[purchaseTotem] userId:', userId, 'speciesId:', speciesId);

  // Validate speciesId if provided
  if (speciesId !== undefined) {
    if (typeof speciesId !== 'number' || speciesId < 0 || speciesId >= SPECIES.length) {
      return {
        success: false,
        error: { code: 'INVALID_SPECIES', message: 'Invalid species ID' },
      };
    }
    if (!isSpeciesAvailable(speciesId)) {
      return {
        success: false,
        error: { code: 'SPECIES_UNAVAILABLE', message: 'This species is not currently available' },
      };
    }
  }

  // Validate name if provided
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length < 2 || name.length > 30) {
      return {
        success: false,
        error: { code: 'INVALID_NAME', message: 'Name must be 2-30 characters' },
      };
    }
    if (!/^[a-zA-Z0-9_\-\s]+$/.test(name)) {
      return {
        success: false,
        error: { code: 'INVALID_NAME', message: 'Name can only contain letters, numbers, spaces, underscores, or hyphens' },
      };
    }
  }

  // Deduct Essence
  const deductResult = await deductEssence(userId, TOTEM_PURCHASE_COST, {
    type: 'totem_purchase',
    ref: 'new_totem',
  });

  if (!deductResult.success) {
    return {
      success: false,
      error: {
        code: 'INSUFFICIENT_FUNDS',
        message: deductResult.error || 'Not enough Essence',
        required: TOTEM_PURCHASE_COST,
        available: deductResult.available,
      },
    };
  }

  // Create the totem
  const totemData = createTotem({
    userId,
    speciesId,
    name,
  });

  // Save to DynamoDB
  await putItem(TABLES.TOTEMS, totemData);

  // Get total totem count for achievements
  let totalTotemCount = 1;
  try {
    const allTotems = await getUserTotems(userId);
    totalTotemCount = allTotems.length;
  }
  catch (err) {
    console.warn('Failed to get totem count for achievements:', err.message);
  }

  // Update stats.totalTotems to match actual count
  try {
    await updateUser(userId, { 'stats.totalTotems': totalTotemCount });
  }
  catch (err) {
    console.warn('Failed to update totalTotems stat:', err.message);
  }

  // Trigger achievement check (non-blocking)
  let achievements = [];
  try {
    const achResults = await onTotemAcquired(userId, {
      rarityId: totemData.rarityId,
      totalTotemCount,
      totemId: totemData.id,
    });
    achievements = achResults.filter(a => a.unlocked);
  }
  catch (err) {
    console.error('Failed to process purchase achievements:', err.message);
  }

  // Build response (use simple species display name, e.g. "Wolf" not "Shadow Wolf")
  return {
    success: true,
    data: {
      totem: {
        id: totemData.id,
        speciesId: totemData.speciesId,
        speciesName: SPECIES_DISPLAY_NAMES[totemData.speciesId] || 'Unknown',
        colorId: totemData.colorId,
        rarityId: totemData.rarityId,
        nickname: totemData.nickname || null,  // User-customizable (null on purchase)
        stage: totemData.stage,
        experience: totemData.experience,
        stats: totemData.stats,
        image: getTotemImageUrl(totemData.speciesId, totemData.colorId, 0),
        createdAt: totemData.createdAt,
      },
      newBalance: deductResult.newBalance,
      cost: TOTEM_PURCHASE_COST,
      achievements: achievements.map(a => ({
        achievementId: a.achievementId,
        milestone: a.milestone,
        rewards: a.rewards,
      })),
    },
  };
}

/**
 * Get purchase info (cost, available species)
 */
function getPurchaseInfo() {
  const availableSpecies = SPECIES
    .filter(s => s.available)
    .map(s => ({
      id: s.id,
      name: s.name,
      baseStats: s.baseStats,
    }));

  return {
    success: true,
    data: {
      cost: TOTEM_PURCHASE_COST,
      currency: 'essence',
      availableSpecies,
      note: 'Rarity and color are determined randomly based on drop rates',
    },
  };
}

module.exports = {
  purchaseTotem,
  getPurchaseInfo,
  TOTEM_PURCHASE_COST,
};
