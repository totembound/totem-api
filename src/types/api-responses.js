/**
 * API Response Types for TotemBound Web2 API
 *
 * These JSDoc types provide structure for API responses.
 * Used for documentation and IDE autocomplete.
 */

/**
 * @typedef {Object} ApiResponse
 * @property {boolean} success - Whether the request was successful
 * @property {*} [data] - Response data (when success=true)
 * @property {ApiError} [error] - Error details (when success=false)
 */

/**
 * @typedef {Object} ApiError
 * @property {string} code - Error code (e.g., 'UNAUTHORIZED', 'NOT_FOUND', 'VALIDATION_ERROR')
 * @property {string} message - Human-readable error message
 * @property {Object} [details] - Additional error details
 */

// ============================================
// USER TYPES
// ============================================

/**
 * @typedef {Object} UserProfile
 * @property {string} id - User ID (usr_<uuid>)
 * @property {string} email - User email
 * @property {string} displayName - Display name
 * @property {'free'|'premium'|'vip'} tier - Subscription tier
 * @property {UserCurrencies} currencies - User's currency balances
 * @property {UserStats} stats - User statistics
 * @property {UserSettings} settings - User preferences
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 */

/**
 * @typedef {Object} UserCurrencies
 * @property {number} essence - Soft currency (earned in-game)
 * @property {number} gems - Hard currency (purchased)
 */

/**
 * @typedef {Object} UserStats
 * @property {number} totalTotems - Number of totems owned
 * @property {number} totalChallengesCompleted - Lifetime challenges completed
 * @property {number} loginStreak - Current login streak (days)
 * @property {string} lastLoginDate - Last login date (YYYY-MM-DD)
 */

/**
 * @typedef {Object} UserSettings
 * @property {boolean} notifications - Push notifications enabled
 * @property {'light'|'dark'|'system'} darkMode - Dark mode preference
 */

// ============================================
// TOTEM TYPES
// ============================================

/**
 * @typedef {Object} Totem
 * @property {string} id - Totem ID (ttm_<uuid>)
 * @property {string} userId - Owner's user ID
 * @property {string} species - Species ID (owl, fox, wolf, etc.)
 * @property {string} name - Totem's name
 * @property {number} stage - Evolution stage (1-5)
 * @property {number} experience - Current experience points
 * @property {number|null} experienceToNextLevel - XP needed for next level (null if max)
 * @property {TotemStats} stats - Totem statistics
 * @property {TotemCooldowns} cooldowns - Action cooldowns
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 */

/**
 * @typedef {Object} TotemStats
 * @property {number} strength - Strength stat (1-100)
 * @property {number} agility - Agility stat (1-100)
 * @property {number} wisdom - Wisdom stat (1-100)
 * @property {number} happiness - Happiness level (0-100)
 * @property {number} hunger - Hunger level (0-100, lower is hungrier)
 */

/**
 * @typedef {Object} TotemCooldowns
 * @property {string|null} feed - Feed cooldown end (ISO timestamp or null if ready)
 * @property {string|null} train - Train cooldown end
 * @property {string|null} treat - Treat cooldown end
 */

/**
 * @typedef {Object} ActionResult
 * @property {boolean} success - Whether action succeeded
 * @property {Totem} totem - Updated totem state
 * @property {ActionRewards} rewards - Rewards from action
 * @property {string|null} nextAvailable - When action is available again (ISO timestamp)
 */

/**
 * @typedef {Object} ActionRewards
 * @property {number} experienceGained - XP earned
 * @property {Object} statChanges - Stat modifications
 * @property {number} [essenceEarned] - Currency earned (if any)
 */

// ============================================
// CHALLENGE TYPES
// ============================================

/**
 * @typedef {Object} Challenge
 * @property {string} id - Challenge ID (chl_<id>)
 * @property {string} name - Challenge name
 * @property {string} description - Challenge description
 * @property {'balance'|'strength'|'agility'|'wisdom'} type - Challenge type
 * @property {string} affinity - Stat affinity
 * @property {ChallengeRequirements} requirements - Requirements to attempt
 * @property {number} maxDailyAttempts - Max attempts per day
 * @property {number} maxScore - Maximum possible score
 * @property {boolean} enabled - Whether challenge is active
 */

