/**
 * Gem to Essence Exchange Handlers
 *
 * GET  /api/shop/exchange/bundles - List available exchange bundles
 * POST /api/shop/exchange         - Exchange gems for essence
 *
 * All rates are enforced by the backend - never trust frontend values.
 */

const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const shopConfig = require('../../data/shop-config.json');
const { docClient, TABLES, KEY_PREFIX, getUser, logTransaction } = require('../../common/db-client');

const userPK = (userId) => `${KEY_PREFIX.USER}${userId}`;

// Load exchange bundles from config (single source of truth)
const EXCHANGE_BUNDLES = shopConfig.essenceExchangeBundles || [];
const GEM_TO_ESSENCE_RATIO = shopConfig.conversionRate.gemToEssence || 5;

/**
 * Get exchange bundle by ID
 */
function getExchangeBundleById(bundleId) {
  return EXCHANGE_BUNDLES.find(b => b.id === bundleId && b.enabled) || null;
}

/**
 * Get available exchange bundles
 */
async function getExchangeBundles() {
  const enabledBundles = EXCHANGE_BUNDLES.filter(b => b.enabled);

  return {
    success: true,
    data: {
      bundles: enabledBundles.map(b => ({
        id: b.id,
        name: b.name,
        gemCost: b.gemCost,
        essenceAmount: b.essenceAmount,
        bonus: b.bonus,
        bonusNote: b.bonusNote,
      })),
      conversionRate: GEM_TO_ESSENCE_RATIO,
      conversionNote: `Base rate: 1 Gem = ${GEM_TO_ESSENCE_RATIO} Essence`,
    },
  };
}

/**
 * Exchange gems for essence
 * Backend validates all rates - never trust frontend values
 */
async function exchangeGemsForEssence(user, body) {
  const userId = user?.userId;
  const { bundleId } = body || {};

  if (!userId) {
    return {
      success: false,
      error: { code: 'MISSING_USER', message: 'User ID required' },
    };
  }

  if (!bundleId) {
    return {
      success: false,
      error: { code: 'MISSING_BUNDLE', message: 'Bundle ID required' },
    };
  }

  // Validate bundle exists and is enabled
  const bundle = getExchangeBundleById(bundleId);
  if (!bundle) {
    return {
      success: false,
      error: { code: 'INVALID_BUNDLE', message: 'Exchange bundle not found or disabled' },
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

  try {
    // Atomic single-row update: decrement gems AND increment essence in one operation.
    // ConditionExpression ensures gems >= cost, preventing double-spend.
    // No partial failure possible — both currency changes succeed or neither does.
    const command = new UpdateCommand({
      TableName: TABLES.USERS,
      Key: { pk: userPK(userId), sk: 'PROFILE' },
      UpdateExpression: 'SET currencies.gems = currencies.gems - :gemCost, currencies.essence = if_not_exists(currencies.essence, :zero) + :essenceAmount, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk) AND currencies.gems >= :gemCost',
      ExpressionAttributeValues: {
        ':gemCost': bundle.gemCost,
        ':essenceAmount': bundle.essenceAmount,
        ':zero': 0,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    });

    const response = await docClient.send(command);
    const attrs = response.Attributes;
    const newGemsBalance = attrs?.currencies?.gems || 0;
    const newEssenceBalance = attrs?.currencies?.essence || 0;

    // Log both transactions (non-critical — currency is already safe)
    const gemBalanceBefore = newGemsBalance + bundle.gemCost;
    const essBalanceBefore = newEssenceBalance - bundle.essenceAmount;
    await Promise.all([
      logTransaction(userId, {
        type: 'exchange_gems_to_essence',
        currency: 'gems',
        amount: -bundle.gemCost,
        balanceBefore: gemBalanceBefore,
        balanceAfter: newGemsBalance,
        ref: bundleId,
      }),
      logTransaction(userId, {
        type: 'exchange_gems_to_essence',
        currency: 'essence',
        amount: bundle.essenceAmount,
        balanceBefore: essBalanceBefore,
        balanceAfter: newEssenceBalance,
        ref: bundleId,
      }),
    ]);

    console.log(`[Exchange] User ${userId} exchanged ${bundle.gemCost} Gems for ${bundle.essenceAmount} Essence (bundle: ${bundleId})`);

    return {
      success: true,
      data: {
        bundleId: bundle.id,
        bundleName: bundle.name,
        gemsSpent: bundle.gemCost,
        essenceReceived: bundle.essenceAmount,
        bonus: bundle.bonus,
        newGemsBalance,
        newEssenceBalance,
      },
      message: `Exchanged ${bundle.gemCost.toLocaleString()} Gems for ${bundle.essenceAmount.toLocaleString()} Essence!`,
    };
  }
  catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
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
    console.error('[Exchange] Error:', error);
    return {
      success: false,
      error: {
        code: 'EXCHANGE_FAILED',
        message: error.message || 'Failed to complete exchange',
      },
    };
  }
}

module.exports = {
  getExchangeBundles,
  exchangeGemsForEssence,
  getExchangeBundleById,
  EXCHANGE_BUNDLES,
  GEM_TO_ESSENCE_RATIO,
};
