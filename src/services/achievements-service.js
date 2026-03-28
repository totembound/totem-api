/**
 * Achievements Service
 *
 * Handles achievement progress tracking, milestone unlocking, and reward distribution.
 * Called from various backend hooks (signup, game actions, etc.)
 *
 * Rewards:
 * - Essence rewards are logged with type 'reward_achievement'
 * - XP rewards update the totem's experience if totemId is provided
 * - All rewards are logged in the transactions table for audit
 *
 * Usage:
 *   const { checkAchievement } = require('./services/achievements/achievements-service');
 *   await checkAchievement(userId, 'ACTION_TRAIN', { count: newTrainCount, totemId: 'ttm_123' });
 */

const {
  getItem,
  putItem,
  updateItem,
  queryItems,
  getTotem,
  updateTotem,
  addEssence,
  logTransaction,
  TABLES,
} = require('../common/db-client');

// =============================================================================
// ACHIEVEMENT IDS (must match schema)
// =============================================================================

const ACHIEVEMENT_IDS = {
  RARE_COLLECTOR: 'ach_rare-collector',
  EPIC_COLLECTOR: 'ach_epic-collector',
  LEGENDARY_COLLECTOR: 'ach_legendary-collector',
  COLLECTOR_PROGRESSION: 'ach_collector-progression',
  EVOLUTION_PROGRESSION: 'ach_evolution-progression',
  LOGIN_PROGRESSION: 'ach_login-progression',
  FEED_PROGRESSION: 'ach_feed-progression',
  TRAIN_PROGRESSION: 'ach_train-progression',
  TREAT_PROGRESSION: 'ach_treat-progression',
  CHALLENGE_INITIATE: 'ach_challenge-initiate',
  CHALLENGE_PROGRESSION: 'ach_challenge-progression',
  EXPEDITION_EXPLORER: 'ach_expedition-explorer',
  EXPEDITION_PROGRESSION: 'ach_expedition-progression',
  FUSION_PROGRESSION: 'ach_fusion-progression',
  PURE_FUSION: 'ach_pure-fusion',
  WILD_FUSION: 'ach_wild-fusion',
  RARE_FORGER: 'ach_rare-forger',
  EPIC_FORGER: 'ach_epic-forger',
  LEGENDARY_FORGER: 'ach_legendary-forger',
};

// =============================================================================
// TRIGGER -> ACHIEVEMENTS MAPPING
// =============================================================================

const TRIGGER_TO_ACHIEVEMENTS = {
  USER_SIGNUP: [ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION],
  TOTEM_ACQUIRED: [
    ACHIEVEMENT_IDS.RARE_COLLECTOR,
    ACHIEVEMENT_IDS.EPIC_COLLECTOR,
    ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR,
    ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION,
  ],
  TOTEM_EVOLVED: [ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION],
  ACTION_FEED: [ACHIEVEMENT_IDS.FEED_PROGRESSION],
  ACTION_TRAIN: [ACHIEVEMENT_IDS.TRAIN_PROGRESSION],
  ACTION_TREAT: [ACHIEVEMENT_IDS.TREAT_PROGRESSION],
  LOGIN_STREAK: [ACHIEVEMENT_IDS.LOGIN_PROGRESSION],
  CHALLENGE_COMPLETED: [
    ACHIEVEMENT_IDS.CHALLENGE_INITIATE,
    ACHIEVEMENT_IDS.CHALLENGE_PROGRESSION,
  ],
  EXPEDITION_COMPLETED: [
    ACHIEVEMENT_IDS.EXPEDITION_EXPLORER,
    ACHIEVEMENT_IDS.EXPEDITION_PROGRESSION,
  ],
  TOTEM_FUSED: [
    ACHIEVEMENT_IDS.FUSION_PROGRESSION,
    ACHIEVEMENT_IDS.PURE_FUSION,
    ACHIEVEMENT_IDS.WILD_FUSION,
    ACHIEVEMENT_IDS.RARE_FORGER,
    ACHIEVEMENT_IDS.EPIC_FORGER,
    ACHIEVEMENT_IDS.LEGENDARY_FORGER,
    ACHIEVEMENT_IDS.RARE_COLLECTOR,
    ACHIEVEMENT_IDS.EPIC_COLLECTOR,
    ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR,
    ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION,
  ],
};

