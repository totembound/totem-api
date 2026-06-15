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
  rawUpdate,
  queryItems,
  getTotem,
  updateTotem,
  addEssence,
  logTransaction,
  TABLES,
} = require('../common/db-client');
const { getAffinity, getDomain } = require('./species-data');

// Total counts for set-based one-time achievements.
const TOTAL_AFFINITIES = 3;  // Strength, Agility, Wisdom
const TOTAL_DOMAINS = 3;     // Earth, Water, Air
const TOTAL_SPECIES = 12;    // species ids 0..11
const TOTAL_COLORS = 28;     // colorIds 0..27 (see COLOR_NAMES in totem-app/utils/species.ts)

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
  // Challenge Mastery — total tiers earned across all challenges (category 4)
  CHALLENGE_MASTERY: 'ach_challenge-mastery',
  CHALLENGE_GOLD: 'ach_challenge-gold',
  CHALLENGE_GRANDMASTER: 'ach_challenge-grandmaster',
  EXPEDITION_EXPLORER: 'ach_expedition-explorer',
  EXPEDITION_PROGRESSION: 'ach_expedition-progression',
  FUSION_PROGRESSION: 'ach_fusion-progression',
  PURE_FUSION: 'ach_pure-fusion',
  WILD_FUSION: 'ach_wild-fusion',
  RARE_FORGER: 'ach_rare-forger',
  EPIC_FORGER: 'ach_epic-forger',
  LEGENDARY_FORGER: 'ach_legendary-forger',
  FIRST_ELDER: 'ach_first-elder',
  FULL_COUNCIL: 'ach_full-council',
  SANCTUM_CLAIM: 'ach_sanctum-claim',
  TENURE_MASTER: 'ach_tenure-master',
  COUNCIL_MISSIONS: 'ach_council-missions',
  FOUNDING_RITUAL: 'ach_founding-ritual',
  // Batch 1
  RARE_EVOLUTION: 'ach_rare-evolution',
  EPIC_EVOLUTION: 'ach_epic-evolution',
  LEGENDARY_EVOLUTION: 'ach_legendary-evolution',
  BALANCED_CARE: 'ach_balanced-care',
  ANTI_META_COLLECTOR: 'ach_anti-meta-collector',
  MIXED_AFFINITY_EVOLUTION: 'ach_mixed-affinity-evolution',
  // Batch 2 — TOTEM_ACQUIRED-driven affinity/domain/species achievements
  AFFINITY_SPECIALIST: 'ach_affinity-specialist',
  AFFINITY_DIVERSITY: 'ach_affinity-diversity',
  DOMAIN_SPECIALIST: 'ach_domain-specialist',
  DOMAIN_DIVERSITY: 'ach_domain-diversity',
  SPECIES_MASTERY: 'ach_species-mastery',
  // Batch 3 (selected) — Chromatic Mastery + Seasonal Spirit Keeper
  COLOR_COLLECTOR_EVOLUTION: 'ach_color-collector-evolution',
  SEASONAL_COLLECTOR: 'ach_seasonal-collector',
  // Batch 3 — login + persistence (driven by daily-login event in auth handler)
  PERSISTENCE_REWARD: 'ach_persistence-reward',
  // Batch 3 — prestige (driven by XP threshold crossings via totem-xp chokepoint)
  PRESTIGE_PROGRESSION: 'ach_prestige-progression',
  // Daily Quests — fires from daily-quests-service batchClaim
  QUEST_SET_MASTER: 'ach_quest-set-master',
  THEME_MASTER: 'ach_theme-master',
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
    // Batch 2 — handled by post-loop atomic helpers (route through but value=0)
    ACHIEVEMENT_IDS.AFFINITY_SPECIALIST,
    ACHIEVEMENT_IDS.AFFINITY_DIVERSITY,
    ACHIEVEMENT_IDS.DOMAIN_SPECIALIST,
    ACHIEVEMENT_IDS.DOMAIN_DIVERSITY,
    ACHIEVEMENT_IDS.SPECIES_MASTERY,
    // Batch 3 (selected)
    ACHIEVEMENT_IDS.SEASONAL_COLLECTOR,
  ],
  TOTEM_EVOLVED: [
    ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION,
    ACHIEVEMENT_IDS.RARE_EVOLUTION,
    ACHIEVEMENT_IDS.EPIC_EVOLUTION,
    ACHIEVEMENT_IDS.LEGENDARY_EVOLUTION,
    ACHIEVEMENT_IDS.ANTI_META_COLLECTOR,
    ACHIEVEMENT_IDS.MIXED_AFFINITY_EVOLUTION,
    ACHIEVEMENT_IDS.COLOR_COLLECTOR_EVOLUTION,
  ],
  ACTION_FEED: [ACHIEVEMENT_IDS.FEED_PROGRESSION],
  ACTION_TRAIN: [ACHIEVEMENT_IDS.TRAIN_PROGRESSION],
  ACTION_TREAT: [ACHIEVEMENT_IDS.TREAT_PROGRESSION],
  LOGIN_STREAK: [ACHIEVEMENT_IDS.LOGIN_PROGRESSION],
  PERSISTENCE_CHECK: [ACHIEVEMENT_IDS.PERSISTENCE_REWARD],
  CHALLENGE_COMPLETED: [
    ACHIEVEMENT_IDS.CHALLENGE_INITIATE,
    ACHIEVEMENT_IDS.CHALLENGE_PROGRESSION,
  ],
  CHALLENGE_TIER_REACHED: [
    ACHIEVEMENT_IDS.CHALLENGE_MASTERY,
    ACHIEVEMENT_IDS.CHALLENGE_GOLD,
    ACHIEVEMENT_IDS.CHALLENGE_GRANDMASTER,
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
  ELDER_SEATED: [ACHIEVEMENT_IDS.FIRST_ELDER, ACHIEVEMENT_IDS.FULL_COUNCIL],
  SANCTUM_CLAIMED: [ACHIEVEMENT_IDS.SANCTUM_CLAIM],
  TENURE_CHECK: [ACHIEVEMENT_IDS.TENURE_MASTER],
  TOTEM_PRESTIGED: [ACHIEVEMENT_IDS.PRESTIGE_PROGRESSION],
  MISSION_COMPLETED: [ACHIEVEMENT_IDS.COUNCIL_MISSIONS, ACHIEVEMENT_IDS.FOUNDING_RITUAL],
  QUEST_SET_COMPLETED: [ACHIEVEMENT_IDS.QUEST_SET_MASTER],
  QUEST_THEMED_CLAIM: [ACHIEVEMENT_IDS.THEME_MASTER],
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
  // Challenge Mastery — total tiers earned across all challenges (max 60 = 12×5)
  [ACHIEVEMENT_IDS.CHALLENGE_MASTERY]: [1, 5, 15, 30, 60],
  [ACHIEVEMENT_IDS.EXPEDITION_PROGRESSION]: [10, 50, 250, 1000, 10000],
  [ACHIEVEMENT_IDS.FUSION_PROGRESSION]: [1, 5, 10, 25, 50, 100, 250],
  [ACHIEVEMENT_IDS.PURE_FUSION]: [1, 3, 5, 10, 25],
  [ACHIEVEMENT_IDS.WILD_FUSION]: [1, 3, 5, 10, 25],
  [ACHIEVEMENT_IDS.FULL_COUNCIL]: [3],
  [ACHIEVEMENT_IDS.SANCTUM_CLAIM]: [1, 10, 50, 100, 500],
  [ACHIEVEMENT_IDS.TENURE_MASTER]: [7, 14, 30],
  [ACHIEVEMENT_IDS.COUNCIL_MISSIONS]: [5, 25, 50, 100, 500],
  // Batch 1 — must mirror totem-app/src/config/achievements.ts
  [ACHIEVEMENT_IDS.BALANCED_CARE]: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  [ACHIEVEMENT_IDS.ANTI_META_COLLECTOR]: [3, 3, 3], // per-rarity counter, see checkAntiMetaProgress
  [ACHIEVEMENT_IDS.MIXED_AFFINITY_EVOLUTION]: [2, 3],
  // Batch 2 — collect-N-of-one-affinity / collect-N-of-one-domain
  [ACHIEVEMENT_IDS.AFFINITY_SPECIALIST]: [6, 12, 24],
  [ACHIEVEMENT_IDS.DOMAIN_SPECIALIST]: [6, 12, 24],
  // Batch 3 (selected) — Seasonal Spirit Keeper (Limited rarity, unique months)
  [ACHIEVEMENT_IDS.SEASONAL_COLLECTOR]: [1, 3, 6, 12],
  // Batch 3 — persistence-reward: days since signup (lazy-evaluated on login)
  [ACHIEVEMENT_IDS.PERSISTENCE_REWARD]: [30, 90, 365],
  // Batch 3 — prestige-progression: total prestige levels across all totems
  [ACHIEVEMENT_IDS.PRESTIGE_PROGRESSION]: [1, 3, 5, 10, 25, 50, 100],
  // Daily Quests
  [ACHIEVEMENT_IDS.QUEST_SET_MASTER]: [1, 7, 30, 100, 365],
  [ACHIEVEMENT_IDS.THEME_MASTER]: [10, 30, 90, 270],
};

