/**
 * Sanctum Service
 *
 * Handles the Elder Sanctum feature where Stage 4+ (Adult/Ascended) totems can be
 * seated to passively earn Essence over time. Earnings scale with tenure.
 *
 * Key patterns:
 * - Uses EXPEDITION_STATE table with SANCTUM# prefix for seat records
 * - Totem records get a `sanctum` field when seated
 * - Earnings are capped at 168 hours (7 days) to encourage regular claiming
 * - Atomic claim via transactWrite to prevent double-spend
 *
 * Usage:
 *   const sanctumService = require('./services/sanctum-service');
 *   await sanctumService.seatTotem(userId, totemId, 0);
 *   await sanctumService.claimSanctum(userId);
 */

const {
  getItem,
  putItem,
  deleteItem,
  queryItems,
  getTotem,
  updateTotem,
  addRunes,
  getUserTotems,
  transactWrite,
  TABLES,
  userPK,
  logTransaction,
} = require('../common/db-client');

const {
  onElderSeated,
  onSanctumClaimed,
  onTenureCheck,
  onMissionCompleted,
} = require('./achievements-service');

const { SPECIES_DISPLAY_NAMES } = require('./totem-creation');
const { addTotemXp } = require('./totem-xp');
const { resolveTraitBonuses } = require('../config/trait-effects');

// =============================================================================
// Constants
// =============================================================================

/** Minimum XP to enter the Sanctum — Stage 4 in UI (internal stage 3, Adult) */
const SANCTUM_MIN_XP = 3500;


/** Maximum hours of earnings that can accumulate before claiming */
const MAX_ACCUMULATION_HOURS = 168; // 7 days

/** Base Essence per hour (before tenure multiplier) */
const BASE_RATE_PER_HOUR = 0.5;

/** Maximum number of seats possible */
const MAX_SEATS = 3;

// =============================================================================
// Key Helpers
// =============================================================================

function sanctumPK(userId) {
  return `SANCTUM#${userId}`;
}