/**
 * @typedef {Object} ChallengeRequirements
 * @property {number} stage - Minimum totem stage
 * @property {number} strength - Minimum strength stat
 * @property {number} agility - Minimum agility stat
 * @property {number} wisdom - Minimum wisdom stat
 */

/**
 * @typedef {Object} ChallengeStatus
 * @property {string} challengeId - Challenge ID
 * @property {number} highScore - Personal best score
 * @property {number} dailyAttempts - Attempts used today
 * @property {number} attemptsRemaining - Attempts left today
 * @property {number} totalAttempts - Lifetime attempts
 * @property {number} totalScore - Lifetime score
 */

/**
 * @typedef {Object} ChallengeResult
 * @property {boolean} success - Whether submission succeeded
 * @property {number} score - Submitted score
 * @property {boolean} isHighScore - Whether this is a new high score
 * @property {number} experienceGained - XP earned from challenge
 * @property {number} attemptsRemaining - Remaining attempts today
 */

// ============================================
// SHOP TYPES
// ============================================

/**
 * @typedef {Object} ShopItem
 * @property {string} id - Item ID
 * @property {string} name - Item name
 * @property {string} description - Item description
 * @property {'consumable'|'cosmetic'|'boost'|'totem'} type - Item type
 * @property {ItemPrice} price - Price in currencies
 * @property {boolean} available - Whether item is available
 * @property {Object} [requirements] - Requirements to purchase
 */

/**
 * @typedef {Object} ItemPrice
 * @property {number} [essence] - Price in essence
 * @property {number} [gems] - Price in gems
 */

/**
 * @typedef {Object} PurchaseResult
 * @property {boolean} success - Whether purchase succeeded
 * @property {ShopItem} item - Purchased item
 * @property {UserCurrencies} newBalances - Updated currency balances
 */

// ============================================
// REWARDS TYPES
// ============================================

/**
 * @typedef {Object} RewardStatus
 * @property {DailyRewardStatus} daily - Daily reward status
 * @property {WeeklyRewardStatus} weekly - Weekly reward status
 * @property {number} loginStreak - Current login streak
 */

/**
 * @typedef {Object} DailyRewardStatus
 * @property {boolean} claimed - Whether claimed today
 * @property {Object} reward - Today's reward details
 * @property {string} nextClaimTime - When next claim available (ISO timestamp)
 */

/**
 * @typedef {Object} WeeklyRewardStatus
 * @property {boolean} claimed - Whether claimed this week
 * @property {number} progress - Days completed this week (0-7)
 * @property {Object} reward - Weekly reward details
 */

/**
 * @typedef {Object} ClaimResult
 * @property {boolean} success - Whether claim succeeded
 * @property {Object} reward - Claimed reward
 * @property {UserCurrencies} newBalances - Updated currency balances
 * @property {number} [newStreak] - Updated login streak
 */

// ============================================
// EXPEDITION TYPES
// ============================================

/**
 * @typedef {Object} Expedition
 * @property {string} id - Expedition ID
 * @property {string} name - Expedition name
 * @property {string} description - Expedition description
 * @property {number} durationMinutes - Duration in minutes
 * @property {ExpeditionRequirements} requirements - Requirements
 * @property {ExpeditionRewards} rewards - Potential rewards
 */

/**
 * @typedef {Object} ActiveExpedition
 * @property {string} id - Active expedition instance ID
 * @property {string} expeditionId - Expedition type ID
 * @property {string[]} totemIds - Totems on expedition
 * @property {string} startedAt - Start time (ISO timestamp)
 * @property {string} completesAt - Completion time (ISO timestamp)
 * @property {boolean} canClaim - Whether ready to claim
 */

module.exports = {
  // Export for documentation purposes
  // Types are used via JSDoc comments
};
