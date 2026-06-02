/**
 * Game Actions Helpers
 *
 * Shared logic for game actions - ALL VALUES MUST MATCH CONTRACT RULES
 * Source of truth: /src/data/totem-config.json (from totem-contracts)
 *
 * DO NOT use random values - use exact fixed values from contract
 */

const {
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
  TIME_WINDOWS,
  HUNGER,
  DEFAULT_STAGE_NAMES,
  getStageNameForSpecies,
} = require('../../config/totem-config');

const MAX_STAGE = 4;

// ============================================
// Stage Names
// ============================================

/**
 * Get stage name for a given species and stage number
 */
function getStageName(speciesId, stage = 0) {
  return getStageNameForSpecies(speciesId, stage);
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
 * Calculate prestige level from experience.
 *
 * Prestige is XP past the Wise Elder threshold, divided by PRESTIGE_XP_REQUIREMENT.
 * Mirrors the frontend formula in TotemStatsPanel.tsx so client display and
 * server-side achievement triggering agree.
 *
 * Examples (BASE_ELDER_XP=7500, PRESTIGE_XP_REQUIREMENT=2500):
 *   7400 -> 0   (still pre-Elder)
 *   7500 -> 0   (just hit Elder, P0)
 *  10000 -> 1   (P1)
 *  22500 -> 6   (P6)
 */
function calculatePrestigeLevel(experience) {
  const elderThreshold = STAGE_THRESHOLDS[MAX_STAGE];
  if (!experience || experience <= elderThreshold) return 0;
  return Math.floor((experience - elderThreshold) / PRESTIGE_XP_REQUIREMENT);
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
 * Calculate stat changes from an action.
 *
 * Uses FIXED values from ACTION_CONFIGS - NO random values. Optional `bonuses`
 * (from the trait-effect resolver) nudges:
 *  - `happinessFlat`           adds to the action's happinessChange
 *                              (Gentle: train −10 → −8, Hardy: feed +10 → +12,
 *                               Playful: treat +10 → +12)
 *  - `hungerRestoreBonusPct`   adds to the fraction of HUNGER.feedRestore granted
 *                              by feed (trt_diligent_forager: +0.20 → 30 → 36).
 *
 * `hungerMultiplier` (default 1) scales a NEGATIVE base happiness change — the
 * "hungry totem gets sad faster" effect. Callers pass 2 when hunger < trainMin.
 * It only multiplies losses (config.happinessChange < 0), so Feed/Treat gains
 * (+10) are never buffed by being hungry; in practice only Train (−10) doubles.
 * The trait `happinessFlat` overlay is applied AFTER the multiplier, so a Gentle
 * totem still softens the harsher hungry penalty (−20 + 2 = −18).
 */
function calculateStatChanges(actionType, totem, bonuses = null, hungerMultiplier = 1) {
  const config = ACTION_CONFIGS[actionType];
  const result = {};

  if (!config) return result;

  // Hungry penalty multiplies the loss only (never a gain), then trait flat overlay.
  const baseChange = config.happinessChange;
  const hungerMult = baseChange < 0 ? hungerMultiplier : 1;
  const happinessFlat = bonuses?.happinessFlat || 0;
  const happinessChange = (baseChange * hungerMult) + happinessFlat;
  const currentHappiness = totem.stats?.happiness || 50;
  const newHappiness = Math.max(0, Math.min(100, currentHappiness + happinessChange));

  result.happiness = newHappiness;
  result.happinessChange = happinessChange;

  // Feed grants a fixed partial restore (HUNGER.feedRestore, +trait bonus),
  // clamped to HUNGER.max. `currentHunger` is the already-decayed value (the read
  // boundary decayed it). `hungerGained` reports the ACTUAL amount so the client
  // never shows "+30" when the totem was already near full.
  if (actionType === 'feed') {
    const currentHunger = totem.stats?.hunger ?? 0;
    const bonusPct = bonuses?.hungerRestoreBonusPct || 0;
    const restore = Math.round(HUNGER.feedRestore * (1 + bonusPct));
    const newHunger = Math.min(HUNGER.max, currentHunger + restore);
    result.hunger = newHunger;
    result.hungerGained = newHunger - currentHunger;
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
  // Config from totem-config
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
  TIME_WINDOWS,
  HUNGER,

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
  calculatePrestigeLevel,
  getXpToNextStage,
  checkEvolutionRequirements,

  // Stats
  calculateStatChanges,
  buildActionResult,
};