function seatSK(seatIndex) {
  return `SEAT#${seatIndex}`;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get tenure multiplier based on hours seated
 *
 * Brackets:
 *   0-24 hrs   = 1.0x
 *   24-72 hrs  = 1.1x
 *   72-168 hrs = 1.2x
 *   168-336 hrs = 1.3x
 *   336-720 hrs = 1.4x
 *   720+ hrs   = 1.5x
 *
 * @param {number} tenureHours - Hours since totem was seated
 * @returns {number} Multiplier between 1.0 and 1.5
 */
function getTenureMultiplier(tenureHours) {
  if (tenureHours >= 720) return 1.5;
  if (tenureHours >= 336) return 1.4;
  if (tenureHours >= 168) return 1.3;
  if (tenureHours >= 72) return 1.2;
  if (tenureHours >= 24) return 1.1;
  return 1.0;
}

/**
 * Calculate Essence earnings for a single seat
 *
 * Formula: floor(BASE_RATE_PER_HOUR * tenureMultiplier * cappedHours)
 * - Hours since lastClaimedAt, capped at MAX_ACCUMULATION_HOURS
 * - Tenure multiplier based on total time seated (seatedAt)
 *
 * @param {object} seat - Seat record from DB
 * @param {Date} [now] - Current time (for testing)
 * @returns {number} Integer Essence earned
 */
function calculateSeatEarnings(seat, now, bonuses = null) {
  if (!seat || !seat.lastClaimedAt || !seat.seatedAt) return 0;

  const currentTime = now || new Date();
  const lastClaimed = new Date(seat.lastClaimedAt);
  const seatedAt = new Date(seat.seatedAt);

  // Hours since last claim (earning period)
  const hoursSinceLastClaim = (currentTime - lastClaimed) / (1000 * 60 * 60);
  const cappedHours = Math.min(hoursSinceLastClaim, MAX_ACCUMULATION_HOURS);

  // Tenure = total time seated (for multiplier bracket).
  // Shy: seatEarnRateMultiplier ×1.05; Loyal: tenureBonusMultiplier ×1.05.
  const tenureHours = (currentTime - seatedAt) / (1000 * 60 * 60);
  const tenureMul = getTenureMultiplier(tenureHours) * (bonuses?.tenureBonusMultiplier ?? 1);
  const ratePerHour = BASE_RATE_PER_HOUR * (bonuses?.seatEarnRateMultiplier ?? 1);

  return Math.floor(ratePerHour * tenureMul * cappedHours);
}

/**
 * Check if a totem meets the minimum stage for the Sanctum (Stage 4+ / 3500 XP)
 * @param {object} totem - Totem record
 * @returns {boolean}
 */
function isSanctumEligible(totem) {
  return (totem.experience || 0) >= SANCTUM_MIN_XP;
}

// =============================================================================
// Service Functions
// =============================================================================

/**
 * Get the user's sanctum state including all seats and pending earnings
 *
 * @param {string} userId - User ID
 * @returns {Promise<object>} Sanctum state
 */
async function getSanctum(userId) {
  // Query all seat records for this user
  const seats = await queryItems(TABLES.EXPEDITION_STATE, 'pk', sanctumPK(userId), {
    skPrefix: 'SEAT#',
  });

  // Get user's tier (for max seats calculation)
  const user = await require('../common/db-client').getUser(userId);
  const userTier = user?.subscription?.tier || 0;

  // Calculate max seats
  const maxSeats = await getMaxSeats(userId, userTier);

  const now = new Date();

  // Enrich each seat with totem data and compute earnings
  const seatData = [];
  for (const seat of seats) {
    const totem = await getTotem(userId, seat.totemId);
    const seatBonuses = totem ? resolveTraitBonuses(totem, { system: 'sanctum' }) : null;
    const tenureHours = (now - new Date(seat.seatedAt)) / 3_600_000;
    const multiplier = getTenureMultiplier(tenureHours) * (seatBonuses?.tenureBonusMultiplier ?? 1);
    const accumulated = calculateSeatEarnings(seat, now, seatBonuses);

    // Check for active mission
    const missionRecord = await getItem(TABLES.EXPEDITION_STATE, {
      pk: sanctumPK(userId),
      sk: missionActiveSK(seat.totemId),
    });

    seatData.push({
      seatIndex: seat.seatIndex,
      totemId: seat.totemId,
      totemName: totem?.nickname || SPECIES_DISPLAY_NAMES[totem?.speciesId] || 'Totem',
      species: SPECIES_DISPLAY_NAMES[totem?.speciesId] || `Species ${totem?.speciesId}`,
      seatedAt: seat.seatedAt,
      lastClaimedAt: seat.lastClaimedAt,
      tenureDays: +(tenureHours / 24).toFixed(1),
      tenureMultiplier: multiplier,
      accumulatedEssence: accumulated,
      atCap: (now - new Date(seat.lastClaimedAt)) / 3_600_000 >= MAX_ACCUMULATION_HOURS,
      onMission: !!(totem?.sanctum?.onMission || missionRecord),
      activeMission: missionRecord ? {
        missionType: missionRecord.missionType,
        name: COUNCIL_MISSIONS[missionRecord.missionType]?.name || missionRecord.missionType,
        startedAt: missionRecord.startedAt,
        endsAt: missionRecord.endsAt,
        canClaim: new Date(missionRecord.endsAt) <= now,
      } : null,
    });
  }

  const totalAccumulated = seatData.reduce((sum, s) => sum + s.accumulatedEssence, 0);

  // Determine locked seats (seats the user hasn't unlocked yet)
  const lockedSeats = [];
  for (let i = 0; i < 3; i++) {
    if (i >= maxSeats) lockedSeats.push(i);
  }

  return {
    maxSeats,
    seats: seatData,
    totalAccumulated,
    lockedSeats,
  };
}

/**
 * Determine how many sanctum seats a user has unlocked
 *
 * Seat 1: Own any Stage 4 totem
 * Seat 2: VIP tier 1+ OR 5+ Stage 4 totems
 * Seat 3: VIP tier 2 OR 10+ Stage 4 totems
 *
 * @param {string} userId - User ID
 * @param {number} userTier - User's subscription tier (0=free, 1=premium, 2=VIP)
 * @returns {Promise<number>} Number of available seats (0-3)
 */
async function getMaxSeats(userId, userTier) {
  const totems = await getUserTotems(userId);
  const stage4Count = totems.filter(t => (t.experience || 0) >= SANCTUM_MIN_XP).length;

  if (stage4Count === 0) return 0;

  let seats = 1; // Seat 1: any stage 4 totem

  // Seat 2: VIP tier 1+ OR 5+ stage 4 totems
  if (userTier >= 1 || stage4Count >= 5) {
    seats = 2;
  }

  // Seat 3: VIP tier 2 OR 10+ stage 4 totems
  if (userTier >= 2 || stage4Count >= 10) {
    seats = 3;
  }

  return seats;
}

/**
 * Seat a totem in the Elder Sanctum
 *
 * @param {string} userId - User ID
 * @param {string} totemId - Totem to seat
 * @param {number} [seatIndex] - Specific seat (0, 1, 2). Auto-assigns if omitted.
 * @returns {Promise<object>} Result with updated sanctum state
 */
async function seatTotem(userId, totemId, seatIndex) {
  // 1. Validate totem exists and is owned
  const totem = await getTotem(userId, totemId);
  if (!totem) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Totem not found or not owned by you' },
    };
  }

  // 2. Must be Stage 4 (Ascended)
  if (!isSanctumEligible(totem)) {
    return {
      success: false,
      error: {
        code: 'NOT_ASCENDED',
        message: 'Totem must be at least Stage 4 (Adult) to enter the Elder Sanctum. Requires 3,500 XP.',
      },
    };
  }

  // 3. Check not already seated
  if (totem.sanctum && totem.sanctum.seated) {
    return {
      success: false,
      error: {
        code: 'ALREADY_SEATED',
        message: 'This totem is already seated in the Elder Sanctum',
      },
    };
  }

  // 4. Check not on expedition
  const activeExpedition = await getItem(TABLES.EXPEDITION_STATE, {
    pk: `USER#${userId}`,
    sk: `EXPEDITION#ACTIVE#${totemId}`,
  });
  if (activeExpedition) {
    return {
      success: false,
      error: {
        code: 'ON_EXPEDITION',
        message: 'This totem is currently on an expedition and cannot be seated',
      },
    };
  }

  // 5. Get user tier and max seats
  const user = await require('../common/db-client').getUser(userId);
  const userTier = user?.subscription?.tier || 0;
  const maxSeats = await getMaxSeats(userId, userTier);

  if (maxSeats === 0) {
    return {
      success: false,
      error: {
        code: 'NO_STAGE4_TOTEMS',
        message: 'You need at least one Stage 4+ totem (3,500 XP) to unlock the Elder Sanctum',
      },
    };
  }

  // 6. Get current seats
  const existingSeats = await queryItems(TABLES.EXPEDITION_STATE, 'pk', sanctumPK(userId), {
    skPrefix: 'SEAT#',
  });

  // Check if totem is already in a seat (double-check via seat records)
  const alreadySeated = existingSeats.find(s => s.totemId === totemId);
  if (alreadySeated) {
    return {
      success: false,
      error: {
        code: 'ALREADY_SEATED',
        message: 'This totem is already seated in the Elder Sanctum',
      },
    };
  }

  // 7. Determine seat index
  const occupiedIndices = new Set(existingSeats.map(s => s.seatIndex));

  if (seatIndex !== undefined && seatIndex !== null) {
    // Validate requested seat
    if (seatIndex < 0 || seatIndex >= maxSeats) {
      return {
        success: false,
        error: {
          code: 'NO_AVAILABLE_SEAT',
          message: `Seat ${seatIndex} is not available. You have ${maxSeats} seat(s) unlocked.`,
        },
      };
    }
    if (occupiedIndices.has(seatIndex)) {
      return {
        success: false,
        error: {
          code: 'NO_AVAILABLE_SEAT',
          message: `Seat ${seatIndex} is already occupied`,
        },
      };
    }
  }
  else {
    // Auto-assign first available seat
    seatIndex = null;
    for (let i = 0; i < maxSeats; i++) {
      if (!occupiedIndices.has(i)) {
        seatIndex = i;
        break;
      }
    }
    if (seatIndex === null) {
      return {
        success: false,
        error: {
          code: 'NO_AVAILABLE_SEAT',
          message: `All ${maxSeats} seat(s) are occupied. Unseat a totem first.`,
        },
      };
    }
  }

  // 8. Create seat record
  const now = new Date().toISOString();
  const seatRecord = {
    pk: sanctumPK(userId),
    sk: seatSK(seatIndex),
    userId,
    totemId,
    totemName: totem.name || totem.species,
    species: totem.species,
    rarity: totem.rarity,
    seatIndex,
    seatedAt: now,
    lastClaimedAt: now,
    onMission: false,
    createdAt: now,
    updatedAt: now,
  };

  await putItem(TABLES.EXPEDITION_STATE, seatRecord);

  // 9. Update totem with sanctum field
  await updateTotem(userId, totemId, {
    sanctum: {
      seated: true,
      seatIndex,
      seatedAt: now,
      onMission: false,
    },
  });

  // 10. Check sanctum achievements (non-blocking)
  let achievements = [];
  try {
    const totalSeatedCount = existingSeats.length + 1;
    achievements = await onElderSeated(userId, { totalSeatedCount });
  }
  catch (err) {
    console.error('[Sanctum] Achievement check failed on seatTotem:', err.message);
  }

  // 11. Return updated sanctum state
  const sanctum = await getSanctum(userId);
  return {
    success: true,
    data: {
      ...sanctum,
      achievements,
    },
  };
}