// =============================================================================
// MILESTONE THRESHOLDS
// =============================================================================

const ACHIEVEMENT_MILESTONES = {
  [ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION]: [1, 3, 6, 12, 32, 64, 128, 256],
  [ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION]: [1, 2, 3, 4],
  [ACHIEVEMENT_IDS.LOGIN_PROGRESSION]: [7, 30, 90, 180, 365],
  [ACHIEVEMENT_IDS.FEED_PROGRESSION]: [100, 500, 1000, 5000, 10000],
  [ACHIEVEMENT_IDS.TRAIN_PROGRESSION]: [100, 500, 1000, 5000, 10000],
  [ACHIEVEMENT_IDS.TREAT_PROGRESSION]: [100, 500, 1000, 5000, 10000],
  [ACHIEVEMENT_IDS.CHALLENGE_PROGRESSION]: [10, 100, 1000, 5000, 10000],
  [ACHIEVEMENT_IDS.EXPEDITION_PROGRESSION]: [10, 50, 250, 1000, 10000],
  [ACHIEVEMENT_IDS.FUSION_PROGRESSION]: [1, 5, 10, 25, 50, 100, 250],
  [ACHIEVEMENT_IDS.PURE_FUSION]: [1, 3, 5, 10, 25],
  [ACHIEVEMENT_IDS.WILD_FUSION]: [1, 3, 5, 10, 25],
};

const ONETIME_ACHIEVEMENTS = [
  ACHIEVEMENT_IDS.RARE_COLLECTOR,
  ACHIEVEMENT_IDS.EPIC_COLLECTOR,
  ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR,
  ACHIEVEMENT_IDS.CHALLENGE_INITIATE,
  ACHIEVEMENT_IDS.EXPEDITION_EXPLORER,
  ACHIEVEMENT_IDS.RARE_FORGER,
  ACHIEVEMENT_IDS.EPIC_FORGER,
  ACHIEVEMENT_IDS.LEGENDARY_FORGER,
];

// Rarity IDs (from totem data)
const RARITY = {
  COMMON: 0,
  UNCOMMON: 1,
  RARE: 2,
  EPIC: 3,
  LEGENDARY: 4,
  LIMITED: 5,
};

// =============================================================================
// ACHIEVEMENT REWARDS CONFIGURATION
// Synced with frontend - achievements grant Essence and/or XP
// =============================================================================

/**
 * Reward configuration for one-time achievements
 * { achievementId: { essence: number, xp: number, name: string } }
 */
const ONE_TIME_REWARDS = {
  [ACHIEVEMENT_IDS.RARE_COLLECTOR]: {
    essence: 50,
    xp: 50,
    name: 'Rare Collector',
  },
  [ACHIEVEMENT_IDS.EPIC_COLLECTOR]: {
    essence: 100,
    xp: 100,
    name: 'Epic Collector',
  },
  [ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR]: {
    essence: 250,
    xp: 150,
    name: 'Legendary Collector',
  },
  [ACHIEVEMENT_IDS.CHALLENGE_INITIATE]: {
    essence: 25,
    xp: 50,
    name: 'Challenge Initiate',
  },
  [ACHIEVEMENT_IDS.EXPEDITION_EXPLORER]: {
    essence: 25,
    xp: 50,
    name: 'Expedition Explorer',
  },
  [ACHIEVEMENT_IDS.RARE_FORGER]: {
    essence: 200,
    xp: 75,
    name: 'Rare Forger',
  },
  [ACHIEVEMENT_IDS.EPIC_FORGER]: {
    essence: 500,
    xp: 100,
    name: 'Epic Forger',
  },
  [ACHIEVEMENT_IDS.LEGENDARY_FORGER]: {
    essence: 1000,
    xp: 150,
    name: 'Legendary Forger',
  },
};

/**
 * Milestone rewards for progression achievements
 * { achievementId: [{ essence, xp, name }, ...] }
 * Index corresponds to milestone index
 */