const ONETIME_ACHIEVEMENTS = [
  ACHIEVEMENT_IDS.RARE_COLLECTOR,
  ACHIEVEMENT_IDS.EPIC_COLLECTOR,
  ACHIEVEMENT_IDS.LEGENDARY_COLLECTOR,
  ACHIEVEMENT_IDS.CHALLENGE_INITIATE,
  // Challenge Mastery one-time achievements
  ACHIEVEMENT_IDS.CHALLENGE_GOLD,
  ACHIEVEMENT_IDS.CHALLENGE_GRANDMASTER,
  ACHIEVEMENT_IDS.EXPEDITION_EXPLORER,
  ACHIEVEMENT_IDS.RARE_FORGER,
  ACHIEVEMENT_IDS.EPIC_FORGER,
  ACHIEVEMENT_IDS.LEGENDARY_FORGER,
  ACHIEVEMENT_IDS.FIRST_ELDER,
  ACHIEVEMENT_IDS.FOUNDING_RITUAL,
  // Batch 1
  ACHIEVEMENT_IDS.RARE_EVOLUTION,
  ACHIEVEMENT_IDS.EPIC_EVOLUTION,
  ACHIEVEMENT_IDS.LEGENDARY_EVOLUTION,
  // Batch 2
  ACHIEVEMENT_IDS.AFFINITY_DIVERSITY,
  ACHIEVEMENT_IDS.DOMAIN_DIVERSITY,
  ACHIEVEMENT_IDS.SPECIES_MASTERY,
  // Batch 3 (selected) — Chromatic Mastery (one-time, all 28 colors)
  ACHIEVEMENT_IDS.COLOR_COLLECTOR_EVOLUTION,
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
  // Challenge Mastery — one-time: first challenge to Gold
  [ACHIEVEMENT_IDS.CHALLENGE_GOLD]: {
    essence: 100,
    xp: 150,
    name: 'First Gold',
  },
  // Challenge Mastery — one-time: all 12 challenges to Diamond (60 total tiers)
  [ACHIEVEMENT_IDS.CHALLENGE_GRANDMASTER]: {
    essence: 500,
    xp: 1000,
    lootBoxId: 'essence_box_huge',
    name: 'Grandmaster',
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
  [ACHIEVEMENT_IDS.FIRST_ELDER]: {
    essence: 50,
    xp: 100,
    name: 'First Among Equals',
  },
  [ACHIEVEMENT_IDS.FOUNDING_RITUAL]: {
    essence: 100,
    xp: 150,
    name: 'World Founder',
  },
  // Batch 1
  [ACHIEVEMENT_IDS.RARE_EVOLUTION]: {
    essence: 100,
    xp: 75,
    name: 'Rare Elder Evolution',
  },
  [ACHIEVEMENT_IDS.EPIC_EVOLUTION]: {
    essence: 250,
    xp: 100,
    name: 'Epic Elder Evolution',
  },
  [ACHIEVEMENT_IDS.LEGENDARY_EVOLUTION]: {
    essence: 500,
    xp: 150,
    name: 'Legendary Elder Evolution',
  },
  // Batch 2 — one-time diversity / mastery
  [ACHIEVEMENT_IDS.AFFINITY_DIVERSITY]: {
    essence: 300,
    xp: 100,
    name: 'Affinity Harmonizer',
  },
  [ACHIEVEMENT_IDS.DOMAIN_DIVERSITY]: {
    essence: 300,
    xp: 100,
    name: 'Domain Wayfarer',
  },
  [ACHIEVEMENT_IDS.SPECIES_MASTERY]: {
    essence: 1000,
    xp: 250,
    name: 'Totem Taxonomist',
  },
  // Batch 3 (selected) — long-term Chromatic Mastery (all 28 colors to Elder)
  [ACHIEVEMENT_IDS.COLOR_COLLECTOR_EVOLUTION]: {
    essence: 5000,
    xp: 500,
    name: 'Chromatic Mastery',
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
    { essence: 100, xp: 0, lootBoxId: 'uncommon_totem_box', name: 'Established Guardian' }, // 12 totems
    { essence: 150, xp: 0, lootBoxId: 'uncommon_totem_box', name: 'Master Curator' },   // 32 totems
    { essence: 200, xp: 0, lootBoxId: 'rare_totem_box', name: 'Arcane Librarian' },     // 64 totems
    { essence: 300, xp: 0, lootBoxId: 'rare_totem_box', name: 'Ethereal Archivist' },   // 128 totems
    { essence: 500, xp: 0, lootBoxId: 'epic_totem_box', name: 'Legendary Sage' },       // 256 totems
  ],
  [ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION]: [
    { essence: 25, xp: 25, name: 'First Evolution' },      // Stage 1
    { essence: 50, xp: 50, name: 'Adept Evolution' },      // Stage 2
    { essence: 100, xp: 75, name: 'Master Evolution' },    // Stage 3
    { essence: 200, xp: 100, name: 'Elder Evolution' },    // Stage 4
  ],
  [ACHIEVEMENT_IDS.LOGIN_PROGRESSION]: [
    { essence: 50, xp: 0, name: 'Week Warrior' },          // 7 days
    { essence: 100, xp: 0, lootBoxId: 'essence_box_small', name: 'Monthly Master' },        // 30 days
    { essence: 200, xp: 0, lootBoxId: 'essence_box_large', name: 'Seasonal Spirit' },       // 90 days
    { essence: 300, xp: 0, lootBoxId: 'essence_box_large', name: 'Seasonal Guardian' },     // 180 days
    { essence: 500, xp: 0, lootBoxId: 'essence_box_huge', name: 'Eternal Spirit Keeper' },  // 365 days
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
  // Challenge Mastery — total tiers earned (mirrors challenge-progression curve)
  [ACHIEVEMENT_IDS.CHALLENGE_MASTERY]: [
    { essence: 25, xp: 50, name: 'Mastery Climber' },      // 1 tier
    { essence: 75, xp: 75, name: 'Mastery Adept' },        // 5 tiers
    { essence: 150, xp: 150, name: 'Mastery Veteran' },    // 15 tiers
    { essence: 300, xp: 200, name: 'Mastery Champion' },   // 30 tiers
    // No box here — the 60th tier co-fires CHALLENGE_GRANDMASTER, which carries the huge box.
    { essence: 500, xp: 400, name: 'Mastery Grandmaster' }, // 60 tiers
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
  [ACHIEVEMENT_IDS.FULL_COUNCIL]: [
    { essence: 100, xp: 200, name: 'Full Council' },          // 3 seats filled
  ],
  [ACHIEVEMENT_IDS.SANCTUM_CLAIM]: [
    { essence: 25, xp: 25, name: 'First Tithe' },             // 1 claim
    { essence: 50, xp: 50, name: 'Tithe Collector' },         // 10 claims
    { essence: 100, xp: 100, name: 'Sanctum Treasurer' },     // 50 claims
    { essence: 200, xp: 200, name: 'Grand Treasurer' },       // 100 claims
    { essence: 500, xp: 400, name: 'Eternal Treasurer' },     // 500 claims
  ],
  [ACHIEVEMENT_IDS.TENURE_MASTER]: [
    { essence: 50, xp: 0, name: 'Week Watch' },               // 7 days
    { essence: 100, xp: 0, name: 'Fortnight Keeper' },        // 14 days
    { essence: 200, xp: 0, name: 'Long Reign' },              // 30 days
  ],
  [ACHIEVEMENT_IDS.COUNCIL_MISSIONS]: [
    { essence: 25, xp: 50, name: 'Mission Initiate' },        // 5 missions
    { essence: 50, xp: 100, name: 'Council Veteran' },        // 25 missions
    { essence: 100, xp: 200, name: 'Elder Diplomat' },        // 50 missions
    { essence: 200, xp: 400, name: 'Grand Elder' },           // 100 missions
    { essence: 500, xp: 750, name: 'Eternal Elder' },         // 500 missions
  ],
  // Batch 1 — balanced-care (Daily Trifecta) 9 milestones
  [ACHIEVEMENT_IDS.BALANCED_CARE]: [
    { essence: 25, xp: 0, name: 'Mindful Keeper' },           // 10 trifectas
    { essence: 75, xp: 25, name: 'Harmony Initiator' },       // 50
    { essence: 150, xp: 50, name: 'Attentive Guardian' },     // 100
    { essence: 250, xp: 75, name: 'Spirit Harmonizer' },      // 250
    { essence: 400, xp: 100, name: 'Balanced Nurturer' },     // 500
    { essence: 600, xp: 150, name: 'Devoted Custodian' },     // 1000
    { essence: 1000, xp: 200, name: 'Enlightened Caregiver' },// 2500
    { essence: 1500, xp: 250, name: 'Mystic Cultivator' },    // 5000
    { essence: 2500, xp: 400, name: 'Legendary Steward' },    // 10000
  ],
  // Batch 1 — anti-meta-collector: per-rarity (common/uncommon/rare) milestone
  [ACHIEVEMENT_IDS.ANTI_META_COLLECTOR]: [
    { essence: 200, xp: 75, name: 'Humble Ascendant' },        // 3 commons to stage 4
    { essence: 300, xp: 100, name: 'Uncommon Champion' },      // 3 uncommons to stage 4
    { essence: 500, xp: 150, name: 'Rare Virtuoso' },          // 3 rares to stage 4
  ],
  // Batch 1 — mixed-affinity-evolution: 2 milestones
  [ACHIEVEMENT_IDS.MIXED_AFFINITY_EVOLUTION]: [
    { essence: 150, xp: 75, name: 'Dual Affinity Harmony' },   // 2 affinities
    { essence: 300, xp: 150, name: 'Triforce of Spirits' },    // 3 affinities
  ],
  // Batch 2 — affinity-specialist: 3 milestones at 6/12/24
  [ACHIEVEMENT_IDS.AFFINITY_SPECIALIST]: [
    { essence: 100, xp: 50, name: 'Affinity Student' },        // 6
    { essence: 250, xp: 100, name: 'Affinity Scholar' },       // 12
    { essence: 500, xp: 200, name: 'Affinity Master' },        // 24
  ],
  // Batch 2 — domain-specialist: 3 milestones at 6/12/24
  [ACHIEVEMENT_IDS.DOMAIN_SPECIALIST]: [
    { essence: 100, xp: 50, name: 'Domain Adept' },            // 6
    { essence: 250, xp: 100, name: 'Domain Expert' },          // 12
    { essence: 500, xp: 200, name: 'Domain Sovereign' },       // 24
  ],
  // Batch 3 (selected) — Seasonal Spirit Keeper: 4 milestones, one Limited per month
  [ACHIEVEMENT_IDS.SEASONAL_COLLECTOR]: [
    { essence: 100, xp: 50, name: 'Seasonal Debut' },          // 1 month
    { essence: 250, xp: 100, name: 'Seasonal Curator' },       // 3 months
    { essence: 500, xp: 200, name: 'Seasonal Archiver' },      // 6 months
    { essence: 1500, xp: 400, name: 'Eternal Timekeeper' },    // 12 months
  ],
  // Batch 3 — persistence-reward: 3 milestones (days since account creation)
  [ACHIEVEMENT_IDS.PERSISTENCE_REWARD]: [
    { essence: 200, xp: 50, name: 'First Moon' },              // 30 days
    { essence: 500, xp: 100, name: 'Cycle Master' },           // 90 days
    { essence: 2000, xp: 500, name: 'Eternal Spirit' },        // 365 days
  ],
  // Batch 3 — prestige-progression: 7 milestones (total prestige across totems)
  [ACHIEVEMENT_IDS.PRESTIGE_PROGRESSION]: [
    { essence: 200, xp: 50, name: 'Emerging Collective' },     // 1
    { essence: 400, xp: 100, name: 'Collective Wisdom' },      // 3
    { essence: 750, xp: 150, name: 'Legendary Guardians' },    // 5
    { essence: 1500, xp: 200, name: 'Ethereal Convergence' },  // 10
    { essence: 3000, xp: 300, name: 'Cosmic Resonance' },      // 25
    { essence: 6000, xp: 400, name: 'Realm Shapers' },         // 50
    { essence: 12000, xp: 500, name: 'Infinite Pantheon' },    // 100
  ],
  [ACHIEVEMENT_IDS.QUEST_SET_MASTER]: [
    { essence: 25, xp: 0, name: 'Devoted Seeker' },            // 1 set
    { essence: 75, xp: 0, name: 'Weekly Pilgrim' },            // 7 sets
    { essence: 200, xp: 0, name: 'Lunar Devotee' },            // 30 sets
    { essence: 500, xp: 0, name: 'Centurion of Quests' },      // 100 sets
    { essence: 1500, xp: 0, name: 'Year of the Spirits' },     // 365 sets
  ],
  [ACHIEVEMENT_IDS.THEME_MASTER]: [
    { essence: 50, xp: 0, name: 'Theme Apprentice' },          // 10 themed claims
    { essence: 150, xp: 0, name: 'Pathwalker' },               // 30 themed claims
    { essence: 400, xp: 0, name: 'Thematic Sage' },            // 90 themed claims
    { essence: 1000, xp: 0, name: 'Master of the Cycle' },     // 270 themed claims
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
 * @param {string|null} lootBoxId - Optional loot box id to grant (e.g. 'rare_totem_box')
 * @returns {Promise<{ essence: number, xp: number, newEssenceBalance?: number, newTotemExp?: number, lootBox?: object }>}
 */
async function distributeAchievementReward(userId, achievementId, rewardName, essenceReward, xpReward, totemId = null, milestoneIndex = null, lootBoxId = null) {
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

  // Grant a loot box if specified (escalating reward on marquee milestones).
  // The box lands unclaimed in the player's Loot Boxes card to open later.
  if (lootBoxId) {
    try {
      // Lazy require avoids a circular dependency — loot-service triggers achievements on totem-box claim.
      const { grantLootItem } = require('./loot-service');
      const lootResult = await grantLootItem(userId, lootBoxId, 'achievement');
      rewards.lootBox = { id: lootResult.id, boxId: lootResult.boxId, source: 'achievement' };
      console.log(`[Achievement] Granted loot box "${lootBoxId}" to ${userId} for "${rewardName}"`);
    }
    catch (err) {
      console.error(`[Achievement] Error granting loot box "${lootBoxId}" for ${achievementId}:`, err.message);
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
          null,
          rewardConfig.lootBoxId
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
            i,
            rewardConfig.lootBoxId
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
          if (rewardResult.lootBox) {
            if (!result.rewards.lootBoxes) result.rewards.lootBoxes = [];
            result.rewards.lootBoxes.push(rewardResult.lootBox);
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
          else {
            // Batch 2 affinity/domain/species achievements use atomic helpers
            // run AFTER the standard loop (see post-loop block below).
            value = 0;
          }
          break;

        case 'TOTEM_EVOLVED':
          if (achievementId === ACHIEVEMENT_IDS.EVOLUTION_PROGRESSION) {
            value = data.newStage || data.evolutionCount || 0;
          }
          // "Elder" = data stage 4 (UI display "5/5"). The achievement names
          // (Rare/Epic/Legendary "Elder Evolution") and the maximum-potential
          // intent require reaching the Wise Elder stage, not Adult (stage 3).
          else if (achievementId === ACHIEVEMENT_IDS.RARE_EVOLUTION) {
            value = (data.newStage === 4 && data.rarityId === RARITY.RARE) ? 1 : 0;
          }
          else if (achievementId === ACHIEVEMENT_IDS.EPIC_EVOLUTION) {
            value = (data.newStage === 4 && data.rarityId === RARITY.EPIC) ? 1 : 0;
          }
          else if (achievementId === ACHIEVEMENT_IDS.LEGENDARY_EVOLUTION) {
            value = (data.newStage === 4 && data.rarityId === RARITY.LEGENDARY) ? 1 : 0;
          }
          else {
            // ANTI_META_COLLECTOR, MIXED_AFFINITY_EVOLUTION, COLOR_COLLECTOR_EVOLUTION
            // are handled by dedicated atomic helpers after the standard loop.
            value = 0;
          }
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

        case 'PERSISTENCE_CHECK':
          value = data.daysSinceCreated || 0;
          break;

        case 'CHALLENGE_COMPLETED':
          if (achievementId === ACHIEVEMENT_IDS.CHALLENGE_INITIATE) {
            value = 1; // First challenge = complete
          }
          else {
            value = data.totalChallengeCount || 0;
          }
          break;

        case 'CHALLENGE_TIER_REACHED': {
          const tiers = data.totalTiersEarned || 0;
          if (achievementId === ACHIEVEMENT_IDS.CHALLENGE_MASTERY) {
            value = tiers; // progression: total tiers earned across all challenges
          }
          else if (achievementId === ACHIEVEMENT_IDS.CHALLENGE_GOLD) {
            // one-time: a SINGLE challenge first reaches Gold (newTier >= 3).
            // Not total tiers — three Bronzes must not award it. A value of 0
            // on sub-Gold tier-ups is a no-op for one-time achievements.
            value = (data.newTier || 0) >= 3 ? 1 : 0;
          }
          else if (achievementId === ACHIEVEMENT_IDS.CHALLENGE_GRANDMASTER) {
            // one-time: all 12 challenges to Diamond (60 = 12 × 5)
            value = tiers >= 60 ? 1 : 0;
          }
          break;
        }

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

        case 'ELDER_SEATED':
          if (achievementId === ACHIEVEMENT_IDS.FIRST_ELDER) {
            value = 1; // One-time: first totem seated
          }
          else if (achievementId === ACHIEVEMENT_IDS.FULL_COUNCIL) {
            value = data.totalSeatedCount || 0;
          }
          break;

        case 'SANCTUM_CLAIMED':
          value = data.totalClaimCount || 0;
          break;

        case 'TENURE_CHECK':
          value = data.tenureDays || 0;
          break;

        case 'MISSION_COMPLETED':
          if (achievementId === ACHIEVEMENT_IDS.FOUNDING_RITUAL) {
            // Only triggers for the founding-ritual mission
            value = data.missionType === 'cm_founding-ritual' ? 1 : 0;
          }
          else if (achievementId === ACHIEVEMENT_IDS.COUNCIL_MISSIONS) {
            value = data.totalMissionCount || 0;
          }
          break;

        case 'QUEST_SET_COMPLETED':
          value = data.totalQuestSetCount || 0;
          break;

        case 'QUEST_THEMED_CLAIM':
          value = data.totalThemedClaimCount || 0;
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

  // Post-loop custom helpers — atomic / non-sequential achievements that don't
  // fit the standard "currentValue >= threshold" model.
  if (trigger === 'TOTEM_EVOLVED') {
    try {
      const antiMeta = await checkAntiMetaProgress(userId, data, totemId);
      if (antiMeta) results.push(antiMeta);
    }
    catch (err) {
      console.error(`[Achievement] anti-meta error for ${userId}:`, err.message);
    }
    try {
      const mixedAff = await checkMixedAffinityProgress(userId, data, totemId);
      if (mixedAff) results.push(mixedAff);
    }
    catch (err) {
      console.error(`[Achievement] mixed-affinity error for ${userId}:`, err.message);
    }
    try {
      const chromatic = await checkColorCollectorEvolution(userId, data, totemId);
      if (chromatic) results.push(chromatic);
    }
    catch (err) {
      console.error(`[Achievement] color-collector error for ${userId}:`, err.message);
    }
  }

  if (trigger === 'TOTEM_ACQUIRED' && data.speciesId !== null && data.speciesId !== undefined) {
    const checks = [
      ['affinity-specialist', () => checkAffinitySpecialist(userId, data, totemId)],
      ['domain-specialist', () => checkDomainSpecialist(userId, data, totemId)],
      ['species-mastery', () => checkSpeciesMastery(userId, data, totemId)],
      ['affinity-diversity', () => checkAffinityDiversity(userId, data, totemId)],
      ['domain-diversity', () => checkDomainDiversity(userId, data, totemId)],
      ['seasonal-collector', () => checkSeasonalCollector(userId, data, totemId)],
    ];
    for (const [name, fn] of checks) {
      try {
        const r = await fn();
        if (r) results.push(r);
      }
      catch (err) {
        console.error(`[Achievement] ${name} error for ${userId}:`, err.message);
      }
    }
  }

  return results;
}

// =============================================================================
// BATCH 1 — Atomic helpers for non-sequential / set-based achievements
// =============================================================================

/**
 * Ensure the achievement progress record exists. Returns the existing or
 * newly-created record. Initializes Batch 1 fields (perRarityCount, etc.)
 * when first creating, so subsequent atomic updates don't fail on missing
 * parent maps.
 */
async function ensureAchievementRecord(userId, achievementId) {
  let progress = await getAchievementProgress(userId, achievementId);
  if (progress) return progress;

  const now = new Date().toISOString();
  progress = {
    pk: achievementPK(userId),
    sk: achievementSK(achievementId),
    odUserId: userId,
    achievementId,
    currentValue: 0,
    milestoneIndex: -1,
    isComplete: false,
    milestones: [],
    lastUpdatedAt: now,
  };
  if (achievementId === ACHIEVEMENT_IDS.BALANCED_CARE) {
    progress.trifectaLog = {};
  }
  if (achievementId === ACHIEVEMENT_IDS.ANTI_META_COLLECTOR) {
    progress.perRarityCount = {};
  }
  if (achievementId === ACHIEVEMENT_IDS.AFFINITY_SPECIALIST) {
    progress.affinityCounts = {};
  }
  if (achievementId === ACHIEVEMENT_IDS.DOMAIN_SPECIALIST) {
    progress.domainCounts = {};
  }
  if (achievementId === ACHIEVEMENT_IDS.PRESTIGE_PROGRESSION) {
    progress.prestigeByTotem = {};
  }
  await putItem(TABLES.ACHIEVEMENT_PROGRESS, progress);
  return progress;
}

/**
 * Atomically award a milestone if not already in the unlocked set.
 * Used by anti-meta-collector (non-sequential milestones).
 */
async function awardSingleMilestone(userId, achievementId, milestoneIndex, totemId) {
  const progress = await getAchievementProgress(userId, achievementId);
  const existing = progress?.milestones || [];
  if (existing.some(m => m.index === milestoneIndex)) {
    return null; // already unlocked, idempotent
  }
  const now = new Date().toISOString();
  const newMilestones = [...existing, { index: milestoneIndex, unlockedAt: now }];
  const newMilestoneIndex = Math.max(...newMilestones.map(m => m.index));

  await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId),
    sk: achievementSK(achievementId),
  }, {
    milestones: newMilestones,
    milestoneIndex: newMilestoneIndex,
    unlockedAt: progress?.unlockedAt || now,
    lastUpdatedAt: now,
  });

  const rewardConfig = getRewardConfig(achievementId, milestoneIndex);
  let rewards = { essence: 0, xp: 0 };
  if (rewardConfig) {
    rewards = await distributeAchievementReward(
      userId, achievementId, rewardConfig.name, rewardConfig.essence, rewardConfig.xp,
      totemId, milestoneIndex
    );
  }
  return {
    unlocked: true,
    achievementId,
    milestone: milestoneIndex,
    newMilestones: [milestoneIndex],
    rewards,
  };
}

/**
 * Anti-meta collector: per-rarity counter. Atomic ADD on perRarityCount.{r}.
 * Milestone i unlocks when perRarityCount[i] >= 3 (i ∈ {0,1,2} = common/uncommon/rare).
 */
async function checkAntiMetaProgress(userId, data, totemId) {
  const { newStage, rarityId } = data;
  if (newStage !== 4) return null;
  if (rarityId !== RARITY.COMMON && rarityId !== RARITY.UNCOMMON && rarityId !== RARITY.RARE) {
    return null;
  }

  const id = ACHIEVEMENT_IDS.ANTI_META_COLLECTOR;
  await ensureAchievementRecord(userId, id);

  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId),
    sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD perRarityCount.#r :one SET lastUpdatedAt = :now',
    ExpressionAttributeNames: { '#r': String(rarityId) },
    ExpressionAttributeValues: {
      ':one': 1,
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  });

  const newCount = result?.Attributes?.perRarityCount?.[rarityId] || 0;
  if (newCount >= ACHIEVEMENT_MILESTONES[id][rarityId]) {
    return await awardSingleMilestone(userId, id, rarityId, totemId);
  }
  return null;
}

/**
 * Mixed-affinity-evolution: string-set ADD. Milestone unlocks when set size
 * crosses the threshold (2 → milestone 0, 3 → milestone 1).
 */
async function checkMixedAffinityProgress(userId, data, totemId) {
  const { newStage, speciesId } = data;
  // Mirror the Elder semantics: "evolve to maximum potential" = stage 4.
  if (newStage !== 4) return null;
  const affinity = getAffinity(speciesId);
  if (!affinity) return null;

  const id = ACHIEVEMENT_IDS.MIXED_AFFINITY_EVOLUTION;
  await ensureAchievementRecord(userId, id);

  // DynamoDB SS type — use a Set instance so the SDK serializes it correctly.
  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId),
    sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD seenAffinities :a SET lastUpdatedAt = :now',
    ExpressionAttributeValues: {
      ':a': new Set([affinity]),
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  });

  const seen = result?.Attributes?.seenAffinities;
  const size = seen instanceof Set ? seen.size : (seen?.values?.length ?? (Array.isArray(seen) ? seen.length : 0));
  if (!size) return null;

  // Mirror checkAndUnlockMilestone: also update currentValue so frontend
  // progress display reflects "X of Y affinities".
  await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId),
    sk: achievementSK(id),
  }, { currentValue: size });

  // Walk milestones; for the new ones, dispatch via checkAndUnlockMilestone with
  // the size as currentValue. Use the standard sequential progression flow.
  return await checkAndUnlockMilestone(userId, id, size, totemId);
}

