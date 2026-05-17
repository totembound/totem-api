/**
 * Shop Service
 *
 * Handles marketplace operations for TotemBound:
 * - Listing totems for sale (creates "Unbound" totems)
 * - Purchasing unbound totems from the marketplace
 * - Cancelling listings
 * - Querying available listings
 *
 * Fee Structure (matches TotemShop.sol + TotemGame.sol):
 * - Seller receives full calculated sell price: 300 + (stage * 30) + (rarityId * 20)
 * - Buyer pays sell price + 100 Essence purchase fee
 * - Initial totem purchase price: 500 Essence (from egg/shop)
 */

const { generateId } = require('../common/id-utils');
const {
  getItem,
  transactWrite,
  getUser,
  getTotem,
  updateUser,
  logTransaction,
  TABLES,
  userPK,
  totemSK,
  docClient,
} = require('../common/db-client');
const { QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { onTotemAcquired } = require('./achievements-service');
const { buildInitialTraits } = require('../config/traits');

// =============================================================================
// CONSTANTS
// =============================================================================

const SHOP_TABLE = TABLES.SHOP;

const SHOP_KEY_PREFIX = {
  UNBOUND: 'SHOP#UNBOUND',
  TOTEM: 'TOTEM#',
};

/**
 * Shop fees in Essence
 * - Buyer pays PURCHASE_FEE when buying an unbound totem
 */
const PURCHASE_FEE = 100;
const LISTING_FEE = 0;

/**
 * Calculate sell price based on totem's stage and rarity
 * Matches TotemHelpers.sol calculateSellPrice formula:
 *   baseValue = 300
 *   stageBonus = stage * 30
 *   rarityBonus = rarityId * 20
 *   sellPrice = 300 + (stage * 30) + (rarityId * 20)
 *
 * Rarity IDs: Common=0, Uncommon=1, Rare=2, Epic=3, Legendary=4, Limited=5
 * Stage: 0-4
 *
 * @param {number} stage - Totem stage (0-4)
 * @param {number} rarityId - Rarity ID (0-5)
 * @returns {number} - Calculated sell price in Essence
 */
function calculateSellPrice(stage, rarityId) {
  const baseValue = 300;
  const stageBonus = stage * 30;
  const rarityBonus = rarityId * 20;
  return baseValue + stageBonus + rarityBonus;
}

// =============================================================================
// KEY HELPERS
// =============================================================================

function shopUnboundPK() {
  return SHOP_KEY_PREFIX.UNBOUND;
}

function shopTotemSK(totemId) {
  return `${SHOP_KEY_PREFIX.TOTEM}${totemId}`;
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * List a totem for sale in the marketplace
 *
 * Process (matches TotemShop.sol + TotemGame.sol contract behavior):
 * 1. Verify user owns the totem
 * 2. Calculate sell price based on stage and rarity (server-side, not trusting frontend)
 * 3. Pay seller immediately: sellPrice (matches contract: totemToken.transfer(user, sellValue))
 * 4. Create shop listing with totem snapshot
 * 5. Remove totem from user's inventory
 *
 * @param {string} userId - User listing the totem
 * @param {string} totemId - Totem to list
 * @param {number} askingPrice - IGNORED: Price is now calculated server-side from stage/rarity
 * @returns {Promise<{ success: boolean, listing?: object, error?: string }>}
 */
async function listTotemForSale(userId, totemId, _askingPrice) {
  try {
    // Get user
    const user = await getUser(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Get totem and verify ownership
    const totem = await getTotem(userId, totemId);
    if (!totem) {
      return { success: false, error: 'Totem not found or not owned by user' };
    }

    // Calculate sell price server-side based on totem's stage and rarity
    // This matches TotemHelpers.calculateSellPrice in the contract
    const stage = totem.stage || 0;
    const rarityId = totem.rarityId || 0;
    const calculatedSellPrice = calculateSellPrice(stage, rarityId);

    // Seller receives the full calculated sell price (no listing fee)
    const currentBalance = user.currencies?.essence || 0;
    const newBalance = currentBalance + calculatedSellPrice;

    // Check if totem is already listed
    const existingListing = await getItem(SHOP_TABLE, {
      pk: shopUnboundPK(),
      sk: shopTotemSK(totemId),
    });

    if (existingListing && existingListing.status === 'active') {
      return { success: false, error: 'Totem is already listed for sale' };
    }

    const now = new Date().toISOString();
    const listingId = generateId('shopListing');

    // Create the shop listing with server-calculated price
    const listing = {
      pk: shopUnboundPK(),
      sk: shopTotemSK(totemId),
      id: listingId,
      totemId,
      originalOwnerId: userId,
      sellPrice: calculatedSellPrice, // Server-calculated, not from frontend
      listedAt: now,
      status: 'active',
      totemData: {
        speciesId: totem.speciesId,
        colorId: totem.colorId,
        rarityId: totem.rarityId,
        name: totem.name || totem.nickname,
        stage: totem.stage,
        experience: totem.experience,
        prestigeLevel: totem.prestigeLevel,
        stats: { ...totem.stats },
        traits: totem.traits ? { ...totem.traits } : null,
      },
      // GSI attributes
      speciesId: totem.speciesId,
      rarityId: totem.rarityId,
      createdAt: now,
      updatedAt: now,
    };

    // Execute transaction: pay seller, create listing, remove totem from inventory
    await transactWrite([
      {
        // Pay seller the calculated sell price
        Update: {
          TableName: TABLES.USERS,
          Key: { pk: userPK(userId), sk: 'PROFILE' },
          UpdateExpression: 'SET #currencies.#essence = :newBalance, #updatedAt = :now',
          ExpressionAttributeNames: {
            '#currencies': 'currencies',
            '#essence': 'essence',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':newBalance': newBalance,
            ':now': now,
          },
        },
      },
      {
        // Create shop listing
        Put: {
          TableName: SHOP_TABLE,
          Item: listing,
        },
      },
      {
        // Mark totem as listed (or delete from user's inventory)
        Delete: {
          TableName: TABLES.TOTEMS,
          Key: { pk: userPK(userId), sk: totemSK(totemId) },
        },
      },
    ]);

    // Log the sale transaction (seller receives full sell price)
    await logTransaction(userId, {
      type: 'shop_sale',
      currency: 'essence',
      amount: calculatedSellPrice,
      balanceBefore: currentBalance,
      balanceAfter: newBalance,
      refType: 'shop',
      ref: listingId,
      refName: totem.name || totem.nickname || 'Totem',
    });

    return {
      success: true,
      listing,
      sellPrice: calculatedSellPrice,
      newBalance,
    };
  }
  catch (error) {
    console.error('[Shop] Error listing totem:', error);
    return { success: false, error: error.message || 'Failed to list totem' };
  }
}

/**
 * Purchase an unbound totem from the marketplace
 *
 * Process:
 * 1. Verify listing exists and is active
 * 2. Calculate total cost (sellPrice + purchase fee)
 * 3. Deduct payment from buyer
 * 4. Credit seller (sellPrice only, they already paid listing fee)
 * 5. Transfer totem to buyer
 * 6. Mark listing as sold
 *
 * @param {string} buyerId - User purchasing the totem
 * @param {string} totemId - Totem to purchase
 * @returns {Promise<{ success: boolean, totem?: object, error?: string }>}
 */
async function purchaseUnboundTotem(buyerId, totemId) {
  try {
    // Get the listing
    const listing = await getItem(SHOP_TABLE, {
      pk: shopUnboundPK(),
      sk: shopTotemSK(totemId),
    });

    if (!listing) {
      return { success: false, error: 'Listing not found' };
    }

    if (listing.status !== 'active') {
      return { success: false, error: 'Listing is no longer available' };
    }

    // Note: Users CAN buy back totems they originally sold to the shop
    // The shop owns all unbound totems, so anyone can purchase them
    // Payment goes to the shop (removed from circulation), not to the original seller

    // Get buyer
    const buyer = await getUser(buyerId);
    if (!buyer) {
      return { success: false, error: 'Buyer not found' };
    }

    // Calculate costs
    const sellPrice = listing.sellPrice;
    const totalCost = sellPrice + PURCHASE_FEE;
    const buyerBalance = buyer.currencies?.essence || 0;

    if (buyerBalance < totalCost) {
      return {
        success: false,
        error: 'Insufficient Essence',
        required: totalCost,
        available: buyerBalance,
      };
    }

    const now = new Date().toISOString();
    const buyerNewBalance = buyerBalance - totalCost;

    // Recreate totem for buyer
    const totemRecord = {
      pk: userPK(buyerId),
      sk: totemSK(totemId),
      id: totemId,
      userId: buyerId,
      speciesId: listing.totemData.speciesId,
      colorId: listing.totemData.colorId,
      rarityId: listing.totemData.rarityId,
      name: listing.totemData.name,
      stage: listing.totemData.stage,
      experience: listing.totemData.experience,
      prestigeLevel: listing.totemData.prestigeLevel,
      stats: { ...listing.totemData.stats },
      cooldowns: { feed: null, train: null, treat: null },
      // Traits travel with the totem — they're identity, not seller-bound state.
      // Fallback to a fresh innate roll if the snapshot is pre-traits (legacy listing).
      traits: listing.totemData.traits
        ? { ...listing.totemData.traits }
        : buildInitialTraits(),
      createdAt: now,
      updatedAt: now,
    };

    // Execute transaction
    await transactWrite([
      {
        // Deduct from buyer (payment goes to the shop, not another user)
        Update: {
          TableName: TABLES.USERS,
          Key: { pk: userPK(buyerId), sk: 'PROFILE' },
          UpdateExpression: 'SET #currencies.#essence = :newBalance, #updatedAt = :now',
          ExpressionAttributeNames: {
            '#currencies': 'currencies',
            '#essence': 'essence',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':newBalance': buyerNewBalance,
            ':now': now,
          },
        },
      },
      {
        // Create totem for buyer
        Put: {
          TableName: TABLES.TOTEMS,
          Item: totemRecord,
        },
      },
      {
        // Mark listing as sold (with TTL for cleanup)
        // ConditionExpression prevents double-purchase race: if two buyers
        // read status='active' concurrently, only the first transactWrite
        // succeeds; the second fails because status is already 'sold'.
        Update: {
          TableName: SHOP_TABLE,
          Key: { pk: shopUnboundPK(), sk: shopTotemSK(totemId) },
          UpdateExpression: 'SET #status = :status, #soldTo = :buyerId, #soldAt = :now, #updatedAt = :now, #ttl = :ttl',
          ConditionExpression: '#status = :active',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#soldTo': 'soldTo',
            '#soldAt': 'soldAt',
            '#updatedAt': 'updatedAt',
            '#ttl': 'ttl',
          },
          ExpressionAttributeValues: {
            ':status': 'sold',
            ':active': 'active',
            ':buyerId': buyerId,
            ':now': now,
            ':ttl': Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
          },
        },
      },
    ]);

    // Log buyer transaction (shop purchase - payment goes to the shop)
    const itemName = listing.totemData.name || 'Totem';
    await logTransaction(buyerId, {
      type: 'shop_purchase',
      currency: 'essence',
      amount: -totalCost,
      balanceBefore: buyerBalance,
      balanceAfter: buyerNewBalance,
      refType: 'shop',
      ref: listing.id,
      refName: itemName,
      unitPrice: sellPrice,
      quantity: 1,
    });

    // Trigger achievement check for the new totem (same as egg purchase)
    let achievements = [];
    try {
      const { getUserTotems } = require('../common/db-client');
      const allTotems = await getUserTotems(buyerId);
      const totalTotemCount = allTotems.length;

      // Update stats.totalTotems
      await updateUser(buyerId, { 'stats.totalTotems': totalTotemCount });

      // Check collector progression + rarity achievements
      const achResults = await onTotemAcquired(buyerId, {
        rarityId: listing.totemData.rarityId,
        totalTotemCount,
        totemId,
        speciesId: listing.totemData.speciesId,
        colorId: listing.totemData.colorId,
        acquiredAt: new Date().toISOString(),
      });
      achievements = (achResults || []).filter(a => a.unlocked).map(a => ({
        achievementId: a.achievementId,
        milestone: a.milestone,
        rewards: a.rewards,
      }));
    }
    catch (achErr) {
      console.error('[Shop] Failed to process purchase achievements:', achErr.message);
    }

    return {
      success: true,
      totem: totemRecord,
      totalPaid: totalCost,
      purchaseFee: PURCHASE_FEE,
      newBalance: buyerNewBalance,
      achievements,
    };
  }
  catch (error) {
    // TransactionCanceledException means a ConditionExpression failed.
    // Most likely the listing was already sold by another buyer (race condition prevented).
    if (error.name === 'TransactionCanceledException') {
      console.warn(`[Shop] Transaction cancelled for totem ${totemId} — likely already sold`);
      return { success: false, error: 'This totem has already been sold' };
    }
    console.error('[Shop] Error purchasing totem:', error);
    return { success: false, error: error.message || 'Failed to purchase totem' };
  }
}

/**
 * Cancel an active listing
 *
 * Note: Listing fee is NOT refunded (as per contract rules)
 *
 * @param {string} userId - User cancelling the listing
 * @param {string} totemId - Totem listing to cancel
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function cancelListing(userId, totemId) {
  try {
    // Get the listing
    const listing = await getItem(SHOP_TABLE, {
      pk: shopUnboundPK(),
      sk: shopTotemSK(totemId),
    });

    if (!listing) {
      return { success: false, error: 'Listing not found' };
    }

    if (listing.status !== 'active') {
      return { success: false, error: 'Listing is no longer active' };
    }

    // Verify ownership
    if (listing.originalOwnerId !== userId) {
      return { success: false, error: 'Not authorized to cancel this listing' };
    }

    const now = new Date().toISOString();

    // Recreate totem for owner (restore to inventory)
    const totemRecord = {
      pk: userPK(userId),
      sk: totemSK(totemId),
      id: totemId,
      userId,
      speciesId: listing.totemData.speciesId,
      colorId: listing.totemData.colorId,
      rarityId: listing.totemData.rarityId,
      name: listing.totemData.name,
      stage: listing.totemData.stage,
      experience: listing.totemData.experience,
      prestigeLevel: listing.totemData.prestigeLevel,
      stats: { ...listing.totemData.stats },
      cooldowns: { feed: null, train: null, treat: null },
      // Preserve traits across unlist (or backfill if pre-traits listing).
      traits: listing.totemData.traits
        ? { ...listing.totemData.traits }
        : buildInitialTraits(),
      createdAt: now,
      updatedAt: now,
    };

    // Execute transaction
    await transactWrite([
      {
        // Restore totem to user's inventory
        Put: {
          TableName: TABLES.TOTEMS,
          Item: totemRecord,
        },
      },
      {
        // Mark listing as cancelled (with TTL for cleanup)
        Update: {
          TableName: SHOP_TABLE,
          Key: { pk: shopUnboundPK(), sk: shopTotemSK(totemId) },
          UpdateExpression: 'SET #status = :status, #cancelledAt = :now, #updatedAt = :now, #ttl = :ttl',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#cancelledAt': 'cancelledAt',
            '#updatedAt': 'updatedAt',
            '#ttl': 'ttl',
          },
          ExpressionAttributeValues: {
            ':status': 'cancelled',
            ':now': now,
            ':ttl': Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
          },
        },
      },
    ]);

    return {
      success: true,
      totem: totemRecord,
      message: 'Listing cancelled. Note: Listing fee is not refunded.',
    };
  }
  catch (error) {
    console.error('[Shop] Error cancelling listing:', error);
    return { success: false, error: error.message || 'Failed to cancel listing' };
  }
}

/**
 * Get all active unbound listings
 *
 * @param {object} filters - Filter options
 * @param {number} [filters.speciesId] - Filter by species
 * @param {number} [filters.rarityId] - Filter by rarity
 * @param {number} [filters.minPrice] - Minimum price
 * @param {number} [filters.maxPrice] - Maximum price
 * @param {number} [filters.minStage] - Minimum stage
 * @param {string} [filters.sortBy='listedAt'] - Sort field
 * @param {string} [filters.sortOrder='desc'] - Sort order
 * @param {number} [filters.limit=50] - Max results
 * @param {number} [filters.offset=0] - Pagination offset
 * @returns {Promise<{ success: boolean, listings?: array, total?: number }>}
 */
async function getUnboundListings(filters = {}) {
  try {
    const {
      speciesId,
      rarityId,
      minPrice,
      maxPrice,
      minStage,
      sortBy = 'listedAt',
      sortOrder = 'desc',
      limit = 50,
      offset = 0,
    } = filters;

    let items = [];

    // Use appropriate GSI based on filters
    if (speciesId !== undefined) {
      // Query by species
      const command = new QueryCommand({
        TableName: SHOP_TABLE,
        IndexName: 'species-index',
        KeyConditionExpression: '#speciesId = :speciesId',
        FilterExpression: '#status = :active',
        ExpressionAttributeNames: {
          '#speciesId': 'speciesId',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':speciesId': speciesId,
          ':active': 'active',
        },
        ScanIndexForward: sortOrder === 'asc',
      });
      const response = await docClient.send(command);
      items = response.Items || [];
    }
    else if (rarityId !== undefined) {
      // Query by rarity
      const command = new QueryCommand({
        TableName: SHOP_TABLE,
        IndexName: 'rarity-index',
        KeyConditionExpression: '#rarityId = :rarityId',
        FilterExpression: '#status = :active',
        ExpressionAttributeNames: {
          '#rarityId': 'rarityId',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':rarityId': rarityId,
          ':active': 'active',
        },
        ScanIndexForward: sortOrder === 'asc',
      });
      const response = await docClient.send(command);
      items = response.Items || [];
    }
    else {
      // Query all active listings
      const command = new QueryCommand({
        TableName: SHOP_TABLE,
        KeyConditionExpression: '#pk = :pk',
        FilterExpression: '#status = :active',
        ExpressionAttributeNames: {
          '#pk': 'pk',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':pk': shopUnboundPK(),
          ':active': 'active',
        },
      });
      const response = await docClient.send(command);
      items = response.Items || [];
    }

    // Apply additional filters
    let filtered = items;

    if (minPrice !== undefined) {
      filtered = filtered.filter(item => item.sellPrice >= minPrice);
    }

    if (maxPrice !== undefined) {
      filtered = filtered.filter(item => item.sellPrice <= maxPrice);
    }

    if (minStage !== undefined) {
      filtered = filtered.filter(item => item.totemData?.stage >= minStage);
    }

    // Sort
    const sortKey = sortBy === 'price' ? 'sellPrice' : sortBy;
    filtered.sort((a, b) => {
      const aVal = sortBy === 'stage' ? a.totemData?.stage : a[sortKey];
      const bVal = sortBy === 'stage' ? b.totemData?.stage : b[sortKey];

      if (sortOrder === 'asc') {
        return aVal > bVal ? 1 : -1;
      }
      return aVal < bVal ? 1 : -1;
    });

    // Paginate
    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      success: true,
      listings: paginated,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    };
  }
  catch (error) {
    console.error('[Shop] Error getting listings:', error);
    return { success: false, error: error.message || 'Failed to get listings' };
  }
}

/**
 * Get user's active listings
 *
 * @param {string} userId - User ID
 * @returns {Promise<{ success: boolean, listings?: array }>}
 */
async function getMyListings(userId) {
  try {
    const command = new QueryCommand({
      TableName: SHOP_TABLE,
      IndexName: 'seller-index',
      KeyConditionExpression: '#originalOwnerId = :userId',
      FilterExpression: '#status = :active',
      ExpressionAttributeNames: {
        '#originalOwnerId': 'originalOwnerId',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
        ':active': 'active',
      },
      ScanIndexForward: false, // Most recent first
    });

    const response = await docClient.send(command);

    return {
      success: true,
      listings: response.Items || [],
    };
  }
  catch (error) {
    console.error('[Shop] Error getting user listings:', error);
    return { success: false, error: error.message || 'Failed to get listings' };
  }
}

/**
 * Get a specific listing by totem ID
 *
 * @param {string} totemId - Totem ID
 * @returns {Promise<{ success: boolean, listing?: object }>}
 */
async function getListing(totemId) {
  try {
    const listing = await getItem(SHOP_TABLE, {
      pk: shopUnboundPK(),
      sk: shopTotemSK(totemId),
    });

    if (!listing) {
      return { success: false, error: 'Listing not found' };
    }

    return { success: true, listing };
  }
  catch (error) {
    console.error('[Shop] Error getting listing:', error);
    return { success: false, error: error.message || 'Failed to get listing' };
  }
}

/**
 * Get shop statistics
 *
 * @returns {Promise<object>}
 */
async function getShopStats() {
  try {
    // Scan for active listings count
    const command = new ScanCommand({
      TableName: SHOP_TABLE,
      FilterExpression: '#status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active' },
      Select: 'COUNT',
    });

    const response = await docClient.send(command);

    return {
      success: true,
      stats: {
        activeListings: response.Count || 0,
        listingFee: LISTING_FEE,
        purchaseFee: PURCHASE_FEE,
        totalFeePerTransaction: LISTING_FEE + PURCHASE_FEE,
      },
    };
  }
  catch (error) {
    console.error('[Shop] Error getting stats:', error);
    return { success: false, error: error.message };
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Constants
  SHOP_TABLE,
  PURCHASE_FEE,

  // Key helpers
  shopUnboundPK,
  shopTotemSK,

  // Price calculation (matches TotemHelpers.sol)
  calculateSellPrice,

  // Core operations
  listTotemForSale,
  purchaseUnboundTotem,
  cancelListing,

  // Query operations
  getUnboundListings,
  getMyListings,
  getListing,
  getShopStats,
};
