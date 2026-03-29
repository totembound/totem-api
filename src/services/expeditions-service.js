/**
 * Expeditions Service
 *
 * Handles expedition management including starting, tracking, and claiming rewards.
 * Integrates with achievements service for progression tracking.
 *
 * Usage:
 *   const expeditionsService = require('./services/expeditions-service');
 *   await expeditionsService.startExpedition(userId, totemId, 'meadow-stroll');
 *   await expeditionsService.claimExpeditionReward(userId, totemId);
 */

const {
  getItem,
  putItem,
  deleteItem,
  queryItems,
  getTotem,
  updateTotem,
  addEssence,
  deductEssence,
  addRunes,
  getUserTotems,
  TABLES,
} = require('../common/db-client');

const { generateId } = require('../common/id-utils');
const { onExpeditionCompleted } = require('./achievements-service');

// =============================================================================
// EXPEDITION DEFINITIONS (15 total - synced with frontend expeditions.json)
// =============================================================================

/**
 * All available expeditions with their configurations
 * Synced with totem-app/public/config/expeditions.json
 *
 * Costs: Essence is DEDUCTED when starting (essenceCost)
 * Rewards: XP and Essence are GRANTED on completion (baseExp, baseEssence)
 */
const EXPEDITIONS = {
  // Quick (30 min) - Cost: 2 Essence + 1 Happiness, Reward: 5 XP + Runes
  'exp_lunch-delivery-mission': {
    id: 'exp_lunch-delivery-mission',
    name: 'Lunch Delivery Mission',
    description: 'A quick errand delivering meals across the meadow',
    domain: 0, // Air
    durationMinutes: 30,
    essenceCost: 2,
    happinessCost: 1,
    baseExp: 5,
    baseEssence: 3,
    affinityWeights: { strength: 1, agility: 8, wisdom: 1 },
    runeDropChances: { lesser: 20, greater: 0, ancient: 0 },
    requiredStage: 0,
  },
  'exp_weed-pulling-quest': {
    id: 'exp_weed-pulling-quest',
    name: 'Weed Pulling Quest',
    description: 'Help clear the garden of pesky weeds',
    domain: 1, // Earth
    durationMinutes: 30,
    essenceCost: 2,
    happinessCost: 1,
    baseExp: 5,
    baseEssence: 3,
    affinityWeights: { strength: 8, agility: 1, wisdom: 1 },
    runeDropChances: { lesser: 20, greater: 0, ancient: 0 },
    requiredStage: 0,
  },
  'exp_backyard-fishing-journey': {
    id: 'exp_backyard-fishing-journey',
    name: 'Backyard Fishing Journey',
    description: 'A relaxing trip to the nearby pond',
    domain: 2, // Water
    durationMinutes: 30,
    essenceCost: 2,
    happinessCost: 1,
    baseExp: 5,
    baseEssence: 3,
    affinityWeights: { strength: 1, agility: 1, wisdom: 8 },
    runeDropChances: { lesser: 20, greater: 0, ancient: 0 },
    requiredStage: 0,
  },

  // Medium (3 hr / 180 min) - Cost: 10 Essence + 5 Happiness, Reward: 15 XP + Runes
  'exp_wind-scout-patrol': {
    id: 'exp_wind-scout-patrol',
    name: 'Wind Scout Patrol',
    description: 'Surveying the territory from high vantage points',
    domain: 0, // Air
    durationMinutes: 180,
    essenceCost: 10,
    happinessCost: 5,
    baseExp: 15,
    baseEssence: 10,
    affinityWeights: { strength: 1, agility: 8, wisdom: 1 },
    runeDropChances: { lesser: 100, greater: 0, ancient: 0 },
    requiredStage: 1,
  },
  'exp_harvesting-run': {
    id: 'exp_harvesting-run',
    name: 'Harvesting Run',
    description: 'Gathering resources from the fertile lands',
    domain: 1, // Earth
    durationMinutes: 180,
    essenceCost: 10,
    happinessCost: 5,
    baseExp: 15,
    baseEssence: 10,
    affinityWeights: { strength: 8, agility: 1, wisdom: 1 },
    runeDropChances: { lesser: 100, greater: 0, ancient: 0 },
    requiredStage: 1,
  },
  'exp_quick-study-ritual': {
    id: 'exp_quick-study-ritual',
    name: 'Quick Study Ritual',
    description: 'Learning ancient wisdom from the elder spirits',
    domain: 2, // Water
    durationMinutes: 180,
    essenceCost: 10,
    happinessCost: 5,
    baseExp: 15,
    baseEssence: 10,
    affinityWeights: { strength: 1, agility: 1, wisdom: 8 },
    runeDropChances: { lesser: 100, greater: 0, ancient: 0 },
    requiredStage: 1,
  },

  // Long (6 hr / 360 min) - Cost: 20 Essence + 10 Happiness, Reward: 30 XP + Runes
  'exp_diplomatic-envoy': {
    id: 'exp_diplomatic-envoy',
    name: 'Diplomatic Envoy',
    description: 'Representing the tribe in peaceful negotiations',
    domain: 0, // Air
    durationMinutes: 360,
    essenceCost: 20,
    happinessCost: 10,
    baseExp: 30,
    baseEssence: 20,
    affinityWeights: { strength: 1, agility: 1, wisdom: 8 },
    runeDropChances: { lesser: 100, greater: 25, ancient: 0 },
    requiredStage: 1,
  },
  'exp_ruins-recovery': {
    id: 'exp_ruins-recovery',
    name: 'Ruins Recovery',
    description: 'Excavating artifacts from ancient sites',
    domain: 1, // Earth
    durationMinutes: 360,
    essenceCost: 20,
    happinessCost: 10,
    baseExp: 30,
    baseEssence: 20,
    affinityWeights: { strength: 8, agility: 1, wisdom: 1 },
    runeDropChances: { lesser: 100, greater: 25, ancient: 0 },
    requiredStage: 1,
  },
  'exp_basic-research-mission': {
    id: 'exp_basic-research-mission',
    name: 'Basic Research Mission',
    description: 'Investigating natural phenomena',
    domain: 2, // Water
    durationMinutes: 360,
    essenceCost: 20,
    happinessCost: 10,
    baseExp: 30,
    baseEssence: 20,
    affinityWeights: { strength: 1, agility: 8, wisdom: 1 },
    runeDropChances: { lesser: 100, greater: 25, ancient: 0 },
    requiredStage: 1,
  },

  // Extended (12 hr / 720 min) - Cost: 30 Essence + 15 Happiness, Reward: 60 XP + Runes
  'exp_festival-envoy': {
    id: 'exp_festival-envoy',
    name: 'Festival Envoy',
    description: 'Participating in grand celebrations across the land',
    domain: 0, // Air
    durationMinutes: 720,
    essenceCost: 30,
    happinessCost: 15,
    baseExp: 60,
    baseEssence: 35,
    affinityWeights: { strength: 1, agility: 8, wisdom: 1 },
    runeDropChances: { lesser: 100, greater: 50, ancient: 10 },
    requiredStage: 1,
  },
  'exp_warden-patrol': {
    id: 'exp_warden-patrol',
    name: 'Warden Patrol',
    description: 'Protecting the borders of the sacred lands',
    domain: 1, // Earth
    durationMinutes: 720,
    essenceCost: 30,
    happinessCost: 15,
    baseExp: 60,
    baseEssence: 35,
    affinityWeights: { strength: 8, agility: 1, wisdom: 1 },
    runeDropChances: { lesser: 100, greater: 50, ancient: 10 },
    requiredStage: 1,
  },
  'exp_sigil-synthesis': {
    id: 'exp_sigil-synthesis',
    name: 'Sigil Synthesis',
    description: 'Crafting mystical symbols of power',
    domain: 2, // Water
    durationMinutes: 720,
    essenceCost: 30,
    happinessCost: 15,
    baseExp: 60,
    baseEssence: 35,
    affinityWeights: { strength: 1, agility: 1, wisdom: 8 },
    runeDropChances: { lesser: 100, greater: 50, ancient: 10 },
    requiredStage: 1,
  },

  // Epic (24 hr / 1440 min) - Cost: 50 Essence + 20 Happiness, Reward: 120 XP + Runes
  'exp_celestial-mapping': {
    id: 'exp_celestial-mapping',
    name: 'Celestial Mapping',
    description: 'Charting the movements of the stars',
    domain: 0, // Air
    durationMinutes: 1440,
    essenceCost: 50,
    happinessCost: 20,
    baseExp: 120,
    baseEssence: 60,
    affinityWeights: { strength: 1, agility: 1, wisdom: 8 },
    runeDropChances: { lesser: 100, greater: 75, ancient: 25 },
    requiredStage: 2,
  },
  'exp_deep-exploration': {
    id: 'exp_deep-exploration',
    name: 'Deep Exploration',
    description: 'Venturing into uncharted territories',
    domain: 1, // Earth
    durationMinutes: 1440,
    essenceCost: 50,
    happinessCost: 20,
    baseExp: 120,
    baseEssence: 60,
    affinityWeights: { strength: 1, agility: 8, wisdom: 1 },
    runeDropChances: { lesser: 100, greater: 75, ancient: 25 },
    requiredStage: 2,
  },
  'exp_spirit-diplomacy': {
    id: 'exp_spirit-diplomacy',
    name: 'Spirit Diplomacy',
    description: 'Communing with the ancient spirit council',
    domain: 2, // Water
    durationMinutes: 1440,
    essenceCost: 50,
    happinessCost: 20,
    baseExp: 120,
    baseEssence: 60,
    affinityWeights: { strength: 8, agility: 1, wisdom: 1 },
    runeDropChances: { lesser: 100, greater: 75, ancient: 25 },
    requiredStage: 2,
  },
};