const MILESTONE_REWARDS = {
  [ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION]: [
    { essence: 10, xp: 0, name: 'Chosen Keeper' },         // 1 totem
    { essence: 25, xp: 0, name: 'Novice Curator' },        // 3 totems
    { essence: 50, xp: 0, name: 'Dedicated Keeper' },      // 6 totems
    { essence: 100, xp: 0, name: 'Established Guardian' }, // 12 totems
    { essence: 150, xp: 0, name: 'Master Curator' },       // 32 totems
    { essence: 200, xp: 0, name: 'Arcane Librarian' },     // 64 totems
    { essence: 300, xp: 0, name: 'Ethereal Archivist' },   // 128 totems
    { essence: 500, xp: 0, name: 'Legendary Sage' },       // 256 totems
  ],
  [ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION]: [
    { essence: 25, xp: 25, name: 'First Evolution' },      // Stage 1
    { essence: 50, xp: 50, name: 'Adept Evolution' },      // Stage 2
    { essence: 100, xp: 75, name: 'Master Evolution' },    // Stage 3
    { essence: 200, xp: 100, name: 'Elder Evolution' },    // Stage 4
  ],
  [ACHIEVEMENT_IDS.LOGIN_PROGRESSION]: [
    { essence: 50, xp: 0, name: 'Week Warrior' },          // 7 days
    { essence: 100, xp: 0, name: 'Monthly Master' },       // 30 days
    { essence: 200, xp: 0, name: 'Seasonal Spirit' },      // 90 days
    { essence: 300, xp: 0, name: 'Seasonal Guardian' },    // 180 days
    { essence: 500, xp: 0, name: 'Eternal Spirit Keeper' },// 365 days
  ],
  [ACHIEVEMENT_IDS.FEED_PROGRESSION]: [
    { essence: 25, xp: 25, name: 'Caring Keeper' },        // 100 feeds
    { essence: 50, xp: 50, name: 'Diligent Caretaker' },   // 500 feeds
    { essence: 100, xp: 75, name: 'Devoted Guardian' },    // 1000 feeds
    { essence: 200, xp: 150, name: 'Everlasting Nurturer' }, // 5000 feeds
    { essence: 400, xp: 200, name: 'Eternal Provider' },   // 10000 feeds
  ],
  [ACHIEVEMENT_IDS.TRAIN_PROGRESSION]: [
    { essence: 25, xp: 25, name: 'Aspiring Trainer' },     // 100 trains
    { essence: 50, xp: 50, name: 'Skilled Instructor' },   // 500 trains
    { essence: 100, xp: 75, name: 'Master Mentor' },       // 1000 trains
    { essence: 200, xp: 150, name: 'Legendary Sensei' },   // 5000 trains
    { essence: 400, xp: 200, name: 'Totem Whisperer' },    // 10000 trains
  ],
  [ACHIEVEMENT_IDS.TREAT_PROGRESSION]: [
    { essence: 25, xp: 25, name: 'Gentle Healer' },        // 100 treats
    { essence: 50, xp: 50, name: 'Soothing Spirit' },      // 500 treats
    { essence: 100, xp: 75, name: 'Compassionate Guardian' }, // 1000 treats
    { essence: 200, xp: 150, name: 'Blessed Medic' },      // 5000 treats
    { essence: 400, xp: 200, name: 'Divine Healer' },      // 10000 treats
  ],
  [ACHIEVEMENT_IDS.CHALLENGE_PROGRESSION]: [
    { essence: 25, xp: 50, name: 'Challenge Seeker' },     // 10 challenges
    { essence: 75, xp: 75, name: 'Challenge Apprentice' }, // 100 challenges
    { essence: 150, xp: 150, name: 'Challenge Adept' },    // 1000 challenges
    { essence: 300, xp: 200, name: 'Challenge Expert' },   // 5000 challenges
    { essence: 500, xp: 400, name: 'Challenge Master' },   // 10000 challenges
  ],
  [ACHIEVEMENT_IDS.EXPEDITION_PROGRESSION]: [
    { essence: 25, xp: 50, name: 'Expedition Seeker' },    // 10 expeditions
    { essence: 50, xp: 75, name: 'Expedition Scout' },     // 50 expeditions
    { essence: 100, xp: 100, name: 'Expedition Pathfinder' }, // 250 expeditions
    { essence: 200, xp: 200, name: 'Expedition Explorer' }, // 1000 expeditions
    { essence: 500, xp: 400, name: 'Expedition Legend' },   // 10000 expeditions
  ],
  [ACHIEVEMENT_IDS.FUSION_PROGRESSION]: [
    { essence: 100, xp: 50, name: 'First Forge' },           // 1 fusion
    { essence: 250, xp: 75, name: 'Apprentice Smith' },      // 5 fusions
    { essence: 500, xp: 100, name: 'Journeyman Forger' },    // 10 fusions
    { essence: 1000, xp: 150, name: 'Master Forger' },       // 25 fusions
    { essence: 2500, xp: 200, name: 'Legendary Smith' },     // 50 fusions
    { essence: 5000, xp: 250, name: 'Eternal Artisan' },     // 100 fusions
    { essence: 10000, xp: 250, name: 'Forge Transcendent' }, // 250 fusions
  ],
  [ACHIEVEMENT_IDS.PURE_FUSION]: [
    { essence: 150, xp: 50, name: 'Purebred' },              // 1 pure fusion
    { essence: 300, xp: 75, name: 'Species Master' },        // 3 pure fusions
    { essence: 750, xp: 100, name: 'Bloodline Keeper' },     // 5 pure fusions
    { essence: 1500, xp: 150, name: 'Lineage Guardian' },    // 10 pure fusions
    { essence: 3000, xp: 200, name: 'Ancestral Forger' },    // 25 pure fusions
  ],
  [ACHIEVEMENT_IDS.WILD_FUSION]: [
    { essence: 150, xp: 50, name: 'First Experiment' },      // 1 wild fusion
    { essence: 300, xp: 75, name: 'Chaos Mixer' },           // 3 wild fusions
    { essence: 750, xp: 100, name: 'Wild Alchemist' },       // 5 wild fusions
    { essence: 1500, xp: 150, name: 'Entropy Weaver' },      // 10 wild fusions
    { essence: 3000, xp: 200, name: 'Primordial Shaper' },   // 25 wild fusions
  ],
};

