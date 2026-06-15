/**
 * Challenges Service
 *
 * Handles challenge attempts, progress tracking, and reward distribution.
 * Challenges give XP + Happiness to totems AND Essence to users.
 *
 * XP Formula (matches contract): floor((score * maxXP) / maxScore)
 * - maxScore 1000 -> maxXP 10
 * - maxScore 2000 -> maxXP 20
 * - maxScore 3000 -> maxXP 30
 * Example: maxScore=2000, score=1500 -> floor((1500 * 20) / 2000) = 15 XP
 *
 * Happiness: +10 per challenge completion (fixed)
 *
 * Essence Rewards (per completion):
 * - Stage 1 challenges: 5 Essence
 * - Stage 2 challenges: 10 Essence
 * - Stage 3 challenges: 15 Essence
 * - Stage 4 challenges: 20 Essence
 *
 * Usage:
 *   const { completeChallenge, getChallengeStatus, getAvailableChallenges } = require('./services/challenges-service');
 *   const result = await completeChallenge(userId, challengeId, totemId, score);
 */

const {
  getItem,
  putItem,
  queryItems,
  getTotem,
  updateTotem,
  addEssence,
  TABLES,
} = require('../common/db-client');

const { onChallengeCompleted, onChallengeTierReached } = require('./achievements-service');
const { checkEvolutionRequirements } = require('../functions/game-actions/helpers');
const { checkActionAvailability } = require('../common/totem-utils');
const { resolveTraitBonuses } = require('../config/trait-effects');

// =============================================================================
// CHALLENGE MASTERY (mirror of totem-app/src/config/challenge-mastery.json)
// =============================================================================
//
// Mastery is a property of the CHALLENGE, not the totem. Progress = the
// per-(user, challenge) `masteryCount` (falls back to `completionCount` for
// legacy records; identical at the default anti-farm floor of 0); the tier is
// a pure step-function of that count. Reaching a tier (1) scales XP on every future
// completion of that challenge by any totem and (2) grants a one-time Essence
// loot box + XP lump to the triggering totem. Gold (raiseTier) unlocks raising
// difficulty above the stage-derived auto level.

const MASTERY = {
  version: '1.0.0',
  // index === tier
  tiers: [
    { tier: 0, name: 'Novice', minCompletions: 0, xpMult: 1.0 },
    { tier: 1, name: 'Bronze', minCompletions: 10, xpMult: 1.25 },
    { tier: 2, name: 'Silver', minCompletions: 30, xpMult: 1.5 },
    { tier: 3, name: 'Gold', minCompletions: 75, xpMult: 2.0 },
    { tier: 4, name: 'Platinum', minCompletions: 150, xpMult: 2.5 },
    { tier: 5, name: 'Diamond', minCompletions: 300, xpMult: 3.0 },
  ],
  // one-time bonus granted on reaching the tier (keyed by tier number).
  // Rebalanced (2026-06-09): Bronze pays XP only; boxes start at Silver and cap
  // at large — the huge box is exclusive to the CHALLENGE_GRANDMASTER achievement
  // so the final Diamond doesn't triple-dip (~10.7k Essence in one run).
  tierUpBonus: {
    1: { lootBoxId: null, xp: 100 },
    2: { lootBoxId: 'essence_box_small', xp: 250 },
    3: { lootBoxId: 'essence_box_small', xp: 500 },
    4: { lootBoxId: 'essence_box_large', xp: 1000 },
    5: { lootBoxId: 'essence_box_large', xp: 2000 },
  },
  raiseTier: 3, // Gold — raising difficulty above stage-lock unlocks here
  maxDifficulty: 3, // game has 3 difficulty levels
  essenceXpScalingEnabled: false,
  minMasteryScorePct: 0, // optional anti-AFK floor (0 = any score>0 counts)
};

/**
 * Tier is a pure function of the completion count (never stored as truth).
 * @param {number} completions
 * @returns {number} tier index 0..5
 */
function tierForCompletions(completions) {
  const n = Number.isFinite(completions) ? completions : 0;
  let tier = 0;
  for (let i = MASTERY.tiers.length - 1; i >= 0; i--) {
    if (n >= MASTERY.tiers[i].minCompletions) {
      tier = MASTERY.tiers[i].tier;
      break;
    }
  }
  return tier;
}

/**
 * Round to an integer, then clamp into [min, max]. Difficulty is declared as
 * enum [1, 2, 3] in swagger — a fractional request (e.g. 2.7) rounds first.
 */