/**
 * Remove a totem from the Elder Sanctum
 *
 * @param {string} userId - User ID
 * @param {string} totemId - Totem to unseat
 * @returns {Promise<object>} Result with updated sanctum state
 */
async function unseatTotem(userId, totemId) {
  // 1. Validate totem exists and is owned
  const totem = await getTotem(userId, totemId);
  if (!totem) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Totem not found or not owned by you' },
    };
  }

  // 2. Check totem is actually seated
  if (!totem.sanctum || !totem.sanctum.seated) {
    return {
      success: false,
      error: {
        code: 'NOT_SEATED',
        message: 'This totem is not seated in the Elder Sanctum',
      },
    };
  }

  // 3. Check not on a council mission
  if (totem.sanctum.onMission) {
    return {
      success: false,
      error: {
        code: 'ON_MISSION',
        message: 'This totem is currently on a council mission and cannot be removed',
      },
    };
  }

  const seatIndex = totem.sanctum.seatIndex;

  // 4. Delete seat record from EXPEDITION_STATE
  await deleteItem(TABLES.EXPEDITION_STATE, {
    pk: sanctumPK(userId),
    sk: seatSK(seatIndex),
  });

  // 5. Clear sanctum field on totem
  await updateTotem(userId, totemId, {
    sanctum: null,
  });

  // 6. Return updated sanctum state
  const sanctum = await getSanctum(userId);
  return {
    success: true,
    data: sanctum,
  };
}