// =============================================================================
// BATCH 2 — TOTEM_ACQUIRED-driven affinity/domain/species helpers
// =============================================================================

/**
 * Affinity-specialist: collect N totems of the same affinity. Storage:
 *   affinityCounts: { Strength: N, Agility: N, Wisdom: N }
 * Milestones [6, 12, 24] unlock when MAX(counts) crosses each threshold.
 * Sets currentValue = max so the UI's progress bar tracks the leading affinity.
 */
async function checkAffinitySpecialist(userId, data, totemId) {
  const affinity = getAffinity(data.speciesId);
  if (!affinity) return null;

  const id = ACHIEVEMENT_IDS.AFFINITY_SPECIALIST;
  await ensureAchievementRecord(userId, id);

  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId), sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD affinityCounts.#a :one SET lastUpdatedAt = :now',
    ExpressionAttributeNames: { '#a': affinity },
    ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  });
  const counts = result?.Attributes?.affinityCounts || {};
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return null;

  return await checkAndUnlockMilestone(userId, id, max, totemId);
}

/**
 * Domain-specialist: same pattern as affinity-specialist but keyed on domain.
 */
async function checkDomainSpecialist(userId, data, totemId) {
  const domain = getDomain(data.speciesId);
  if (!domain) return null;

  const id = ACHIEVEMENT_IDS.DOMAIN_SPECIALIST;
  await ensureAchievementRecord(userId, id);

  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId), sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD domainCounts.#d :one SET lastUpdatedAt = :now',
    ExpressionAttributeNames: { '#d': domain },
    ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  });
  const counts = result?.Attributes?.domainCounts || {};
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return null;

  return await checkAndUnlockMilestone(userId, id, max, totemId);
}

