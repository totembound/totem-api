/**
 * Rewards Service
 *
 * Handles daily and weekly reward claims with streak tracking.
 * Uses Essence currency (NOT Gems - those are premium only).
 *
 * Reward Rules (from phase-10-rewards-config.ts):
 * - Daily Reward: 10 Essence base + 5% streak bonus per day (max 100% = 20 Essence at 20+ day streak)
 * - Weekly Reward: 100 Essence base + 10% bonus per consecutive week (max 100% = 200 Essence at 10+ weeks)
 *
 * Usage:
 *   const { claimDailyReward, claimWeeklyReward, getRewardStatus } = require('./services/rewards-service');
 *   const result = await claimDailyReward(userId);
 *   const status = await getRewardStatus(userId);
 */

const { getItem, putItem, updateItem, queryItems, getUser, addEssence, logTransaction, getTotem, updateTotem, TABLES } = require('../common/db-client');
const { onLoginStreak } = require('./achievements-service');

// =============================================================================
// TABLE NAME
// =============================================================================

const REWARDS_CLAIMS_TABLE = TABLES.REWARDS_CLAIMS;

// =============================================================================
// REWARD CONFIGURATION
// =============================================================================

const REWARD_CONFIG = {
  daily: {
    baseAmount: 10,              // 10 Essence base
    streakBonusPercent: 5,       // 5% per day
    maxStreakBonusPercent: 100,  // Max 100% bonus (caps at 20 days)
    cooldownMs: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
    cooldownHours: 24,
    // Grace period: if more than 48 hours since last claim, streak resets
    gracePeriodMs: 48 * 60 * 60 * 1000,
  },
  weekly: {
    baseAmount: 100,             // 100 Essence base
    streakBonusPercent: 10,      // 10% per consecutive week
    maxStreakBonusPercent: 100,  // Max 100% bonus (caps at 10 weeks)
    cooldownMs: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    cooldownDays: 7,
    // Grace period: if more than 14 days since last claim, streak resets
    gracePeriodMs: 14 * 24 * 60 * 60 * 1000,
  },
};

// =============================================================================
// TUTORIAL REWARDS CONFIGURATION
// Based on frontend config at totem-app/public/config/rewards.json
// =============================================================================

const TUTORIAL_REWARDS = {
  1: {
    id: 'rwd_tutorial-1-signup',
    step: 1,
    name: 'Claim Your Spiritkeeper Reward',
    description: 'As your journey begins, a small gift awaits. The Ancients honor the brave.',
    essenceReward: 50,
    experienceReward: 0,
    requiresTotem: false,
  },
  2: {
    id: 'rwd_tutorial-2-mint',
    step: 2,
    name: 'Step into the Spirit World',
    description: 'The veil thins. The Ancients call. But first... a Totem must be chosen.',
    essenceReward: 50,
    experienceReward: 100,
    requiresTotem: true,
  },
  3: {
    id: 'rwd_tutorial-3-care',
    step: 3,
    name: 'Care for Your Totem',
    description: 'Every Totem hungers, grows, and remembers. Begin the ritual of care.',
    essenceReward: 50,
    experienceReward: 150,
    requiresTotem: true,
  },
  4: {
    id: 'rwd_tutorial-4-challenge',
    step: 4,
    name: 'Prove Yourself in a Challenge',
    description: 'Test your bond. Step into the Trials and be seen.',
    essenceReward: 50,
    experienceReward: 200,
    requiresTotem: true,
  },
  5: {
    id: 'rwd_tutorial-5-evolve',
    step: 5,
    name: 'Evolve Your Totem',
    description: 'Only those who journey may grow. Let evolution mark your spirit.',
    essenceReward: 50,
    experienceReward: 250,
    requiresTotem: true,
  },
  6: {
    id: 'rwd_tutorial-6-explore',
    step: 6,
    name: 'Explore the World',
    description: 'Beyond the veil lies discovery, Codex, Expeditions, and fellow Spiritkeepers await.',
    essenceReward: 250,
    experienceReward: 0,
    requiresTotem: false,
  },
};

// =============================================================================
// KEY HELPERS
// =============================================================================

