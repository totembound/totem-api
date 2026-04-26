/**
 * Loot Box Service
 *
 * Handles granting, listing, and claiming loot box items.
 * Uses the RewardState table with LOOT# SK prefix.
 */

const { generateId } = require('../common/id-utils');
const {
  putItem,
  queryItems,
  updateItem,
  addEssence,
  TABLES,
  userPK,
} = require('../common/db-client');
const { createTotem, selectColor, getSpecies, isSpeciesAvailable, RARITIES, getStageNameForSpecies } = require('./totem-creation');
const { onTotemAcquired } = require('./achievements-service');

// Load loot box definitions
const lootBoxConfig = require('../data/loot-boxes.json');

/**
 * Get a loot box definition by ID
 */
function getBoxDefinition(boxId) {
  return lootBoxConfig.boxes[boxId] || null;
}

/**
 * Get all loot box definitions
 */
function getAllBoxDefinitions() {
  return lootBoxConfig.boxes;
}

/**
 * Grant a loot item to a user
 * @param {string} userId - User to grant to
 * @param {string} boxId - Box type ID (e.g., 'uncommon_totem_box')
 * @param {string} source - How it was granted (e.g., 'signup', 'achievement', 'purchase')
 * @returns {object} The created loot item record
 */
async function grantLootItem(userId, boxId, source) {
  const boxDef = getBoxDefinition(boxId);
  if (!boxDef) {
    throw new Error(`Unknown loot box type: ${boxId}`);
  }

  const lootItemId = generateId('loot');
  const now = new Date().toISOString();

  const item = {
    pk: userPK(userId),
    sk: `LOOT#${lootItemId}`,
    id: lootItemId,
    userId,
    boxId,
    source,
    status: 'unclaimed',
    grantedAt: now,
    claimedAt: null,
    claimResult: null,
  };

  await putItem(TABLES.REWARD_STATE, item);

  return {
    id: lootItemId,
    boxId,
    source,
    status: 'unclaimed',
    grantedAt: now,
    box: boxDef,
  };
}

/**
 * Get all unclaimed loot items for a user
 * @param {string} userId
 * @returns {Array} Unclaimed loot items enriched with box definitions
 */
async function getUnclaimedLoot(userId) {
  const items = await queryItems(TABLES.REWARD_STATE, 'pk', userPK(userId), {
    skPrefix: 'LOOT#',
    filterExpression: '#status = :unclaimed',
    filterNames: { '#status': 'status' },
    filterValues: { ':unclaimed': 'unclaimed' },
  });

  // Enrich with box definitions
  return items.map((item) => ({
    id: item.id,
    boxId: item.boxId,
    source: item.source,
    status: item.status,
    grantedAt: item.grantedAt,
    box: getBoxDefinition(item.boxId),
  }));
}

/**
 * Claim/open a loot item
 * @param {string} userId
 * @param {string} lootItemId - The specific loot instance ID
 * @param {object} options - User choices (e.g., { speciesId: 2 })
 * @returns {object} Claim result
 */
async function claimLootItem(userId, lootItemId, options = {}) {
  // Fetch the loot item
  const items = await queryItems(TABLES.REWARD_STATE, 'pk', userPK(userId), {
    skPrefix: `LOOT#${lootItemId}`,
  });

  const lootItem = items[0];
  if (!lootItem) {
    throw new Error('Loot item not found');
  }

  if (lootItem.status !== 'unclaimed') {
    throw new Error('Loot item already claimed');
  }

  const boxDef = getBoxDefinition(lootItem.boxId);
  if (!boxDef) {
    throw new Error('Unknown loot box type');
  }

  // SECURITY: Atomically reserve the claim BEFORE creating rewards.
  // ConditionExpression ensures only one concurrent request can succeed.
  // This prevents replay attacks and double-claim race conditions.
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  const { docClient } = require('../common/db-client');
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.REWARD_STATE,
      Key: { pk: userPK(userId), sk: `LOOT#${lootItemId}` },
      UpdateExpression: 'SET #status = :claiming, updatedAt = :now',
      ConditionExpression: '#status = :unclaimed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':claiming': 'claiming',
        ':unclaimed': 'unclaimed',
        ':now': new Date().toISOString(),
      },
    }));
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      throw new Error('Loot item already claimed');
    }
    throw err;
  }

  // Now create the rewards — only one request can reach here per loot item
  let claimResult;
  try {
    if (boxDef.type === 'totem_box') {
      claimResult = await claimTotemBox(userId, boxDef, options);
    }
    else if (boxDef.type === 'essence_box') {
      claimResult = await claimEssenceBox(userId, boxDef);
    }
    else {
      throw new Error(`Unknown box type: ${boxDef.type}`);
    }
  }
  catch (err) {
    // Reward creation failed — revert claim status so user can retry
    await updateItem(
      TABLES.REWARD_STATE,
      { pk: userPK(userId), sk: `LOOT#${lootItemId}` },
      { status: 'unclaimed' }
    );
    throw err;
  }

  // Finalize the claim with result data
  await updateItem(
    TABLES.REWARD_STATE,
    { pk: userPK(userId), sk: `LOOT#${lootItemId}` },
    {
      status: 'claimed',
      claimedAt: new Date().toISOString(),
      claimResult: JSON.stringify(claimResult),
    }
  );

  return {
    lootItemId,
    boxId: lootItem.boxId,
    boxName: boxDef.name,
    type: boxDef.type,
    result: claimResult,
  };
}