/**
 * Species-mastery: collect at least one of each species (12 total). Atomic
 * string-set ADD on seenSpecies. Unlocks once size === TOTAL_SPECIES.
 */
async function checkSpeciesMastery(userId, data, totemId) {
  if (data.speciesId === null || data.speciesId === undefined) return null;

  const id = ACHIEVEMENT_IDS.SPECIES_MASTERY;
  // Optimization: once a one-time achievement is unlocked, skip the rawUpdate
  // entirely on subsequent calls. Saves a DB write per acquired totem.
  const existing = await getAchievementProgress(userId, id);
  if (existing?.isComplete) return null;
  if (!existing) await ensureAchievementRecord(userId, id);

  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId), sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD seenSpecies :s SET lastUpdatedAt = :now',
    ExpressionAttributeValues: {
      ':s': new Set([String(data.speciesId)]),
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  });
  const seen = result?.Attributes?.seenSpecies;
  const size = seen instanceof Set ? seen.size : 0;
  if (size < TOTAL_SPECIES) {
    await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
      pk: achievementPK(userId), sk: achievementSK(id),
    }, { currentValue: size });
    return null;
  }
  return await checkAndUnlockMilestone(userId, id, 1, totemId);
}

/**
 * Affinity-diversity: collect a Rare+ totem from each of the 3 affinities.
 * Atomic string-set ADD on seenAffinitiesRare. Skipped for non-Rare+ totems.
 */