// =============================================================================
// KEY HELPERS
// =============================================================================

function achievementPK(userId) {
  return `USER#${userId}`;
}

function achievementSK(achievementId) {
  return `ACH#${achievementId}`;
}

// =============================================================================
// REWARD DISTRIBUTION FUNCTIONS
// =============================================================================

/**
 * Get reward configuration for an achievement
 * @param {string} achievementId - Achievement ID
 * @param {number|null} milestoneIndex - Milestone index (null for one-time)
 * @returns {{ essence: number, xp: number, name: string } | null}
 */
function getRewardConfig(achievementId, milestoneIndex = null) {
  // One-time achievement reward
  if (milestoneIndex === null) {
    return ONE_TIME_REWARDS[achievementId] || null;
  }

  // Milestone reward
  const milestoneRewards = MILESTONE_REWARDS[achievementId];
  if (!milestoneRewards || milestoneIndex >= milestoneRewards.length) {
    return null;
  }

  return milestoneRewards[milestoneIndex];
}

/**
 * Distribute achievement rewards (Essence and/or XP)
 *
 * @param {string} userId - User ID
 * @param {string} achievementId - Achievement ID
 * @param {string} rewardName - Reward/milestone name
 * @param {number} essenceReward - Essence amount to award
 * @param {number} xpReward - XP amount to award
 * @param {string|null} totemId - Optional totem ID for XP rewards
 * @param {number|null} milestoneIndex - Milestone index (for logging)
 * @returns {Promise<{ essence: number, xp: number, newEssenceBalance?: number, newTotemExp?: number }>}
 */
