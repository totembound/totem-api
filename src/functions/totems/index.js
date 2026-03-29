/**
 * Totems API Handlers
 *
 * Handles totem-related operations:
 * - GET /api/totems - Get all user's totems
 * - GET /api/totems/:id - Get a specific totem
 */

const {
  getUserTotems,
  getTotem: getTotemFromDb,
} = require('../../common/db-client');

const {
  SPECIES,
  RARITIES,
  COLORS_BY_RARITY,
  SPECIES_DISPLAY_NAMES,
  DOMAIN_BY_SPECIES,
  getStageNameForSpecies,
  getTotemImageUrl,
} = require('../../config/totem-config');

// ============================================
// Helpers
// ============================================

/**
 * Get color name from colorId
 */
function getColorName(colorId) {
  for (const colors of Object.values(COLORS_BY_RARITY)) {
    const color = colors.find((c) => c.id === colorId);
    if (color) {
      // Split compound names: "CrimsonRed" → "Crimson Red"
      return color.name.replace(/([a-z])([A-Z])/g, '$1 $2');
    }
  }
  return 'Unknown';
}


/**
 * Get species data from speciesId
 */
function getSpeciesData(speciesId) {
  return SPECIES[speciesId] || null;
}

/**
 * Get rarity data from rarityId
 */
function getRarityData(rarityId) {
  return RARITIES[rarityId] || null;
}

/**
 * Transform DynamoDB totem record to API response format
 * Maps to the TotemData format expected by frontend
 */
function transformTotemForApi(totem) {
  const species = getSpeciesData(totem.speciesId);
  const rarity = getRarityData(totem.rarityId);
  const colorName = getColorName(totem.colorId);

  // Determine affinity based on highest base stat
  const speciesStats = species?.baseStats || { strength: 5, agility: 5, wisdom: 5 };
  let affinity = 'Strength';
  if (speciesStats.agility > speciesStats.strength && speciesStats.agility >= speciesStats.wisdom) {
    affinity = 'Agility';
  }
  else if (speciesStats.wisdom > speciesStats.strength && speciesStats.wisdom > speciesStats.agility) {
    affinity = 'Wisdom';
  }

  const domain = DOMAIN_BY_SPECIES[totem.speciesId] || 'Spirit';

  const currentStage = totem.stage || 0;
  const stageName = getStageNameForSpecies(totem.speciesId, currentStage);

  return {
    // Core identifiers
    id: totem.id,
    tokenId: totem.id.replace('ttm_', '').substring(0, 8), // Use first 8 chars of UUID as string ID

    // Display name computed by frontend from species cache (per-color stage names)
    name: SPECIES_DISPLAY_NAMES[totem.speciesId] || 'Totem',
    description: `A ${rarity?.name || 'Common'} ${colorName} ${SPECIES_DISPLAY_NAMES[totem.speciesId] || 'Totem'} (${stageName})`,
    image: getTotemImageUrl(totem.speciesId, totem.colorId, currentStage),

    // Classification
    affinity,
    domain,

    // Attributes (matches TotemData.attributes)
    attributes: {
      species: totem.speciesId,
      color: totem.colorId,
      rarity: totem.rarityId,
      happiness: totem.stats?.happiness ?? 50,
      experience: totem.experience || 0,
      stage: totem.stage || 0,
      strength: totem.stats?.strength || 5,
      agility: totem.stats?.agility || 5,
      wisdom: totem.stats?.wisdom || 5,
      nickname: totem.nickname || null,  // User-customizable name (optional)
      prestigeLevel: totem.prestigeLevel || 0,
      ...(totem.sanctum && { sanctum: totem.sanctum }),
    },

    // Action tracking (used for cooldowns)
    trackings: {
      0: totem.cooldowns?.feed ? {
        lastUsed: new Date(totem.cooldowns.feed).getTime() / 1000,
        dailyUses: 0,
        dayStartTime: 0,
      } : undefined,
      1: totem.cooldowns?.train ? {
        lastUsed: new Date(totem.cooldowns.train).getTime() / 1000,
        dailyUses: 0,
        dayStartTime: 0,
      } : undefined,
      2: totem.cooldowns?.treat ? {
        lastUsed: new Date(totem.cooldowns.treat).getTime() / 1000,
        dailyUses: 0,
        dayStartTime: 0,
      } : undefined,
    },

    // Metadata
    createdAt: totem.createdAt,
    updatedAt: totem.updatedAt,
  };
}

// ============================================
// Handlers
// ============================================

/**
 * GET /api/totems
 *
 * Get all totems for the authenticated user.
 * Returns transformed totem data matching TotemData format.
 */
async function getTotems(user) {
  try {
    const userId = user.userId;
    console.log('[getTotems] userId:', userId);

    // Get all totems from DynamoDB
    const totems = await getUserTotems(userId);
    console.log('[getTotems] found totems:', totems.length);

    // Transform to API format
    const transformedTotems = totems.map(transformTotemForApi);

    return {
      success: true,
      data: transformedTotems,
    };
  }
  catch (error) {
    console.error('Error fetching totems:', error);
    throw error;
  }
}

/**
 * GET /api/totems/:id
 *
 * Get a specific totem by ID.
 */
async function getTotem(user, totemId) {
  try {
    const userId = user.userId;

    // Validate totemId format
    if (!totemId || !totemId.startsWith('ttm_')) {
      return {
        success: false,
        error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
      };
    }

    // Get totem from DynamoDB
    const totem = await getTotemFromDb(userId, totemId);

    if (!totem) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Totem not found' },
      };
    }

    // Transform to API format
    const transformedTotem = transformTotemForApi(totem);

    return {
      success: true,
      data: transformedTotem,
    };
  }
  catch (error) {
    console.error('Error fetching totem:', error);
    throw error;
  }
}

// ============================================
// Purchase Handler
// ============================================

const { purchaseTotem, getPurchaseInfo } = require('./purchase');
const { forgeTotem } = require('./forge');

// ============================================
// Exports
// ============================================

module.exports = {
  getTotems,
  getTotem,
  transformTotemForApi,
  purchaseTotem,
  getPurchaseInfo,
  forgeTotem,
};
