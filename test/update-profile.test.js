/**
 * Update Profile Handler Tests — focused on bio/avatar/banner additions.
 *
 * Display name + settings paths are covered indirectly by existing tests.
 */

jest.mock('../src/common/db-client', () => ({
  getUser: jest.fn(),
  updateUser: jest.fn(),
  getUserTotems: jest.fn(),
}));

jest.mock('../src/common/profanity', () => ({
  containsProfanity: jest.fn(() => false),
}));

const db = require('../src/common/db-client');
const { updateProfile } = require('../src/functions/user/update-profile');

const userCtx = { userId: 'usr_test' };

const baseUser = {
  id: 'usr_test',
  email: 'test@example.com',
  displayName: 'Player',
  currencies: { essence: 100, gems: 0 },
  stats: { totalTotems: 1, totalChallengesCompleted: 0, loginStreak: 0 },
  settings: { notifications: true, darkMode: 'dark' },
  profile: undefined, // pre-feature user
};

beforeEach(() => {
  jest.clearAllMocks();
  db.getUser.mockResolvedValue(baseUser);
  db.getUserTotems.mockResolvedValue([
    { speciesId: 0, colorId: 4, stage: 3 },
  ]);
  db.updateUser.mockImplementation(async (_id, updates) => ({
    ...baseUser,
    profile: updates.profile ?? baseUser.profile,
  }));
});

describe('updateProfile — profile sub-object', () => {
  it('writes the whole profile map atomically (lazy create)', async () => {
    await updateProfile(userCtx, {
      bio: 'A short bio',
      avatar: { kind: 'domain', id: 2 },
      banner: { kind: 'domain', id: 0 },
    });

    expect(db.updateUser).toHaveBeenCalledWith('usr_test', expect.objectContaining({
      profile: {
        bio: 'A short bio',
        avatar: { kind: 'domain', id: 2 },
        banner: { kind: 'domain', id: 0 },
      },
    }));
  });

  it('preserves untouched profile fields when patching one field', async () => {
    db.getUser.mockResolvedValue({
      ...baseUser,
      profile: { bio: 'old bio', avatar: { kind: 'domain', id: 1 }, banner: null },
    });

    await updateProfile(userCtx, { bio: 'new bio' });

    expect(db.updateUser).toHaveBeenCalledWith('usr_test', expect.objectContaining({
      profile: {
        bio: 'new bio',
        avatar: { kind: 'domain', id: 1 },
        banner: null,
      },
    }));
  });

  it('rejects bio with embedded link', async () => {
    const result = await updateProfile(userCtx, { bio: 'visit https://evil.com' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('rejects avatar referencing a totem the user does not own', async () => {
    db.getUserTotems.mockResolvedValue([]); // no totems
    const result = await updateProfile(userCtx, {
      avatar: { kind: 'totem', speciesId: 0, colorId: 4, stage: 0 },
    });
    expect(result.success).toBe(false);
    expect(result.error.message).toMatch(/do not own/i);
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('rejects avatar stage above totem\'s current stage', async () => {
    // Totem is stage 3; user requests stage 4
    const result = await updateProfile(userCtx, {
      avatar: { kind: 'totem', speciesId: 0, colorId: 4, stage: 4 },
    });
    expect(result.success).toBe(false);
    expect(result.error.message).toMatch(/exceeds/i);
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('accepts avatar at a stage <= the totem\'s current stage', async () => {
    const result = await updateProfile(userCtx, {
      avatar: { kind: 'totem', speciesId: 0, colorId: 4, stage: 1 },
    });
    expect(result.success).toBe(true);
    expect(db.updateUser).toHaveBeenCalled();
  });

  it('accepts null to clear bio/avatar/banner', async () => {
    db.getUser.mockResolvedValue({
      ...baseUser,
      profile: { bio: 'something', avatar: { kind: 'domain', id: 0 }, banner: { kind: 'domain', id: 0 } },
    });

    await updateProfile(userCtx, { bio: null, avatar: null, banner: null });

    expect(db.updateUser).toHaveBeenCalledWith('usr_test', expect.objectContaining({
      profile: { bio: null, avatar: null, banner: null },
    }));
  });

  it('rejects banner referencing a totem (banner is domain-only)', async () => {
    const result = await updateProfile(userCtx, {
      banner: { kind: 'totem', speciesId: 0, colorId: 4, stage: 0 },
    });
    expect(result.success).toBe(false);
    expect(db.updateUser).not.toHaveBeenCalled();
  });
});
