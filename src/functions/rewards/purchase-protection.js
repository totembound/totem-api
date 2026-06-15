/**
 * Purchase Protection Handler
 *
 * POST /v1/rewards/:type/protection
 *
 * Streak protection is a consumable-charge model: each charge is spent only
 * when a streak would actually reset (no expiry). Players buy charges to TOP UP
 * toward a per-type holding cap, so they can refill after spending some without
 * having to drain to zero first.
 *
 * Pricing is per-charge, with a bulk discount for buying a full daily week:
 *   Daily:  50 Essence/charge, cap 7, requires 7-day streak. Full 7-pack: 250.
 *   Weekly: 250 Essence/charge, cap 2, requires 4-week streak.
 *
 * Request body: { quantity } — number of charges to add. Omitted/null means
 * "fill to the cap" (buy exactly the remaining headroom).
 */

const { getItem, updateItem, TABLES } = require('../../common/db-client');
const { deductEssence } = require('../../common/db-client');

const REWARDS_CLAIMS_TABLE = TABLES.REWARDS_CLAIMS;

const PROTECTION_CONFIG = {
  daily: {
    costPerCharge: 50,
    maxCharges: 7,
    requiredStreak: 7,
    // Buying a full week of cover in one purchase is discounted.
    bulk: { quantity: 7, cost: 250 },
  },
  weekly: {
    costPerCharge: 250,
    maxCharges: 2,
    requiredStreak: 4,
  },
};

// Cost to add `quantity` charges, applying a full-pack bulk discount if it
// exactly matches the configured bulk quantity.
function chargeCost(config, quantity) {
  if (config.bulk && quantity === config.bulk.quantity) {
    return config.bulk.cost;
  }
  return quantity * config.costPerCharge;
}

async function purchaseProtection(user, body, rewardType) {
  if (!user || !user.userId) {
    return {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'User authentication required' },
    };
  }

  const userId = user.userId;

  if (!['daily', 'weekly'].includes(rewardType)) {
    return {
      success: false,
      error: { code: 'INVALID_TYPE', message: 'Invalid reward type. Must be daily or weekly.' },
    };
  }

  const config = PROTECTION_CONFIG[rewardType];
  const unit = rewardType === 'daily' ? 'day' : 'week';

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
    if (currentStreak < config.requiredStreak) {
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_STREAK',
          message: `Requires ${config.requiredStreak}-${unit} streak. Current: ${currentStreak}.`,
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

    const headroom = config.maxCharges - currentCharges;
    if (headroom <= 0) {
      return {
        success: false,
        error: {
          code: 'CHARGES_FULL',
          message: `Streak Saver is full (${currentCharges}/${config.maxCharges}). Use a charge before buying more.`,
          protectionCharges: currentCharges,
          maxCharges: config.maxCharges,
        },
      };
    }

    // No explicit quantity → top all the way up to the cap.
    const requested = body?.quantity ?? headroom;
    const quantity = Math.floor(Number(requested));
    if (!Number.isInteger(quantity) || quantity < 1) {
      return {
        success: false,
        error: { code: 'INVALID_QUANTITY', message: 'Quantity must be a positive whole number.' },
      };
    }
    if (quantity > headroom) {
      return {
        success: false,
        error: {
          code: 'EXCEEDS_CAP',
          message: `Can only add ${headroom} more charge${headroom === 1 ? '' : 's'} (cap ${config.maxCharges}, have ${currentCharges}).`,
          protectionCharges: currentCharges,
          maxCharges: config.maxCharges,
          available: headroom,
        },
      };
    }

    const cost = chargeCost(config, quantity);
    const deductResult = await deductEssence(userId, cost, {
      type: 'protection_purchase',
      ref: `${rewardType}_x${quantity}`,
      refType: 'protection',
      refName: `${rewardType === 'daily' ? 'Daily' : 'Weekly'} Protection (x${quantity})`,
    });

    if (!deductResult.success) {
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_ESSENCE',
          message: `Not enough Essence. Need ${cost}, have ${deductResult.currentBalance || 0}.`,
        },
      };
    }

    const newCharges = currentCharges + quantity;
    await updateItem(REWARDS_CLAIMS_TABLE, streakKey, {
      protectionCharges: newCharges,
      protectionPurchasedAt: new Date().toISOString(),
      // Charges replace any legacy expiry-window protection.
      protectionExpiry: null,
    });

    console.log(`[Protection] User ${userId} bought ${rewardType} x${quantity} (now ${newCharges}/${config.maxCharges}) for ${cost} Essence.`);

    return {
      success: true,
      data: {
        rewardType,
        chargesAdded: quantity,
        cost,
        protectionCharges: newCharges,
        maxCharges: config.maxCharges,
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

module.exports = { purchaseProtection, PROTECTION_CONFIG };