async function distributeAchievementReward(userId, achievementId, rewardName, essenceReward, xpReward, totemId = null, milestoneIndex = null) {
  const rewards = { essence: 0, xp: 0 };

  // Award Essence if > 0
  if (essenceReward > 0) {
    try {
      const refSuffix = milestoneIndex !== null ? `_m${milestoneIndex}` : '';
      const result = await addEssence(userId, essenceReward, {
        type: 'reward_achievement',
        ref: `${achievementId}${refSuffix}`,
        refType: 'achievement',
        refName: rewardName,
      });

      if (result.success) {
        rewards.essence = essenceReward;
        rewards.newEssenceBalance = result.newBalance;
        console.log(`[Achievement] Awarded ${essenceReward} Essence to ${userId} for "${rewardName}"`);
      }
      else {
        console.error(`[Achievement] Failed to award Essence for ${achievementId}:`, result.error);
      }
    }
    catch (err) {
      console.error(`[Achievement] Error awarding Essence for ${achievementId}:`, err.message);
    }
  }

  // Award XP to totem if > 0 and totemId provided
  if (xpReward > 0 && totemId) {
    try {
      const totem = await getTotem(userId, totemId);
      if (totem) {
        const currentExp = totem.experience || 0;
        const newExp = currentExp + xpReward;
        await updateTotem(userId, totemId, { experience: newExp });

        rewards.xp = xpReward;
        rewards.newTotemExp = newExp;

        // Log XP transaction for audit
        await logTransaction(userId, {
          type: 'reward_achievement_xp',
          currency: 'xp',
          amount: xpReward,
          balanceBefore: currentExp,
          balanceAfter: newExp,
          ref: achievementId,
          refType: 'achievement',
          refName: `${rewardName} (XP)`,
        });

        console.log(`[Achievement] Awarded ${xpReward} XP to totem ${totemId} for "${rewardName}"`);
      }
      else {
        console.warn(`[Achievement] Totem ${totemId} not found for XP reward`);
      }
    }
    catch (err) {
      console.error(`[Achievement] Error awarding XP for ${achievementId}:`, err.message);
    }
  }

  return rewards;
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Get user's progress for a specific achievement
 */
async function getAchievementProgress(userId, achievementId) {
  return getItem(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId),
    sk: achievementSK(achievementId),
  });
}

/**
 * Get all achievement progress for a user
 */
async function getAllAchievementProgress(userId) {
  return queryItems(TABLES.ACHIEVEMENT_PROGRESS, 'pk', achievementPK(userId), {
    skPrefix: 'ACH#',
  });
}

/**
 * Initialize or update achievement progress
 */
async function updateAchievementProgress(userId, achievementId, newValue, metadata = {}) {
  const now = new Date().toISOString();
  const existing = await getAchievementProgress(userId, achievementId);

  if (!existing) {
    // Create new progress record
    const record = {
      pk: achievementPK(userId),
      sk: achievementSK(achievementId),
      odUserId: userId,
      achievementId,
      currentValue: newValue,
      milestoneIndex: -1,
      isComplete: false,
      lastUpdatedAt: now,
      milestones: [],
    };

    await putItem(TABLES.ACHIEVEMENT_PROGRESS, record);
    return record;
  }

  // Update existing
  return updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId),
    sk: achievementSK(achievementId),
  }, {
    currentValue: newValue,
    lastUpdatedAt: now,
    ...metadata,
  });
}

/**
 * Check and potentially unlock achievement milestones
 * Distributes Essence and XP rewards when milestones are unlocked.
 *
 * @param {string} userId - User ID
 * @param {string} achievementId - Achievement ID to check
 * @param {number} currentValue - Current progress value
 * @param {string|null} totemId - Optional totem ID for XP rewards
 * @returns {Promise<{ unlocked: boolean, milestone?: number, achievementId: string, rewards?: object }>}
 */
