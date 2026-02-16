/**
 * Totem Creation Service
 *
 * Handles business rules for creating new totems:
 * - Rarity determination (weighted random)
 * - Color selection based on rarity
 * - Base stats calculation with rarity bonuses
 * - Species availability validation
 */

const { generateId } = require('../common/id-utils');

// ============================================
// Load static config from JSON files (single source of truth)
// ============================================

// Load species stage data for proper naming
let speciesStages;
try {
  speciesStages = require('../data/species-stages.json');
}
catch (e) {
  console.warn('Species stages data not found, using defaults');
  speciesStages = { species: {}, speciesById: {} };
}

// Load business rules (rarities, species stats, colors, action configs)
let businessRules;
try {
  businessRules = require('../data/business-rules.json');
}
catch (e) {
  console.warn('Business rules not found, using defaults');
  businessRules = null;
}

/**
 * Get species-specific stage name (e.g., "Pup" for wolf, "Hatchling" for owl)
 */
function getStageNameForSpecies(speciesId, stage) {
  const speciesKey = speciesStages.speciesById?.[speciesId];
  const speciesData = speciesKey ? speciesStages.species?.[speciesKey] : null;

  const defaultStages = ['Hatchling', 'Chick', 'Juvenile', 'Adult', 'Wise Elder'];

  if (speciesData?.stages?.[stage]) {
    return speciesData.stages[stage];
  }

  return defaultStages[stage] || defaultStages[0];
}

// ============================================
// Static Config loaded from JSON (business rules)
// ============================================

const RARITIES = businessRules?.rarities || [
  { id: 0, name: 'Common', statBonus: 0, dropChance: 75 },
  { id: 1, name: 'Uncommon', statBonus: 0, dropChance: 15 },
  { id: 2, name: 'Rare', statBonus: 1, dropChance: 7 },
  { id: 3, name: 'Epic', statBonus: 2, dropChance: 2.5 },
  { id: 4, name: 'Legendary', statBonus: 4, dropChance: 0.5 },
  { id: 5, name: 'Limited', statBonus: 2, dropChance: 0 },
];

const COLORS_BY_RARITY = businessRules?.colorsByRarity || {
  common: [{ id: 0, name: 'Brown' }, { id: 1, name: 'Gray' }, { id: 2, name: 'White' }, { id: 3, name: 'Tawny' }],
  uncommon: [{ id: 4, name: 'Slate' }, { id: 5, name: 'Copper' }, { id: 6, name: 'Cream' }, { id: 7, name: 'Dappled' }],
  rare: [{ id: 8, name: 'Golden' }, { id: 9, name: 'DarkPurple' }, { id: 10, name: 'Charcoal' }],
  epic: [{ id: 11, name: 'EmeraldGreen' }, { id: 12, name: 'CrimsonRed' }, { id: 13, name: 'DeepSapphire' }],
  legendary: [{ id: 14, name: 'EtherealSilver' }, { id: 15, name: 'RadiantGold' }],
  limited: [{ id: 16, name: 'FrostbiteBlue' }, { id: 17, name: 'RosyPink' }, { id: 18, name: 'VerdantGold' }, { id: 19, name: 'RaindropTeal' }, { id: 20, name: 'FloralViolet' }, { id: 21, name: 'SunsetOrange' }, { id: 22, name: 'EmberRed' }, { id: 23, name: 'OceanicAzure' }, { id: 24, name: 'HarvestGold' }, { id: 25, name: 'PhantomBlack' }, { id: 26, name: 'EmberwoodBrown' }, { id: 27, name: 'StarlitSilver' }],
};

const SPECIES = businessRules?.species || [
  { id: 0, name: 'Goose', baseStats: { strength: 8, agility: 6, wisdom: 10 }, available: true },
  { id: 1, name: 'Otter', baseStats: { strength: 8, agility: 10, wisdom: 6 }, available: true },
  { id: 2, name: 'Wolf', baseStats: { strength: 11, agility: 8, wisdom: 5 }, available: true },
  { id: 3, name: 'Falcon', baseStats: { strength: 5, agility: 12, wisdom: 7 }, available: true },
  { id: 4, name: 'Beaver', baseStats: { strength: 10, agility: 5, wisdom: 9 }, available: true },
  { id: 5, name: 'Deer', baseStats: { strength: 5, agility: 11, wisdom: 8 }, available: true },
  { id: 6, name: 'Woodpecker', baseStats: { strength: 7, agility: 11, wisdom: 6 }, available: false },
  { id: 7, name: 'Turtle', baseStats: { strength: 10, agility: 8, wisdom: 6 }, available: false },
  { id: 8, name: 'Bear', baseStats: { strength: 12, agility: 5, wisdom: 7 }, available: false },
  { id: 9, name: 'Raven', baseStats: { strength: 5, agility: 8, wisdom: 11 }, available: false },
  { id: 10, name: 'Snake', baseStats: { strength: 7, agility: 6, wisdom: 11 }, available: false },
  { id: 11, name: 'Owl', baseStats: { strength: 5, agility: 7, wisdom: 12 }, available: true },
];