async function checkAffinityDiversity(userId, data, totemId) {
  if (data.rarityId < RARITY.RARE) return null;
  const affinity = getAffinity(data.speciesId);
  if (!affinity) return null;

  const id = ACHIEVEMENT_IDS.AFFINITY_DIVERSITY;
  const existing = await getAchievementProgress(userId, id);
  if (existing?.isComplete) return null;
  if (!existing) await ensureAchievementRecord(userId, id);

  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId), sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD seenAffinitiesRare :a SET lastUpdatedAt = :now',
    ExpressionAttributeValues: {
      ':a': new Set([affinity]),
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  });
  const seen = result?.Attributes?.seenAffinitiesRare;
  const size = seen instanceof Set ? seen.size : 0;
  if (size < TOTAL_AFFINITIES) {
    await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
      pk: achievementPK(userId), sk: achievementSK(id),
    }, { currentValue: size });
    return null;
  }
  return await checkAndUnlockMilestone(userId, id, 1, totemId);
}

/**
 * Chromatic Mastery: evolve every color variant to Elder (stage 4).
 * Atomic string-set ADD on seenColors. Unlocks once size === TOTAL_COLORS.
 *
 * Long-term achievement — most players will never complete it.
 */
async function checkColorCollectorEvolution(userId, data, totemId) {
  if (data.newStage !== 4) return null;
  if (data.colorId === null || data.colorId === undefined) return null;

  const id = ACHIEVEMENT_IDS.COLOR_COLLECTOR_EVOLUTION;
  const existing = await getAchievementProgress(userId, id);
  if (existing?.isComplete) return null;
  if (!existing) await ensureAchievementRecord(userId, id);

  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId), sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD seenColors :c SET lastUpdatedAt = :now',
    ExpressionAttributeValues: {
      ':c': new Set([String(data.colorId)]),
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  });
  const seen = result?.Attributes?.seenColors;
  const size = seen instanceof Set ? seen.size : 0;
  if (size < TOTAL_COLORS) {
    await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
      pk: achievementPK(userId), sk: achievementSK(id),
    }, { currentValue: size });
    return null;
  }
  return await checkAndUnlockMilestone(userId, id, 1, totemId);
}