async function checkAndUnlockMilestone(userId, achievementId, currentValue, totemId = null) {
  console.log(`[Achievement] checkAndUnlockMilestone: achievementId=${achievementId}, currentValue=${currentValue}`);
  const milestones = ACHIEVEMENT_MILESTONES[achievementId];
  const isOneTime = ONETIME_ACHIEVEMENTS.includes(achievementId);
  const now = new Date().toISOString();

  let progress = await getAchievementProgress(userId, achievementId);

  // Initialize if doesn't exist
  if (!progress) {
    progress = {
      pk: achievementPK(userId),
      sk: achievementSK(achievementId),
      odUserId: userId,
      achievementId,
      currentValue: 0,
      milestoneIndex: -1,
      isComplete: false,
      lastUpdatedAt: now,
      milestones: [],
    };
    await putItem(TABLES.ACHIEVEMENT_PROGRESS, progress);
  }

  // Already complete (for one-time achievements)
  if (isOneTime && progress.isComplete) {
    return { unlocked: false, achievementId };
  }

  const result = { unlocked: false, achievementId, newMilestones: [], rewards: { essence: 0, xp: 0 } };

  if (isOneTime) {
    // One-time achievement - just mark complete
    if (currentValue >= 1) {
      await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
        pk: achievementPK(userId),
        sk: achievementSK(achievementId),
      }, {
        currentValue: 1,
        isComplete: true,
        unlockedAt: now,
        lastUpdatedAt: now,
      });

      result.unlocked = true;
      result.milestone = 0;

      // Distribute one-time achievement reward
      const rewardConfig = getRewardConfig(achievementId, null);
      if (rewardConfig) {
        const rewardResult = await distributeAchievementReward(
          userId,
          achievementId,
          rewardConfig.name,
          rewardConfig.essence,
          rewardConfig.xp,
          totemId,
          null
        );
        result.rewards = rewardResult;
      }
    }
  }
  else if (milestones) {
    // Progression achievement - check milestones
    const currentMilestoneIndex = progress.milestoneIndex;
    const existingMilestones = progress.milestones || [];

    for (let i = currentMilestoneIndex + 1; i < milestones.length; i++) {
      if (currentValue >= milestones[i]) {
        // Unlocked new milestone!
        existingMilestones.push({ index: i, unlockedAt: now });
        result.newMilestones.push(i);
        result.unlocked = true;

        // Distribute milestone reward
        const rewardConfig = getRewardConfig(achievementId, i);
        if (rewardConfig) {
          const rewardResult = await distributeAchievementReward(
            userId,
            achievementId,
            rewardConfig.name,
            rewardConfig.essence,
            rewardConfig.xp,
            totemId,
            i
          );

          // Accumulate rewards
          result.rewards.essence += rewardResult.essence;
          result.rewards.xp += rewardResult.xp;
          if (rewardResult.newEssenceBalance !== undefined) {
            result.rewards.newEssenceBalance = rewardResult.newEssenceBalance;
          }
          if (rewardResult.newTotemExp !== undefined) {
            result.rewards.newTotemExp = rewardResult.newTotemExp;
          }
        }
      }
      else {
        break; // No more milestones to unlock
      }
    }

    if (result.unlocked) {
      // Set milestone to latest unlocked index for consistent frontend consumption
      if (result.newMilestones.length > 0) {
        result.milestone = result.newMilestones[result.newMilestones.length - 1];
      }

      const newMilestoneIndex = existingMilestones.length > 0
        ? Math.max(...existingMilestones.map(m => m.index))
        : -1;

      await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
        pk: achievementPK(userId),
        sk: achievementSK(achievementId),
      }, {
        currentValue,
        milestoneIndex: newMilestoneIndex,
        milestones: existingMilestones,
        unlockedAt: progress.unlockedAt || now,
        lastUpdatedAt: now,
      });
    }
    else {
      // Just update the value
      console.log(`[Achievement] No new milestones, updating currentValue to ${currentValue} for ${achievementId}`);
      await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
        pk: achievementPK(userId),
        sk: achievementSK(achievementId),
      }, {
        currentValue,
        lastUpdatedAt: now,
      });
    }
  }

  return result;
}

// =============================================================================
// MAIN TRIGGER FUNCTION - Call this from backend hooks
// =============================================================================

/**
 * Check achievements based on a trigger event
 *
 * Automatically distributes Essence and XP rewards when achievements/milestones unlock.
 * Pass totemId in data to enable XP rewards for the totem.
 *
 * @param {string} userId - User ID
 * @param {string} trigger - Trigger event type
 * @param {object} data - Event-specific data
 * @param {string} [data.totemId] - Optional totem ID for XP rewards
 * @returns {Promise<Array>} - Array of unlocked achievements/milestones with rewards
 *
 * Usage examples:
 *   await checkAchievement(userId, 'USER_SIGNUP', { totemCount: 1 });
 *   await checkAchievement(userId, 'ACTION_TRAIN', { totalTrainCount: 150, totemId: 'ttm_123' });
 *   await checkAchievement(userId, 'TOTEM_ACQUIRED', { rarityId: 2, totemCount: 5, totemId: 'ttm_456' });
 *   await checkAchievement(userId, 'LOGIN_STREAK', { streak: 7 });
 */