const AVAILABLE_SPECIES_IDS = SPECIES.filter((s) => s.available).map((s) => s.id);

// Simple species display names (just the animal name, not full "Shadow Wolf" style)
const SPECIES_DISPLAY_NAMES = [
  'Goose', 'Otter', 'Wolf', 'Falcon', 'Beaver',
  'Deer', 'Woodpecker', 'Turtle', 'Bear', 'Raven', 'Snake', 'Owl'
];

// Action configs for business rule validation
const ACTION_CONFIGS = businessRules?.actionConfigs || {
  feed: { cost: 10, cooldown: 0, maxDaily: 3, minHappiness: 0, happinessChange: 10, experienceGain: 0 },
  train: { cost: 20, cooldown: 0, maxDaily: 0, minHappiness: 20, happinessChange: -10, experienceGain: 50 },
  treat: { cost: 20, cooldown: 14400, maxDaily: 0, minHappiness: 0, happinessChange: 10, experienceGain: 0 },
  evolve: { cost: 0, cooldown: 0, maxDaily: 0, minHappiness: 30, happinessChange: 0, experienceGain: 0 },
};

const STAGE_THRESHOLDS = businessRules?.stageThresholds || [0, 500, 1500, 3500, 7500];
const PRESTIGE_XP_REQUIREMENT = businessRules?.prestigeXpRequirement || 2500;

// ============================================
// Rarity Determination
// ============================================

/**
 * Determine rarity using weighted random selection
 * @param {number} [luckBonus=0] - Bonus percentage to shift towards rarer
 * @returns {{ rarityId: number, rarityName: string }}
 */
function determineRarity(luckBonus = 0) {
  // Get droppable rarities (exclude Limited which has 0 dropChance)
  const droppableRarities = RARITIES.filter((r) => r.dropChance > 0);

  // Apply luck bonus (shifts weights towards rarer)
  const adjustedRarities = droppableRarities.map((r, index) => {
    let adjustedChance = r.dropChance;
    if (index > 0 && luckBonus > 0) {
      // Increase chance of rarer items
      adjustedChance += (luckBonus / 100) * r.dropChance;
    }
    return { ...r, adjustedChance };
  });

  // Normalize to 100%
  const totalChance = adjustedRarities.reduce((sum, r) => sum + r.adjustedChance, 0);
  const normalizedRarities = adjustedRarities.map((r) => ({
    ...r,
    normalizedChance: (r.adjustedChance / totalChance) * 100,
  }));

  // Roll random number
  const roll = Math.random() * 100;

  // Find matching rarity
  let cumulative = 0;
  for (const rarity of normalizedRarities) {
    cumulative += rarity.normalizedChance;
    if (roll <= cumulative) {
      return {
        rarityId: rarity.id,
        rarityName: rarity.name,
        statBonus: rarity.statBonus,
      };
    }
  }

  // Fallback to Common
  return {
    rarityId: 0,
    rarityName: 'Common',
    statBonus: 0,
  };
}

/**
 * Get rarity name from ID
 */
function getRarityName(rarityId) {
  return RARITIES[rarityId]?.name.toLowerCase() || 'common';
}

// ============================================
// Color Selection
// ============================================

/**
 * Select a random color based on rarity
 * @param {number} rarityId - The rarity ID (0-5)
 * @returns {{ colorId: number, colorName: string }}
 */
function selectColor(rarityId) {
  const rarityName = getRarityName(rarityId);
  const colorPool = COLORS_BY_RARITY[rarityName] || COLORS_BY_RARITY.common;

  const randomIndex = Math.floor(Math.random() * colorPool.length);
  const selectedColor = colorPool[randomIndex];

  return {
    colorId: selectedColor.id,
    colorName: selectedColor.name,
  };
}

/**
 * Select a specific limited color (for monthly specials, etc.)
 * @param {number} colorId - The specific limited color ID
 * @returns {{ colorId: number, colorName: string } | null}
 */
function selectLimitedColor(colorId) {
  const limitedColor = COLORS_BY_RARITY.limited.find((c) => c.id === colorId);
  if (!limitedColor) {
    return null;
  }
  return {
    colorId: limitedColor.id,
    colorName: limitedColor.name,
  };
}

// ============================================
// Species Selection
// ============================================

/**
 * Select a random available species
 * @returns {{ speciesId: number, speciesName: string, baseStats: object }}
 */
function selectRandomSpecies() {
  const randomIndex = Math.floor(Math.random() * AVAILABLE_SPECIES_IDS.length);
  const speciesId = AVAILABLE_SPECIES_IDS[randomIndex];
  const species = SPECIES[speciesId];

  return {
    speciesId: species.id,
    speciesName: SPECIES_DISPLAY_NAMES[speciesId] || species.name,
    baseStats: { ...species.baseStats },
  };
}

/**
 * Get species by ID (validates availability)
 * @param {number} speciesId
 * @param {boolean} [checkAvailability=true]
 * @returns {object | null}
 */
