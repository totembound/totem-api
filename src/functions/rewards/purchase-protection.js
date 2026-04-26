/**
 * Purchase Protection Handler
 *
 * POST /v1/rewards/:type/protection
 *
 * Allows users to purchase streak protection. Protection is now a consumable
 * charge model rather than a time-window: each purchase grants N charges that
 * are spent only when a streak would actually reset. No expiry.
 *
 * Protection Tiers:
 * Daily:
 *   - Tier 0: 50 Essence, 1 charge,  requires 7-day streak
 *   - Tier 1: 250 Essence, 7 charges, requires 14-day streak (bulk discount)
 * Weekly:
 *   - Tier 0: 500 Essence, 2 charges, requires 4-week streak
 *
 * To prevent unbounded stockpiling, a per-type cap limits the total charges a
 * user can hold simultaneously.
 */

const { getItem, updateItem, TABLES } = require('../../common/db-client');
const { deductEssence, logTransaction } = require('../../common/db-client');

const REWARDS_CLAIMS_TABLE = TABLES.REWARDS_CLAIMS;

const PROTECTION_TIERS = {
  daily: [
    { tier: 0, cost: 50, charges: 1, requiredStreak: 7 },
    { tier: 1, cost: 250, charges: 7, requiredStreak: 14 },
  ],
  weekly: [
    { tier: 0, cost: 500, charges: 2, requiredStreak: 4 },
  ],
};

// Caps each user's banked charges. Matches the highest-tier capacity so a
// single max-tier purchase always succeeds; subsequent buys must wait until
// charges are spent.
const MAX_CHARGES = {
  daily: 7,
  weekly: 2,
};

async function purchaseProtection(user, body, rewardType) {
  if (!user || !user.userId) {
    return {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'User authentication required' },
    };
  }

  const userId = user.userId;
  const tierIndex = body?.tier ?? 0;

  if (!['daily', 'weekly'].includes(rewardType)) {
    return {
      success: false,
      error: { code: 'INVALID_TYPE', message: 'Invalid reward type. Must be daily or weekly.' },
    };
  }

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
  const maxCharges = MAX_CHARGES[rewardType];

  try {
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

    // Lazy migrate any legacy time-window protection to a single charge so
    // existing players don't lose what they paid for.
    let currentCharges = streakState.protectionCharges || 0;
    if (!currentCharges && streakState.protectionExpiry) {
      const expiryTime = new Date(streakState.protectionExpiry).getTime();
      if (expiryTime > Date.now()) {
        currentCharges = 1;
      }
    }

    const newCharges = currentCharges + tierConfig.charges;
    if (newCharges > maxCharges) {
      return {
        success: false,
        error: {
          code: 'CHARGES_FULL',
          message: `You already have ${currentCharges} ${rewardType} protection charge${currentCharges === 1 ? '' : 's'} (max ${maxCharges}). Use them before buying more.`,
          protectionCharges: currentCharges,
        },
      };
    }

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

    await updateItem(REWARDS_CLAIMS_TABLE, streakKey, {
      protectionCharges: newCharges,
      protectionTier: tierIndex,
      protectionPurchasedAt: new Date().toISOString(),
      // Clear any legacy expiry-based protection — charges replace it.
      protectionExpiry: null,
    });

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

    console.log(`[Protection] User ${userId} purchased ${rewardType} tier ${tierIndex}: +${tierConfig.charges} charges (now ${newCharges}/${maxCharges}) for ${tierConfig.cost} Essence.`);

    return {
      success: true,
      data: {
        rewardType,
        tier: tierIndex,
        cost: tierConfig.cost,
        chargesAdded: tierConfig.charges,
        protectionCharges: newCharges,
        maxCharges,
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

module.exports = { purchaseProtection, PROTECTION_TIERS, MAX_CHARGES };