// =============================================================================
// KEY HELPERS
// =============================================================================

function expeditionPK(userId) {
  return `USER#${userId}`;
}

function activeExpeditionSK(totemId) {
  return `EXPEDITION#ACTIVE#${totemId}`;
}

function expeditionHistorySK(timestamp) {
  return `EXPEDITION#HISTORY#${timestamp}`;
}

function generateExpeditionId() {
  return generateId('userExpedition');
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Get expedition definition by ID
 * @param {string} expeditionId - Expedition ID (e.g., 'meadow-stroll')
 * @returns {object|null} Expedition definition or null if not found
 */
function getExpeditionDefinition(expeditionId) {
  return EXPEDITIONS[expeditionId] || null;
}

/**
 * Get all available expeditions
 * @returns {object[]} Array of expedition definitions
 */
function getAllExpeditions() {
  return Object.values(EXPEDITIONS);
}

/**
 * Get expeditions available for a totem based on its stage
 * @param {number} totemStage - Current totem stage (0-4)
 * @returns {object[]} Array of available expedition definitions
 */
function getAvailableExpeditions(totemStage) {
  return Object.values(EXPEDITIONS).filter(
    (exp) => exp.requiredStage <= totemStage
  );
}

// =============================================================================
// AFFINITY & DOMAIN SCORING (from TotemExpeditions.sol contract)
// =============================================================================

/**
 * Species → Affinity mapping (matches contract _getTotemAffinity)
 * Based on highest base stat per species
 */
const SPECIES_AFFINITIES = {
  0: 'wisdom',    // Goose (S:8, A:6, W:10)
  1: 'agility',   // Otter (S:8, A:10, W:6)
  2: 'strength',  // Wolf (S:11, A:8, W:5)
  3: 'agility',   // Falcon (S:5, A:12, W:7)
  4: 'strength',  // Beaver (S:10, A:5, W:9)
  5: 'agility',   // Deer (S:5, A:11, W:8)
  6: 'agility',   // Woodpecker (S:7, A:11, W:6)
  7: 'strength',  // Turtle (S:10, A:8, W:6)
  8: 'strength',  // Bear (S:12, A:5, W:7)
  9: 'wisdom',    // Raven (S:5, A:8, W:11)
  10: 'wisdom',   // Snake (S:7, A:6, W:11)
  11: 'wisdom',   // Owl (S:5, A:7, W:12)
};

/**
 * Species → Domain mapping (matches contract _getTotemDomain)
 * Domain IDs match expedition domains: 0=Air, 1=Earth, 2=Water
 */
const SPECIES_DOMAINS = {
  0: 2,   // Goose → Water
  1: 2,   // Otter → Water
  2: 1,   // Wolf → Earth
  3: 0,   // Falcon → Air
  4: 2,   // Beaver → Water
  5: 1,   // Deer → Earth
  6: 0,   // Woodpecker → Air
  7: 2,   // Turtle → Water
  8: 1,   // Bear → Earth
  9: 0,   // Raven → Air
  10: 1,  // Snake → Earth
  11: 0,  // Owl → Air
};

/**
 * Calculate expedition synergy score (0-100) based on totem-expedition match
 * Adapted from TotemExpeditions.sol _calculateScore() for single-totem
 *
 * @param {object} totem - Totem record from DB (needs speciesId, stage)
 * @param {object} expedition - Expedition config (needs domain, affinityWeights)
 * @returns {{ score: number, breakdown: object }}
 */
function calculateExpeditionScore(totem, expedition) {
  let score = 50; // Base score
  const breakdown = {};

  // 1. Domain match: +15 (captain domain matches expedition)
  const totemDomainId = SPECIES_DOMAINS[totem.speciesId] ?? -1;
  if (totemDomainId === expedition.domain) {
    score += 15;
    breakdown.domainMatch = 15;
  }
  else {
    breakdown.domainMatch = 0;
  }

  // 2. Affinity match: up to +14 (totem affinity vs expedition weights)
  const totemAffinity = SPECIES_AFFINITIES[totem.speciesId] || 'strength';
  const affinityIndex = { strength: 0, agility: 1, wisdom: 2 }[totemAffinity];
  const weights = expedition.affinityWeights || { strength: 1, agility: 1, wisdom: 1 };
  const weightArr = [weights.strength || 1, weights.agility || 1, weights.wisdom || 1];
  const primaryWeight = Math.max(...weightArr);
  const totemWeight = weightArr[affinityIndex];

  // Primary affinity bonus: 5 + (matchCount × 3) from contract
  // For single totem: if totem matches primary, full bonus (14); partial otherwise
  if (totemWeight === primaryWeight) {
    score += 14;
    breakdown.affinityMatch = 14;
  }
  else {
    // Partial bonus scaled by weight ratio
    const partial = Math.floor(5 * (totemWeight / primaryWeight));
    score += partial;
    breakdown.affinityMatch = partial;
  }

  // 3. Stage bonus: +10 (Elder stage 4+)
  const totemStage = totem.stage || 0;
  if (totemStage >= 4) {
    score += 10;
    breakdown.stageBonus = 10;
  }
  else {
    breakdown.stageBonus = 0;
  }

  // 4. Random variance: ±3
  const randomBonus = Math.floor(Math.random() * 7) - 3;
  score += randomBonus;
  breakdown.random = randomBonus;

  // Clamp 0-100
  score = Math.max(0, Math.min(100, score));

  // Determine success tier
  let tier;
  if (score >= 90) tier = 'great_success';
  else if (score >= 70) tier = 'success';
  else if (score >= 50) tier = 'normal';
  else tier = 'below_average';

  return { score, tier, breakdown, totemAffinity, totemDomainId };
}

/**
 * Get reward multipliers based on expedition score
 * From TotemExpeditions.sol: Great=150%, Success=125%, Normal=100%, Below=75%
 *
 * @param {string} tier - Score tier
 * @returns {{ xpMultiplier: number, essenceMultiplier: number, runeMultiplier: number }}
 */
function getScoreMultipliers(tier) {
  switch (tier) {
    case 'great_success':
      return { xpMultiplier: 1.5, essenceMultiplier: 1.5, runeMultiplier: 1.3 };
    case 'success':
      return { xpMultiplier: 1.25, essenceMultiplier: 1.25, runeMultiplier: 1.0 };
    case 'normal':
      return { xpMultiplier: 1.0, essenceMultiplier: 1.0, runeMultiplier: 1.0 };
    case 'below_average':
    default:
      return { xpMultiplier: 0.75, essenceMultiplier: 0.75, runeMultiplier: 0.5 };
  }
}

/**
 * Calculate XP reward with multiplier
 * @param {string} expeditionId - Expedition ID
 * @param {number} multiplier - Score multiplier
 * @returns {number} XP reward amount
 */
function calculateExpReward(expeditionId, multiplier = 1.0) {
  const expedition = EXPEDITIONS[expeditionId];
  if (!expedition) {
    throw new Error(`Unknown expedition: ${expeditionId}`);
  }

  // Base XP with 10% variance, then apply multiplier
  const { baseExp } = expedition;
  const variance = Math.floor(baseExp * 0.1);
  const bonus = Math.floor(Math.random() * variance * 2) - variance;
  return Math.max(1, Math.floor((baseExp + bonus) * multiplier));
}

/**
 * Calculate Essence reward with multiplier
 * @param {string} expeditionId - Expedition ID
 * @param {number} multiplier - Score multiplier
 * @returns {number} Essence reward amount
 */
function calculateEssenceReward(expeditionId, multiplier = 1.0) {
  const expedition = EXPEDITIONS[expeditionId];
  if (!expedition || !expedition.baseEssence) {
    return 0;
  }

  // Base Essence with 10% variance, then apply multiplier
  const { baseEssence } = expedition;
  const variance = Math.floor(baseEssence * 0.1);
  const bonus = Math.floor(Math.random() * variance * 2) - variance;
  return Math.max(1, Math.floor((baseEssence + bonus) * multiplier));
}

/**
 * Get base rune quantity by expedition duration tier.
 * Longer expeditions reward more runes when the drop chance succeeds.
 *   30min → 1, 3hr → 1, 6hr → 2, 12hr → 3, 24hr → 4
 * @param {number} durationMinutes - Expedition duration in minutes
 * @returns {number} Base quantity per successful roll
 */
function getRuneQuantity(durationMinutes) {
  if (durationMinutes >= 1440) return 3; // 24hr
  if (durationMinutes >= 720) return 2;  // 12hr
  return 1;                               // 30min / 3hr / 6hr
}

/**
 * Roll for rune drops with multiplier applied to chances.
 * Quantity scales with expedition duration so longer expeditions
 * reward more runes (not just the same single rune).
 *
 * @param {object} expedition - Expedition definition
 * @param {number} runeMultiplier - Multiplier for rune drop chances
 * @returns {object} Runes earned { lesser: number, greater: number, ancient: number }
 */
function rollForRunes(expedition, runeMultiplier = 1.0) {
  const { runeDropChances } = expedition;
  if (!runeDropChances) return { lesser: 0, greater: 0, ancient: 0 };

  // Only lesser runes scale in quantity with duration; greater/ancient stay 0 or 1.
  const lesserQty = getRuneQuantity(expedition.durationMinutes);

  const runes = {
    lesser: Math.random() * 100 < (runeDropChances.lesser || 0) * runeMultiplier ? lesserQty : 0,
    greater: Math.random() * 100 < (runeDropChances.greater || 0) * runeMultiplier ? 1 : 0,
    ancient: Math.random() * 100 < (runeDropChances.ancient || 0) * runeMultiplier ? 1 : 0,
  };

  return runes;
}

/**
 * Check if a totem is currently busy (on expedition)
 * @param {string} userId - User ID
 * @param {string} totemId - Totem ID
 * @returns {Promise<object|null>} Active expedition or null if not busy
 */
async function getActiveExpedition(userId, totemId) {
  return getItem(TABLES.EXPEDITION_STATE, {
    pk: expeditionPK(userId),
    sk: activeExpeditionSK(totemId),
  });
}

/**
 * Get all active expeditions for a user
 * @param {string} userId - User ID
 * @returns {Promise<object[]>} Array of active expeditions
 */
async function getActiveExpeditions(userId) {
  const items = await queryItems(TABLES.EXPEDITION_STATE, 'pk', expeditionPK(userId), {
    skPrefix: 'EXPEDITION#ACTIVE#',
  });

  // Update status based on current time
  const now = new Date();
  return items.map((exp) => ({
    ...exp,
    status: new Date(exp.endsAt) <= now ? 'completed' : 'in_progress',
    canClaim: new Date(exp.endsAt) <= now && !exp.claimed,
  }));
}

/**
 * Get expedition history for a user
 * @param {string} userId - User ID
 * @param {number} limit - Maximum number of records to return
 * @returns {Promise<object[]>} Array of historical expedition records
 */
async function getExpeditionHistory(userId, limit = 50) {
  return queryItems(TABLES.EXPEDITION_STATE, 'pk', expeditionPK(userId), {
    skPrefix: 'EXPEDITION#HISTORY#',
    limit,
    scanIndexForward: false, // Most recent first
  });
}

/**
 * Get total expedition count for a user (for achievements)
 * @param {string} userId - User ID
 * @returns {Promise<number>} Total completed expeditions
 */
async function getExpeditionCount(userId) {
  const history = await queryItems(TABLES.EXPEDITION_STATE, 'pk', expeditionPK(userId), {
    skPrefix: 'EXPEDITION#HISTORY#',
  });
  return history.length;
}

/**
 * Start a new expedition for a totem
 * @param {string} userId - User ID
 * @param {string} totemId - Totem ID
 * @param {string} expeditionId - Expedition ID to start
 * @returns {Promise<object>} Result with success status and expedition data
 */
async function startExpedition(userId, totemId, expeditionId, totemIds) {
  // Validate expedition exists
  const expedition = EXPEDITIONS[expeditionId];
  if (!expedition) {
    return {
      success: false,
      error: 'Invalid expedition',
      message: `Expedition "${expeditionId}" does not exist`,
    };
  }

  // Check if totem exists and belongs to user
  const totem = await getTotem(userId, totemId);
  if (!totem) {
    return {
      success: false,
      error: 'Totem not found',
      message: 'The specified totem does not exist or does not belong to you',
    };
  }

  // Check user has at least 3 totems
  const userTotems = await getUserTotems(userId);
  if (userTotems.length < 3) {
    return {
      success: false,
      error: 'Not enough totems',
      message: `Expeditions require at least 3 totems. You have ${userTotems.length}.`,
      required: 3,
      available: userTotems.length,
    };
  }

  // Check totem stage requirement
  if (totem.stage < expedition.requiredStage) {
    return {
      success: false,
      error: 'Totem stage too low',
      message: `This expedition requires stage ${expedition.requiredStage} or higher. Your totem is stage ${totem.stage}.`,
    };
  }

  // Resolve all team totems
  const allTotemIds = Array.isArray(totemIds) && totemIds.length > 0 ? totemIds : [totemId];

  // Check if ANY team totem is already on an expedition (not just the lead)
  for (const tid of allTotemIds) {
    const existingExp = await getActiveExpedition(userId, tid);
    if (existingExp) {
      return {
        success: false,
        error: 'Totem is busy',
        message: `Totem ${tid} is already on an expedition`,
        activeExpedition: {
          id: existingExp.id,
          expeditionId: existingExp.expeditionId,
          expeditionName: EXPEDITIONS[existingExp.expeditionId]?.name,
          endsAt: existingExp.endsAt,
          busyTotemId: tid,
        },
      };
    }
  }

  // Resolve all team totems and check sanctum availability
  const { checkExpeditionAvailability, checkActionAvailability } = require('../common/totem-utils');
  const teamTotems = [];
  for (const tid of allTotemIds) {
    const t = tid === totemId ? totem : await getTotem(userId, tid);
    if (!t) continue;
    const councilCheck = checkExpeditionAvailability(t);
    if (!councilCheck.available) {
      return { success: false, error: councilCheck.error };
    }
    const missionCheck = checkActionAvailability(t);
    if (!missionCheck.available) {
      return { success: false, error: missionCheck.error };
    }
    teamTotems.push({ id: tid, totem: t });
  }

  // Check happiness cost requirement for ALL team totems (validate before deducting anything)
  const happinessCost = expedition.happinessCost || 0;
  if (happinessCost > 0) {
    for (const { id: tid, totem: t } of teamTotems) {
      const currentHappiness = t.stats?.happiness ?? 50;
      if (currentHappiness < happinessCost) {
        return {
          success: false,
          error: 'Insufficient happiness',
          message: `This expedition requires ${happinessCost} happiness. Totem ${tid} has ${currentHappiness}.`,
          required: happinessCost,
          available: currentHappiness,
        };
      }
    }
  }

  // Deduct Essence cost
  const essenceCost = expedition.essenceCost || 0;
  if (essenceCost > 0) {
    const costResult = await deductEssence(userId, essenceCost, {
      type: 'expedition_start',
      ref: expeditionId,
      refType: 'expedition',
      refName: expedition.name,
    });

    if (!costResult.success) {
      return {
        success: false,
        error: 'Insufficient Essence',
        message: `This expedition requires ${essenceCost} Essence to start. You have ${costResult.available || 0}.`,
        required: essenceCost,
        available: costResult.available,
      };
    }
  }

  // Deduct happiness cost from ALL team totems
  if (happinessCost > 0) {
    for (const { id: tid, totem: t } of teamTotems) {
      const currentHappiness = t.stats?.happiness ?? 50;
      await updateTotem(userId, tid, {
        'stats.happiness': Math.max(0, currentHappiness - happinessCost),
      });
    }
  }

  // Calculate timing
  const now = new Date();
  const endsAt = new Date(now.getTime() + expedition.durationMinutes * 60 * 1000);
  const expId = generateExpeditionId();

  // Create active expedition record
  const expeditionRecord = {
    pk: expeditionPK(userId),
    sk: activeExpeditionSK(totemId),
    id: expId,
    odUserId: userId,
    totemId,
    totemIds: Array.isArray(totemIds) && totemIds.length > 0 ? totemIds : [totemId],
    expeditionId,
    startedAt: now.toISOString(),
    endsAt: endsAt.toISOString(),
    status: 'in_progress',
    claimed: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await putItem(TABLES.EXPEDITION_STATE, expeditionRecord);

  // Mark ALL team totems as busy
  for (const tid of allTotemIds) {
    try {
      await updateTotem(userId, tid, {
        expedition: { active: true, expeditionId: expId, endsAt: endsAt.toISOString() },
      });
    }
    catch (err) {
      console.warn(`[Expedition] Failed to mark totem ${tid} busy (non-critical):`, err.message);
    }
  }

  console.log(`[Expedition] Started "${expedition.name}" for totem ${totemId} by user ${userId} (cost: ${essenceCost} Essence, ${happinessCost} happiness)`);

  return {
    success: true,
    expedition: {
      id: expId,
      expeditionId,
      name: expedition.name,
      description: expedition.description,
      durationMinutes: expedition.durationMinutes,
      essenceCost,
      happinessCost,
      baseExp: expedition.baseExp,
      startedAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
      totemId,
      status: 'in_progress',
    },
  };
}

/**
 * Claim reward for a completed expedition
 * @param {string} userId - User ID
 * @param {string} totemId - Totem ID
 * @returns {Promise<object>} Result with success status and rewards
 */
async function claimExpeditionReward(userId, totemId) {
  // Get active expedition
  const activeExpedition = await getActiveExpedition(userId, totemId);
  if (!activeExpedition) {
    return {
      success: false,
      error: 'No active expedition',
      message: 'This totem is not on an expedition',
    };
  }

  // Check if already claimed
  if (activeExpedition.claimed) {
    return {
      success: false,
      error: 'Already claimed',
      message: 'This expedition reward has already been claimed',
    };
  }

  // Check if expedition is complete
  const now = new Date();
  const endsAt = new Date(activeExpedition.endsAt);
  if (now < endsAt) {
    const remainingMs = endsAt.getTime() - now.getTime();
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return {
      success: false,
      error: 'Expedition in progress',
      message: 'This expedition is not yet complete',
      remainingMinutes,
      endsAt: activeExpedition.endsAt,
    };
  }

  // Get expedition definition
  const expedition = EXPEDITIONS[activeExpedition.expeditionId];
  if (!expedition) {
    return {
      success: false,
      error: 'Invalid expedition',
      message: 'Expedition definition not found',
    };
  }

  // Get lead totem for scoring
  const leadTotem = await getTotem(userId, totemId);
  if (!leadTotem) {
    return {
      success: false,
      error: 'Totem not found',
      message: 'Could not find totem to grant XP',
    };
  }

  // Calculate synergy score based on lead totem-expedition match
  const scoreResult = calculateExpeditionScore(leadTotem, expedition);
  const multipliers = getScoreMultipliers(scoreResult.tier);

  // Calculate rewards with score multiplier
  const expReward = calculateExpReward(activeExpedition.expeditionId, multipliers.xpMultiplier);
  const essenceReward = calculateEssenceReward(activeExpedition.expeditionId, multipliers.essenceMultiplier);
  const runesEarned = rollForRunes(expedition, multipliers.runeMultiplier);

  // Award Essence to user
  let newEssenceBalance = null;
  if (essenceReward > 0) {
    const essenceResult = await addEssence(userId, essenceReward, {
      type: 'reward_expedition',
      ref: activeExpedition.expeditionId,
    });
    newEssenceBalance = essenceResult.newBalance;
  }

  // Award Runes to user
  let newRuneBalances = null;
  const hasRunes = (runesEarned.lesser || 0) + (runesEarned.greater || 0) + (runesEarned.ancient || 0) > 0;
  if (hasRunes) {
    const runeResult = await addRunes(userId, runesEarned, {
      type: 'reward_expedition',
      ref: activeExpedition.expeditionId,
    });
    if (runeResult.success) {
      newRuneBalances = runeResult.newBalances;
    }
  }

  // Add XP to ALL team totems (all paid happiness, all earn XP)
  const allTotemIds = activeExpedition.totemIds || [totemId];
  const totemExpUpdates = {};
  for (const tid of allTotemIds) {
    const t = tid === totemId ? leadTotem : await getTotem(userId, tid);
    if (t) {
      const currentExp = t.experience || 0;
      const newExp = currentExp + expReward;
      await updateTotem(userId, tid, { experience: newExp });
      totemExpUpdates[tid] = newExp;
    }
  }

  // Create history record
  const historyRecord = {
    pk: expeditionPK(userId),
    sk: expeditionHistorySK(now.toISOString()),
    id: activeExpedition.id,
    odUserId: userId,
    totemId,
    totemIds: allTotemIds,
    expeditionId: activeExpedition.expeditionId,
    expeditionName: expedition.name,
    startedAt: activeExpedition.startedAt,
    completedAt: now.toISOString(),
    durationMinutes: expedition.durationMinutes,
    expEarned: expReward,
    essenceEarned: essenceReward,
    runesEarned,
    score: scoreResult.score,
    scoreTier: scoreResult.tier,
    createdAt: now.toISOString(),
    // Auto-delete after 90 days
    ttl: Math.floor(now.getTime() / 1000) + 90 * 24 * 60 * 60,
  };

  await putItem(TABLES.EXPEDITION_STATE, historyRecord);

  // Delete active expedition record
  await deleteItem(TABLES.EXPEDITION_STATE, {
    pk: expeditionPK(userId),
    sk: activeExpeditionSK(totemId),
  });

  // Clear busy status on ALL team totems
  for (const tid of allTotemIds) {
    try {
      await updateTotem(userId, tid, {
        expedition: { active: false, expeditionId: null, endsAt: null },
      });
    }
    catch (err) {
      console.warn(`[Expedition] Failed to clear totem ${tid} busy status (non-critical):`, err.message);
    }
  }

  // Trigger achievement check (pass totemId for XP rewards)
  const totalExpeditions = await getExpeditionCount(userId);
  let achievements = [];
  try {
    const achResults = await onExpeditionCompleted(userId, totalExpeditions, totemId);
    achievements = (achResults || []).filter(a => a.unlocked).map(a => ({
      achievementId: a.achievementId,
      milestone: a.milestone,
      rewards: a.rewards,
    }));
  }
  catch (err) {
    console.error('[Expedition] Achievement check failed:', err.message);
  }

  const tierLabels = { great_success: 'Great Success', success: 'Success', normal: 'Normal', below_average: 'Below Average' };
  console.log(`[Expedition] Claimed "${expedition.name}" reward: ${expReward} XP, ${essenceReward} Essence, score=${scoreResult.score} (${tierLabels[scoreResult.tier]}) for totem ${totemId} (user ${userId})`);

  return {
    success: true,
    rewards: {
      experience: expReward,
      essence: essenceReward,
      newEssenceBalance,
      runes: runesEarned,
      newRuneBalances,
      totemExpUpdates,
    },
    score: {
      value: scoreResult.score,
      tier: scoreResult.tier,
      tierLabel: tierLabels[scoreResult.tier] || 'Normal',
      breakdown: scoreResult.breakdown,
      totemAffinity: scoreResult.totemAffinity,
      multipliers,
    },
    expedition: {
      id: activeExpedition.id,
      expeditionId: activeExpedition.expeditionId,
      name: expedition.name,
      startedAt: activeExpedition.startedAt,
      completedAt: now.toISOString(),
      durationMinutes: expedition.durationMinutes,
    },
    totalExpeditions,
    achievements,
  };
}

/**
 * Cancel an active expedition (loses progress, no rewards)
 * @param {string} userId - User ID
 * @param {string} totemId - Totem ID
 * @returns {Promise<object>} Result with success status
 */
async function cancelExpedition(userId, totemId) {
  const activeExpedition = await getActiveExpedition(userId, totemId);
  if (!activeExpedition) {
    return {
      success: false,
      error: 'No active expedition',
      message: 'This totem is not on an expedition',
    };
  }

  // Delete active expedition record
  await deleteItem(TABLES.EXPEDITION_STATE, {
    pk: expeditionPK(userId),
    sk: activeExpeditionSK(totemId),
  });

  // Clear busy status on ALL team totems
  const allTotemIds = activeExpedition.totemIds || [totemId];
  for (const tid of allTotemIds) {
    try {
      await updateTotem(userId, tid, {
        expedition: { active: false, expeditionId: null, endsAt: null },
      });
    }
    catch (err) {
      console.warn(`[Expedition] Failed to clear totem ${tid} busy status (non-critical):`, err.message);
    }
  }

  const expedition = EXPEDITIONS[activeExpedition.expeditionId];
  console.log(`[Expedition] Cancelled "${expedition?.name || activeExpedition.expeditionId}" for totem ${totemId}`);

  return {
    success: true,
    message: 'Expedition cancelled. No rewards earned.',
    cancelledExpedition: {
      id: activeExpedition.id,
      expeditionId: activeExpedition.expeditionId,
      name: expedition?.name,
    },
  };
}

/**
 * Check expedition status for a totem
 * @param {string} userId - User ID
 * @param {string} totemId - Totem ID
 * @returns {Promise<object>} Expedition status
 */
async function checkExpeditionStatus(userId, totemId) {
  const activeExpedition = await getActiveExpedition(userId, totemId);

  if (!activeExpedition) {
    return {
      hasActiveExpedition: false,
      status: 'idle',
    };
  }

  const now = new Date();
  const endsAt = new Date(activeExpedition.endsAt);
  const expedition = EXPEDITIONS[activeExpedition.expeditionId];
  const isComplete = now >= endsAt;

  return {
    hasActiveExpedition: true,
    status: isComplete ? 'completed' : 'in_progress',
    canClaim: isComplete && !activeExpedition.claimed,
    expedition: {
      id: activeExpedition.id,
      expeditionId: activeExpedition.expeditionId,
      name: expedition?.name,
      description: expedition?.description,
      startedAt: activeExpedition.startedAt,
      endsAt: activeExpedition.endsAt,
      durationMinutes: expedition?.durationMinutes,
      remainingMinutes: isComplete ? 0 : Math.ceil((endsAt.getTime() - now.getTime()) / 60000),
      progress: isComplete
        ? 100
        : Math.floor(
          ((now.getTime() - new Date(activeExpedition.startedAt).getTime()) /
              (expedition?.durationMinutes * 60 * 1000)) *
              100
        ),
    },
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Constants
  EXPEDITIONS,

  // Expedition definitions
  getExpeditionDefinition,
  getAllExpeditions,
  getAvailableExpeditions,

  // Reward calculation
  calculateExpReward,
  rollForRunes,

  // Core operations
  startExpedition,
  claimExpeditionReward,
  cancelExpedition,

  // Status & queries
  getActiveExpedition,
  getActiveExpeditions,
  getExpeditionHistory,
  getExpeditionCount,
  checkExpeditionStatus,

  // Key helpers (for external use if needed)
  expeditionPK,
  activeExpeditionSK,
  expeditionHistorySK,
  generateExpeditionId,
};