/**
 * Claim accumulated Essence from all seated totems (atomic)
 *
 * Uses transactWrite for atomic: add Essence + update all lastClaimedAt.
 * This prevents double-claim race conditions.
 *
 * @param {string} userId - User ID
 * @returns {Promise<object>} Claim result with breakdown per seat
 */
async function claimSanctum(userId) {
  // 1. Query all seats
  const seats = await queryItems(TABLES.EXPEDITION_STATE, 'pk', sanctumPK(userId), {
    skPrefix: 'SEAT#',
  });

  if (seats.length === 0) {
    return {
      success: false,
      error: {
        code: 'NOTHING_TO_CLAIM',
        message: 'No totems are seated in the Elder Sanctum',
      },
    };
  }

  // 2. Calculate earnings per seat
  const now = new Date();
  const nowISO = now.toISOString();
  const breakdown = [];
  let totalEarnings = 0;

  for (const seat of seats) {
    // Pull traits per seated totem so Shy / Loyal fold into the claimed Essence.
    const totem = await getTotem(userId, seat.totemId);
    const seatBonuses = totem ? resolveTraitBonuses(totem, { system: 'sanctum' }) : null;
    const earnings = calculateSeatEarnings(seat, now, seatBonuses);
    const tenureHours = (now - new Date(seat.seatedAt)) / (1000 * 60 * 60);
    breakdown.push({
      seatIndex: seat.seatIndex,
      totemId: seat.totemId,
      totemName: seat.totemName,
      earnings,
      tenureMultiplier:
        getTenureMultiplier(tenureHours) * (seatBonuses?.tenureBonusMultiplier ?? 1),
      hoursSinceLastClaim: (now - new Date(seat.lastClaimedAt)) / (1000 * 60 * 60),
    });
    totalEarnings += earnings;
  }

  // 3. Must have at least 1 Essence to claim
  if (totalEarnings < 1) {
    return {
      success: false,
      error: {
        code: 'NOTHING_TO_CLAIM',
        message: 'Not enough Essence accumulated yet. Keep your totems seated to earn more.',
      },
    };
  }

  // 4. Atomic transaction: add Essence + update all seat lastClaimedAt
  const transactItems = [
    // Add Essence to user
    {
      Update: {
        TableName: TABLES.USERS,
        Key: { pk: userPK(userId), sk: 'PROFILE' },
        UpdateExpression: 'SET currencies.essence = if_not_exists(currencies.essence, :zero) + :amount, updatedAt = :now',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: {
          ':amount': totalEarnings,
          ':zero': 0,
          ':now': nowISO,
        },
      },
    },
    // Update lastClaimedAt on each seat
    ...seats.map(seat => ({
      Update: {
        TableName: TABLES.EXPEDITION_STATE,
        Key: { pk: sanctumPK(userId), sk: seatSK(seat.seatIndex) },
        UpdateExpression: 'SET lastClaimedAt = :now, updatedAt = :now',
        ExpressionAttributeValues: {
          ':now': nowISO,
        },
      },
    })),
  ];

  await transactWrite(transactItems);

  // 5. Get updated balance for response
  const user = await require('../common/db-client').getUser(userId);
  const newEssenceBalance = user?.currencies?.essence || 0;

  // 6. Log the Essence credit to the ledger so reconciliation queries chain
  // through sanctum claims. transactWrite above bypasses logTransaction, so we
  // post the credit explicitly here, mirroring the council-mission-claim path.
  await logTransaction(userId, {
    type: 'reward_sanctum',
    currency: 'essence',
    amount: totalEarnings,
    balanceBefore: newEssenceBalance - totalEarnings,
    balanceAfter: newEssenceBalance,
    refType: 'sanctum',
    refName: `Sanctum Claim (${seats.length} seat${seats.length === 1 ? '' : 's'})`,
  });

  // 7. Check sanctum claim achievements (non-blocking)
  let achievements = [];
  try {
    // Get current claim count from achievement progress (incremental)
    const { getAchievementProgress } = require('./achievements-service');
    const claimProgress = await getAchievementProgress(userId, 'ach_sanctum-claim');
    const totalClaimCount = (claimProgress?.currentValue || 0) + 1;
    achievements = await onSanctumClaimed(userId, { totalClaimCount });
  }
  catch (err) {
    console.error('[Sanctum] Achievement check failed on claimSanctum:', err.message);
  }

  // Lazy tenure check — seats are already loaded above, so zero extra reads.
  try {
    const tenureResults = await onTenureCheck(userId, seats);
    for (const r of tenureResults) {
      if (r.unlocked) {
        achievements.push({
          achievementId: r.achievementId,
          milestone: r.milestone,
          rewards: r.rewards,
        });
      }
    }
  }
  catch (err) {
    console.error('[Sanctum] Tenure check failed on claimSanctum:', err.message);
  }

  return {
    success: true,
    data: {
      totalClaimed: totalEarnings,
      newEssenceBalance,
      breakdown,
      claimedAt: nowISO,
      achievements,
    },
  };
}

