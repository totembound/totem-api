/**
 * Achievements API Handler
 *
 * GET /api/achievements - Returns user's achievement progress
 *
 * Response format expected by frontend:
 * {
 *   achievements: {
 *     "ach_collector-progression": [
 *       { unlocked: true, progress: 1 },
 *       { unlocked: false, progress: 1 },
 *       ...
 *     ],
 *     ...
 *   }
 * }
 */

const {
  getAllAchievementProgress,
  ACHIEVEMENT_MILESTONES,
  ONETIME_ACHIEVEMENTS,
} = require('../../services/achievements-service');

/**
 * Get all achievements with user progress
 * @param {object} user - Authenticated user { userId, email, displayName, tier }
 * @returns {Promise<{ success: boolean, data: { achievements: Record<string, Array> } }>}
 */
async function getAchievements(user) {
  try {
    // Get user's progress from DynamoDB
    const progressRecords = await getAllAchievementProgress(user.userId);

    // Build progress map by achievement ID
    const progressByAchId = {};
    for (const record of progressRecords) {
      progressByAchId[record.achievementId] = record;
    }

    // Build response in format expected by frontend
    const achievements = {};

    // Process progression achievements (with milestones)
    for (const [achId, milestoneThresholds] of Object.entries(ACHIEVEMENT_MILESTONES)) {
      const progress = progressByAchId[achId];
      const currentValue = progress?.currentValue || 0;
      const unlockedMilestones = progress?.milestones || [];

      // Build milestones array
      achievements[achId] = milestoneThresholds.map((threshold, index) => {
        const isUnlocked = unlockedMilestones.some(m => m.index === index);
        return {
          unlocked: isUnlocked,
          progress: currentValue,
        };
      });
    }

    // Process one-time achievements
    for (const achId of ONETIME_ACHIEVEMENTS) {
      const progress = progressByAchId[achId];
      const isComplete = progress?.isComplete || false;

      // One-time achievements have a single "milestone"
      achievements[achId] = [{
        unlocked: isComplete,
        progress: isComplete ? 1 : 0,
      }];
    }

    return {
      success: true,
      data: { achievements },
    };
  }
  catch (error) {
    console.error('[Achievements] Error fetching achievements:', error);
    return {
      success: false,
      error: {
        code: 'FETCH_ERROR',
        message: 'Failed to fetch achievements',
      },
    };
  }
}

/**
 * Check a specific achievement (used by frontend to verify requirements)
 * @param {object} user - Authenticated user
 * @param {string} achievementId - Achievement ID to check
 * @returns {Promise<{ success: boolean, data: { requirementsMet: boolean } }>}
 */
async function checkAchievement(user, achievementId) {
  try {
    // For now, just return that requirements are met
    // In the future, this could check prerequisite achievements
    return {
      success: true,
      data: {
        requirementsMet: true,
        achievementId,
      },
    };
  }
  catch (error) {
    console.error(`[Achievements] Error checking ${achievementId}:`, error);
    return {
      success: false,
      error: {
        code: 'CHECK_ERROR',
        message: 'Failed to check achievement',
      },
    };
  }
}

module.exports = {
  getAchievements,
  checkAchievement,
};