/**
 * Seasonal Spirit Keeper: collect Limited-rarity totems, deduped by
 * the totem's colorId. Each monthly Limited release has its own unique
 * color (16=frostbite Jan, 17=rosy Feb, 18=verdant Mar, ... 27=starlit Dec),
 * so colorId is the canonical identity of a seasonal release.
 *
 * Two duplicate January totems (same colorId) collapse into 1.
 * Four totems from four different months (four distinct colorIds) count as 4.
 *
 * Storage: seenSeasonalColors — StringSet of colorId entries.
 * Milestones [1, 3, 6, 12] unlock as the set size grows.
 */
async function checkSeasonalCollector(userId, data, totemId) {
  if (data.rarityId !== RARITY.LIMITED) return null;
  if (data.colorId === null || data.colorId === undefined) return null;

  const id = ACHIEVEMENT_IDS.SEASONAL_COLLECTOR;
  await ensureAchievementRecord(userId, id);

  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId), sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD seenSeasonalColors :c SET lastUpdatedAt = :now',
    ExpressionAttributeValues: {
      ':c': new Set([String(data.colorId)]),
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  });
  const seen = result?.Attributes?.seenSeasonalColors;
  const size = seen instanceof Set ? seen.size : 0;
  if (size === 0) return null;

  return await checkAndUnlockMilestone(userId, id, size, totemId);
}

