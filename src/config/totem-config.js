/**
 * Totem Game Config — Single source of truth for all API-side game rule config.
 *
 * Loads totem-config.json and species-stages.json once at startup.
 * No try/catch, no fallback defaults — if the files are missing the
 * process fails fast so we notice immediately.
 *
 * Every module that needs game rules should require from here:
 *   const { ACTION_CONFIGS, SPECIES, ... } = require('../config/totem-config');
 */

const totemConfig = require('../data/totem-config.json');
const speciesStages = require('../data/species-stages.json');
const totemImages = require('../data/totem-images.json');

// --- Rarities ---
const RARITIES = totemConfig.rarities;

// --- Species ---
const SPECIES = totemConfig.species;
const AVAILABLE_SPECIES_IDS = SPECIES.filter(s => s.available).map(s => s.id);
const SPECIES_DISPLAY_NAMES = SPECIES.map(s => s.name);

// --- Colors ---
const COLORS_BY_RARITY = totemConfig.colorsByRarity;

// --- Domains ---
const DOMAINS = totemConfig.domains;
// Build speciesId → domain name lookup from config
const DOMAIN_BY_SPECIES = {};
for (const domain of DOMAINS) {
  for (const speciesId of domain.speciesIds) {
    DOMAIN_BY_SPECIES[speciesId] = domain.name;
  }
}

// --- Actions ---
const ACTION_CONFIGS = totemConfig.actionConfigs;

// --- Progression ---
const STAGE_THRESHOLDS = totemConfig.stageThresholds;
const PRESTIGE_XP_REQUIREMENT = totemConfig.prestigeXpRequirement;

// --- Time Windows (feed uses 8-hour UTC slots) ---
const TIME_WINDOWS = totemConfig.timeWindows;

// --- Totem Images (IPFS CIDs) ---
const SPECIES_NAMES = [
  'goose', 'otter', 'wolf', 'falcon', 'beaver',
  'deer', 'woodpecker', 'turtle', 'bear', 'raven', 'snake', 'owl'
];

const COLOR_NAMES = [
  'brown', 'gray', 'white', 'tawny',           // Common (0-3)
  'slate', 'copper', 'cream', 'dappled',       // Uncommon (4-7)
  'golden', 'purple', 'charcoal',              // Rare (8-10)
  'emerald', 'crimson', 'sapphire',            // Epic (11-13)
  'silver', 'gold',                            // Legendary (14-15)
  'frostbite', 'rosy', 'verdant', 'raindrop',  // Limited (16-27)
  'floral', 'sunset', 'ember', 'oceanic',
  'harvest', 'phantom', 'emberwood', 'starlit'
];

/**
 * Get totem image URL from IPFS CIDs
 */
function getTotemImageUrl(speciesId, colorId, stage = 0) {
  const speciesName = SPECIES_NAMES[speciesId];
  const colorName = COLOR_NAMES[colorId];

  if (!speciesName || !colorName) {
    return `/totems/${speciesName || 'unknown'}placecard.png`;
  }

  const speciesData = totemImages.species[speciesName];
  if (!speciesData || !speciesData[colorName]) {
    return `/totems/${speciesName}placecard.png`;
  }

  const cid = speciesData[colorName][stage] || speciesData[colorName][0];
  return `${totemImages.gateway}${cid}`;
}

// --- Stage Names ---
const DEFAULT_STAGE_NAMES = ['Hatchling', 'Chick', 'Juvenile', 'Adult', 'Wise Elder'];

/**
 * Get species-specific stage name (e.g., "Pup" for wolf, "Hatchling" for owl)
 */
function getStageNameForSpecies(speciesId, stage) {
  const speciesKey = speciesStages.speciesById?.[speciesId];
  const speciesData = speciesKey ? speciesStages.species?.[speciesKey] : null;

  if (speciesData?.stages?.[stage]) {
    return speciesData.stages[stage];
  }

  return DEFAULT_STAGE_NAMES[stage] || DEFAULT_STAGE_NAMES[DEFAULT_STAGE_NAMES.length - 1];
}

module.exports = {
  RARITIES,
  SPECIES,
  AVAILABLE_SPECIES_IDS,
  SPECIES_DISPLAY_NAMES,
  COLORS_BY_RARITY,
  DOMAINS,
  DOMAIN_BY_SPECIES,
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
  TIME_WINDOWS,
  DEFAULT_STAGE_NAMES,
  getStageNameForSpecies,
  getTotemImageUrl,
  speciesStages,
};
