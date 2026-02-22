/**
 * Special Offer Bundle Purchase Handler
 *
 * POST /api/shop/bundles/purchase
 *
 * Purchases a special offer bundle that includes:
 * - Gems deduction
 * - Essence reward
 * - A new totem with rarity based on bundle type
 *
 * Request body:
 * {
 *   bundleId: number  // 0-3 (index into specialOfferBundles array)
 * }
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     bundle: { ... },           // Bundle details
 *     totem: { ... },            // Created totem data
 *     gemsSpent: number,
 *     essenceReceived: number,
 *     newGemsBalance: number,
 *     newEssenceBalance: number
 *   }
 * }
 */

const { generateId } = require('../../common/id-utils');
const shopConfig = require('../../data/shop-config.json');
const {
  getUser,
  logTransaction,
  transactWrite,
  TABLES,
  KEY_PREFIX,
  getBundlePurchasesToday,
  getUserTotems,
} = require('../../common/db-client');

const userPK = (userId) => `${KEY_PREFIX.USER}${userId}`;

const {
  selectRandomSpecies,
  selectColor,
  calculateInitialStats,
  SPECIES,
} = require('../../services/totem-creation');

const { onTotemAcquired } = require('../../services/achievements-service');

const { getTotemImageUrl } = require('../../config/totem-config');

// Load special offer bundles from config
const SPECIAL_OFFER_BUNDLES = shopConfig.specialOfferBundles || [];

// Load limited totem series for monthly specials
const LIMITED_TOTEM_SERIES = shopConfig.limitedTotemSeries?.series || [];

/**
 * Get current month's limited series totem config.
 * Matches by calendar month name (e.g. "March"). Series rotate annually —
 * each month's special returns every year with no deploy needed.
 * @returns {Object|null} Monthly series config or null if none for this month
 */
function getCurrentMonthlySpecial() {
  const now = new Date();
  const monthName = now.toLocaleString('en-US', { month: 'long' });
  return LIMITED_TOTEM_SERIES.find(s => s.month === monthName) || null;
}

/**
 * Map bundle totemRarity to rarityId
 * - "common" = rarityId 0
 * - "uncommon" = rarityId 1
 * - "rare" = rarityId 2
 * - "epic" = rarityId 3
 * - "legendary" = rarityId 4
 * - "exclusive" / "limited" = rarityId 5
 */
function getRarityIdFromBundleRarity(totemRarity) {
  switch (totemRarity) {
    case 'common':
      return 0;
    case 'uncommon':
      return 1;
    case 'rare':
      return 2;
    case 'epic':
      return 3;
    case 'legendary':
      return 4;
    case 'exclusive':
    case 'limited':
      return 5;
    default:
      return 1; // Default to uncommon
  }
}

/**
 * Get rarity stat bonus
 */
function getRarityStatBonus(rarityId) {
  const bonuses = [0, 0, 1, 2, 4, 2]; // Common, Uncommon, Rare, Epic, Legendary, Limited
  return bonuses[rarityId] || 0;
}

/**
 * Get rarity name
 */
function getRarityName(rarityId) {
  const names = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Limited'];
  return names[rarityId] || 'Common';
}

/**
 * Get bundle by bundleId
 */
function getBundleByBundleId(bundleId) {
  return SPECIAL_OFFER_BUNDLES.find(b => b.bundleId === bundleId && b.enabled) || null;
}

/**
 * Get available special offer bundles
 */
async function getSpecialOfferBundles() {
  const enabledBundles = SPECIAL_OFFER_BUNDLES.filter(b => b.enabled);

  return {
    success: true,
    data: {
      bundles: enabledBundles.map(b => ({
        id: b.id,
        bundleId: b.bundleId,
        name: b.name,
        description: b.description,
        gemCost: b.gemCost,
        priceUsd: b.priceUsd,
        essence: b.essence,
        includesTotem: b.includesTotem,
        totemRarity: b.totemRarity,
        dailyLimit: b.dailyLimit,
        category: b.category,
      })),
    },
  };
}

/**
 * Purchase a special offer bundle
 *
 * @param {Object} user - Authenticated user from JWT middleware
 * @param {Object} body - Request body
 * @param {number} body.bundleId - Bundle ID (0-3)
 * @returns {Object} Purchase result with bundle, totem, and balance info
 */