/**
 * Domain-diversity: same as affinity-diversity but keyed on domain.
 */
async function checkDomainDiversity(userId, data, totemId) {
  if (data.rarityId < RARITY.RARE) return null;
  const domain = getDomain(data.speciesId);
  if (!domain) return null;

  const id = ACHIEVEMENT_IDS.DOMAIN_DIVERSITY;
  const existing = await getAchievementProgress(userId, id);
  if (existing?.isComplete) return null;
  if (!existing) await ensureAchievementRecord(userId, id);

  const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
    pk: achievementPK(userId), sk: achievementSK(id),
  }, {
    UpdateExpression: 'ADD seenDomainsRare :d SET lastUpdatedAt = :now',
    ExpressionAttributeValues: {
      ':d': new Set([domain]),
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  });
  const seen = result?.Attributes?.seenDomainsRare;
  const size = seen instanceof Set ? seen.size : 0;
  if (size < TOTAL_DOMAINS) {
    await updateItem(TABLES.ACHIEVEMENT_PROGRESS, {
      pk: achievementPK(userId), sk: achievementSK(id),
    }, { currentValue: size });
    return null;
  }
  return await checkAndUnlockMilestone(userId, id, 1, totemId);
}

/**
 * Balanced-care (Daily Trifecta). Called from feed/train/treat handlers
 * with the merged-in-memory totem after the action's totem update.
 *
 * Atomic conditional update on trifectaLog[totemId]:
 *   - succeeds (and increments currentValue) only if the entry is not today.
 *   - throws ConditionalCheckFailedException if already counted today (idempotent no-op).
 *
 * @param {string} userId
 * @param {object} totem - merged totem record including lastActionDates
 * @returns {Array} - array of unlocked achievement results (possibly empty)
 */
async function checkBalancedCare(userId, totem) {
  const today = new Date().toISOString().slice(0, 10);
  const dates = totem.lastActionDates || {};
  if (dates.feed !== today || dates.train !== today || dates.treat !== today) {
    return [];
  }

  const id = ACHIEVEMENT_IDS.BALANCED_CARE;
  const totemId = totem.id;
  await ensureAchievementRecord(userId, id);

  let attributes;
  try {
    const result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
      pk: achievementPK(userId),
      sk: achievementSK(id),
    }, {
      UpdateExpression: 'SET trifectaLog.#tid = :today, currentValue = if_not_exists(currentValue, :zero) + :one, lastUpdatedAt = :now',
      ConditionExpression: 'attribute_not_exists(trifectaLog.#tid) OR trifectaLog.#tid <> :today',
      ExpressionAttributeNames: { '#tid': totemId },
      ExpressionAttributeValues: {
        ':today': today,
        ':one': 1,
        ':zero': 0,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    });
    attributes = result?.Attributes || {};
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Already counted today for this totem — idempotent no-op.
      return [];
    }
    throw err;
  }

  // Run standard milestone unlock against the new currentValue.
  const newValue = attributes.currentValue || 0;
  const milestoneResult = await checkAndUnlockMilestone(userId, id, newValue, totemId);
  return milestoneResult.unlocked ? [milestoneResult] : [];
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
async function onTotemAcquired(userId, { rarityId, totalTotemCount, totemId = null, speciesId = null, colorId = null, acquiredAt = null }) {
  return checkAchievement(userId, 'TOTEM_ACQUIRED', {
    rarityId,
    totemCount: totalTotemCount,
    totemId,
    speciesId,
    colorId,
    acquiredAt,
  });
}

/**
 * Call when a totem evolves
 * @param {string} userId - User ID
 * @param {object} options - Options object
 * @param {number} options.newStage - The new evolution stage (1-4)
 * @param {string} [options.totemId] - Totem ID for XP rewards
 * @param {number} [options.rarityId] - Rarity (0-5) — drives rare/epic/legendary-evolution + anti-meta
 * @param {number} [options.speciesId] - Species (0-11) — drives mixed-affinity-evolution via static lookup
 */
