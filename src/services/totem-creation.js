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

const {
  RARITIES,
  SPECIES,
  AVAILABLE_SPECIES_IDS,
  SPECIES_DISPLAY_NAMES,
  COLORS_BY_RARITY,
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
  getStageNameForSpecies,
} = require('../config/totem-config');

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
 * @param {number} [options.forcedRarityId] - Force a specific rarity (used by Forge fusion)
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
  forcedRarityId,
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
  if (forcedRarityId !== undefined) {
    const forcedRarity = RARITIES[forcedRarityId];
    if (!forcedRarity) {
      throw new Error(`Invalid forced rarity ID: ${forcedRarityId}`);
    }
    rarity = { rarityId: forcedRarityId, rarityName: forcedRarity.name, statBonus: forcedRarity.statBonus || 0 };
  }
  else if (isLimited) {
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

  // Config re-exported for consumers that import from here
  RARITIES,
  COLORS_BY_RARITY,
  SPECIES,
  SPECIES_DISPLAY_NAMES,
  AVAILABLE_SPECIES_IDS,
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
};