async function checkAchievement(userId, trigger, data = {}) {
  const achievementIds = TRIGGER_TO_ACHIEVEMENTS[trigger];
  if (!achievementIds) {
    console.warn(`Unknown achievement trigger: ${trigger}`);
    return [];
  }

  const results = [];
  const totemId = data.totemId || null;

  for (const achievementId of achievementIds) {
    try {
      let value = 0;

      // Determine the value based on trigger type
      switch (trigger) {
        case 'USER_SIGNUP':
        case 'TOTEM_ACQUIRED':
          // Check rarity-specific achievements
          if (achievementId === ACHIEVEMENT_IDS.RARE_COLLECTOR && data.rarityId === RARITY.RARE) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.EPIC_COLLECTOR && data.rarityId === RARITY.EPIC) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR && data.rarityId === RARITY.LEGENDARY) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION) {
            value = data.totemCount || 1;
          }
          break;

        case 'TOTEM_EVOLVED':
          value = data.newStage || data.evolutionCount || 0;
          break;

        case 'ACTION_FEED':
          value = data.totalFeedCount || 0;
          break;

        case 'ACTION_TRAIN':
          value = data.totalTrainCount || 0;
          break;

        case 'ACTION_TREAT':
          value = data.totalTreatCount || 0;
          break;

        case 'LOGIN_STREAK':
          value = data.streak || 0;
          break;

        case 'CHALLENGE_COMPLETED':
          if (achievementId === ACHIEVEMENT_IDS.CHALLENGE_INITIATE) {
            value = 1; // First challenge = complete
          }
          else {
            value = data.totalChallengeCount || 0;
          }
          break;

        case 'EXPEDITION_COMPLETED':
          if (achievementId === ACHIEVEMENT_IDS.EXPEDITION_EXPLORER) {
            value = 1; // First expedition = complete
          }
          else {
            value = data.totalExpeditionCount || 0;
          }
          break;

        case 'TOTEM_FUSED':
          if (achievementId === ACHIEVEMENT_IDS.FUSION_PROGRESSION) {
            value = data.totalFusionCount || 0;
          }
          else if (achievementId === ACHIEVEMENT_IDS.PURE_FUSION) {
            value = data.isPureFusion ? (data.totalPureFusionCount || 0) : 0;
          }
          else if (achievementId === ACHIEVEMENT_IDS.WILD_FUSION) {
            value = !data.isPureFusion ? (data.totalWildFusionCount || 0) : 0;
          }
          else if (achievementId === ACHIEVEMENT_IDS.RARE_FORGER && data.newRarityId === RARITY.RARE) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.EPIC_FORGER && data.newRarityId === RARITY.EPIC) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.LEGENDARY_FORGER && data.newRarityId === RARITY.LEGENDARY) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.RARE_COLLECTOR && data.newRarityId === RARITY.RARE) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.EPIC_COLLECTOR && data.newRarityId === RARITY.EPIC) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR && data.newRarityId === RARITY.LEGENDARY) {
            value = 1;
          }
          else if (achievementId === ACHIEVEMENT_IDS.COLLECTOR_PROGRESSION) {
            value = data.totemCount || 0;
          }
          break;

        default:
          value = data.value || 0;
      }

      if (value > 0) {
        const result = await checkAndUnlockMilestone(userId, achievementId, value, totemId);
        if (result.unlocked) {
          results.push(result);
          const rewardInfo = result.rewards && (result.rewards.essence > 0 || result.rewards.xp > 0)
            ? ` (+${result.rewards.essence} Essence, +${result.rewards.xp} XP)`
            : '';
          console.log(`[Achievement] User ${userId} unlocked: ${achievementId}${rewardInfo}`, result.newMilestones);
        }
      }
    }
    catch (err) {
      console.error(`[Achievement] Error checking ${achievementId} for ${userId}:`, err.message);
    }
  }

  return results;
}

// =============================================================================
// CONVENIENCE HELPERS - For common triggers
// =============================================================================

/**
 * Call on user signup (after creating user + starter totem)
 * @param {string} userId - User ID
 * @param {string} [totemId] - Optional starter totem ID for XP rewards
 */
async function onUserSignup(userId, totemId = null) {
  return checkAchievement(userId, 'USER_SIGNUP', { totemCount: 1, totemId });
}

/**
 * Call when user acquires a new totem
 * @param {string} userId - User ID
 * @param {object} options - Options object
 * @param {number} options.rarityId - Totem rarity ID (0-5)
 * @param {number} options.totalTotemCount - Total totems owned by user
 * @param {string} [options.totemId] - The new totem's ID for XP rewards
 */
async function onTotemAcquired(userId, { rarityId, totalTotemCount, totemId = null }) {
  return checkAchievement(userId, 'TOTEM_ACQUIRED', {
    rarityId,
    totemCount: totalTotemCount,
    totemId,
  });
}