async function purchaseBundle(user, body = {}) {
  const userId = user?.userId;
  const { bundleId } = body;

  // Validate user
  if (!userId) {
    return {
      success: false,
      error: { code: 'MISSING_USER', message: 'User ID required' },
    };
  }

  // Validate bundleId
  if (bundleId === undefined || bundleId === null) {
    return {
      success: false,
      error: { code: 'MISSING_BUNDLE_ID', message: 'Bundle ID required' },
    };
  }

  if (typeof bundleId !== 'number' || bundleId < 0 || bundleId > 3) {
    return {
      success: false,
      error: { code: 'INVALID_BUNDLE_ID', message: 'Bundle ID must be 0-3' },
    };
  }

  // Get bundle config
  const bundle = getBundleByBundleId(bundleId);
  if (!bundle) {
    return {
      success: false,
      error: { code: 'BUNDLE_NOT_FOUND', message: 'Bundle not found or not available' },
    };
  }

  // Get current user to check gem balance
  const currentUser = await getUser(userId);
  if (!currentUser) {
    return {
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    };
  }

  const currentGems = currentUser.currencies?.gems || 0;

  // Check if user has enough gems
  if (currentGems < bundle.gemCost) {
    return {
      success: false,
      error: {
        code: 'INSUFFICIENT_GEMS',
        message: `Not enough Gems. Need ${bundle.gemCost}, have ${currentGems}.`,
        required: bundle.gemCost,
        available: currentGems,
      },
    };
  }

  // Check daily limit
  if (bundle.dailyLimit) {
    const purchasesToday = await getBundlePurchasesToday(userId, bundle.id);
    if (purchasesToday >= bundle.dailyLimit) {
      return {
        success: false,
        error: {
          code: 'DAILY_LIMIT_REACHED',
          message: `Daily limit of ${bundle.dailyLimit} reached for this bundle`,
          limit: bundle.dailyLimit,
          purchased: purchasesToday,
        },
      };
    }
  }

  try {
    // 1. Determine totem species/color/rarity (pure computation, no DB)
    let speciesId, colorId, rarityId;

    // For monthly special (bundleId 3), use the specific species/color from config
    if (bundleId === 3) {
      const monthlySpecial = getCurrentMonthlySpecial();
      if (!monthlySpecial) {
        return {
          success: false,
          error: {
            code: 'MONTHLY_SPECIAL_NOT_AVAILABLE',
            message: 'No monthly special is available for the current month',
          },
        };
      }
      speciesId = monthlySpecial.species;
      colorId = monthlySpecial.color;
      rarityId = monthlySpecial.rarity; // Usually 5 (Limited)
      console.log(`[PurchaseBundle] Monthly special: ${monthlySpecial.name} (species: ${speciesId}, color: ${colorId})`);
    }
    else {
      // Regular bundles: use random species with rarity-based color
      rarityId = getRarityIdFromBundleRarity(bundle.totemRarity);
      const species = selectRandomSpecies();
      speciesId = species.speciesId;
      colorId = selectColor(rarityId).colorId;
    }

    // Get species data for stats
    const speciesData = SPECIES[speciesId] || SPECIES[0];
    const statBonus = getRarityStatBonus(rarityId);
    const stats = calculateInitialStats(speciesData.baseStats, statBonus);

    const totemId = generateId('totem');
    const now = new Date().toISOString();

    const totemData = {
      pk: `USER#${userId}`,
      sk: `TOTEM#${totemId}`,
      id: totemId,
      userId,
      speciesId,
      colorId,
      rarityId,
      nickname: null,
      stage: 0,
      experience: 0,
      prestigeLevel: 0,
      stats,
      cooldowns: {
        feed: null,
        train: null,
        treat: null,
      },
      source: 'bundle_purchase',
      bundleId: bundle.id,
      createdAt: now,
      updatedAt: now,
    };

    // 2. Atomic transaction: deduct gems + add essence + create totem
    // All three succeed or none do — no partial state possible.
    await transactWrite([
      {
        // Deduct gems and add essence in a single user-row update
        Update: {
          TableName: TABLES.USERS,
          Key: { pk: userPK(userId), sk: 'PROFILE' },
          UpdateExpression: 'SET currencies.gems = currencies.gems - :gemCost, currencies.essence = if_not_exists(currencies.essence, :zero) + :essenceAmount, updatedAt = :now',
          ConditionExpression: 'attribute_exists(pk) AND currencies.gems >= :gemCost',
          ExpressionAttributeValues: {
            ':gemCost': bundle.gemCost,
            ':essenceAmount': bundle.essence,
            ':zero': 0,
            ':now': now,
          },
        },
      },
      {
        // Create the totem
        Put: {
          TableName: TABLES.TOTEMS,
          Item: totemData,
        },
      },
    ]);

    // Read updated balances (transactWrite doesn't return values)
    const updatedUser = await getUser(userId);
    const newGemsBalance = updatedUser?.currencies?.gems || 0;
    const newEssenceBalance = updatedUser?.currencies?.essence || 0;

    // Log transactions (non-critical — currency is already safe)
    await Promise.all([
      logTransaction(userId, {
        type: 'purchase_bundle',
        currency: 'gems',
        amount: -bundle.gemCost,
        balanceBefore: newGemsBalance + bundle.gemCost,
        balanceAfter: newGemsBalance,
        ref: bundle.id,
      }),
      logTransaction(userId, {
        type: 'bundle_reward',
        currency: 'essence',
        amount: bundle.essence,
        balanceBefore: newEssenceBalance - bundle.essence,
        balanceAfter: newEssenceBalance,
        ref: bundle.id,
      }),
    ]);

    console.log(`[PurchaseBundle] User ${userId} purchased bundle ${bundle.id}: ${bundle.gemCost} Gems spent, ${bundle.essence} Essence received, Totem ${totemId} created (rarity: ${getRarityName(rarityId)})`);

    // Get total totem count for achievements
    let totalTotemCount = 1;
    try {
      const allTotems = await getUserTotems(userId);
      totalTotemCount = allTotems.length;
    }
    catch (err) {
      console.warn('[PurchaseBundle] Failed to get totem count for achievements:', err.message);
    }

    // Trigger achievement check (non-blocking)
    let achievements = [];
    try {
      const achResults = await onTotemAcquired(userId, {
        rarityId,
        totalTotemCount,
        totemId,
      });
      achievements = achResults.filter(a => a.unlocked);
      if (achievements.length > 0) {
        console.log(`[PurchaseBundle] User ${userId} unlocked ${achievements.length} achievement(s)`);
      }
    }
    catch (err) {
      console.error('[PurchaseBundle] Failed to process achievements:', err.message);
    }

    // Build response
    return {
      success: true,
      data: {
        bundle: {
          id: bundle.id,
          bundleId: bundle.bundleId,
          name: bundle.name,
          description: bundle.description,
        },
        totem: {
          id: totemData.id,
          speciesId: totemData.speciesId,
          speciesName: SPECIES[totemData.speciesId]?.name || 'Unknown',
          colorId: totemData.colorId,
          rarityId: totemData.rarityId,
          rarityName: getRarityName(totemData.rarityId),
          stage: totemData.stage,
          experience: totemData.experience,
          stats: totemData.stats,
          image: getTotemImageUrl(totemData.speciesId, totemData.colorId, 0),
          createdAt: totemData.createdAt,
        },
        gemsSpent: bundle.gemCost,
        essenceReceived: bundle.essence,
        newGemsBalance,
        newEssenceBalance,
        achievements: achievements.map(a => ({
          achievementId: a.achievementId,
          milestone: a.milestone,
          rewards: a.rewards,
        })),
      },
      message: `Successfully purchased ${bundle.name}! You received ${bundle.essence.toLocaleString()} Essence and a ${getRarityName(rarityId)} totem!`,
    };
  }
  catch (error) {
    // TransactionCanceledException means ConditionExpression failed (insufficient gems)
    if (error.name === 'TransactionCanceledException') {
      const user = await getUser(userId);
      const available = user?.currencies?.gems || 0;
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_GEMS',
          message: `Not enough Gems. Need ${bundle.gemCost}, have ${available}.`,
          required: bundle.gemCost,
          available,
        },
      };
    }
    console.error('[PurchaseBundle] Error:', error);
    return {
      success: false,
      error: {
        code: 'PURCHASE_FAILED',
        message: error.message || 'Failed to complete bundle purchase',
      },
    };
  }
}

module.exports = {
  purchaseBundle,
  getSpecialOfferBundles,
  getBundleByBundleId,
  SPECIAL_OFFER_BUNDLES,
};
