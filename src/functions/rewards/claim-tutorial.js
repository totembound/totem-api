/**
 * Claim Tutorial Reward Handler
 *
 * POST /api/rewards/tutorial
 *
 * Allows users to claim rewards for completing tutorial steps.
 * Each step can only be claimed once.
 *
 * Request body:
 *   - step: number (1-6) - The tutorial step to claim
 *   - totemId?: string - Required for steps 2-5 (awards XP to totem)
 *
 * Tutorial Steps:
 *   1. Signup         - 25 Essence
 *   2. Mint Totem     - 50 Essence + 100 XP (requires totemId)
 *   3. Care for Totem - 20 Essence + 150 XP (requires totemId)
 *   4. Challenge      - 30 Essence + 200 XP (requires totemId)
 *   5. Evolve         - 25 Essence + 250 XP (requires totemId)
 *   6. Explore        - 200 Essence
 */

const rewardsService = require('../../services/rewards-service');

/**
 * Claim tutorial reward for authenticated user
 *
 * @param {object} user - Authenticated user { userId, tier }
 * @param {object} body - Request body { step, totemId? }
 * @returns {object} - Claim result
 *
 * @example Success Response:
 * {
 *   success: true,
 *   data: {
 *     reward: {
 *       step: 2,
 *       id: "rwd_tutorial-2-mint",
 *       name: "Step into the Spirit World",
 *       essenceReward: 50,
 *       experienceReward: 100
 *     },
 *     newBalance: 150,
 *     totemId: "totem_abc123",
 *     totemExperience: 100,
 *     message: "Tutorial reward claimed! +50 Essence, +100 XP"
 *   }
 * }
 *
 * @example Error Response (already claimed):
 * {
 *   success: false,
 *   error: {
 *     code: "ALREADY_CLAIMED",
 *     message: "Tutorial step 2 has already been claimed"
 *   }
 * }
 */
async function claimTutorial(user, body = {}) {
  // 1. Validate user authentication
  if (!user || !user.userId) {
    return {
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'User authentication required',
      },
    };
  }

  const userId = user.userId;
  const { step, totemId } = body;

  // 2. Validate step parameter
  if (step === undefined || step === null) {
    return {
      success: false,
      error: {
        code: 'MISSING_STEP',
        message: 'Tutorial step is required',
      },
    };
  }

  const stepNum = parseInt(step, 10);
  if (isNaN(stepNum) || stepNum < 1 || stepNum > 6) {
    return {
      success: false,
      error: {
        code: 'INVALID_STEP',
        message: 'Tutorial step must be a number between 1 and 6',
      },
    };
  }

  try {
    // 3. Call rewards service to claim tutorial reward
    const result = await rewardsService.claimTutorialReward(userId, stepNum, totemId || null);

    // 4. Handle service errors
    if (!result.success) {
      // Determine error code based on error message
      let errorCode = 'CLAIM_FAILED';
      if (result.error.includes('already been claimed')) {
        errorCode = 'ALREADY_CLAIMED';
      }
      else if (result.error.includes('requires a totemId')) {
        errorCode = 'TOTEM_REQUIRED';
      }
      else if (result.error.includes('not found')) {
        errorCode = 'NOT_FOUND';
      }
      else if (result.error.includes('Invalid tutorial step')) {
        errorCode = 'INVALID_STEP';
      }

      return {
        success: false,
        error: {
          code: errorCode,
          message: result.error,
        },
      };
    }

    // 5. Build success message
    const reward = result.reward;
    let message = `Tutorial reward claimed! +${reward.essenceReward} Essence`;
    if (reward.experienceReward > 0) {
      message += `, +${reward.experienceReward} XP`;
    }

    // 6. Return success response
    return {
      success: true,
      data: {
        reward: result.reward,
        newBalance: result.newBalance,
        totemId: result.totemId,
        totemExperience: result.totemExperience,
        message,
      },
    };
  }
  catch (error) {
    console.error('[claimTutorial] Error:', error);
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while claiming tutorial reward',
      },
    };
  }
}

/**
 * Get tutorial progress for authenticated user
 *
 * GET /api/rewards/tutorial/progress
 *
 * @param {object} user - Authenticated user { userId, tier }
 * @returns {object} - Tutorial progress
 *
 * @example Success Response:
 * {
 *   success: true,
 *   data: {
 *     completedSteps: [1, 2],
 *     totalSteps: 6,
 *     nextStep: 3,
 *     rewards: {
 *       1: { step: 1, name: "...", claimed: true, claimedAt: "..." },
 *       2: { step: 2, name: "...", claimed: true, claimedAt: "..." },
 *       ...
 *     },
 *     totalEssenceEarned: 75,
 *     totalExperienceEarned: 100
 *   }
 * }
 */
async function getTutorialProgress(user) {
  // 1. Validate user authentication
  if (!user || !user.userId) {
    return {
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'User authentication required',
      },
    };
  }

  const userId = user.userId;

  try {
    // 2. Call rewards service to get tutorial progress
    const result = await rewardsService.getTutorialProgress(userId);

    // 3. Handle service errors
    if (!result.success) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: result.error || 'Failed to get tutorial progress',
        },
      };
    }

    // 4. Return success response
    return {
      success: true,
      data: {
        completedSteps: result.completedSteps,
        totalSteps: result.totalSteps,
        nextStep: result.nextStep,
        rewards: result.rewards,
        totalEssenceEarned: result.totalEssenceEarned,
        totalExperienceEarned: result.totalExperienceEarned,
      },
    };
  }
  catch (error) {
    console.error('[getTutorialProgress] Error:', error);
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while fetching tutorial progress',
      },
    };
  }
}

module.exports = {
  claimTutorial,
  getTutorialProgress,
};
