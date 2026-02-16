/**
 * Game Actions Helpers
 *
 * Shared logic for game actions - ALL VALUES MUST MATCH CONTRACT RULES
 * Source of truth: /src/data/business-rules.json (from totem-contracts)
 *
 * DO NOT use random values - use exact fixed values from contract
 */

// ============================================
// Load Business Rules (Source of Truth)
// ============================================

let businessRules;
try {
  businessRules = require('../../data/business-rules.json');
}
catch (e) {
  console.error('CRITICAL: business-rules.json not found - using hardcoded fallbacks');
  businessRules = null;
}

// Action configs from contract (phase-6-game-logic-setup.ts)
const ACTION_CONFIGS = businessRules?.actionConfigs || {
  feed: { cost: 10, cooldown: 0, maxDaily: 3, minHappiness: 0, happinessChange: 10, experienceGain: 0 },
  train: { cost: 20, cooldown: 0, maxDaily: 0, minHappiness: 20, happinessChange: -10, experienceGain: 50 },
  treat: { cost: 20, cooldown: 14400, maxDaily: 0, minHappiness: 0, happinessChange: 10, experienceGain: 0 },
  evolve: { cost: 0, cooldown: 0, maxDaily: 0, minHappiness: 30, happinessChange: 0, experienceGain: 0 },
};

// Stage thresholds from contract (phase-3-proxy-deployments.ts)
const STAGE_THRESHOLDS = businessRules?.stageThresholds || [0, 500, 1500, 3500, 7500];
const PRESTIGE_XP_REQUIREMENT = businessRules?.prestigeXpRequirement || 2500;

// Time windows from contract (8-hour UTC slots)
const TIME_WINDOWS = businessRules?.timeWindows || {
  windowDuration: 28800, // 8 hours in seconds
  windowsPerDay: 3,
  windows: [
    { start: 0, end: 28800 },      // 00:00 - 08:00 UTC
    { start: 28800, end: 57600 },  // 08:00 - 16:00 UTC
    { start: 57600, end: 86400 },  // 16:00 - 24:00 UTC
  ],
};

// ============================================
// Stage Names (from IPFS metadata)
// ============================================

let speciesStages;
try {
  speciesStages = require('../../data/species-stages.json');
}
catch (e) {
  console.warn('Species stages data not found, using default names');
  speciesStages = { species: {}, speciesById: {} };
}

const DEFAULT_STAGE_NAMES = ['Hatchling', 'Chick', 'Juvenile', 'Adult', 'Wise Elder'];
const MAX_STAGE = 4;

/**
 * Get stage name for a given species and stage number
 */
function getStageName(speciesId, stage = 0) {
  const speciesKey = speciesStages.speciesById?.[speciesId];
  const speciesData = speciesKey ? speciesStages.species?.[speciesKey] : null;

  if (speciesData?.stages?.[stage]) {
    return speciesData.stages[stage];
  }

  return DEFAULT_STAGE_NAMES[stage] || DEFAULT_STAGE_NAMES[DEFAULT_STAGE_NAMES.length - 1];
}

// ============================================
// Cooldown Management (from contract rules)
// ============================================

/**
 * Check if an action is on cooldown
 * Uses cooldown values from ACTION_CONFIGS (in seconds)
 */
function checkCooldown(lastActionTime, actionType, _isPremium = false) {
  const config = ACTION_CONFIGS[actionType];
  if (!config) {
    return { onCooldown: false, remainingMs: 0, readyAt: null };
  }

  // No cooldown configured for this action
  if (config.cooldown === 0) {
    return { onCooldown: false, remainingMs: 0, readyAt: null };
  }

  if (!lastActionTime) {
    return { onCooldown: false, remainingMs: 0, readyAt: null };
  }

  const cooldownMs = config.cooldown * 1000; // Convert seconds to ms
  const lastTime = new Date(lastActionTime).getTime();
  const now = Date.now();
  const elapsed = now - lastTime;
  const remaining = cooldownMs - elapsed;

  if (remaining <= 0) {
    return { onCooldown: false, remainingMs: 0, readyAt: null };
  }

  return {
    onCooldown: true,
    remainingMs: remaining,
    readyAt: new Date(lastTime + cooldownMs),
  };
}

