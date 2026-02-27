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

const { onChallengeCompleted } = require('./achievements-service');
const { checkEvolutionRequirements } = require('../functions/game-actions/helpers');

// =============================================================================
// CHALLENGE DEFINITIONS (10 Challenges - synced from frontend challenges.json)
// =============================================================================

const CHALLENGES = [
  {
    id: 'chl_garden-pest-patrol',
    name: 'Garden Pest Patrol',
    description: 'Start your totem\'s journey by protecting the garden. Use your instinct and reflexes to smack down those pesky moles.',
    type: 'balance',
    affinity: 'balance',
    requirements: { stage: 1, strength: 1, agility: 1, wisdom: 1 },
    maxDailyAttempts: 5,
    maxScore: 1000,
    xpReward: { base: 10, perPoint: 0.01 },
    essenceReward: 5,  // Stage 1 challenge
    enabled: true,
  },
  {
    id: 'chl_boulder-breaker',
    name: 'Boulder Breaker',
    description: 'Break a massive rock by timing your strikes correctly. Strength determines power and speed.',
    type: 'strength',
    affinity: 'strength',
    requirements: { stage: 2, strength: 10, agility: 5, wisdom: 5 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 10,  // Stage 2 challenge
    enabled: true,
  },
  {
    id: 'chl_totem-wrestling',
    name: 'Totem Wrestling',
    description: 'Push against a guardian spirit in a strength duel. Tap rapidly to overpower it.',
    type: 'strength',
    affinity: 'strength',
    requirements: { stage: 3, strength: 15, agility: 8, wisdom: 8 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 15,  // Stage 3 challenge
    enabled: true,
  },
  {
    id: 'chl_rockfall-defense',
    name: 'Rockfall Defense',
    description: 'Block falling boulders by clicking in the right zones. Strength increases stamina.',
    type: 'strength',
    affinity: 'strength',
    requirements: { stage: 4, strength: 20, agility: 10, wisdom: 10 },
    maxDailyAttempts: 5,
    maxScore: 3000,
    xpReward: { base: 30, perPoint: 0.01 },
    essenceReward: 20,  // Stage 4 challenge
    enabled: true,
  },
  {
    id: 'chl_spirit-path',
    name: 'Spirit Path Navigation',
    description: 'Navigate a magical path of vanishing tiles, racing from start to finish.',
    type: 'agility',
    affinity: 'agility',
    requirements: { stage: 2, strength: 5, agility: 10, wisdom: 5 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 10,  // Stage 2 challenge
    enabled: true,
  },
  {
    id: 'chl_aerial-ring-dive',
    name: 'Aerial Ring Dive',
    description: 'Fly through shifting rings in the air. Agility improves control.',
    type: 'agility',
    affinity: 'agility',
    requirements: { stage: 3, strength: 8, agility: 15, wisdom: 8 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 15,  // Stage 3 challenge
    enabled: true,
  },
  {
    id: 'chl_spirit-dance',
    name: 'Totem Spirit Dance',
    description: 'Tap in rhythm with spirit drum beats. Agility determines timing accuracy.',
    type: 'agility',
    affinity: 'agility',
    requirements: { stage: 4, strength: 10, agility: 20, wisdom: 10 },
    maxDailyAttempts: 5,
    maxScore: 3000,
    xpReward: { base: 30, perPoint: 0.01 },
    essenceReward: 20,  // Stage 4 challenge
    enabled: true,
  },
  {
    id: 'chl_ancient-runes',
    name: 'Ancient Runes Decoding',
    description: 'Memorize and repeat glowing rune patterns. Wisdom increases memory retention.',
    type: 'wisdom',
    affinity: 'wisdom',
    requirements: { stage: 2, strength: 5, agility: 5, wisdom: 10 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 10,  // Stage 2 challenge
    enabled: true,
  },
  {
    id: 'chl_star-mapping',
    name: 'Celestial Star Mapping',
    description: 'Connect stars to form constellations. Wisdom provides hints and reduces errors.',
    type: 'wisdom',
    affinity: 'wisdom',
    requirements: { stage: 3, strength: 8, agility: 8, wisdom: 15 },
    maxDailyAttempts: 5,
    maxScore: 2000,
    xpReward: { base: 20, perPoint: 0.01 },
    essenceReward: 15,  // Stage 3 challenge
    enabled: true,
  },
  {
    id: 'chl_spirit-weaving',
    name: 'Spirit Weaving Runes',
    description: 'Align magical runes in the correct order. Wisdom slows instability.',
    type: 'wisdom',
    affinity: 'wisdom',
    requirements: { stage: 4, strength: 10, agility: 10, wisdom: 20 },
    maxDailyAttempts: 5,
    maxScore: 3000,
    xpReward: { base: 30, perPoint: 0.01 },
    essenceReward: 20,  // Stage 4 challenge
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
 * Check if a totem meets the requirements for a challenge
 * @param {object} totem - The totem object
 * @param {object} challenge - The challenge definition
 * @returns {{ qualified: boolean, reason?: string }}
 */
function checkRequirements(totem, challenge) {
  const { requirements } = challenge;
  const totemStats = totem.stats || {};
  const totemStage = totem.stage || 0;

  // Check stage requirement (stage is 0-indexed in totem, 1-indexed in requirements)
  // Stage 0 = Hatchling (stage 1 in requirements)
  const effectiveStage = totemStage + 1;
  if (effectiveStage < requirements.stage) {
    return {
      qualified: false,
      reason: `Totem must be stage ${requirements.stage} or higher (currently stage ${effectiveStage})`,
      requirement: 'stage',
      required: requirements.stage,
      current: effectiveStage,
    };
  }

  // Check strength requirement
  if ((totemStats.strength || 0) < requirements.strength) {
    return {
      qualified: false,
      reason: `Totem needs at least ${requirements.strength} strength (currently ${totemStats.strength || 0})`,
      requirement: 'strength',
      required: requirements.strength,
      current: totemStats.strength || 0,
    };
  }

  // Check agility requirement
  if ((totemStats.agility || 0) < requirements.agility) {
    return {
      qualified: false,
      reason: `Totem needs at least ${requirements.agility} agility (currently ${totemStats.agility || 0})`,
      requirement: 'agility',
      required: requirements.agility,
      current: totemStats.agility || 0,
    };
  }

  // Check wisdom requirement
  if ((totemStats.wisdom || 0) < requirements.wisdom) {
    return {
      qualified: false,
      reason: `Totem needs at least ${requirements.wisdom} wisdom (currently ${totemStats.wisdom || 0})`,
      requirement: 'wisdom',
      required: requirements.wisdom,
      current: totemStats.wisdom || 0,
    };
  }

  return { qualified: true };
}

/**
 * Calculate XP reward based on score (matches contract formula)
 * Formula: floor((score * maxXP) / maxScore)
 *
 * @param {number} maxScore - Maximum possible score (determines maxXP tier)
 * @param {number} score - The player's score
 * @returns {number} - XP to award
 */
function calculateXpReward(maxScore, score) {
  // Determine max XP based on challenge difficulty (matches contract)
  let maxXP;
  if (maxScore === 1000) {
    maxXP = 10;
  }
  else if (maxScore === 2000) {
    maxXP = 20;
  }
  else if (maxScore === 3000) {
    maxXP = 30;
  }
  else {
    maxXP = 10; // Default case
  }

  // Cap score at maxScore
  const cappedScore = Math.min(Math.max(0, score), maxScore);

  // Calculate XP using contract formula: (score * maxXP) / maxScore
  // Minimum 1 XP for any positive score
  const xp = Math.floor((cappedScore * maxXP) / maxScore);

  return cappedScore > 0 ? Math.max(1, xp) : 0;
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
 * @returns {Promise<object>} - Result of the challenge completion
 */
async function completeChallenge(userId, challengeId, totemId, score) {
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

  // 2. Validate score (must be > 0, cannot submit a zero score)
  if (typeof score !== 'number' || score <= 0) {
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

  // 5. Check requirements (stage + stats)
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

  // 7. Calculate XP reward based on score (using contract formula)
  const xpEarned = calculateXpReward(challenge.maxScore, score);

  // 7b. Award Essence reward
  const essenceReward = challenge.essenceReward || 0;
  let newEssenceBalance = null;
  if (essenceReward > 0) {
    const essenceResult = await addEssence(userId, essenceReward, {
      type: 'reward_challenge',
      ref: challengeId,
    });
    newEssenceBalance = essenceResult.newBalance;
  }

  // 8. Update totem's experience AND happiness (NEVER auto-evolve stage)
  // Evolution must ALWAYS be a user-initiated action via /api/game-actions/evolve
  const currentXp = totem.experience || 0;
  const newXp = currentXp + xpEarned;
  const currentStage = totem.stage || 0;

  // Calculate new happiness (capped at 100)
  const currentHappiness = totem.stats?.happiness || 50;
  const newHappiness = Math.min(100, currentHappiness + CHALLENGE_HAPPINESS_REWARD);

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

  // 9. Update progress record
  const newTotalAttempts = (progress?.totalAttempts || 0) + 1;
  const newCompletionCount = (progress?.completionCount || 0) + 1;
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
  try {
    // Get all challenge progress to calculate global total
    const allProgress = await getAllChallengeProgress(userId);

    // Sum up completions across all challenges
    // Note: allProgress might have stale data for current challenge, so we handle it specially
    let globalCompletionCount = 0;
    let foundCurrentChallenge = false;

    for (const p of allProgress) {
      if (p.challengeId === challengeId) {
        // Use the fresh count we just calculated (DB might have stale read)
        globalCompletionCount += newCompletionCount;
        foundCurrentChallenge = true;
      }
      else {
        globalCompletionCount += (p.completionCount || 0);
      }
    }

    // If this is the user's first ever challenge completion
    if (!foundCurrentChallenge) {
      globalCompletionCount += newCompletionCount;
    }

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

  console.log(`[Challenges] User ${userId} completed ${challengeId} with score ${score} (+${xpEarned} XP, +${CHALLENGE_HAPPINESS_REWARD} happiness to totem ${totemId})`);

  // 11. Build response
  const essenceMsg = essenceReward > 0 ? `, ${essenceReward} Essence` : '';
  const happinessMsg = `, +${CHALLENGE_HAPPINESS_REWARD} Happiness`;
  return {
    success: true,
    data: {
      challengeId,
      challengeName: challenge.name,
      totemId,
      score,
      xpEarned,
      happinessEarned: CHALLENGE_HAPPINESS_REWARD,
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
};