// =============================================================================
// Council Mission Constants
// =============================================================================

// Council Missions: a seated totem spends happiness + time to earn XP and rune drops.
const COUNCIL_MISSIONS = {
  // Governance: Stage 4+ (Adult) — short local leadership tasks. Rewards: XP + Lesser Rune chance
  'cm_decree-of-wisdom': { id: 'cm_decree-of-wisdom', name: 'Decree of Wisdom', tier: 'governance', requiredStage: 3, duration: 7200, cost: { happiness: 5 }, rewards: { xp: 20, runes: { lesser: 40 } } },
  'cm_territorial-survey': { id: 'cm_territorial-survey', name: 'Territorial Survey', tier: 'governance', requiredStage: 3, duration: 10800, cost: { happiness: 6 }, rewards: { xp: 30, runes: { lesser: 50 } } },
  'cm_spirit-audience': { id: 'cm_spirit-audience', name: 'Spirit Audience', tier: 'governance', requiredStage: 3, duration: 14400, cost: { happiness: 8 }, rewards: { xp: 40, runes: { lesser: 60 } } },
  // Diplomacy: Stage 5 (Ascended) only — longer, higher stakes. Rewards: XP + Greater Rune chance
  'cm_peace-summit': { id: 'cm_peace-summit', name: 'Peace Summit', tier: 'diplomacy', requiredStage: 4, duration: 21600, cost: { happiness: 10 }, rewards: { xp: 40, runes: { greater: 50 } } },
  'cm_alliance-forging': { id: 'cm_alliance-forging', name: 'Alliance Forging', tier: 'diplomacy', requiredStage: 4, duration: 28800, cost: { happiness: 12 }, rewards: { xp: 45, runes: { greater: 60 } } },
  'cm_elder-exchange': { id: 'cm_elder-exchange', name: 'Elder Exchange', tier: 'diplomacy', requiredStage: 4, duration: 36000, cost: { happiness: 14 }, rewards: { xp: 50, runes: { greater: 70 } } },
  // Legacy: Stage 5 (Ascended) only — epic endgame missions. Rewards: XP + Greater Rune + Ancient Rune chance
  'cm_rite-of-passage': { id: 'cm_rite-of-passage', name: 'Rite of Passage', tier: 'legacy', requiredStage: 4, duration: 43200, cost: { happiness: 15 }, rewards: { xp: 60, runes: { greater: 75, ancient: 10 } } },
  'cm_ancient-convocation': { id: 'cm_ancient-convocation', name: 'Ancient Convocation', tier: 'legacy', requiredStage: 4, duration: 64800, cost: { happiness: 18 }, rewards: { xp: 90, runes: { greater: 75, ancient: 15 } } },
  'cm_founding-ritual': { id: 'cm_founding-ritual', name: 'Founding Ritual', tier: 'legacy', requiredStage: 4, duration: 86400, cost: { happiness: 20 }, rewards: { xp: 120, runes: { greater: 75, ancient: 20 } } },
};

