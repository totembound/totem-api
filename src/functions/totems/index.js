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
} = require('../../services/totem-creation');

// Load totem image CIDs
let totemImages;
try {
  totemImages = require('../../data/totem-images.json');
}
catch (e) {
  console.warn('Totem images data not found, using placeholders');
  totemImages = { gateway: 'https://ipfs.totembound.com/ipfs/', species: {} };
}

// Load species stage data for proper naming
let speciesStages;
try {
  speciesStages = require('../../data/species-stages.json');
}
catch (e) {
  console.warn('Species stages data not found, using default names');
  speciesStages = { species: {}, speciesById: {} };
}

// Species ID to name mapping (lowercase for CID lookup)
const SPECIES_NAMES = [
  'goose', 'otter', 'wolf', 'falcon', 'beaver',
  'deer', 'woodpecker', 'turtle', 'bear', 'raven', 'snake', 'owl'
];

// Species display names (capitalized, simple - just the animal name)
const SPECIES_DISPLAY_NAMES = [
  'Goose', 'Otter', 'Wolf', 'Falcon', 'Beaver',
  'Deer', 'Woodpecker', 'Turtle', 'Bear', 'Raven', 'Snake', 'Owl'
];

// Color ID to name mapping (lowercase for CID lookup)
const COLOR_NAMES = [
  'brown', 'gray', 'white', 'tawny',           // Common (0-3)
  'slate', 'copper', 'cream', 'dappled',       // Uncommon (4-7)
  'golden', 'purple', 'charcoal',              // Rare (8-10) - DarkPurple → purple
  'emerald', 'crimson', 'sapphire',            // Epic (11-13)
  'silver', 'gold',                            // Legendary (14-15)
  'frostbite', 'rosy', 'verdant', 'raindrop',  // Limited (16-27)
  'floral', 'sunset', 'ember', 'oceanic',
  'harvest', 'phantom', 'emberwood', 'starlit'
];

// ============================================
// Helpers
// ============================================

/**
 * Get totem image URL from IPFS CIDs
 */
function getTotemImageUrl(speciesId, colorId, stage) {
  const speciesName = SPECIES_NAMES[speciesId];
  const colorName = COLOR_NAMES[colorId];

  if (!speciesName || !colorName) {
    return `${totemImages.gateway}placeholder`;
  }

  const speciesData = totemImages.species[speciesName];
  if (!speciesData || !speciesData[colorName]) {
    // Fallback to placeholder
    return `/totems/${speciesName}placecard.png`;
  }

  const cid = speciesData[colorName][stage] || speciesData[colorName][0];
  return `${totemImages.gateway}${cid}`;
}

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
 * Get stage name for a species
 * Uses species-specific naming from metadata (e.g., Wolf: Pup, Owl: Hatchling)
 */
function getStageNameForSpecies(speciesId, stage) {
  const speciesKey = speciesStages.speciesById?.[speciesId];
  const speciesData = speciesKey ? speciesStages.species?.[speciesKey] : null;

  const defaultStages = ['Hatchling', 'Chick', 'Juvenile', 'Adult', 'Wise Elder'];

  if (speciesData?.stages?.[stage]) {
    return speciesData.stages[stage];
  }

  return defaultStages[stage] || defaultStages[defaultStages.length - 1];
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

  // Determine domain based on species (must match public/config/species.json)
  const domainMap = {
    0: 'Water',  // Goose
    1: 'Water',  // Otter
    2: 'Earth',  // Wolf
    3: 'Air',    // Falcon
    4: 'Water',  // Beaver
    5: 'Earth',  // Deer
    6: 'Air',    // Woodpecker
    7: 'Water',  // Turtle
    8: 'Earth',  // Bear
    9: 'Air',    // Raven
    10: 'Earth', // Snake
    11: 'Air',   // Owl
  };
  const domain = domainMap[totem.speciesId] || 'Spirit';

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
      isStaked: false, // Web2 doesn't have staking
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

// ============================================
// Exports
// ============================================

module.exports = {
  getTotems,
  getTotem,
  transformTotemForApi,
  purchaseTotem,
  getPurchaseInfo,
};