const KEY_PREFIX = {
  USER: 'USER#',
  REWARD: 'REWARD#',
  STREAK: 'STREAK#',
  TUTORIAL: 'TUTORIAL#',
};

function rewardUserPK(userId) {
  return `${KEY_PREFIX.USER}${userId}`;
}

function rewardClaimSK(type, date) {
  return `${KEY_PREFIX.REWARD}${type}#${date}`;
}

function streakSK(type) {
  return `${KEY_PREFIX.STREAK}${type}`;
}

function tutorialSK(step) {
  return `${KEY_PREFIX.TUTORIAL}${step}`;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get date string in YYYY-MM-DD format (UTC)
 */
function getDateString(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/**
 * Get today's date at UTC midnight (start of day)
 */
function getTodayUTCMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Get tomorrow's date at UTC midnight (next reset time)
 */
function getNextUTCMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
}

/**
 * Check if a timestamp is from a previous UTC day (before today's midnight)
 */
function isBeforeTodayUTC(timestamp) {
  if (!timestamp) return true;
  const claimDate = new Date(timestamp);
  const todayMidnight = getTodayUTCMidnight();
  return claimDate.getTime() < todayMidnight.getTime();
}

/**
 * Calculate daily bonus based on streak
 * 5% per day, max 100% (caps at 20 days)
 */
function calculateDailyBonus(streak) {
  const bonusPercent = streak * REWARD_CONFIG.daily.streakBonusPercent;
  return Math.min(bonusPercent, REWARD_CONFIG.daily.maxStreakBonusPercent);
}

/**
 * Calculate weekly bonus based on week streak
 * 10% per consecutive week, max 100% (caps at 10 weeks)
 */
function calculateWeeklyBonus(weekStreak) {
  const bonusPercent = weekStreak * REWARD_CONFIG.weekly.streakBonusPercent;
  return Math.min(bonusPercent, REWARD_CONFIG.weekly.maxStreakBonusPercent);
}

/**
 * Calculate total reward amount for a given type and streak
 */
function calculateRewardAmount(type, streak) {
  const config = REWARD_CONFIG[type];
  const baseAmount = config.baseAmount;

  const bonusPercent = type === 'daily'
    ? calculateDailyBonus(streak)
    : calculateWeeklyBonus(streak);

  const bonusAmount = Math.floor(baseAmount * (bonusPercent / 100));
  const totalAmount = baseAmount + bonusAmount;

  return { baseAmount, bonusPercent, bonusAmount, totalAmount };
}

/**
 * Check if reward can be claimed based on cooldown
 *
 * Daily rewards: Reset at UTC midnight (can claim once per calendar day UTC)
 * Weekly rewards: 7 days from last claim
 */
function canClaimReward(lastClaimTimestamp, type) {
  if (!lastClaimTimestamp) {
    return { canClaim: true, nextClaimTime: null };
  }

  if (type === 'daily') {
    // Daily rewards reset at UTC midnight
    const canClaim = isBeforeTodayUTC(lastClaimTimestamp);
    if (canClaim) {
      return { canClaim: true, nextClaimTime: null };
    }
    // Next claim available at next UTC midnight
    const nextClaimTime = getNextUTCMidnight().toISOString();
    return { canClaim: false, nextClaimTime };
  }

  // Weekly rewards use rolling 7-day cooldown
  const config = REWARD_CONFIG[type];
  const lastClaim = new Date(lastClaimTimestamp);
  const now = new Date();
  const timeSinceLastClaim = now.getTime() - lastClaim.getTime();

  if (timeSinceLastClaim >= config.cooldownMs) {
    return { canClaim: true, nextClaimTime: null };
  }

  const nextClaimTime = new Date(lastClaim.getTime() + config.cooldownMs).toISOString();
  return { canClaim: false, nextClaimTime };
}

/**
 * Check if streak should be reset based on grace period
 *
 * Daily rewards: Streak resets if you miss a full UTC day (didn't claim yesterday)
 * Weekly rewards: 14 days grace period
 *
 * Protection: If protectionExpiry is provided and still active, streak is preserved
 * (migrated from TotemRewards.sol _shouldMaintainStreak)
 */
function shouldResetStreak(lastClaimTimestamp, type, protectionExpiry = null) {
  if (!lastClaimTimestamp) {
    return true; // No previous claim, start fresh
  }

  // Check if protection is active — if so, never reset streak
  if (protectionExpiry) {
    const expiryTime = new Date(protectionExpiry).getTime();
    if (expiryTime > Date.now()) {
      return false; // Protection active, maintain streak
    }
  }

  if (type === 'daily') {
    // For daily rewards, check if last claim was yesterday or today (UTC)
    // If it was 2+ days ago, reset the streak
    const lastClaim = new Date(lastClaimTimestamp);
    const todayMidnight = getTodayUTCMidnight();
    const yesterdayMidnight = new Date(todayMidnight.getTime() - 24 * 60 * 60 * 1000);

    // If last claim was before yesterday's midnight, streak resets
    return lastClaim.getTime() < yesterdayMidnight.getTime();
  }

  // Weekly rewards use rolling grace period
  const config = REWARD_CONFIG[type];
  const lastClaim = new Date(lastClaimTimestamp);
  const now = new Date();
  const timeSinceLastClaim = now.getTime() - lastClaim.getTime();

  return timeSinceLastClaim > config.gracePeriodMs;
}

// =============================================================================
// STREAK STATE OPERATIONS
// =============================================================================

/**
 * Get streak state for a user and reward type
 */
async function getStreakState(userId, type) {
  const key = {
    pk: rewardUserPK(userId),
    sk: streakSK(type),
  };

  const state = await getItem(REWARDS_CLAIMS_TABLE, key);

  if (!state) {
    // Return default state for new users
    return {
      pk: key.pk,
      sk: key.sk,
      userId,
      rewardType: type,
      currentStreak: 0,
      longestStreak: 0,
      lastClaimDate: null,
      lastClaimTimestamp: null,
      totalClaims: 0,
      totalEssenceEarned: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return state;
}

/**
 * Update streak state after a claim
 */
async function updateStreakState(userId, type, newStreak, totalAmount) {
  const now = new Date();
  const key = {
    pk: rewardUserPK(userId),
    sk: streakSK(type),
  };

  const existing = await getItem(REWARDS_CLAIMS_TABLE, key);

  if (!existing) {
    // Create new streak state
    const newState = {
      pk: key.pk,
      sk: key.sk,
      userId,
      rewardType: type,
      currentStreak: newStreak,
      longestStreak: newStreak,
      lastClaimDate: getDateString(now),
      lastClaimTimestamp: now.toISOString(),
      totalClaims: 1,
      totalEssenceEarned: totalAmount,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await putItem(REWARDS_CLAIMS_TABLE, newState);
    return newState;
  }

  // Update existing
  const newLongestStreak = Math.max(existing.longestStreak || 0, newStreak);
  const updates = {
    currentStreak: newStreak,
    longestStreak: newLongestStreak,
    lastClaimDate: getDateString(now),
    lastClaimTimestamp: now.toISOString(),
    totalClaims: (existing.totalClaims || 0) + 1,
    totalEssenceEarned: (existing.totalEssenceEarned || 0) + totalAmount,
  };

  return updateItem(REWARDS_CLAIMS_TABLE, key, updates);
}

// =============================================================================
// CLAIM OPERATIONS
// =============================================================================

/**
 * Record a reward claim
 */
async function recordClaim(userId, type, claimData) {
  const now = new Date();
  const dateStr = getDateString(now);

  const record = {
    pk: rewardUserPK(userId),
    sk: rewardClaimSK(type, dateStr),
    userId,
    rewardType: type,
    claimDate: dateStr,
    baseAmount: claimData.baseAmount,
    streakAtClaim: claimData.streakAtClaim,
    bonusPercent: claimData.bonusPercent,
    bonusAmount: claimData.bonusAmount,
    totalAmount: claimData.totalAmount,
    claimedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await putItem(REWARDS_CLAIMS_TABLE, record);
  return record;
}

// =============================================================================
// MAIN SERVICE FUNCTIONS
// =============================================================================

/**
 * Claim daily reward
 *
 * @param {string} userId - User ID
 * @returns {Promise<object>} Claim result with reward details
 *
 * Returns:
 *   - success: true/false
 *   - error: error message if failed
 *   - reward: { type, baseAmount, streakAtClaim, bonusPercent, bonusAmount, totalAmount }
 *   - newStreak: updated streak count
 *   - newBalance: new Essence balance
 *   - nextClaimTime: ISO timestamp when next claim is available
 */
async function claimDailyReward(userId) {
  try {
    // Verify user exists
    const user = await getUser(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Get current streak state
    const streakState = await getStreakState(userId, 'daily');

    // Check if can claim (24hr cooldown)
    const { canClaim, nextClaimTime } = canClaimReward(streakState.lastClaimTimestamp, 'daily');
    if (!canClaim) {
      return {
        success: false,
        error: 'Daily reward not yet available',
        nextClaimTime,
        currentStreak: streakState.currentStreak,
      };
    }

    // Determine new streak (reset if outside grace period, respecting protection)
    let newStreak;
    if (shouldResetStreak(streakState.lastClaimTimestamp, 'daily', streakState.protectionExpiry)) {
      newStreak = 1; // Start fresh
    }
    else {
      newStreak = (streakState.currentStreak || 0) + 1;
    }

    // Calculate reward amount
    // Bonus is based on the NEW streak (after this claim)
    const { baseAmount, bonusPercent, bonusAmount, totalAmount } = calculateRewardAmount('daily', newStreak);

    // Add Essence to user balance
    const balanceResult = await addEssence(userId, totalAmount, {
      type: 'reward_daily',
      ref: `daily_${getDateString()}`,
    });

    if (!balanceResult.success) {
      return { success: false, error: balanceResult.error };
    }

    // Record the claim
    await recordClaim(userId, 'daily', {
      baseAmount,
      streakAtClaim: newStreak,
      bonusPercent,
      bonusAmount,
      totalAmount,
    });

    // Update streak state
    await updateStreakState(userId, 'daily', newStreak, totalAmount);

    // Log transaction for audit
    await logTransaction(userId, {
      type: 'reward_daily',
      currency: 'essence',
      amount: totalAmount,
      balanceBefore: balanceResult.newBalance - totalAmount,
      balanceAfter: balanceResult.newBalance,
      refType: 'reward',
      ref: `daily_streak_${newStreak}`,
      refName: `Daily Reward (${newStreak} day streak)`,
    });

    // Update login streak achievement progress
    let achievements = [];
    try {
      const achResults = await onLoginStreak(userId, newStreak);
      achievements = (achResults || []).filter(a => a.unlocked).map(a => ({
        achievementId: a.achievementId,
        milestone: a.milestone,
        rewards: a.rewards,
      }));
    }
    catch (achErr) {
      console.error(`[Rewards] Error updating login achievement for ${userId}:`, achErr.message);
      // Don't fail the claim if achievement update fails
    }

    // Calculate next claim time (next UTC midnight)
    const nextClaim = getNextUTCMidnight().toISOString();

    console.log(`[Rewards] User ${userId} claimed daily reward: ${totalAmount} Essence (streak: ${newStreak})`);

    return {
      success: true,
      reward: {
        type: 'daily',
        baseAmount,
        streakAtClaim: newStreak,
        bonusPercent,
        bonusAmount,
        totalAmount,
      },
      newStreak,
      newBalance: balanceResult.newBalance,
      nextClaimTime: nextClaim,
      achievements,
    };
  }
  catch (error) {
    console.error(`[Rewards] Error claiming daily reward for ${userId}:`, error);
    return { success: false, error: 'Failed to claim daily reward' };
  }
}

/**
 * Claim weekly reward
 *
 * @param {string} userId - User ID
 * @returns {Promise<object>} Claim result with reward details
 */
async function claimWeeklyReward(userId) {
  try {
    // Verify user exists
    const user = await getUser(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Get current streak state
    const streakState = await getStreakState(userId, 'weekly');

    // Check if can claim (7 day cooldown)
    const { canClaim, nextClaimTime } = canClaimReward(streakState.lastClaimTimestamp, 'weekly');
    if (!canClaim) {
      return {
        success: false,
        error: 'Weekly reward not yet available',
        nextClaimTime,
        currentStreak: streakState.currentStreak,
      };
    }

    // Determine new streak (reset if outside grace period, respecting protection)
    let newStreak;
    if (shouldResetStreak(streakState.lastClaimTimestamp, 'weekly', streakState.protectionExpiry)) {
      newStreak = 1; // Start fresh
    }
    else {
      newStreak = (streakState.currentStreak || 0) + 1;
    }

    // Calculate reward amount
    // Bonus is based on the NEW streak (after this claim)
    const { baseAmount, bonusPercent, bonusAmount, totalAmount } = calculateRewardAmount('weekly', newStreak);

    // Add Essence to user balance
    const balanceResult = await addEssence(userId, totalAmount, {
      type: 'reward_weekly',
      ref: `weekly_${getDateString()}`,
    });

    if (!balanceResult.success) {
      return { success: false, error: balanceResult.error };
    }

    // Record the claim
    await recordClaim(userId, 'weekly', {
      baseAmount,
      streakAtClaim: newStreak,
      bonusPercent,
      bonusAmount,
      totalAmount,
    });

    // Update streak state
    await updateStreakState(userId, 'weekly', newStreak, totalAmount);

    // Log transaction for audit
    await logTransaction(userId, {
      type: 'reward_weekly',
      currency: 'essence',
      amount: totalAmount,
      balanceBefore: balanceResult.newBalance - totalAmount,
      balanceAfter: balanceResult.newBalance,
      refType: 'reward',
      ref: `weekly_streak_${newStreak}`,
      refName: `Weekly Reward (${newStreak} week streak)`,
    });

    // Calculate next claim time
    const nextClaim = new Date(Date.now() + REWARD_CONFIG.weekly.cooldownMs).toISOString();

    console.log(`[Rewards] User ${userId} claimed weekly reward: ${totalAmount} Essence (streak: ${newStreak})`);

    return {
      success: true,
      reward: {
        type: 'weekly',
        baseAmount,
        streakAtClaim: newStreak,
        bonusPercent,
        bonusAmount,
        totalAmount,
      },
      newStreak,
      newBalance: balanceResult.newBalance,
      nextClaimTime: nextClaim,
    };
  }
  catch (error) {
    console.error(`[Rewards] Error claiming weekly reward for ${userId}:`, error);
    return { success: false, error: 'Failed to claim weekly reward' };
  }
}

/**
 * Get reward status for a user
 *
 * @param {string} userId - User ID
 * @returns {Promise<object>} Current reward status for daily and weekly
 *
 * Returns status for both daily and weekly rewards including:
 *   - canClaim: whether the reward can be claimed now
 *   - currentStreak: current streak count
 *   - longestStreak: all-time longest streak
 *   - lastClaimDate: date of last claim
 *   - nextClaimTime: when the reward becomes claimable
 *   - potentialReward: what the user would receive if they claim
 */
async function getRewardStatus(userId) {
  try {
    // Verify user exists
    const user = await getUser(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Get streak states for both types
    const [dailyState, weeklyState] = await Promise.all([
      getStreakState(userId, 'daily'),
      getStreakState(userId, 'weekly'),
    ]);

    // Calculate daily status (pass protectionExpiry to respect active protection)
    const dailyClaimCheck = canClaimReward(dailyState.lastClaimTimestamp, 'daily');
    const dailyStreakWillReset = shouldResetStreak(dailyState.lastClaimTimestamp, 'daily', dailyState.protectionExpiry);
    const dailyEffectiveStreak = dailyStreakWillReset ? 0 : dailyState.currentStreak;
    const dailyNextStreak = dailyEffectiveStreak + 1;
    const dailyPotentialReward = calculateRewardAmount('daily', dailyNextStreak);

    // Calculate weekly status (pass protectionExpiry to respect active protection)
    const weeklyClaimCheck = canClaimReward(weeklyState.lastClaimTimestamp, 'weekly');
    const weeklyStreakWillReset = shouldResetStreak(weeklyState.lastClaimTimestamp, 'weekly', weeklyState.protectionExpiry);
    const weeklyEffectiveStreak = weeklyStreakWillReset ? 0 : weeklyState.currentStreak;
    const weeklyNextStreak = weeklyEffectiveStreak + 1;
    const weeklyPotentialReward = calculateRewardAmount('weekly', weeklyNextStreak);

    return {
      success: true,
      daily: {
        canClaim: dailyClaimCheck.canClaim,
        currentStreak: dailyEffectiveStreak,
        longestStreak: dailyState.longestStreak || 0,
        lastClaimDate: dailyState.lastClaimDate || null,
        nextClaimTime: dailyClaimCheck.nextClaimTime,
        streakWillReset: dailyStreakWillReset && dailyState.currentStreak > 0,
        totalClaims: dailyState.totalClaims || 0,
        totalEssenceEarned: dailyState.totalEssenceEarned || 0,
        potentialReward: dailyPotentialReward,
      },
      weekly: {
        canClaim: weeklyClaimCheck.canClaim,
        currentStreak: weeklyEffectiveStreak,
        longestStreak: weeklyState.longestStreak || 0,
        lastClaimDate: weeklyState.lastClaimDate || null,
        nextClaimTime: weeklyClaimCheck.nextClaimTime,
        streakWillReset: weeklyStreakWillReset && weeklyState.currentStreak > 0,
        totalClaims: weeklyState.totalClaims || 0,
        totalEssenceEarned: weeklyState.totalEssenceEarned || 0,
        potentialReward: weeklyPotentialReward,
      },
    };
  }
  catch (error) {
    console.error(`[Rewards] Error getting reward status for ${userId}:`, error);
    return { success: false, error: 'Failed to get reward status' };
  }
}

// =============================================================================
// TUTORIAL REWARD FUNCTIONS
// =============================================================================

/**
 * Check if a tutorial step has been claimed by a user
 */
async function isTutorialStepClaimed(userId, step) {
  const key = {
    pk: rewardUserPK(userId),
    sk: tutorialSK(step),
  };

  const claim = await getItem(REWARDS_CLAIMS_TABLE, key);
  return !!claim;
}

/**
 * Get tutorial progress for a user
 *
 * @param {string} userId - User ID
 * @returns {Promise<object>} Tutorial progress with claimed steps
 *
 * Returns:
 *   - success: true/false
 *   - completedSteps: array of completed step numbers
 *   - totalSteps: total number of tutorial steps
 *   - nextStep: next step to complete (or null if all done)
 *   - rewards: map of step -> reward details (with claimed status)
 */
async function getTutorialProgress(userId) {
  try {
    // Verify user exists
    const user = await getUser(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Query all tutorial claims for this user
    const pk = rewardUserPK(userId);
    const items = await queryItems(REWARDS_CLAIMS_TABLE, 'pk', pk, {
      skPrefix: KEY_PREFIX.TUTORIAL,
    });

    // Extract completed steps
    const completedSteps = items.map((item) => item.step).sort((a, b) => a - b);

    // Build rewards map with claimed status
    const rewards = {};
    const totalSteps = Object.keys(TUTORIAL_REWARDS).length;

    for (const stepStr of Object.keys(TUTORIAL_REWARDS)) {
      const step = parseInt(stepStr, 10);
      const reward = TUTORIAL_REWARDS[step];
      const claimRecord = items.find((item) => item.step === step);

      rewards[step] = {
        ...reward,
        claimed: !!claimRecord,
        claimedAt: claimRecord?.claimedAt || null,
      };
    }

    // Find next unclaimed step
    let nextStep = null;
    for (let i = 1; i <= totalSteps; i++) {
      if (!completedSteps.includes(i)) {
        nextStep = i;
        break;
      }
    }

    return {
      success: true,
      completedSteps,
      totalSteps,
      nextStep,
      rewards,
      totalEssenceEarned: items.reduce((sum, item) => sum + (item.essenceReward || 0), 0),
      totalExperienceEarned: items.reduce((sum, item) => sum + (item.experienceReward || 0), 0),
    };
  }
  catch (error) {
    console.error(`[Rewards] Error getting tutorial progress for ${userId}:`, error);
    return { success: false, error: 'Failed to get tutorial progress' };
  }
}

/**
 * Claim a tutorial reward
 *
 * @param {string} userId - User ID
 * @param {number} step - Tutorial step number (1-6)
 * @param {string} [totemId] - Totem ID (required for steps 2-5)
 * @returns {Promise<object>} Claim result with reward details
 *
 * Returns:
 *   - success: true/false
 *   - error: error message if failed
 *   - reward: { step, name, essenceReward, experienceReward }
 *   - newBalance: new Essence balance
 *   - totemExperience: new totem experience (if applicable)
 */
async function claimTutorialReward(userId, step, totemId = null) {
  try {
    // 1. Validate step exists
    const reward = TUTORIAL_REWARDS[step];
    if (!reward) {
      return {
        success: false,
        error: `Invalid tutorial step: ${step}. Valid steps are 1-6.`,
      };
    }

    // 2. Verify user exists
    const user = await getUser(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // 3. Check if step was already claimed
    const alreadyClaimed = await isTutorialStepClaimed(userId, step);
    if (alreadyClaimed) {
      return {
        success: false,
        error: `Tutorial step ${step} has already been claimed`,
      };
    }

    // 4. Validate totem requirement
    if (reward.requiresTotem && !totemId) {
      return {
        success: false,
        error: `Tutorial step ${step} requires a totemId`,
      };
    }

    // Verify totem exists if provided
    let totem = null;
    if (totemId) {
      totem = await getTotem(userId, totemId);
      if (!totem) {
        return {
          success: false,
          error: `Totem ${totemId} not found`,
        };
      }
    }

    // 5. Award Essence
    let newBalance = null;
    if (reward.essenceReward > 0) {
      const balanceResult = await addEssence(userId, reward.essenceReward, {
        type: 'reward_tutorial',
        ref: `tutorial_step_${step}`,
      });

      if (!balanceResult.success) {
        return { success: false, error: balanceResult.error };
      }

      newBalance = balanceResult.newBalance;
    }

    // 6. Award XP to totem if applicable
    let totemExperience = null;
    if (reward.experienceReward > 0 && totemId && totem) {
      const currentXP = totem.experience || 0;
      totemExperience = currentXP + reward.experienceReward;

      await updateTotem(userId, totemId, {
        experience: totemExperience,
      });
    }

    // 7. Record the claim
    const now = new Date();
    const claimRecord = {
      pk: rewardUserPK(userId),
      sk: tutorialSK(step),
      userId,
      step,
      rewardId: reward.id,
      rewardType: 'tutorial',
      essenceReward: reward.essenceReward,
      experienceReward: reward.experienceReward,
      totemId: totemId || null,
      claimedAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await putItem(REWARDS_CLAIMS_TABLE, claimRecord);

    // 8. Log transaction for audit (if essence was awarded)
    if (reward.essenceReward > 0) {
      await logTransaction(userId, {
        type: 'reward_tutorial',
        currency: 'essence',
        amount: reward.essenceReward,
        balanceBefore: newBalance - reward.essenceReward,
        balanceAfter: newBalance,
        refType: 'tutorial',
        ref: `tutorial_step_${step}`,
        refName: reward.name,
      });
    }

    console.log(`[Rewards] User ${userId} claimed tutorial step ${step}: ${reward.essenceReward} Essence, ${reward.experienceReward} XP`);

    return {
      success: true,
      reward: {
        step,
        id: reward.id,
        name: reward.name,
        description: reward.description,
        essenceReward: reward.essenceReward,
        experienceReward: reward.experienceReward,
      },
      newBalance,
      totemId: totemId || null,
      totemExperience,
    };
  }
  catch (error) {
    console.error(`[Rewards] Error claiming tutorial reward for ${userId} step ${step}:`, error);
    return { success: false, error: 'Failed to claim tutorial reward' };
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Configuration
  REWARD_CONFIG,
  TUTORIAL_REWARDS,
  REWARDS_CLAIMS_TABLE,

  // Main service functions
  claimDailyReward,
  claimWeeklyReward,
  getRewardStatus,

  // Tutorial reward functions
  claimTutorialReward,
  getTutorialProgress,

  // Calculation helpers (exported for testing)
  calculateDailyBonus,
  calculateWeeklyBonus,
  calculateRewardAmount,

  // UTC midnight helpers (exported for frontend/testing)
  getTodayUTCMidnight,
  getNextUTCMidnight,
  isBeforeTodayUTC,

  // Internal helpers (exported for testing)
  getStreakState,
  canClaimReward,
  shouldResetStreak,
  isTutorialStepClaimed,
};
