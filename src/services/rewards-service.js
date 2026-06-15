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

const { getItem, putItem, updateItem, queryItems, getUser, addEssence, getTotem, updateTotem, TABLES } = require('../common/db-client');
const { onLoginStreak } = require('./achievements-service');
const { getTierMultiplier, getTierBonusPercent } = require('./tier-bonuses');

// =============================================================================
// TABLE NAME
// =============================================================================

const REWARDS_CLAIMS_TABLE = TABLES.REWARDS_CLAIMS;

// =============================================================================
// REWARD CONFIGURATION
// =============================================================================

const REWARD_CONFIG = {
  daily: {
    baseAmount: 30,              // 30 Essence base (bumped from 10 on 2026-05-16 to keep the daily login meaningful next to Daily Quests' 195E/day)
    streakBonusPercent: 5,       // 5% per day
    maxStreakBonusPercent: 100,  // Max 100% bonus at day 20+ → max 60E
    cooldownMs: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
    cooldownHours: 24,
    // Grace period: if more than 48 hours since last claim, streak resets
    gracePeriodMs: 48 * 60 * 60 * 1000,
  },
  weekly: {
    baseAmount: 100,             // 100 Essence base (lowered from 200 on 2026-05-16 once tier multipliers landed — vip max-streak weekly would otherwise reach 1200E)
    streakBonusPercent: 10,      // 10% per consecutive week
    maxStreakBonusPercent: 100,  // Max 100% bonus at week 10+ → max 200E (free)
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
  // Bonus starts on 2nd consecutive claim (streak 2+), first claim = base only
  const consecutiveDays = Math.max(0, streak - 1);
  const bonusPercent = consecutiveDays * REWARD_CONFIG.daily.streakBonusPercent;
  return Math.min(bonusPercent, REWARD_CONFIG.daily.maxStreakBonusPercent);
}

/**
 * Calculate weekly bonus based on week streak
 * 10% per consecutive week, max 100% (caps at 10 weeks)
 */
function calculateWeeklyBonus(weekStreak) {
  // Bonus starts on 2nd consecutive claim (streak 2+), first claim = base only
  const consecutiveWeeks = Math.max(0, weekStreak - 1);
  const bonusPercent = consecutiveWeeks * REWARD_CONFIG.weekly.streakBonusPercent;
  return Math.min(bonusPercent, REWARD_CONFIG.weekly.maxStreakBonusPercent);
}

/**
 * Calculate total reward amount for a given type, streak, and subscription tier.
 *
 * Tier multiplier scales the base reward BEFORE the streak bonus is applied:
 *   total = floor(baseAmount × tierMultiplier × (1 + streakBonus/100))
 *
 * @param {'daily'|'weekly'} type
 * @param {number} streak
 * @param {string} [tier='free'] - 'free' | 'premium' | 'vip'
 */
function calculateRewardAmount(type, streak, tier = 'free') {
  const config = REWARD_CONFIG[type];
  const baseAmount = config.baseAmount;

  const bonusPercent = type === 'daily'
    ? calculateDailyBonus(streak)
    : calculateWeeklyBonus(streak);

  const tierMultiplier = getTierMultiplier(tier);
  const tierBonusPercent = getTierBonusPercent(tier);
  const boostedBase = baseAmount * tierMultiplier;

  const bonusAmount = Math.floor(boostedBase * (bonusPercent / 100));
  const totalAmount = boostedBase + bonusAmount;

  return {
    baseAmount,
    tierMultiplier,
    tierBonusPercent,
    boostedBase,
    bonusPercent,
    bonusAmount,
    totalAmount,
  };
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
 * Decide whether a streak resets, and whether a protection charge should be
 * consumed to save it.
 *
 * Returns: { reset: boolean, consumeCharge: boolean }
 *
 * Daily: streak resets if last claim was before yesterday's UTC midnight.
 * Weekly: streak resets after the configured grace period.
 *
 * If `protectionCharges > 0` (or a legacy active `protectionExpiry`) when the
 * streak would reset, we keep the streak and signal that a charge must be
 * decremented (legacy expiry-based protection counts as a single save during
 * migration).
 */
function shouldResetStreak(lastClaimTimestamp, type, streakState = null) {
  if (!lastClaimTimestamp) {
    return { reset: true, consumeCharge: false };
  }

  let wouldReset;
  if (type === 'daily') {
    const lastClaim = new Date(lastClaimTimestamp);
    const todayMidnight = getTodayUTCMidnight();
    const yesterdayMidnight = new Date(todayMidnight.getTime() - 24 * 60 * 60 * 1000);
    wouldReset = lastClaim.getTime() < yesterdayMidnight.getTime();
  }
  else {
    const config = REWARD_CONFIG[type];
    const lastClaim = new Date(lastClaimTimestamp);
    wouldReset = (Date.now() - lastClaim.getTime()) > config.gracePeriodMs;
  }

  if (!wouldReset) {
    return { reset: false, consumeCharge: false };
  }

  const charges = streakState?.protectionCharges || 0;
  if (charges > 0) {
    return { reset: false, consumeCharge: true };
  }

  // Legacy time-window protection: treat as a one-shot save during migration.
  if (streakState?.protectionExpiry) {
    const expiryTime = new Date(streakState.protectionExpiry).getTime();
    if (expiryTime > Date.now()) {
      return { reset: false, consumeCharge: true };
    }
  }

  return { reset: true, consumeCharge: false };
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
 * Update streak state after a claim.
 *
 * If `consumeProtectionCharge` is true, decrements `protectionCharges` by 1
 * and clears any legacy `protectionExpiry` (one-shot save during migration).
 */
async function updateStreakState(userId, type, newStreak, totalAmount, { consumeProtectionCharge = false } = {}) {
  const now = new Date();
  const key = {
    pk: rewardUserPK(userId),
    sk: streakSK(type),
  };

  const existing = await getItem(REWARDS_CLAIMS_TABLE, key);

  if (!existing) {
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

  const newLongestStreak = Math.max(existing.longestStreak || 0, newStreak);
  const updates = {
    currentStreak: newStreak,
    longestStreak: newLongestStreak,
    lastClaimDate: getDateString(now),
    lastClaimTimestamp: now.toISOString(),
    totalClaims: (existing.totalClaims || 0) + 1,
    totalEssenceEarned: (existing.totalEssenceEarned || 0) + totalAmount,
  };

  if (consumeProtectionCharge) {
    const currentCharges = existing.protectionCharges || 0;
    updates.protectionCharges = Math.max(0, currentCharges - 1);
    // Legacy expiry-based protection counts as a one-shot save during migration.
    updates.protectionExpiry = null;
  }

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
    tier: claimData.tier || 'free',
    tierMultiplier: claimData.tierMultiplier || 1,
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

    // Determine new streak (reset if outside grace period, consuming a
    // protection charge instead of resetting when one is available).
    const { reset, consumeCharge } = shouldResetStreak(streakState.lastClaimTimestamp, 'daily', streakState);
    const newStreak = reset ? 1 : (streakState.currentStreak || 0) + 1;

    // Calculate reward amount (tier multiplier × base, then streak bonus)
    // Bonus is based on the NEW streak (after this claim)
    const tier = user.tier || 'free';
    const { baseAmount, tierMultiplier, tierBonusPercent, bonusPercent, bonusAmount, totalAmount } =
      calculateRewardAmount('daily', newStreak, tier);

    // Add Essence (auto-logs to Transactions)
    const balanceResult = await addEssence(userId, totalAmount, {
      type: 'reward_daily',
      ref: `daily_${getDateString()}`,
      refType: 'reward',
      refName: `Daily Reward (${newStreak} day streak)`,
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
      tier,
      tierMultiplier,
    });

    // Update streak state (decrements protection charge if one was consumed)
    await updateStreakState(userId, 'daily', newStreak, totalAmount, { consumeProtectionCharge: consumeCharge });

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
        tier,
        tierMultiplier,
        tierBonusPercent,
      },
      newStreak,
      newBalance: balanceResult.newBalance,
      nextClaimTime: nextClaim,
      streakSaved: consumeCharge,
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

    // Determine new streak (consume a protection charge instead of resetting
    // when one is available).
    const { reset, consumeCharge } = shouldResetStreak(streakState.lastClaimTimestamp, 'weekly', streakState);
    const newStreak = reset ? 1 : (streakState.currentStreak || 0) + 1;

    // Calculate reward amount (tier multiplier × base, then streak bonus)
    // Bonus is based on the NEW streak (after this claim)
    const tier = user.tier || 'free';
    const { baseAmount, tierMultiplier, tierBonusPercent, bonusPercent, bonusAmount, totalAmount } =
      calculateRewardAmount('weekly', newStreak, tier);

    // Add Essence (auto-logs to Transactions)
    const balanceResult = await addEssence(userId, totalAmount, {
      type: 'reward_weekly',
      ref: `weekly_${getDateString()}`,
      refType: 'reward',
      refName: `Weekly Reward (${newStreak} week streak)`,
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
      tier,
      tierMultiplier,
    });

    // Update streak state (decrements protection charge if one was consumed)
    await updateStreakState(userId, 'weekly', newStreak, totalAmount, { consumeProtectionCharge: consumeCharge });

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
        tier,
        tierMultiplier,
        tierBonusPercent,
      },
      newStreak,
      newBalance: balanceResult.newBalance,
      nextClaimTime: nextClaim,
      streakSaved: consumeCharge,
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

    const tier = user.tier || 'free';

    // Calculate daily status. shouldResetStreak considers protection charges,
    // so an at-risk streak is preserved (and a charge is held in reserve until
    // the next claim actually consumes it).
    const dailyClaimCheck = canClaimReward(dailyState.lastClaimTimestamp, 'daily');
    const dailyResetCheck = shouldResetStreak(dailyState.lastClaimTimestamp, 'daily', dailyState);
    const dailyStreakWillReset = dailyResetCheck.reset;
    const dailyEffectiveStreak = dailyStreakWillReset ? 0 : dailyState.currentStreak;
    const dailyNextStreak = dailyEffectiveStreak + 1;
    const dailyPotentialReward = calculateRewardAmount('daily', dailyNextStreak, tier);

    // Calculate weekly status
    const weeklyClaimCheck = canClaimReward(weeklyState.lastClaimTimestamp, 'weekly');
    const weeklyResetCheck = shouldResetStreak(weeklyState.lastClaimTimestamp, 'weekly', weeklyState);
    const weeklyStreakWillReset = weeklyResetCheck.reset;
    const weeklyEffectiveStreak = weeklyStreakWillReset ? 0 : weeklyState.currentStreak;
    const weeklyNextStreak = weeklyEffectiveStreak + 1;
    const weeklyPotentialReward = calculateRewardAmount('weekly', weeklyNextStreak, tier);

    return {
      success: true,
      tier,
      tierMultiplier: getTierMultiplier(tier),
      tierBonusPercent: getTierBonusPercent(tier),
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

    // 5. Award Essence (auto-logs to Transactions)
    let newBalance = null;
    if (reward.essenceReward > 0) {
      const balanceResult = await addEssence(userId, reward.essenceReward, {
        type: 'reward_tutorial',
        ref: `tutorial_step_${step}`,
        refType: 'tutorial',
        refName: reward.name,
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
