/**
 * User API Handlers
 *
 * Handles user profile operations:
 * - GET /api/user/profile - Get current user's profile
 * - PUT /api/user/profile - Update profile settings
 */

const { getProfile } = require('./get-profile');
const { updateProfile } = require('./update-profile');

module.exports = {
  getProfile,
  updateProfile,
};
