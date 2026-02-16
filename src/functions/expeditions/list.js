/**
 * Expeditions List Handler
 *
 * GET /api/expeditions/list
 *
 * Returns all 15 expedition definitions with their configurations.
 */

const { getAllExpeditions } = require('../../services/expeditions-service');

/**
 * Get all expedition definitions
 *
 * @param {object} user - Authenticated user { userId } (optional, for future personalization)
 * @returns {object} - List of all expedition definitions
 */
function listExpeditionsHandler(_user) {
  try {
    // 1. Get all expedition definitions
    const expeditions = getAllExpeditions();

    // 2. Group by duration tier
    const quick = [];      // 30 min
    const medium = [];     // 3 hr
    const long = [];       // 6 hr
    const extended = [];   // 12 hr
    const epic = [];       // 24 hr

    expeditions.forEach((exp) => {
      const expeditionData = {
        id: exp.id,
        name: exp.name,
        description: exp.description,
        durationMinutes: exp.durationMinutes,
        durationDisplay: formatDuration(exp.durationMinutes),
        rewardRange: {
          min: exp.rewardMin,
          max: exp.rewardMax,
        },
        bonusChance: exp.bonusChance,
        requiredStage: exp.requiredStage,
        tier: getTier(exp.durationMinutes),
      };

      switch (exp.durationMinutes) {
        case 30:
          quick.push(expeditionData);
          break;
        case 180:
          medium.push(expeditionData);
          break;
        case 360:
          long.push(expeditionData);
          break;
        case 720:
          extended.push(expeditionData);
          break;
        case 1440:
          epic.push(expeditionData);
          break;
        default:
          // Handle any unexpected durations
          if (exp.durationMinutes < 60) {
            quick.push(expeditionData);
          }
          else if (exp.durationMinutes < 240) {
            medium.push(expeditionData);
          }
          else if (exp.durationMinutes < 480) {
            long.push(expeditionData);
          }
          else if (exp.durationMinutes < 960) {
            extended.push(expeditionData);
          }
          else {
            epic.push(expeditionData);
          }
      }
    });

    // 3. Build response with all expeditions and grouped view
    return {
      success: true,
      data: {
        expeditions: expeditions.map((exp) => ({
          id: exp.id,
          name: exp.name,
          description: exp.description,
          durationMinutes: exp.durationMinutes,
          durationDisplay: formatDuration(exp.durationMinutes),
          rewardRange: {
            min: exp.rewardMin,
            max: exp.rewardMax,
          },
          bonusChance: exp.bonusChance,
          requiredStage: exp.requiredStage,
          tier: getTier(exp.durationMinutes),
        })),
        byTier: {
          quick,
          medium,
          long,
          extended,
          epic,
        },
        summary: {
          totalExpeditions: expeditions.length,
          tierCounts: {
            quick: quick.length,
            medium: medium.length,
            long: long.length,
            extended: extended.length,
            epic: epic.length,
          },
        },
      },
    };
  }
  catch (err) {
    console.error('Failed to list expeditions:', err);
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve expedition list' },
    };
  }
}

/**
 * Format duration in minutes to human-readable string
 * @param {number} minutes - Duration in minutes
 * @returns {string} - Formatted duration (e.g., "30 min", "3 hr", "24 hr")
 */
function formatDuration(minutes) {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `${hours} hr`;
  }
  return `${hours} hr ${remainingMinutes} min`;
}

/**
 * Get tier name based on duration
 * @param {number} minutes - Duration in minutes
 * @returns {string} - Tier name
 */
function getTier(minutes) {
  if (minutes <= 30) return 'quick';
  if (minutes <= 180) return 'medium';
  if (minutes <= 360) return 'long';
  if (minutes <= 720) return 'extended';
  return 'epic';
}

module.exports = { listExpeditionsHandler };
