/**
 * Update User Profile Handler
 *
 * PUT /api/user/profile
 *
 * Allows users to update their profile settings:
 * - displayName
 * - settings (notifications, darkMode, soundEffects, language)
 * - profile.bio, profile.avatar, profile.banner
 *
 * Protected fields (cannot be updated via this endpoint):
 * - id, email (immutable)
 * - tier (managed by subscription system)
 * - currencies (managed by game actions)
 * - stats (managed by game system)
 */

const { getUser, updateUser, getUserTotems } = require('../../common/db-client');
const {
  validateBio,
  validateAvatar,
  validateBanner,
} = require('../../common/profile-validation');

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
 * Verify the user owns a totem matching speciesId+colorId and has reached the
 * requested stage. Returns null if valid, or an error message string.
 *
 * Why this lives in the handler not the validator: it requires DB access. The
 * pure validators in profile-validation.js stay synchronous and DB-free.
 */
async function authorizeTotemAvatar(userId, avatar) {
  if (!avatar || avatar.kind !== 'totem') return null;
  const totems = await getUserTotems(userId);
  const owned = totems.find(t =>
    t.speciesId === avatar.speciesId && t.colorId === avatar.colorId,
  );
  if (!owned) return 'You do not own a totem matching that avatar';
  if ((owned.stage ?? 0) < avatar.stage) {
    return 'Selected stage exceeds your totem\'s current stage';
  }
  return null;
}

async function updateProfile(user, body) {
  try {
    const userId = user.userId;
    console.log('[updateProfile] userId:', userId, 'updates:', Object.keys(body));

    const existingUser = await getUser(userId);
    if (!existingUser) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' },
      };
    }

    const updates = {};
    const errors = [];

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

    if (body.settings && typeof body.settings === 'object') {
      for (const setting of ALLOWED_SETTINGS) {
        if (body.settings[setting] !== undefined) {
          const validation = validateField(setting, body.settings[setting]);
          if (!validation.valid) {
            errors.push(validation.error);
          }
          else {
            updates[`settings.${setting}`] = body.settings[setting];
          }
        }
      }
    }

    // Profile sub-object: bio, avatar, banner.
    // Set the whole `profile` map at once (atomic, sidesteps "parent map missing"
    // errors with nested SET on absent maps for users who pre-date this feature).
    const wantsProfileUpdate = body.bio !== undefined
      || body.avatar !== undefined
      || body.banner !== undefined;

    if (wantsProfileUpdate) {
      const currentProfile = existingUser.profile || {};
      const nextProfile = {
        bio: currentProfile.bio ?? null,
        avatar: currentProfile.avatar ?? null,
        banner: currentProfile.banner ?? null,
      };

      if (body.bio !== undefined) {
        const r = validateBio(body.bio);
        if (!r.valid) errors.push(r.message);
        else nextProfile.bio = r.value;
      }
      if (body.avatar !== undefined) {
        const r = validateAvatar(body.avatar);
        if (!r.valid) {
          errors.push(r.message);
        }
        else {
          const ownershipErr = await authorizeTotemAvatar(userId, r.value);
          if (ownershipErr) errors.push(ownershipErr);
          else nextProfile.avatar = r.value;
        }
      }
      if (body.banner !== undefined) {
        const r = validateBanner(body.banner);
        if (!r.valid) errors.push(r.message);
        else nextProfile.banner = r.value;
      }

      if (errors.length === 0) {
        updates.profile = nextProfile;
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: errors.join('; ') },
      };
    }

    if (Object.keys(updates).length === 0) {
      return {
        success: false,
        error: { code: 'NO_CHANGES', message: 'No valid fields to update' },
      };
    }

    const updatedUser = await updateUser(userId, updates);

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
      profile: {
        bio: updatedUser.profile?.bio ?? null,
        avatar: updatedUser.profile?.avatar ?? null,
        banner: updatedUser.profile?.banner ?? null,
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