async function onTotemEvolved(userId, { newStage, totemId = null, rarityId = null, speciesId = null, colorId = null }) {
  return checkAchievement(userId, 'TOTEM_EVOLVED', { newStage, totemId, rarityId, speciesId, colorId });
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
 * Call on sanctum claim with the seats array. Computes max-tenure across all
 * seated elders (in days) and fires TENURE_CHECK so milestones at 7/14/30
 * days unlock. Lazy evaluation — runs on each claim instead of via cron.
 *
 * @param {string} userId
 * @param {Array<{seatedAt: string}>} seats - Currently-occupied sanctum seats
 * @returns {Array} unlocked achievement results
 */
async function onTenureCheck(userId, seats) {
  if (!Array.isArray(seats) || seats.length === 0) return [];
  const now = Date.now();
  let maxTenureDays = 0;
  for (const seat of seats) {
    if (!seat?.seatedAt) continue;
    const days = Math.floor((now - new Date(seat.seatedAt).getTime()) / (24 * 60 * 60 * 1000));
    if (days > maxTenureDays) maxTenureDays = days;
  }
  if (maxTenureDays <= 0) return [];
  return checkAchievement(userId, 'TENURE_CHECK', { tenureDays: maxTenureDays });
}

/**
 * Call on each daily login (or app mount) with the user's account-creation
 * timestamp. Computes days-since-signup and fires the PERSISTENCE_CHECK
 * trigger so milestones at 30/90/365 days unlock.
 *
 * @param {string} userId
 * @param {string} createdAt - User account ISO timestamp
 * @param {string} [totemId] - For XP rewards (optional)
 */
async function onPersistenceCheck(userId, createdAt, totemId = null) {
  if (!createdAt) return [];
  const created = new Date(createdAt);
  if (isNaN(created.getTime())) return [];
  const ms = Date.now() - created.getTime();
  const daysSinceCreated = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (daysSinceCreated <= 0) return [];
  return checkAchievement(userId, 'PERSISTENCE_CHECK', { daysSinceCreated, totemId });
}

/**
 * Prestige Collective: total prestige levels across all of the user's totems.
 *
 * Called from totem-xp.addTotemXp whenever a totem's XP crosses a prestige
 * threshold (XP > BASE_ELDER_XP, every PRESTIGE_XP_REQUIREMENT). Storage
 * uses a `prestigeByTotem` map on the achievement record so each totem's
 * contribution is tracked individually and the total is the sum of values.
 *
 * Idempotency: a conditional update only writes when the new prestige
 * exceeds the stored max for that totem. Replaying the same crossing or a
 * lower value is a no-op (ConditionalCheckFailed → return []).
 *
 * Atomicity: the SET of `prestigeByTotem.<tid>` and ADD on `currentValue`
 * happen in one DDB call so the running total never drifts from the map.
 */
async function onTotemPrestiged(userId, { totemId, oldPrestige, newPrestige }) {
  if (!totemId) return [];
  const newP = Number(newPrestige) || 0;
  const oldP = Number(oldPrestige) || 0;
  if (newP <= oldP) return [];

  const id = ACHIEVEMENT_IDS.PRESTIGE_PROGRESSION;
  await ensureAchievementRecord(userId, id);

  const delta = newP - oldP;
  const now = new Date().toISOString();

  let result;
  try {
    result = await rawUpdate(TABLES.ACHIEVEMENT_PROGRESS, {
      pk: achievementPK(userId), sk: achievementSK(id),
    }, {
      UpdateExpression:
        'SET prestigeByTotem.#tid = :newP, lastUpdatedAt = :now ADD currentValue :delta',
      ConditionExpression:
        'attribute_not_exists(prestigeByTotem.#tid) OR prestigeByTotem.#tid < :newP',
      ExpressionAttributeNames: { '#tid': totemId },
      ExpressionAttributeValues: {
        ':newP': newP,
        ':delta': delta,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    });
  }
  catch (err) {
    if (err && err.name === 'ConditionalCheckFailedException') return [];
    throw err;
  }

  const newTotal = result?.Attributes?.currentValue ?? 0;
  if (newTotal <= 0) return [];
  const r = await checkAndUnlockMilestone(userId, id, newTotal, totemId);
  return r ? [r] : [];
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
 * Call when a challenge crosses a mastery tier (Challenge Mastery feature).
 * @param {string} userId - User ID
 * @param {object} options - Options
 * @param {number} options.newTier - The tier the crossing challenge just reached (gates First Gold)
 * @param {number} options.totalTiersEarned - Sum of mastery tiers across all the user's challenges
 * @param {string} [options.totemId] - Triggering totem ID (for XP rewards)
 */
async function onChallengeTierReached(userId, { newTier, totalTiersEarned, totemId = null }) {
  return checkAchievement(userId, 'CHALLENGE_TIER_REACHED', { newTier, totalTiersEarned, totemId });
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

/**
 * Call when an elder totem is seated in the sanctum
 * @param {string} userId - User ID
 * @param {object} options - Options object
 * @param {number} options.totalSeatedCount - Total seats now occupied (after seating)
 */
async function onElderSeated(userId, { totalSeatedCount }) {
  return checkAchievement(userId, 'ELDER_SEATED', { totalSeatedCount });
}

/**
 * Call when sanctum Essence is claimed
 * @param {string} userId - User ID
 * @param {object} options - Options object
 * @param {number} options.totalClaimCount - Total sanctum claims by the user
 */
async function onSanctumClaimed(userId, { totalClaimCount }) {
  return checkAchievement(userId, 'SANCTUM_CLAIMED', { totalClaimCount });
}

/**
 * Call when a council mission is completed and claimed
 * @param {string} userId - User ID
 * @param {object} options - Options object
 * @param {string} options.missionType - Mission type ID (e.g. 'cm_founding-ritual')
 * @param {number} options.totalMissionCount - Total council missions completed by user
 */
async function onMissionCompleted(userId, { missionType, totalMissionCount }) {
  return checkAchievement(userId, 'MISSION_COMPLETED', { missionType, totalMissionCount });
}

/**
 * Call when a daily quest set is completed AND the bonus reward has been claimed.
 * @param {string} userId
 * @param {object} options
 * @param {number} options.totalQuestSetCount - Total bonus claims by this user (running counter on user.stats)
 */
async function onQuestSetClaimed(userId, { totalQuestSetCount }) {
  return checkAchievement(userId, 'QUEST_SET_COMPLETED', { totalQuestSetCount });
}

/**
 * Call when a themed daily quest (slot 3 affinity or slot 4 domain) is claimed.
 * @param {string} userId
 * @param {object} options
 * @param {number} options.totalThemedClaimCount - Total themed claims by this user
 */
async function onQuestThemedClaimed(userId, { totalThemedClaimCount }) {
  return checkAchievement(userId, 'QUEST_THEMED_CLAIM', { totalThemedClaimCount });
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
  onPersistenceCheck,
  onTotemPrestiged,
  onTenureCheck,
  onChallengeCompleted,
  onChallengeTierReached,
  onExpeditionCompleted,
  onTotemFused,
  onElderSeated,
  onSanctumClaimed,
  onMissionCompleted,
  onQuestSetClaimed,
  onQuestThemedClaimed,

  // Batch 1 helpers
  checkBalancedCare,
  checkAntiMetaProgress,
  checkMixedAffinityProgress,

  // Batch 2 helpers
  checkAffinitySpecialist,
  checkDomainSpecialist,
  checkSpeciesMastery,
  checkAffinityDiversity,
  checkDomainDiversity,

  // Batch 3 (selected) helpers
  checkColorCollectorEvolution,
  checkSeasonalCollector,
};