// =============================================================================
// Council Mission Key Helpers
// =============================================================================

function missionActiveSK(totemId) {
  return `MISSION#ACTIVE#${totemId}`;
}

// =============================================================================
// Council Mission Service Functions
// =============================================================================

/**
 * Get all council missions grouped by tier
 *
 * @returns {object} Missions grouped by tier { governance: [...], diplomacy: [...], legacy: [...] }
 */
function getCouncilMissions() {
  const grouped = { governance: [], diplomacy: [], legacy: [] };
  for (const mission of Object.values(COUNCIL_MISSIONS)) {
    grouped[mission.tier].push(mission);
  }
  return grouped;
}

/**
 * Start a council mission for a seated totem
 *
 * @param {string} userId - User ID
 * @param {string} totemId - Totem ID (must be seated)
 * @param {string} missionType - Mission ID from COUNCIL_MISSIONS
 * @returns {Promise<object>} Result with mission info
 */
async function startCouncilMission(userId, totemId, missionType) {
  // 1. Validate mission type
  const mission = COUNCIL_MISSIONS[missionType];
  if (!mission) {
    return {
      success: false,
      error: { code: 'INVALID_MISSION', message: `Unknown mission type: ${missionType}` },
    };
  }

  // 2. Get totem — must be owned by user
  const totem = await getTotem(userId, totemId);
  if (!totem) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Totem not found or not owned by you' },
    };
  }

  // 3. Totem must be seated
  if (!totem.sanctum || !totem.sanctum.seated) {
    return {
      success: false,
      error: { code: 'NOT_SEATED', message: 'Totem must be seated in the Elder Sanctum to start a council mission' },
    };
  }

  // 4. Totem must meet the mission's stage requirement
  const totemStage = totem.stage || 0;
  if (totemStage < mission.requiredStage) {
    const tierLabel = mission.tier === 'governance' ? 'Stage 4 (Adult)' : 'Stage 5 (Ascended)';
    return {
      success: false,
      error: { code: 'INSUFFICIENT_STAGE', message: `${mission.tier.charAt(0).toUpperCase() + mission.tier.slice(1)} missions require ${tierLabel} totems` },
    };
  }

  // 5. Totem must NOT already be on a mission
  const existingMission = await getItem(TABLES.EXPEDITION_STATE, {
    pk: sanctumPK(userId),
    sk: missionActiveSK(totemId),
  });
  if (existingMission) {
    return {
      success: false,
      error: { code: 'ALREADY_ON_MISSION', message: 'This totem is already on a council mission' },
    };
  }

  // 5. Totem must have enough happiness
  const currentHappiness = totem.stats?.happiness ?? totem.happiness ?? 0;
  if (currentHappiness < mission.cost.happiness) {
    return {
      success: false,
      error: { code: 'INSUFFICIENT_HAPPINESS', message: `Need ${mission.cost.happiness} happiness, have ${currentHappiness}` },
    };
  }

  // 6. Deduct happiness from totem
  const newHappiness = currentHappiness - mission.cost.happiness;
  await updateTotem(userId, totemId, {
    'stats.happiness': newHappiness,
  });

  // 7. Create mission record. Emissary: durationMultiplier ×0.80 on sanctum:mission.
  const missionBonuses = resolveTraitBonuses(totem, {
    system: 'sanctum',
    sub: 'mission',
  });
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  const effectiveDurationSec = Math.round(mission.duration * missionBonuses.durationMultiplier);
  const endsAt = now + effectiveDurationSec * 1000;
  const endsAtISO = new Date(endsAt).toISOString();
  const seatIndex = totem.sanctum.seatIndex;

  const missionRecord = {
    pk: sanctumPK(userId),
    sk: missionActiveSK(totemId),
    totemId,
    seatIndex,
    missionType,
    startedAt: nowISO,
    endsAt: endsAtISO,
    status: 'in_progress',
    claimed: false,
    createdAt: nowISO,
    updatedAt: nowISO,
  };

  await putItem(TABLES.EXPEDITION_STATE, missionRecord);

  // 8. Update totem sanctum field
  await updateTotem(userId, totemId, {
    sanctum: {
      ...totem.sanctum,
      onMission: true,
      missionEndsAt: endsAtISO,
    },
  });

  return {
    success: true,
    data: {
      mission: {
        missionType,
        name: mission.name,
        tier: mission.tier,
        totemId,
        seatIndex,
        startedAt: nowISO,
        endsAt: endsAtISO,
        duration: mission.duration,
        rewards: mission.rewards,
      },
    },
  };
}

