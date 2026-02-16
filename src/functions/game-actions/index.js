/**
 * Game Actions API Handlers
 *
 * Routes:
 * - POST /api/game-actions/feed - Feed a totem
 * - POST /api/game-actions/train - Train a totem
 * - POST /api/game-actions/treat - Give a totem a treat
 * - POST /api/game-actions/evolve - Evolve a totem
 * - GET /api/game-actions/evolution-status/:totemId - Get evolution status
 * - GET /api/game-actions/cooldowns/:totemId - Get all cooldown statuses
 */

const { feed } = require('./feed');
const { train } = require('./train');
const { treat } = require('./treat');
const { evolve, getEvolutionStatus } = require('./evolve');
const { getTotem, updateTotem } = require('../../common/db-client');
const { checkCooldown, checkFeedTimeWindow, getNextEvolutionRequirements, getStageName } = require('./helpers');

/**
 * Sanitize user input for safe storage
 * - Removes control characters
 * - Normalizes whitespace (collapses multiple spaces)
 * Note: HTML encoding not needed here because:
 *   1. Whitelist regex blocks HTML chars at validation step
 *   2. React auto-escapes when rendering
 */
function sanitizeUserInput(input) {
  if (!input || typeof input !== 'string') return input;

  return input
    // Remove control characters (except space)
    .replace(/[\x00-\x1f\x7f]/g, '') // eslint-disable-line no-control-regex
    // Normalize whitespace (collapse multiple spaces to single)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Set nickname for a totem
 */
async function setNickname(user, totemId, nickname) {
  const userId = user.userId;

  // 1. Validate totemId format
  if (!totemId || !totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 2. Validate and sanitize nickname
  if (nickname !== null && nickname !== undefined) {
    if (typeof nickname !== 'string') {
      return {
        success: false,
        error: { code: 'INVALID_NICKNAME', message: 'Nickname must be a string' },
      };
    }

    const trimmedNickname = nickname.trim();

    if (trimmedNickname.length > 0 && trimmedNickname.length < 2) {
      return {
        success: false,
        error: { code: 'INVALID_NICKNAME', message: 'Nickname must be at least 2 characters' },
      };
    }

    if (trimmedNickname.length > 20) {
      return {
        success: false,
        error: { code: 'INVALID_NICKNAME', message: 'Nickname must be 20 characters or less' },
      };
    }

    // Whitelist: only allow safe characters (blocks HTML injection at source)
    if (trimmedNickname.length > 0 && !/^[a-zA-Z0-9_\-\s]+$/.test(trimmedNickname)) {
      return {
        success: false,
        error: { code: 'INVALID_NICKNAME', message: 'Nickname can only contain letters, numbers, spaces, underscores, or hyphens' },
      };
    }
  }

  // 3. Get totem from database (verify ownership)
  const totem = await getTotem(userId, totemId);

  if (!totem) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Totem not found' },
    };
  }

  // 4. Sanitize and save nickname (updatedAt is auto-added by updateItem)
  const rawNickname = nickname?.trim() || null;
  const newNickname = rawNickname ? sanitizeUserInput(rawNickname) : null;

  await updateTotem(userId, totemId, {
    nickname: newNickname,
  });

  return {
    success: true,
    data: {
      totemId,
      nickname: newNickname,
    },
  };
}

/**
 * Get all cooldown statuses for a totem
 */
async function getCooldowns(user, totemId) {
  const userId = user.userId;

  // 1. Validate totemId format
  if (!totemId || !totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 2. Get totem from database
  const totem = await getTotem(userId, totemId);

  if (!totem) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Totem not found' },
    };
  }

  // 3. Check all cooldowns
  const isPremium = user.tier === 'premium' || user.tier === 'vip';

  // Feed uses time windows, not traditional cooldowns
  const feedTimeWindow = checkFeedTimeWindow(totem.feedHistory || []);
  const trainCooldown = checkCooldown(totem.cooldowns?.train, 'train', isPremium);
  const treatCooldown = checkCooldown(totem.cooldowns?.treat, 'treat', isPremium);

  return {
    success: true,
    data: {
      totemId: totem.id,
      cooldowns: {
        feed: {
          onCooldown: !feedTimeWindow.canFeed,
          readyAt: feedTimeWindow.remainingMs > 0
            ? new Date(Date.now() + feedTimeWindow.remainingMs).toISOString()
            : null,
          remainingMs: feedTimeWindow.remainingMs || 0,
          reason: feedTimeWindow.reason || null,
        },
        train: {
          onCooldown: trainCooldown.onCooldown,
          readyAt: trainCooldown.readyAt?.toISOString() || null,
          remainingMs: trainCooldown.remainingMs,
        },
        treat: {
          onCooldown: treatCooldown.onCooldown,
          readyAt: treatCooldown.readyAt?.toISOString() || null,
          remainingMs: treatCooldown.remainingMs,
        },
      },
    },
  };
}

/**
 * Get totem status summary (for dashboard)
 */
async function getTotemStatus(user, totemId) {
  const userId = user.userId;

  // 1. Validate totemId format
  if (!totemId || !totemId.startsWith('ttm_')) {
    return {
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid totem ID format' },
    };
  }

  // 2. Get totem from database
  const totem = await getTotem(userId, totemId);

  if (!totem) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Totem not found' },
    };
  }

  // 3. Build status
  const isPremium = user.tier === 'premium' || user.tier === 'vip';
  const currentStage = totem.stage || 0;
  const nextRequirements = getNextEvolutionRequirements(currentStage);

  const feedCooldown = checkCooldown(totem.cooldowns?.feed, 'feed', isPremium);
  const trainCooldown = checkCooldown(totem.cooldowns?.train, 'train', isPremium);
  const treatCooldown = checkCooldown(totem.cooldowns?.treat, 'treat', isPremium);

  return {
    success: true,
    data: {
      totemId: totem.id,
      name: totem.name,
      stage: currentStage,
      stageName: getStageName(currentStage),
      experience: totem.experience || 0,
      stats: totem.stats,
      actions: {
        feed: { available: !feedCooldown.onCooldown, readyAt: feedCooldown.readyAt?.toISOString() },
        train: { available: !trainCooldown.onCooldown, readyAt: trainCooldown.readyAt?.toISOString() },
        treat: { available: !treatCooldown.onCooldown, readyAt: treatCooldown.readyAt?.toISOString() },
      },
      evolution: nextRequirements
        ? {
          nextStage: currentStage + 1,
          nextStageName: getStageName(currentStage + 1),
          requirements: nextRequirements,
          progress: {
            experience: {
              current: totem.experience || 0,
              required: nextRequirements.experience,
              percent: Math.min(100, Math.floor(((totem.experience || 0) / nextRequirements.experience) * 100)),
            },
            happiness: {
              current: totem.stats?.happiness || 0,
              required: nextRequirements.happiness,
              met: (totem.stats?.happiness || 0) >= nextRequirements.happiness,
            },
          },
        }
        : { maxStageReached: true },
    },
  };
}

module.exports = {
  feed,
  train,
  treat,
  evolve,
  getEvolutionStatus,
  getCooldowns,
  getTotemStatus,
  setNickname,
};