function clampDifficulty(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Stage-derived "auto" difficulty — mirrors totem-app getGameDifficulty
 * (totems.tsx): clamp(displayStage − requirements.stage, 1, maxDifficulty),
 * where displayStage = stored stage + 1 (stages are stored 0-4, displayed
 * 1-5). This is the default and the ceiling below Gold; it must match the
 * frontend exactly or the client-computed difficulty gets silently clamped.
 * @param {object} totem
 * @param {object} challenge
 * @returns {number} 1..maxDifficulty
 */
function autoDifficulty(totem, challenge) {
  const displayStage = (totem?.stage || 0) + 1;
  const reqStage = challenge?.requirements?.stage || 0;
  return clampDifficulty(displayStage - reqStage, 1, MASTERY.maxDifficulty);
}

/**
 * Build the per-challenge mastery block surfaced on list/status/complete
 * responses. Field names are a frontend contract — do not rename.
 * @param {number} completions - The mastery-counted value (masteryCount,
 *   falling back to completionCount for legacy records). The tier here is
 *   derived from this count — the same derivation the reward path uses.
 * @param {number|null} preferredDifficulty
 * @returns {object}
 */
function buildMasteryBlock(completions, preferredDifficulty = null) {
  const tier = tierForCompletions(completions);
  const tierDef = MASTERY.tiers[tier];
  const nextDef = MASTERY.tiers[tier + 1] || null;
  const nextTierAt = nextDef ? nextDef.minCompletions : null;
  const completionsToNext = nextDef
    ? Math.max(0, nextDef.minCompletions - completions)
    : null;

  return {
    tier,
    tierName: tierDef.name,
    completions,
    nextTierAt,
    completionsToNext,
    xpMultiplier: tierDef.xpMult,
    difficultyUnlocked: tier >= MASTERY.raiseTier,
    maxDifficulty: MASTERY.maxDifficulty,
    preferredDifficulty: preferredDifficulty ?? null,
  };
}

// =============================================================================
// CHALLENGE DEFINITIONS (12 Challenges - synced from frontend challenges.json)
// =============================================================================

const CHALLENGES = [
  {
    id: 'chl_garden-pest-patrol',
    name: 'Garden Pest Patrol',
    description: 'Start your totem\'s journey by protecting the garden. Use your instinct and reflexes to smack down those pesky moles.',
    type: 'balance',
    affinity: 'balance',
    requirements: { stage: 0, strength: 1, agility: 1, wisdom: 1 },
    maxDailyAttempts: 5,
    maxScore: 1000,
    xpReward: { base: 10, perPoint: 0.01 },
    essenceReward: 10,  // Tier 1 (display Stage 1) — stage curve 10/15/20, matches the card display
    enabled: true,
  },
  {
    id: 'chl_boulder-breaker',
    name: 'Boulder Breaker',
    description: 'Break a massive rock by timing your strikes correctly. Strength determines power and speed.',
    type: 'strength',
    affinity: 'strength',
    requirements: { stage: 0, strength: 10, agility: 5, wisdom: 5 },
    maxDailyAttempts: 5,
    maxScore: 1000,
    xpReward: { base: 10, perPoint: 0.01 },
    essenceReward: 10,  // Tier 1 (display Stage 1)
    enabled: true,
  },
  {
    id: 'chl_totem-wrestling',
    name: 'Totem Wrestling',
    description: 'Push against a guardian spirit in a strength duel. Tap rapidly to overpower it.',
    type: 'strength',
    affinity: 'strength',
    requirements: { stage: 1, strength: 13, agility: 5, wisdom: 5 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 15,  // Tier 2 (display Stage 2)
    enabled: true,
  },
  {
    id: 'chl_rockfall-defense',
    name: 'Rockfall Defense',
    description: 'Block falling boulders by clicking in the right zones. Strength increases stamina.',
    type: 'strength',
    affinity: 'strength',
    requirements: { stage: 2, strength: 16, agility: 5, wisdom: 5 },
    maxDailyAttempts: 5,
    maxScore: 3000,
    xpReward: { base: 30, perPoint: 0.01 },
    essenceReward: 20,  // Tier 3 (display Stage 3)
    enabled: true,
  },
  {
    id: 'chl_riverside-dodge',
    name: 'Riverside Dodge',
    description: 'Evade piranhas leaping from the river. Dodge HIGH, MIDDLE, or LOW — but the controls are inverted.',
    type: 'agility',
    affinity: 'agility',
    requirements: { stage: 0, strength: 5, agility: 10, wisdom: 5 },
    maxDailyAttempts: 5,
    maxScore: 1000,
    xpReward: { base: 10, perPoint: 0.01 },
    essenceReward: 10,
    enabled: true,
  },
  {
    id: 'chl_spirit-path',
    name: 'Spirit Path Navigation',
    description: 'Navigate a magical path of vanishing tiles, racing from start to finish.',
    type: 'balance',
    affinity: 'balance',
    requirements: { stage: 1, strength: 1, agility: 1, wisdom: 1 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 15,  // Tier 2 (stage 1)
    enabled: true,
  },
  {
    id: 'chl_spirit-labyrinth',
    name: 'Spirit Labyrinth',
    description: 'Navigate the fog-shrouded spirit labyrinth. Find the exit before time runs out.',
    type: 'balance',
    affinity: 'balance',
    requirements: { stage: 2, strength: 1, agility: 1, wisdom: 1 },
    maxDailyAttempts: 5,
    maxScore: 3000,
    xpReward: { base: 30, perPoint: 0.01 },
    essenceReward: 20,  // Tier 3 (stage 2)
    enabled: true,
  },
  {
    id: 'chl_aerial-ring-dive',
    name: 'Aerial Ring Dive',
    description: 'Fly through shifting rings in the air. Agility improves control.',
    type: 'agility',
    affinity: 'agility',
    requirements: { stage: 1, strength: 5, agility: 13, wisdom: 5 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 15,  // Tier 2 (display Stage 2)
    enabled: true,
  },
  {
    id: 'chl_spirit-dance',
    name: 'Totem Spirit Dance',
    description: 'Tap in rhythm with spirit drum beats. Agility determines timing accuracy.',
    type: 'agility',
    affinity: 'agility',
    requirements: { stage: 2, strength: 5, agility: 16, wisdom: 5 },
    maxDailyAttempts: 5,
    maxScore: 3000,
    xpReward: { base: 30, perPoint: 0.01 },
    essenceReward: 20,  // Tier 3 (display Stage 3)
    enabled: true,
  },
  {
    id: 'chl_ancient-runes',
    name: 'Ancient Runes Decoding',
    description: 'Memorize and repeat glowing rune patterns. Wisdom increases memory retention.',
    type: 'wisdom',
    affinity: 'wisdom',
    requirements: { stage: 0, strength: 5, agility: 5, wisdom: 10 },
    maxDailyAttempts: 5,
    maxScore: 1000,
    xpReward: { base: 10, perPoint: 0.01 },
    essenceReward: 10,  // Tier 1 (display Stage 1)
    enabled: true,
  },
  {
    id: 'chl_star-mapping',
    name: 'Celestial Star Mapping',
    description: 'Connect stars to form constellations. Wisdom provides hints and reduces errors.',
    type: 'wisdom',
    affinity: 'wisdom',
    requirements: { stage: 1, strength: 5, agility: 5, wisdom: 13 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 15,  // Tier 2 (display Stage 2)
    enabled: true,
  },
  {
    id: 'chl_spirit-weaving',
    name: 'Spirit Weaving Runes',
    description: 'Align magical runes in the correct order. Wisdom slows instability.',
    type: 'wisdom',
    affinity: 'wisdom',
    requirements: { stage: 2, strength: 5, agility: 5, wisdom: 16 },
    maxDailyAttempts: 5,
    maxScore: 3000,
    xpReward: { base: 30, perPoint: 0.01 },
    essenceReward: 20,  // Tier 3 (display Stage 3)
    enabled: true,
  },
];

// Create a lookup map for quick access
const CHALLENGES_MAP = CHALLENGES.reduce((map, challenge) => {
  map[challenge.id] = challenge;
  return map;
}, {});

// =============================================================================
// KEY HELPERS
// =============================================================================

function challengePK(userId) {
  return `USER#${userId}`;
}

function challengeProgressSK(challengeId) {
  return `CHALLENGE#${challengeId}`;
}

/**
 * Get today's date string in UTC (YYYY-MM-DD)
 */
function getTodayUTC() {
  return new Date().toISOString().split('T')[0];
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Get a user's progress for a specific challenge
 */
async function getChallengeProgress(userId, challengeId) {
  return getItem(TABLES.CHALLENGE_PROGRESS, {
    pk: challengePK(userId),
    sk: challengeProgressSK(challengeId),
  });
}

/**
 * Get all challenge progress for a user
 */
async function getAllChallengeProgress(userId) {
  return queryItems(TABLES.CHALLENGE_PROGRESS, 'pk', challengePK(userId), {
    skPrefix: 'CHALLENGE#',
  });
}

/**
 * Check how many attempts a user has made today for a challenge
 * @returns {{ attemptsToday: number, canAttempt: boolean, attemptsRemaining: number }}
 */
function checkDailyAttempts(progress, maxDailyAttempts) {
  if (!progress || !progress.dailyAttempts) {
    return {
      attemptsToday: 0,
      canAttempt: true,
      attemptsRemaining: maxDailyAttempts,
    };
  }

  const today = getTodayUTC();
  const attemptsToday = progress.dailyAttempts[today] || 0;
  const attemptsRemaining = Math.max(0, maxDailyAttempts - attemptsToday);

  return {
    attemptsToday,
    canAttempt: attemptsToday < maxDailyAttempts,
    attemptsRemaining,
  };
}

/**
 * Check if a totem meets the requirements for a challenge.
 *
 * Folds in trait stat bonuses (Stubborn / Restless / Dreamer) scoped to this
 * challenge's affinity, so a totem that's a hair under the gate can still
 * enter if a matching trait closes the gap. Stage gating is unaffected.
 *
 * @param {object} totem - The totem object
 * @param {object} challenge - The challenge definition
 * @returns {{ qualified: boolean, reason?: string }}
 */
function checkRequirements(totem, challenge) {
  const { requirements } = challenge;
  const totemStats = totem.stats || {};
  const totemStage = totem.stage || 0;

  // Resolve self-scope bonuses against this challenge's affinity. Only
  // statBonus matters here — costs and rewards are applied later inside
  // completeChallenge. If the totem has no traits, the resolver returns
  // identity defaults so the math collapses to the base-stat comparison.
  const reqBonuses = resolveTraitBonuses(totem, { challenge: challenge.affinity });
  const effectiveStat = (key) =>
    (totemStats[key] || 0) + (reqBonuses.statBonus?.[key] || 0);

  // Check stage requirement (both totem stage and requirements use 0-indexed data values)
  // Stage 0 = Hatchling, 1 = Juvenile, 2 = Adult, 3 = Elder, 4 = Ascended
  if (totemStage < requirements.stage) {
    return {
      qualified: false,
      reason: `Totem must be stage ${requirements.stage} or higher (currently stage ${totemStage})`,
      requirement: 'stage',
      required: requirements.stage,
      current: totemStage,
    };
  }

  // Check strength requirement (trait stat bonus folds in).
  const effStr = effectiveStat('strength');
  if (effStr < requirements.strength) {
    return {
      qualified: false,
      reason: `Totem needs at least ${requirements.strength} strength (currently ${effStr})`,
      requirement: 'strength',
      required: requirements.strength,
      current: effStr,
    };
  }

  // Check agility requirement (trait stat bonus folds in).
  const effAgi = effectiveStat('agility');
  if (effAgi < requirements.agility) {
    return {
      qualified: false,
      reason: `Totem needs at least ${requirements.agility} agility (currently ${effAgi})`,
      requirement: 'agility',
      required: requirements.agility,
      current: effAgi,
    };
  }

  // Check wisdom requirement (trait stat bonus folds in).
  const effWis = effectiveStat('wisdom');
  if (effWis < requirements.wisdom) {
    return {
      qualified: false,
      reason: `Totem needs at least ${requirements.wisdom} wisdom (currently ${effWis})`,
      requirement: 'wisdom',
      required: requirements.wisdom,
      current: effWis,
    };
  }

  return { qualified: true };
}

/**
 * Calculate XP reward based on score (matches contract formula)
 * Formula: floor((score * maxXP) / maxScore), where maxXP = maxScore / 100
 * (tier pattern: 1000→10, 2000→20, 3000→30, etc.)
 *
 * @param {number} maxScore - Maximum possible score
 * @param {number} score - The player's score
 * @returns {number} - XP to award (0 if inputs are invalid or non-positive)
 */
function calculateXpReward(maxScore, score) {
  if (!Number.isFinite(maxScore) || maxScore <= 0) return 0;
  if (!Number.isFinite(score) || score <= 0) return 0;

  const maxXP = Math.floor(maxScore / 100);
  const cappedScore = Math.min(score, maxScore);
  const xp = Math.floor((cappedScore * maxXP) / maxScore);

  return Math.max(1, xp);
}

// Fixed happiness reward for challenge completion
const CHALLENGE_HAPPINESS_REWARD = 10;

/**
 * Complete a challenge and award XP to the totem
 *
 * @param {string} userId - The user's ID
 * @param {string} challengeId - The challenge ID
 * @param {string} totemId - The totem's ID
 * @param {number} score - The score achieved in the challenge
 * @param {number} [difficulty] - Optional requested difficulty (clamped server-side)
 * @returns {Promise<object>} - Result of the challenge completion
 */
async function completeChallenge(userId, challengeId, totemId, score, difficulty) {
  const now = new Date().toISOString();
  const today = getTodayUTC();

  // 1. Validate challenge exists and is enabled
  const challenge = CHALLENGES_MAP[challengeId];
  if (!challenge) {
    return {
      success: false,
      error: {
        code: 'INVALID_CHALLENGE',
        message: `Challenge '${challengeId}' not found`,
      },
    };
  }

  if (!challenge.enabled) {
    return {
      success: false,
      error: {
        code: 'CHALLENGE_DISABLED',
        message: `Challenge '${challenge.name}' is currently disabled`,
      },
    };
  }

  // 2. Validate score (finite positive number — rejects NaN, Infinity, non-numbers, <=0)
  if (!Number.isFinite(score) || score <= 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_SCORE',
        message: 'Score must be a positive number',
      },
    };
  }

  // 3. Validate totemId format
  if (!totemId || !totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: {
        code: 'INVALID_TOTEM_ID',
        message: 'Invalid totem ID format',
      },
    };
  }

  // 4. Get totem
  const totem = await getTotem(userId, totemId);
  if (!totem) {
    return {
      success: false,
      error: {
        code: 'TOTEM_NOT_FOUND',
        message: 'Totem not found',
      },
    };
  }

  // 5. Check if totem is available (not on council mission)
  const availCheck = checkActionAvailability(totem);
  if (!availCheck.available) {
    return { success: false, error: availCheck.error };
  }

  // 6. Check requirements (stage + stats)
  const reqCheck = checkRequirements(totem, challenge);
  if (!reqCheck.qualified) {
    return {
      success: false,
      error: {
        code: 'REQUIREMENT_NOT_MET',
        message: reqCheck.reason,
        requirement: reqCheck.requirement,
        required: reqCheck.required,
        current: reqCheck.current,
      },
    };
  }

  // 6. Get existing progress and check daily attempts
  const progress = await getChallengeProgress(userId, challengeId);
  const attemptCheck = checkDailyAttempts(progress, challenge.maxDailyAttempts);

  if (!attemptCheck.canAttempt) {
    return {
      success: false,
      error: {
        code: 'DAILY_LIMIT_REACHED',
        message: `You have reached the maximum ${challenge.maxDailyAttempts} attempts for today. Try again tomorrow!`,
        attemptsToday: attemptCheck.attemptsToday,
        maxDailyAttempts: challenge.maxDailyAttempts,
      },
    };
  }

  // 7. Resolve trait bonuses for this challenge (self-scope: no team yet — arena Q3).
  // Brave / Skilled Fighter / Nimble / Studious carry `successChanceBonus`. Instead
  // of patching every mini-game, we inflate the *submitted score* here at the
  // service boundary (capped at maxScore) so every downstream calc — XP, Essence,
  // high-score, progress totals visible to the player — flows from the boosted
  // value. `totalScore` (cumulative analytics) stays on the raw submission.
  const bonuses = resolveTraitBonuses(totem, {
    challenge: challenge.affinity,
    earnsEssence: true,
  });
  // Each matching stat-bonus point adds +1% to the score on this affinity.
  // Stubborn (str), Restless (agi), Dreamer (wis) — innate-tier so the lift
  // stays small. Until Arena (Q3 2026) wires stats into a proper roll, the
  // score-boost path is the only place these traits can manifest.
  const affinityStat = bonuses.statBonus?.[challenge.affinity] || 0;
  const scoreBoostPct = bonuses.successChanceBonus + affinityStat * 0.01;
  const effectiveScore = Math.min(
    challenge.maxScore,
    Math.round(score * (1 + scoreBoostPct)),
  );

  // 7-mastery. Resolve mastery for this (user, challenge) BEFORE computing reward.
  //   prevCount        — completionCount before this submission (always increments).
  //   prevMasteryCount — mastery-counted completions (masteryCount, falling back
  //                      to completionCount for legacy records written before the
  //                      field existed — initialized on this write).
  //   prevTier         — DERIVED from the mastery count (same derivation the
  //                      list/status display uses, so reward and display agree).
  //   storedTier       — the persisted masteryTier, used STRICTLY as the
  //                      idempotency floor for tier-up bonuses. Absent => retro
  //                      record: floor starts at the derived tier so veterans
  //                      never get back-paid loot boxes or XP lumps.
  //   tierMult         — the XP multiplier the totem earns at the CURRENT tier.
  const prevCount = progress?.completionCount || 0;
  const prevMasteryCount = progress?.masteryCount ?? prevCount;
  const hadStoredTier = progress?.masteryTier !== undefined && progress?.masteryTier !== null;
  const prevTier = tierForCompletions(prevMasteryCount);
  const storedTier = hadStoredTier ? progress.masteryTier : prevTier;
  const tierMult = MASTERY.tiers[prevTier].xpMult;

  // Validate the requested difficulty. Lowering is always allowed (1..auto);
  // raising above the stage-locked auto level needs Gold+ (full 1..3). The value
  // is clamped silently — the mini-game uses it to scale intensity, but maxScore
  // (the XP denominator) is UNCHANGED, so difficulty only affects XP via score.
  const auto = autoDifficulty(totem, challenge);
  const maxSel = prevTier >= MASTERY.raiseTier ? MASTERY.maxDifficulty : auto;
  const difficultyProvided = Number.isFinite(difficulty);
  const reqDiff = clampDifficulty(
    difficultyProvided ? difficulty : auto,
    1,
    maxSel,
  );
  // Only an EXPLICIT difficulty updates the saved preference — an omitted
  // difficulty must not overwrite it with the clamped auto value.
  const newPreferredDifficulty = difficultyProvided
    ? reqDiff
    : (progress?.preferredDifficulty ?? null);

  // 7a. XP reward based on the boosted score, then × tierMult × xpMultiplier
  //     (mastery tier mult; Clever +5% on challenge:any; Mentor +10% via aura token).
  //     score ≤ maxScore keeps this bounded with no artificial cap.
  const baseXp = calculateXpReward(challenge.maxScore, effectiveScore);
  let xpEarned = Math.round(baseXp * tierMult * bonuses.xpMultiplier);

  // 7b. Award Essence reward, folded by essenceRewardMultiplier (Merchant's Eye +10%).
  const baseEssence = challenge.essenceReward || 0;
  const essenceReward = Math.round(baseEssence * bonuses.essenceRewardMultiplier);
  let newEssenceBalance = null;
  if (essenceReward > 0) {
    const essenceResult = await addEssence(userId, essenceReward, {
      type: 'reward_challenge',
      ref: challengeId,
    });
    newEssenceBalance = essenceResult.newBalance;
  }

  // 7c. Mastery tier-up detection (idempotent via stored masteryTier).
  // completionCount ALWAYS increments on a valid (score>0) submission — it
  // feeds the global CHALLENGE_INITIATE/CHALLENGE_PROGRESSION achievements and
  // the player-visible stat. The parallel masteryCount only advances when the
  // RAW score (not the trait-boosted effectiveScore) clears the optional
  // anti-AFK floor; default 0 => any score>0 counts and the two counters stay
  // in lockstep. Tier derivation everywhere uses the mastery count.
  const masteryFloor = MASTERY.minMasteryScorePct > 0
    ? MASTERY.minMasteryScorePct * challenge.maxScore
    : 0;
  const countsForMastery = score >= masteryFloor;
  const newCompletionCount = prevCount + 1;
  const newMasteryCount = prevMasteryCount + (countsForMastery ? 1 : 0);
  const newTier = tierForCompletions(newMasteryCount);

  let tierUp = null;
  // Grant the one-time bonus only on a real crossing: the DERIVED tier rose
  // above the stored idempotency floor. On a retro-init (no stored tier yet)
  // the floor starts at the derived tier, so veterans keep their tier but
  // never get back-paid loot boxes or XP lumps.
  if (newTier > storedTier) {
    const bonus = MASTERY.tierUpBonus[newTier];
    if (bonus) {
      xpEarned += bonus.xp; // one-time XP lump folded into this totem
      let lootBox = null;
      if (bonus.lootBoxId) {
        try {
          // Lazy require — loot-service can trigger achievements on box claim.
          const { grantLootItem } = require('./loot-service');
          const granted = await grantLootItem(userId, bonus.lootBoxId, 'mastery');
          lootBox = { id: granted.id, boxId: granted.boxId, source: 'mastery' };
        }
        catch (err) {
          // Deliberate trade: idempotency over delivery. masteryTier is still
          // persisted below, so this crossing will NEVER re-fire — the box is
          // lost unless manually remediated. Log everything needed to re-grant
          // by hand (grantLootItem(userId, boxId, 'mastery')).
          console.error(
            `[Challenges] Mastery loot grant failed — manual remediation needed: user=${userId} challenge=${challengeId} box=${bonus.lootBoxId} tier=${newTier}:`,
            err.message,
          );
        }
      }
      tierUp = {
        from: storedTier,
        to: newTier,
        name: MASTERY.tiers[newTier].name,
        xp: bonus.xp,
        lootBox,
      };
      if (newTier >= MASTERY.raiseTier) {
        tierUp.unlocked = ['difficulty-raise'];
      }
    }
  }

  // 8. Update totem's experience AND happiness (NEVER auto-evolve stage)
  // Evolution must ALWAYS be a user-initiated action via /api/game-actions/evolve
  const currentXp = totem.experience || 0;
  const newXp = currentXp + xpEarned;
  const currentStage = totem.stage || 0;

  // Happiness reward folded by happinessRewardMultiplier (Persistent +20%).
  const currentHappiness = totem.stats?.happiness || 50;
  const happinessReward = Math.round(
    CHALLENGE_HAPPINESS_REWARD * bonuses.happinessRewardMultiplier,
  );
  const newHappiness = Math.min(100, currentHappiness + happinessReward);

  await updateTotem(userId, totemId, {
    experience: newXp,
    'stats.happiness': newHappiness,
  });

  // Check if totem is now eligible to evolve (for informational response only)
  const updatedTotemForCheck = {
    ...totem,
    experience: newXp,
    stage: currentStage,
    stats: { ...totem.stats, happiness: newHappiness },
  };
  const evolutionCheck = checkEvolutionRequirements(updatedTotemForCheck);

  // 9. Update progress record (newCompletionCount + tier-up resolved in 7c)
  const newTotalAttempts = (progress?.totalAttempts || 0) + 1;
  const newTotalXpEarned = (progress?.totalXpEarned || 0) + xpEarned;
  const newTotalScore = (progress?.totalScore || 0) + score; // Track cumulative score (matches contract)
  const newHighScore = Math.max(progress?.highScore || 0, score);
  const isNewHighScore = score > (progress?.highScore || 0);

  // Update daily attempts map
  const dailyAttempts = { ...(progress?.dailyAttempts || {}) };
  dailyAttempts[today] = (dailyAttempts[today] || 0) + 1;

  // Clean up old daily attempt records (keep only last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoffDate = sevenDaysAgo.toISOString().split('T')[0];
  Object.keys(dailyAttempts).forEach((date) => {
    if (date < cutoffDate) {
      delete dailyAttempts[date];
    }
  });

  const progressUpdate = {
    pk: challengePK(userId),
    sk: challengeProgressSK(challengeId),
    userId,
    challengeId,
    completionCount: newCompletionCount,
    masteryCount: newMasteryCount, // mastery-counted completions (anti-farm floor applies)
    totalAttempts: newTotalAttempts,
    totalXpEarned: newTotalXpEarned,
    totalScore: newTotalScore, // Cumulative score (matches contract tracking)
    highScore: newHighScore,
    lastScore: score,
    lastXpEarned: xpEarned,
    dailyAttempts,
    lastAttemptAt: now,
    lastCompletionAt: now,
    firstCompletedAt: progress?.firstCompletedAt || now,
    // Mastery: cached tier is STRICTLY the idempotency floor for tier-up
    // bonuses (never regressed) + the player's explicit difficulty choice.
    masteryTier: Math.max(storedTier, newTier),
    preferredDifficulty: newPreferredDifficulty,
    createdAt: progress?.createdAt || now,
    updatedAt: now,
  };

  // Log high score achievement (matches contract HighScoreSet event)
  if (isNewHighScore) {
    console.log(`[Challenges] New high score! User ${userId} scored ${score} on ${challengeId} (previous: ${progress?.highScore || 0})`);
  }

  await putItem(TABLES.CHALLENGE_PROGRESS, progressUpdate);

  // 10. Trigger achievement check (pass totemId for XP rewards)
  // IMPORTANT: Pass GLOBAL total challenges completed (across ALL challenge types)
  // not just this challenge's count - achievements track overall progress like [10, 100, 1000]
  let achievements = [];
  let globalCompletionCount = newCompletionCount;
  let totalTiersEarned = newTier;
  try {
    // Get all challenge progress to calculate global totals.
    // Sum up completions AND mastery tiers across all challenges.
    // Note: allProgress might have stale data for current challenge, so we handle it specially.
    const allProgress = await getAllChallengeProgress(userId);
    globalCompletionCount = 0;
    totalTiersEarned = 0;
    let foundCurrentChallenge = false;

    for (const p of allProgress) {
      if (p.challengeId === challengeId) {
        // Use the fresh values we just calculated (DB might have stale read)
        globalCompletionCount += newCompletionCount;
        totalTiersEarned += newTier;
        foundCurrentChallenge = true;
      }
      else {
        // Tier derives from the mastery count (completionCount fallback covers
        // legacy records); the stored masteryTier is only the bonus floor.
        globalCompletionCount += (p.completionCount || 0);
        totalTiersEarned += tierForCompletions(p.masteryCount ?? p.completionCount ?? 0);
      }
    }

    // If this is the user's first ever challenge completion
    if (!foundCurrentChallenge) {
      globalCompletionCount += newCompletionCount;
      totalTiersEarned += newTier;
    }
  }
  catch (err) {
    console.error('[Challenges] Achievement aggregation failed:', err.message);
  }

  // Each trigger gets its own try/catch — a failure in one must never
  // suppress the other.
  try {
    const achResults = await onChallengeCompleted(userId, globalCompletionCount, totemId);
    achievements = (achResults || []).filter(a => a.unlocked).map(a => ({
      achievementId: a.achievementId,
      milestone: a.milestone,
      rewards: a.rewards,
    }));
  }
  catch (err) {
    console.error('[Challenges] Achievement check failed:', err.message);
  }

  // Fire the global mastery achievement layer only on a real tier-up.
  if (tierUp) {
    try {
      const tierResults = await onChallengeTierReached(userId, { newTier, totalTiersEarned, totemId });
      const tierAch = (tierResults || []).filter(a => a.unlocked).map(a => ({
        achievementId: a.achievementId,
        milestone: a.milestone,
        rewards: a.rewards,
      }));
      achievements = achievements.concat(tierAch);
    }
    catch (err) {
      console.error('[Challenges] Mastery achievement check failed:', err.message);
    }
  }

  console.log(`[Challenges] User ${userId} completed ${challengeId} with score ${score} (+${xpEarned} XP, +${CHALLENGE_HAPPINESS_REWARD} happiness to totem ${totemId})`);

  // 11. Build response
  const essenceMsg = essenceReward > 0 ? `, ${essenceReward} Essence` : '';
  const happinessMsg = `, +${happinessReward} Happiness`;
  return {
    success: true,
    data: {
      challengeId,
      challengeName: challenge.name,
      totemId,
      score,
      xpEarned,
      happinessEarned: happinessReward,
      essenceEarned: essenceReward,
      newEssenceBalance,
      totem: {
        id: totemId,
        previousXp: currentXp,
        newXp,
        stage: currentStage,
        eligibleToEvolve: evolutionCheck.canEvolve,
        previousHappiness: currentHappiness,
        newHappiness,
      },
      progress: {
        completionCount: newCompletionCount,
        totalAttempts: newTotalAttempts,
        totalXpEarned: newTotalXpEarned,
        totalScore: newTotalScore,
        highScore: newHighScore,
        isNewHighScore,
        attemptsToday: dailyAttempts[today],
        attemptsRemaining: challenge.maxDailyAttempts - dailyAttempts[today],
      },
      achievements,
      mastery: buildMasteryBlock(newMasteryCount, newPreferredDifficulty),
      tierUp,
      message: evolutionCheck.canEvolve
        ? `Your totem earned ${xpEarned} XP${happinessMsg}${essenceMsg} from ${challenge.name}! Your totem is ready to evolve!`
        : `Your totem earned ${xpEarned} XP${happinessMsg}${essenceMsg} from ${challenge.name}!`,
    },
  };
}

/**
 * Get challenge status for all challenges for a user and totem
 *
 * @param {string} userId - The user's ID
 * @param {string} [totemId] - Optional totem ID to check requirements against
 * @returns {Promise<Array>} - Array of challenge statuses
 */
async function getChallengeStatus(userId, totemId = null) {
  // Get all progress records for this user
  const progressRecords = await getAllChallengeProgress(userId);

  // Create a map for quick lookup
  const progressMap = progressRecords.reduce((map, record) => {
    map[record.challengeId] = record;
    return map;
  }, {});

  // Get totem if provided (for requirement checking)
  let totem = null;
  if (totemId) {
    totem = await getTotem(userId, totemId);
  }

  // Build status for each challenge
  const statuses = CHALLENGES.filter((c) => c.enabled).map((challenge) => {
    const progress = progressMap[challenge.id];
    const attemptCheck = checkDailyAttempts(progress, challenge.maxDailyAttempts);

    // Check requirements if totem provided
    let requirementStatus = null;
    if (totem) {
      const reqCheck = checkRequirements(totem, challenge);
      requirementStatus = {
        qualified: reqCheck.qualified,
        reason: reqCheck.reason || null,
      };
    }

    return {
      challengeId: challenge.id,
      name: challenge.name,
      description: challenge.description,
      type: challenge.type,
      affinity: challenge.affinity,
      requirements: challenge.requirements,
      maxScore: challenge.maxScore,
      xpReward: challenge.xpReward,
      maxDailyAttempts: challenge.maxDailyAttempts,
      // Progress data
      completionCount: progress?.completionCount || 0,
      totalAttempts: progress?.totalAttempts || 0,
      totalXpEarned: progress?.totalXpEarned || 0,
      totalScore: progress?.totalScore || 0,
      highScore: progress?.highScore || 0,
      lastScore: progress?.lastScore || null,
      lastAttemptAt: progress?.lastAttemptAt || null,
      firstCompletedAt: progress?.firstCompletedAt || null,
      // Daily attempt tracking
      attemptsToday: attemptCheck.attemptsToday,
      attemptsRemaining: attemptCheck.attemptsRemaining,
      canAttempt: attemptCheck.canAttempt,
      // Mastery block (tier derived from the mastery count, falling back to
      // completionCount for legacy records; frontend contract)
      mastery: buildMasteryBlock(
        progress?.masteryCount ?? progress?.completionCount ?? 0,
        progress?.preferredDifficulty ?? null,
      ),
      // Requirement status (if totem provided)
      requirementStatus,
    };
  });

  return statuses;
}

/**
 * Get challenges that a totem qualifies for based on stage and stats
 *
 * @param {object} totem - The totem object
 * @returns {Array} - Array of challenges the totem can attempt
 */
function getAvailableChallenges(totem) {
  return CHALLENGES.filter((challenge) => {
    if (!challenge.enabled) return false;
    const reqCheck = checkRequirements(totem, challenge);
    return reqCheck.qualified;
  }).map((challenge) => ({
    id: challenge.id,
    name: challenge.name,
    description: challenge.description,
    type: challenge.type,
    affinity: challenge.affinity,
    requirements: challenge.requirements,
    maxScore: challenge.maxScore,
    xpReward: challenge.xpReward,
    maxDailyAttempts: challenge.maxDailyAttempts,
  }));
}

/**
 * Get challenges the totem does NOT qualify for (with reasons)
 *
 * @param {object} totem - The totem object
 * @returns {Array} - Array of unavailable challenges with requirements
 */
function getUnavailableChallenges(totem) {
  return CHALLENGES.filter((challenge) => {
    if (!challenge.enabled) return false;
    const reqCheck = checkRequirements(totem, challenge);
    return !reqCheck.qualified;
  }).map((challenge) => {
    const reqCheck = checkRequirements(totem, challenge);
    return {
      id: challenge.id,
      name: challenge.name,
      description: challenge.description,
      type: challenge.type,
      affinity: challenge.affinity,
      requirements: challenge.requirements,
      maxScore: challenge.maxScore,
      xpReward: challenge.xpReward,
      maxDailyAttempts: challenge.maxDailyAttempts,
      unmetRequirement: reqCheck.requirement,
      reason: reqCheck.reason,
    };
  });
}

/**
 * Get challenge by ID
 */
function getChallengeById(challengeId) {
  return CHALLENGES_MAP[challengeId] || null;
}

/**
 * Get all challenge definitions
 */
function getAllChallenges() {
  return CHALLENGES.filter((c) => c.enabled);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Constants
  CHALLENGES,
  CHALLENGES_MAP,
  MASTERY,

  // Core functions
  completeChallenge,
  getChallengeStatus,
  getAvailableChallenges,
  getUnavailableChallenges,

  // Helper functions
  getChallengeProgress,
  getAllChallengeProgress,
  getChallengeById,
  getAllChallenges,
  checkDailyAttempts,
  checkRequirements,
  calculateXpReward,
  // Mastery helpers
  tierForCompletions,
  autoDifficulty,
  clampDifficulty,
  buildMasteryBlock,
};