/**
 * Claim rewards from a completed council mission
 *
 * @param {string} userId - User ID
 * @param {string} totemId - Totem ID
 * @returns {Promise<object>} Claim result with rewards
 */
async function claimCouncilMission(userId, totemId) {
  // 1. Get active mission record
  const missionRecord = await getItem(TABLES.EXPEDITION_STATE, {
    pk: sanctumPK(userId),
    sk: missionActiveSK(totemId),
  });

  if (!missionRecord) {
    return {
      success: false,
      error: { code: 'MISSION_NOT_FOUND', message: 'No active council mission found for this totem' },
    };
  }

  // 2. Verify mission is complete
  const now = Date.now();
  const endsAt = new Date(missionRecord.endsAt).getTime();
  if (endsAt > now) {
    return {
      success: false,
      error: { code: 'MISSION_NOT_COMPLETE', message: 'Council mission is not yet complete' },
    };
  }

  const mission = COUNCIL_MISSIONS[missionRecord.missionType];
  if (!mission) {
    return {
      success: false,
      error: { code: 'INVALID_MISSION', message: 'Mission definition not found' },
    };
  }

  // 3. Award XP to totem (via chokepoint so prestige check fires).
  // Mentor aura on a totem buffs its own mission XP via the `aura` scope.
  const totem = await getTotem(userId, totemId);
  let prestigeAchievements = [];
  const claimBonuses = totem
    ? resolveTraitBonuses(totem, { system: 'sanctum', sub: 'mission' })
    : null;
  if (totem) {
    const baseXp = mission.rewards.xp || 0;
    const xp = Math.round(baseXp * (claimBonuses?.xpMultiplier ?? 1));
    const xpResult = await addTotemXp(userId, totem, xp);
    if (xpResult.achievements?.length) prestigeAchievements = xpResult.achievements;
  }

  // 4. Roll for rune drops based on mission tier chances.
  // Sage: runeChanceBonus +0.15 on sanctum:mission. Bonus is additive to the base
  // percentage chance (e.g., 60% → 75%).
  const runesEarned = { lesser: 0, greater: 0, ancient: 0 };
  if (mission.rewards.runes) {
    const runeBonusPct = (claimBonuses?.runeChanceBonus ?? 0) * 100;
    for (const [runeType, chance] of Object.entries(mission.rewards.runes)) {
      if (Math.random() * 100 < chance + runeBonusPct) {
        runesEarned[runeType] = 1;
      }
    }
  }

  // Award runes if any dropped
  let newRuneBalances = null;
  if (runesEarned.lesser || runesEarned.greater || runesEarned.ancient) {
    const runeResult = await addRunes(userId, runesEarned, {
      type: 'council_mission_claim',
      ref: mission.id,
    });
    if (runeResult.success) {
      newRuneBalances = runeResult.newBalances;
    }
  }

  // 5. Log transaction for mission claim
  await logTransaction(userId, {
    type: 'council_mission_claim',
    currency: 'xp',
    amount: mission.rewards.xp,
    ref: missionRecord.missionType,
    refType: 'council_mission',
    refName: mission.name,
  });

  // 6. Delete mission record
  await deleteItem(TABLES.EXPEDITION_STATE, {
    pk: sanctumPK(userId),
    sk: missionActiveSK(totemId),
  });

  // 7. Update totem: clear onMission flag + missionEndsAt
  await updateTotem(userId, totemId, {
    sanctum: {
      ...(totem?.sanctum || {}),
      onMission: false,
      missionEndsAt: null,
    },
  });

  // 8. Check council mission achievements (non-blocking) — seed with any
  // prestige unlocks from the XP chokepoint above.
  const achievements = [...prestigeAchievements];
  try {
    const { getAchievementProgress } = require('./achievements-service');
    const missionProgress = await getAchievementProgress(userId, 'ach_council-missions');
    const totalMissionCount = (missionProgress?.currentValue || 0) + 1;
    const missionResults = await onMissionCompleted(userId, {
      missionType: missionRecord.missionType,
      totalMissionCount,
    });
    if (Array.isArray(missionResults)) achievements.push(...missionResults);
  }
  catch (err) {
    console.error('[Sanctum] Achievement check failed on claimCouncilMission:', err.message);
  }

  return {
    success: true,
    data: {
      rewards: {
        xp: mission.rewards.xp,
        runesEarned,
      },
      missionType: missionRecord.missionType,
      missionName: mission.name,
      totemId,
      newRuneBalances,
      achievements,
    },
  };
}

