/**
 * Loot Box API Handlers
 *
 * GET  /v1/loot/items - List unclaimed loot items for current user
 * POST /v1/loot/claim - Claim/open a loot item
 */

const { getUnclaimedLoot, claimLootItem } = require('../../services/loot-service');

/**
 * GET /v1/loot/items
 * Returns all unclaimed loot items for the authenticated user
 */
async function getLootItems(user) {
  const items = await getUnclaimedLoot(user.userId);

  return {
    success: true,
    data: {
      items,
      count: items.length,
    },
  };
}

/**
 * POST /v1/loot/claim
 * Claim/open a loot item with optional user choices
 *
 * Body: { lootItemId: string, options?: { speciesId?: number } }
 */
async function claimLoot(user, body) {
  const { lootItemId, options } = body;

  if (!lootItemId) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'lootItemId is required' },
    };
  }

  try {
    const result = await claimLootItem(user.userId, lootItemId, options || {});

    return {
      success: true,
      data: result,
    };
  }
  catch (err) {
    return {
      success: false,
      error: { code: 'CLAIM_FAILED', message: err.message },
    };
  }
}

module.exports = {
  getLootItems,
  claimLoot,
};