/**
 * Claim a totem box - creates a totem with user-chosen species + random color
 */
async function claimTotemBox(userId, boxDef, options) {
  const { speciesId } = options;
  const rarityId = boxDef.config.rarityId;

  // Validate species choice
  if (speciesId === undefined || speciesId === null) {
    throw new Error('Species selection required for totem boxes');
  }

  if (!isSpeciesAvailable(speciesId)) {
    throw new Error('Selected species is not available');
  }

  const species = getSpecies(speciesId);
  if (!species) {
    throw new Error('Invalid species');
  }

  // Create totem with forced rarity and chosen species (color is random for that rarity)
  const rarity = RARITIES[rarityId];
  const color = selectColor(rarityId);
  const totem = createTotem({
    userId,
    speciesId,
    luckBonus: 0,
  });

  // Override rarity to match the box's guaranteed rarity
  totem.rarityId = rarityId;
  totem.colorId = color.colorId;

  // Recalculate stats with correct rarity bonus
  const statBonus = rarity?.statBonus || 0;
  totem.stats.strength = species.baseStats.strength + statBonus;
  totem.stats.agility = species.baseStats.agility + statBonus;
  totem.stats.wisdom = species.baseStats.wisdom + statBonus;

  // Save the totem
  const { putItem: putTotem, TABLES: tables } = require('../common/db-client');
  await putTotem(tables.TOTEMS, totem);

  // Update user's totalTotems stat and fire achievement
  const { updateUser } = require('../common/db-client');
  let totalTotemCount = 1;
  try {
    const { getUser } = require('../common/db-client');
    const user = await getUser(userId);
    const currentTotal = user?.stats?.totalTotems || 0;
    totalTotemCount = currentTotal + 1;
    await updateUser(userId, {
      'stats.totalTotems': totalTotemCount,
    });
  }
  catch (err) {
    console.warn('Failed to update totalTotems:', err.message);
  }

  // Fire achievement hook and capture results
  let achievements = [];
  try {
    const achResults = await onTotemAcquired(userId, {
      rarityId: totem.rarityId,
      totalTotemCount,
      totemId: totem.id,
      speciesId: totem.speciesId,
      colorId: totem.colorId,
      acquiredAt: totem.createdAt,
    });
    achievements = (achResults || []).filter(a => a.unlocked).map(a => ({
      achievementId: a.achievementId,
      milestone: a.milestone,
      rewards: a.rewards,
    }));
  }
  catch (err) {
    console.error('Loot claim achievement error:', err);
  }

  return {
    type: 'totem',
    totem: {
      id: totem.id,
      speciesId: totem.speciesId,
      speciesName: species.speciesName,
      colorId: totem.colorId,
      colorName: color.colorName,
      rarityId: totem.rarityId,
      rarityName: rarity?.name || 'Unknown',
      stage: 0,
      stageName: getStageNameForSpecies(speciesId, 0),
      experience: 0,
      stats: totem.stats,
    },
    achievements,
  };
}

/**
 * Claim an essence box - awards random essence amount
 */
async function claimEssenceBox(userId, boxDef) {
  const { minAmount, maxAmount } = boxDef.config;
  const amount = Math.floor(Math.random() * (maxAmount - minAmount + 1)) + minAmount;

  const result = await addEssence(userId, amount, {
    type: 'loot_claim',
    ref: boxDef.id,
  });

  if (!result.success) {
    throw new Error('Failed to add essence: ' + result.error);
  }

  return {
    type: 'essence',
    amount,
    newBalance: result.newBalance,
  };
}

module.exports = {
  grantLootItem,
  getUnclaimedLoot,
  claimLootItem,
  getBoxDefinition,
  getAllBoxDefinitions,
};