/**
 * Check if Feed action is available based on time windows
 * Feed uses 8-hour UTC time windows, max 3 per day
 */
function checkFeedTimeWindow(feedHistory = []) {
  const now = new Date();
  const todayUTC = now.toISOString().split('T')[0];
  const secondsSinceMidnightUTC = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

  // Determine current window (0, 1, or 2)
  let currentWindow = 0;
  for (let i = 0; i < TIME_WINDOWS.windows.length; i++) {
    const window = TIME_WINDOWS.windows[i];
    if (secondsSinceMidnightUTC >= window.start && secondsSinceMidnightUTC < window.end) {
      currentWindow = i;
      break;
    }
  }

  // Filter feeds from today
  const todayFeeds = feedHistory.filter((f) => {
    const feedDate = new Date(f.timestamp).toISOString().split('T')[0];
    return feedDate === todayUTC;
  });

  // Check if already fed in current window
  const fedInCurrentWindow = todayFeeds.some((f) => {
    const feedTime = new Date(f.timestamp);
    const feedSeconds = feedTime.getUTCHours() * 3600 + feedTime.getUTCMinutes() * 60 + feedTime.getUTCSeconds();
    const feedWindow = TIME_WINDOWS.windows.findIndex(
      (w) => feedSeconds >= w.start && feedSeconds < w.end
    );
    return feedWindow === currentWindow;
  });

  // Check max daily
  const maxDaily = ACTION_CONFIGS.feed.maxDaily;
  const atMaxDaily = todayFeeds.length >= maxDaily;

  if (fedInCurrentWindow) {
    // Calculate time until next window
    const currentWindowEnd = TIME_WINDOWS.windows[currentWindow].end;
    const secondsUntilNextWindow = currentWindowEnd - secondsSinceMidnightUTC;
    const msUntilNextWindow = secondsUntilNextWindow * 1000;

    return {
      canFeed: false,
      reason: 'Already fed in this time window',
      remainingMs: msUntilNextWindow,
      currentWindow,
      feedsToday: todayFeeds.length,
      maxDaily,
    };
  }

  if (atMaxDaily) {
    return {
      canFeed: false,
      reason: 'Maximum daily feeds reached',
      remainingMs: 0,
      currentWindow,
      feedsToday: todayFeeds.length,
      maxDaily,
    };
  }

  return {
    canFeed: true,
    currentWindow,
    feedsToday: todayFeeds.length,
    maxDaily,
  };
}

/**
 * Format cooldown remaining time for display
 */