/**
 * Cancel an active council mission (no refund, no rewards)
 *
 * @param {string} userId - User ID
 * @param {string} totemId - Totem ID
 * @returns {Promise<object>} Success result
 */
async function cancelCouncilMission(userId, totemId) {
  // 1. Get active mission record
  const missionRecord = await getItem(TABLES.EXPEDITION_STATE, {
    pk: sanctumPK(userId),
    sk: missionActiveSK(totemId),
  });

  if (!missionRecord) {
    return {
      success: false,
      error: { code: 'MISSION_NOT_FOUND', message: 'No active council mission found for this totem' },
    };
  }

  // 2. Delete mission record (no rewards)
  await deleteItem(TABLES.EXPEDITION_STATE, {
    pk: sanctumPK(userId),
    sk: missionActiveSK(totemId),
  });

  // 3. Update totem: clear onMission flag + missionEndsAt
  const totem = await getTotem(userId, totemId);
  if (totem) {
    await updateTotem(userId, totemId, {
      sanctum: {
        ...(totem.sanctum || {}),
        onMission: false,
        missionEndsAt: null,
      },
    });
  }

  return {
    success: true,
    data: {
      cancelled: true,
      missionType: missionRecord.missionType,
      totemId,
    },
  };
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Service functions
  getSanctum,
  seatTotem,
  unseatTotem,
  claimSanctum,
  getMaxSeats,

  // Council Mission functions
  getCouncilMissions,
  startCouncilMission,
  claimCouncilMission,
  cancelCouncilMission,

  // Helpers (exported for testing)
  getTenureMultiplier,
  calculateSeatEarnings,
  isSanctumEligible,

  // Constants (exported for testing)
  SANCTUM_MIN_XP,
  MAX_ACCUMULATION_HOURS,
  BASE_RATE_PER_HOUR,
  MAX_SEATS,
  COUNCIL_MISSIONS,

  // Key helpers (for external use)
  sanctumPK,
  seatSK,
  missionActiveSK,
};