function getSpecies(speciesId, checkAvailability = true) {
  const species = SPECIES[speciesId];
  if (!species) {
    return null;
  }
  if (checkAvailability && !species.available) {
    return null;
  }
  return {
    speciesId: species.id,
    speciesName: SPECIES_DISPLAY_NAMES[speciesId] || species.name,
    baseStats: { ...species.baseStats },
  };
}

/**
 * Check if a species is available for creation
 */
function isSpeciesAvailable(speciesId) {
  return AVAILABLE_SPECIES_IDS.includes(speciesId);
}

// ============================================
// Stats Calculation
// ============================================

/**
 * Calculate initial totem stats with rarity bonus
 * Stats match contract values exactly: base stats + rarity bonus
 * @param {object} baseStats - { strength, agility, wisdom }
 * @param {number} statBonus - Rarity stat bonus (Rare: +1, Epic: +2, Legendary: +4, Limited: +2)
 * @returns {object} - Full stats object
 */
function calculateInitialStats(baseStats, statBonus = 0) {
  // No random variation - stats must match contract values exactly
  return {
    strength: baseStats.strength + statBonus,
    agility: baseStats.agility + statBonus,
    wisdom: baseStats.wisdom + statBonus,
    happiness: 50, // Start at neutral
    hunger: 100, // Start fully fed
  };
}

// ============================================
// Totem Creation
// ============================================

/**
 * Create a new totem with all business rules applied
 *
 * @param {object} options
 * @param {string} options.userId - The user creating the totem
 * @param {number} [options.speciesId] - Specific species (optional, random if not provided)
 * @param {string} [options.name] - Custom name (optional)
 * @param {number} [options.luckBonus=0] - Luck bonus for rarity roll
 * @param {boolean} [options.isLimited=false] - Is this a limited/special totem
 * @param {number} [options.limitedColorId] - Specific limited color ID
 *
 * @returns {object} - Complete totem data ready for DynamoDB
 */
function createTotem({
  userId,
  speciesId,
  name,
  luckBonus = 0,
  isLimited = false,
  limitedColorId,
}) {
  // 1. Select or validate species
  let species;
  if (speciesId !== undefined) {
    species = getSpecies(speciesId);
    if (!species) {
      throw new Error(`Species ${speciesId} is not available`);
    }
  }
  else {
    species = selectRandomSpecies();
  }

  // 2. Determine rarity
  let rarity;
  if (isLimited) {
    rarity = { rarityId: 5, rarityName: 'Limited', statBonus: 2 };
  }
  else {
    rarity = determineRarity(luckBonus);
  }

  // 3. Select color
  let color;
  if (isLimited && limitedColorId !== undefined) {
    color = selectLimitedColor(limitedColorId);
    if (!color) {
      throw new Error(`Limited color ${limitedColorId} not found`);
    }
  }
  else {
    color = selectColor(rarity.rarityId);
  }

  // 4. Calculate stats
  const stats = calculateInitialStats(species.baseStats, rarity.statBonus);

  // 5. Generate totem ID
  const totemId = generateId('totem');

  // 6. Build totem record
  // Note: We don't save a generated display name - it's calculated dynamically
  // from color + stage. Only save user-provided nickname if they set one.
  const now = new Date().toISOString();

  return {
    // Keys
    pk: `USER#${userId}`,
    sk: `TOTEM#${totemId}`,

    // Identifiers
    id: totemId,
    userId,

    // Totem attributes
    speciesId: species.speciesId,
    colorId: color.colorId,
    rarityId: rarity.rarityId,
    nickname: name || null,  // User-customizable name (optional)

    // Progression
    stage: 0, // Hatchling
    experience: 0,
    prestigeLevel: 0,

    // Stats
    stats,

    // Cooldowns
    cooldowns: {
      feed: null,
      train: null,
      treat: null,
    },

    // Metadata
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create starter totem for new user (guaranteed good stats)
 */
function createStarterTotem(userId) {
  // Starter totem is always:
  // - Random available species
  // - Uncommon rarity (slightly better than common)
  // - Random uncommon color
  const species = selectRandomSpecies();
  const color = selectColor(1); // Uncommon
  const stats = calculateInitialStats(species.baseStats, 0);

  const totemId = generateId('totem');
  const now = new Date().toISOString();

  // No auto-generated nickname - user can set their own via daily action
  return {
    pk: `USER#${userId}`,
    sk: `TOTEM#${totemId}`,
    id: totemId,
    userId,
    speciesId: species.speciesId,
    colorId: color.colorId,
    rarityId: 1, // Uncommon
    nickname: null, // User-set nickname (optional)
    stage: 0,
    experience: 0,
    prestigeLevel: 0,
    stats,
    cooldowns: { feed: null, train: null, treat: null },
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Main creation functions
  createTotem,
  createStarterTotem,

  // Individual functions for testing/flexibility
  determineRarity,
  selectColor,
  selectLimitedColor,
  selectRandomSpecies,
  getSpecies,
  isSpeciesAvailable,
  calculateInitialStats,
  getStageNameForSpecies,

  // Config loaded from JSON (for reference)
  RARITIES,
  COLORS_BY_RARITY,
  SPECIES,
  SPECIES_DISPLAY_NAMES,
  AVAILABLE_SPECIES_IDS,
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
};