function formatCooldownRemaining(remainingMs) {
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// ============================================
// Experience & Stage Progression (from contract)
// ============================================

/**
 * Get XP gain for an action - FIXED values from contract
 * DO NOT use random values
 */
function getXpGain(actionType) {
  const config = ACTION_CONFIGS[actionType];
  return config?.experienceGain || 0;
}

/**
 * Get happiness change for an action - FIXED values from contract
 * DO NOT use random values
 */
function getHappinessChange(actionType) {
  const config = ACTION_CONFIGS[actionType];
  return config?.happinessChange || 0;
}

/**
 * Get action cost in Essence
 */
function getActionCost(actionType) {
  const config = ACTION_CONFIGS[actionType];
  return config?.cost || 0;
}

/**
 * Get minimum happiness required for action
 */
function getMinHappiness(actionType) {
  const config = ACTION_CONFIGS[actionType];
  return config?.minHappiness || 0;
}

/**
 * Calculate current stage based on experience
 * Uses STAGE_THRESHOLDS from contract
 */
function calculateStage(experience) {
  for (let i = STAGE_THRESHOLDS.length - 1; i >= 0; i--) {
    if (experience >= STAGE_THRESHOLDS[i]) {
      return Math.min(i, MAX_STAGE);
    }
  }
  return 0;
}

/**
 * Get XP required for next stage
 */
function getXpToNextStage(experience, currentStage) {
  if (currentStage >= MAX_STAGE) {
    return 0; // Already at max stage
  }
  const nextThreshold = STAGE_THRESHOLDS[currentStage + 1];
  return Math.max(0, nextThreshold - experience);
}

/**
 * Check if a totem can evolve
 */
function checkEvolutionRequirements(totem) {
  const currentStage = totem.stage || 0;
  const currentXp = totem.experience || 0;
  const currentHappiness = totem.stats?.happiness || 0;

  if (currentStage >= MAX_STAGE) {
    return {
      canEvolve: false,
      reason: 'Totem is already at maximum stage',
    };
  }

  const xpRequired = STAGE_THRESHOLDS[currentStage + 1];
  const happinessRequired = ACTION_CONFIGS.evolve.minHappiness;

  const meetsXp = currentXp >= xpRequired;
  const meetsHappiness = currentHappiness >= happinessRequired;

  if (!meetsXp || !meetsHappiness) {
    return {
      canEvolve: false,
      reason: !meetsXp
        ? `Need ${xpRequired} XP (have ${currentXp})`
        : `Need ${happinessRequired} happiness (have ${currentHappiness})`,
      requirements: {
        experience: { required: xpRequired, current: currentXp, met: meetsXp },
        happiness: { required: happinessRequired, current: currentHappiness, met: meetsHappiness },
      },
    };
  }

  return {
    canEvolve: true,
    requirements: {
      experience: { required: xpRequired, current: currentXp, met: true },
      happiness: { required: happinessRequired, current: currentHappiness, met: true },
    },
  };
}

// ============================================
// Stat Calculations (FIXED values from contract)
// ============================================

/**
 * Calculate stat changes from an action
 * Uses FIXED values from ACTION_CONFIGS - NO random values
 */
function calculateStatChanges(actionType, totem) {
  const config = ACTION_CONFIGS[actionType];
  const result = {};

  if (!config) return result;

  // Fixed happiness change from contract
  const happinessChange = config.happinessChange;
  const currentHappiness = totem.stats?.happiness || 50;
  const newHappiness = Math.max(0, Math.min(100, currentHappiness + happinessChange));

  result.happiness = newHappiness;
  result.happinessChange = happinessChange;

  // Feed also resets hunger
  if (actionType === 'feed') {
    result.hunger = 100;
  }

  return result;
}

/**
 * Build action result for API response
 */
function buildActionResult(actionType, totem, statChanges, xpGained) {
  const config = ACTION_CONFIGS[actionType];
  const cooldownMs = (config?.cooldown || 0) * 1000;

  const result = {
    action: actionType,
    totemId: totem.id,
    xpGained,
    newExperience: (totem.experience || 0) + xpGained,
    statChanges,
  };

  // Only include cooldown if action has one
  if (cooldownMs > 0) {
    result.cooldown = {
      type: actionType,
      duration: config.cooldown,
      readyAt: new Date(Date.now() + cooldownMs).toISOString(),
    };
  }

  return result;
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Config from business rules
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
  TIME_WINDOWS,

  // Stage naming
  DEFAULT_STAGE_NAMES,
  MAX_STAGE,
  getStageName,

  // Cooldowns
  checkCooldown,
  checkFeedTimeWindow,
  formatCooldownRemaining,

  // Action values (fixed from contract)
  getXpGain,
  getHappinessChange,
  getActionCost,
  getMinHappiness,

  // Stage progression
  calculateStage,
  getXpToNextStage,
  checkEvolutionRequirements,

  // Stats
  calculateStatChanges,
  buildActionResult,
};
