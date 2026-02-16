/**
 * Update User Profile Handler
 *
 * PUT /api/user/profile
 *
 * Allows users to update their profile settings:
 * - displayName
 * - settings (notifications, darkMode, soundEffects, language)
 *
 * Protected fields (cannot be updated via this endpoint):
 * - id, email (immutable)
 * - tier (managed by subscription system)
 * - currencies (managed by game actions)
 * - stats (managed by game system)
 */

const { getUser, updateUser } = require('../../common/db-client');

// Allowed fields for user self-service updates
const ALLOWED_FIELDS = ['displayName'];
const ALLOWED_SETTINGS = ['notifications', 'darkMode', 'soundEffects', 'language'];

// Validation rules
const VALIDATION_RULES = {
  displayName: {
    minLength: 2,
    maxLength: 30,
    pattern: /^[a-zA-Z0-9_\-\s]+$/,
    error: 'Display name must be 2-30 characters and contain only letters, numbers, spaces, underscores, or hyphens',
  },
  darkMode: {
    allowedValues: ['system', 'light', 'dark'],
    error: 'Dark mode must be "system", "light", or "dark"',
  },
  language: {
    allowedValues: ['en', 'es', 'fr', 'de', 'ja', 'zh'],
    error: 'Invalid language code',
  },
};

/**
 * Validate a single field value
 */
function validateField(field, value) {
  const rule = VALIDATION_RULES[field];
  if (!rule) return { valid: true };

  if (rule.minLength && value.length < rule.minLength) {
    return { valid: false, error: rule.error };
  }
  if (rule.maxLength && value.length > rule.maxLength) {
    return { valid: false, error: rule.error };
  }
  if (rule.pattern && !rule.pattern.test(value)) {
    return { valid: false, error: rule.error };
  }
  if (rule.allowedValues && !rule.allowedValues.includes(value)) {
    return { valid: false, error: rule.error };
  }

  return { valid: true };
}

/**
 * Update user profile
 *
 * @param {Object} user - Authenticated user from JWT middleware
 * @param {Object} body - Request body with fields to update
 * @returns {Object} Updated profile data with success flag
 */
async function updateProfile(user, body) {
  try {
    const userId = user.userId;
    console.log('[updateProfile] userId:', userId, 'updates:', Object.keys(body));

    // Get current user to verify existence
    const existingUser = await getUser(userId);
    if (!existingUser) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' },
      };
    }

    // Build update object from allowed fields
    const updates = {};
    const errors = [];

    // Process top-level allowed fields
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) {
        const validation = validateField(field, body[field]);
        if (!validation.valid) {
          errors.push(validation.error);
        }
        else {
          updates[field] = body[field];
        }
      }
    }

    // Process settings updates
    if (body.settings && typeof body.settings === 'object') {
      for (const setting of ALLOWED_SETTINGS) {
        if (body.settings[setting] !== undefined) {
          const validation = validateField(setting, body.settings[setting]);
          if (!validation.valid) {
            errors.push(validation.error);
          }
          else {
            // Use dot notation for nested updates
            updates[`settings.${setting}`] = body.settings[setting];
          }
        }
      }
    }

    // Return validation errors if any
    if (errors.length > 0) {
      return {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: errors.join('; ') },
      };
    }

    // Check if there's anything to update
    if (Object.keys(updates).length === 0) {
      return {
        success: false,
        error: { code: 'NO_CHANGES', message: 'No valid fields to update' },
      };
    }

    // Perform the update
    const updatedUser = await updateUser(userId, updates);

    // Build response with updated values
    const response = {
      id: updatedUser.id,
      email: updatedUser.email,
      displayName: updatedUser.displayName,
      tier: updatedUser.tier || 'free',
      currencies: {
        essence: updatedUser.currencies?.essence || 0,
        gems: updatedUser.currencies?.gems || 0,
      },
      stats: {
        totalTotems: updatedUser.stats?.totalTotems || 0,
        totalChallengesCompleted: updatedUser.stats?.totalChallengesCompleted || 0,
        loginStreak: updatedUser.stats?.loginStreak || 0,
        lastLoginDate: updatedUser.stats?.lastLoginDate || null,
      },
      settings: {
        notifications: updatedUser.settings?.notifications !== false,
        darkMode: updatedUser.settings?.darkMode || 'dark',
        soundEffects: updatedUser.settings?.soundEffects !== false,
        language: updatedUser.settings?.language || 'en',
      },
      updatedAt: updatedUser.updatedAt,
    };

    return {
      success: true,
      data: response,
    };
  }
  catch (error) {
    console.error('Error updating user profile:', error);
    throw error;
  }
}

module.exports = { updateProfile };