/**
 * Call when a totem evolves
 * @param {string} userId - User ID
 * @param {object} options - Options object
 * @param {number} options.newStage - The new evolution stage (1-4)
 * @param {string} [options.totemId] - Totem ID for XP rewards
 */
async function onTotemEvolved(userId, { newStage, totemId = null }) {
  return checkAchievement(userId, 'TOTEM_EVOLVED', { newStage, totemId });
}

/**
 * Call after a game action (feed/train/treat)
 * @param {string} userId - User ID
 * @param {string} actionType - Action type ('feed', 'train', 'treat')
 * @param {number} totalCount - Total count of this action type
 * @param {string} [totemId] - Totem ID for XP rewards
 */
async function onGameAction(userId, actionType, totalCount, totemId = null) {
  const triggerMap = {
    feed: 'ACTION_FEED',
    train: 'ACTION_TRAIN',
    treat: 'ACTION_TREAT',
  };
  const trigger = triggerMap[actionType];
  if (!trigger) return [];

  const dataKey = `total${actionType.charAt(0).toUpperCase() + actionType.slice(1)}Count`;
  return checkAchievement(userId, trigger, { [dataKey]: totalCount, totemId });
}

/**
 * Call on daily login (with current streak)
 * @param {string} userId - User ID
 * @param {number} streak - Current login streak
 * @param {string} [totemId] - Optional totem ID for XP rewards
 */
async function onLoginStreak(userId, streak, totemId = null) {
  return checkAchievement(userId, 'LOGIN_STREAK', { streak, totemId });
}

/**
 * Call when a challenge is completed
 * @param {string} userId - User ID
 * @param {number} totalChallengeCount - Total challenges completed
 * @param {string} [totemId] - Totem ID used for the challenge (for XP rewards)
 */
async function onChallengeCompleted(userId, totalChallengeCount, totemId = null) {
  return checkAchievement(userId, 'CHALLENGE_COMPLETED', { totalChallengeCount, totemId });
}

/**
 * Call when an expedition is completed
 * @param {string} userId - User ID
 * @param {number} totalExpeditionCount - Total expeditions completed
 * @param {string} [totemId] - Totem ID used for the expedition (for XP rewards)
 */
async function onExpeditionCompleted(userId, totalExpeditionCount, totemId = null) {
  return checkAchievement(userId, 'EXPEDITION_COMPLETED', { totalExpeditionCount, totemId });
}

/**
 * Call when totems are fused in the Forge
 * @param {string} userId - User ID
 * @param {object} options - Options
 * @param {boolean} options.isPureFusion - Whether this was a same-species fusion
 * @param {number} options.newRarityId - Rarity of the resulting totem
 * @param {number} options.totalFusionCount - Total fusions performed by user
 * @param {number} options.totalPureFusionCount - Total pure fusions performed by user
 * @param {number} options.totalWildFusionCount - Total wild fusions performed by user
 * @param {number} options.totalTotemCount - Total totems owned after fusion
 * @param {string} [options.totemId] - New totem ID for XP rewards
 */
async function onTotemFused(userId, { isPureFusion, newRarityId, totalFusionCount, totalPureFusionCount, totalWildFusionCount, totalTotemCount, totemId = null }) {
  return checkAchievement(userId, 'TOTEM_FUSED', {
    isPureFusion,
    newRarityId,
    totalFusionCount,
    totalPureFusionCount,
    totalWildFusionCount,
    totemCount: totalTotemCount,
    totemId,
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Constants
  ACHIEVEMENT_IDS,
  ACHIEVEMENT_MILESTONES,
  ONETIME_ACHIEVEMENTS,

  // Reward configuration
  ONE_TIME_REWARDS,
  MILESTONE_REWARDS,

  // Core functions
  getAchievementProgress,
  getAllAchievementProgress,
  updateAchievementProgress,
  checkAndUnlockMilestone,

  // Reward functions
  getRewardConfig,
  distributeAchievementReward,

  // Main trigger function
  checkAchievement,

  // Convenience helpers
  onUserSignup,
  onTotemAcquired,
  onTotemEvolved,
  onGameAction,
  onLoginStreak,
  onChallengeCompleted,
  onExpeditionCompleted,
  onTotemFused,
};
