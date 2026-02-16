/**
 * Purchase Protection Handler
 *
 * POST /v1/rewards/:type/protection
 *
 * Allows users to purchase streak protection to prevent losing their streak
 * if they miss a day/week. Protection extends the grace period.
 *
 * Migrated from TotemRewards.sol purchaseProtection(rewardId, tier)
 *
 * Protection Tiers (from phase-10-rewards-config.ts):
 * Daily:
 *   - Tier 0: 50 Essence, 1 day (86400s), requires 7-day streak
 *   - Tier 1: 250 Essence, 7 days (604800s), requires 14-day streak
 * Weekly:
 *   - Tier 0: 500 Essence, 14 days (1209600s), requires 4-week streak
 */

const { getItem, updateItem, TABLES } = require('../../common/db-client');
const { deductEssence, logTransaction } = require('../../common/db-client');

const REWARDS_CLAIMS_TABLE = TABLES.REWARDS_CLAIMS;

// Protection tier configuration (from contracts phase-10-rewards-config.ts)
const PROTECTION_TIERS = {
  daily: [
    { tier: 0, cost: 50, durationSeconds: 86400, requiredStreak: 7 },
    { tier: 1, cost: 250, durationSeconds: 604800, requiredStreak: 14 },
  ],
  weekly: [
    { tier: 0, cost: 500, durationSeconds: 1209600, requiredStreak: 4 },
  ],
};

/**
 * Purchase streak protection
 *
 * @param {object} user - Authenticated user { userId }
 * @param {object} body - Request body { tier: number }
 * @param {string} rewardType - 'daily' or 'weekly'
 * @returns {object} - Purchase result
 */
async function purchaseProtection(user, body, rewardType) {
  if (!user || !user.userId) {
    return {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'User authentication required' },
    };
  }

  const userId = user.userId;
  const tierIndex = body?.tier ?? 0;

  // Validate reward type
  if (!['daily', 'weekly'].includes(rewardType)) {
    return {
      success: false,
      error: { code: 'INVALID_TYPE', message: 'Invalid reward type. Must be daily or weekly.' },
    };
  }

  // Validate tier exists
  const tiers = PROTECTION_TIERS[rewardType];
  if (tierIndex < 0 || tierIndex >= tiers.length) {
    return {
      success: false,
      error: {
        code: 'INVALID_TIER',
        message: `Invalid tier ${tierIndex}. Valid tiers for ${rewardType}: 0-${tiers.length - 1}`,
      },
    };
  }

  const tierConfig = tiers[tierIndex];

  try {
    // 1. Get current streak state
    const streakKey = {
      pk: `USER#${userId}`,
      sk: `STREAK#${rewardType}`,
    };
    const streakState = await getItem(REWARDS_CLAIMS_TABLE, streakKey);

    if (!streakState) {
      return {
        success: false,
        error: { code: 'NO_STREAK', message: 'No streak found. Start claiming rewards first.' },
      };
    }

    // 2. Check streak requirement
    const currentStreak = streakState.currentStreak || 0;
    if (currentStreak < tierConfig.requiredStreak) {
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_STREAK',
          message: `Requires ${tierConfig.requiredStreak}-${rewardType === 'daily' ? 'day' : 'week'} streak. Current: ${currentStreak}.`,
        },
      };
    }

    // 3. Check no active protection
    if (streakState.protectionExpiry) {
      const expiryTime = new Date(streakState.protectionExpiry).getTime();
      if (expiryTime > Date.now()) {
        return {
          success: false,
          error: {
            code: 'ALREADY_PROTECTED',
            message: 'You already have active streak protection.',
            protectionExpiry: streakState.protectionExpiry,
          },
        };
      }
    }

    // 4. Deduct Essence
    const deductResult = await deductEssence(userId, tierConfig.cost, {
      type: 'protection_purchase',
      ref: `protection_${rewardType}_tier${tierIndex}`,
    });

    if (!deductResult.success) {
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_ESSENCE',
          message: `Not enough Essence. Need ${tierConfig.cost}, have ${deductResult.currentBalance || 0}.`,
        },
      };
    }

    // 5. Set protection expiry on streak state
    const protectionExpiry = new Date(Date.now() + tierConfig.durationSeconds * 1000).toISOString();

    await updateItem(REWARDS_CLAIMS_TABLE, streakKey, {
      protectionExpiry,
      protectionTier: tierIndex,
      protectionPurchasedAt: new Date().toISOString(),
    });

    // 6. Log transaction
    await logTransaction(userId, {
      type: 'protection_purchase',
      currency: 'essence',
      amount: -tierConfig.cost,
      balanceBefore: deductResult.newBalance + tierConfig.cost,
      balanceAfter: deductResult.newBalance,
      refType: 'protection',
      ref: `${rewardType}_tier${tierIndex}`,
      refName: `${rewardType === 'daily' ? 'Daily' : 'Weekly'} Protection (Tier ${tierIndex})`,
    });

    console.log(`[Protection] User ${userId} purchased ${rewardType} protection tier ${tierIndex} for ${tierConfig.cost} Essence. Expires: ${protectionExpiry}`);

    return {
      success: true,
      data: {
        rewardType,
        tier: tierIndex,
        cost: tierConfig.cost,
        durationSeconds: tierConfig.durationSeconds,
        protectionExpiry,
        newBalance: deductResult.newBalance,
      },
    };
  }
  catch (error) {
    console.error(`[Protection] Error purchasing ${rewardType} protection for ${userId}:`, error);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to purchase protection' },
    };
  }
}

module.exports = { purchaseProtection, PROTECTION_TIERS };
