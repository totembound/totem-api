/**
 * Public Profile Handler Tests
 *
 * Verifies that GET /v1/players/:userId/public returns ONLY whitelisted
 * fields and never leaks private data (email, currencies, settings, etc).
 */

jest.mock('../src/common/db-client', () => ({
  getUser: jest.fn(),
  getUserTotems: jest.fn(),
}));

const db = require('../src/common/db-client');
const { getPublicProfile } = require('../src/functions/user/get-public-profile');

const baseUser = {
  id: 'usr_abc123',
  email: 'private@example.com',
  displayName: 'CoolPlayer',
  tier: 'premium',
  role: 'admin',
  status: 'active',
  oauthProvider: 'google',
  oauthProviderId: 'google-internal-id',
  currencies: { essence: 9999, gems: 500 },
  settings: { notifications: true, darkMode: 'dark', language: 'en' },
  stats: { totalTotems: 5, totalChallengesCompleted: 12, loginStreak: 30, bestLoginStreak: 42 },
  profile: {
    bio: 'Hello there 🦊',
    avatar: { kind: 'domain', id: 2 },
    banner: { kind: 'domain', id: 0 },
  },
  displayNameChangeReadyAt: '2026-05-01T00:00:00.000Z',
  createdAt: '2025-01-15T10:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  db.getUser.mockResolvedValue(baseUser);
  db.getUserTotems.mockResolvedValue([
    { stage: 1 }, { stage: 3 }, { stage: 0 }, { stage: 2 }, { stage: 4 },
  ]);
});

describe('getPublicProfile — happy path', () => {
  it('returns whitelisted fields only', async () => {
    const result = await getPublicProfile('usr_abc123');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: 'usr_abc123',
      displayName: 'CoolPlayer',
      createdAt: '2025-01-15T10:00:00.000Z',
      tier: 'premium',
      profile: {
        bio: 'Hello there 🦊',
        avatar: { kind: 'domain', id: 2 },
        banner: { kind: 'domain', id: 0 },
      },
      stats: {
        totalTotems: 5,
        totalChallengesCompleted: 12,
        bestLoginStreak: 42,
        highestStageReached: 4, // max of [1,3,0,2,4]
      },
    });
  });

  it('does NOT leak private fields', async () => {
    const result = await getPublicProfile('usr_abc123');
    const json = JSON.stringify(result);

    expect(json).not.toContain('private@example.com');
    // Note: 'premium' IS exposed (whitelisted tier field for badge display)
    expect(json).not.toContain('admin');
    expect(json).not.toContain('9999');
    expect(json).not.toContain('500');
    expect(json).not.toContain('darkMode');
    expect(json).not.toContain('loginStreak');
    expect(json).not.toContain('oauthProvider');
    expect(json).not.toContain('google-internal-id');
    expect(json).not.toContain('displayNameChangeReadyAt');
  });

  it('returns null defaults when profile sub-object is absent', async () => {
    db.getUser.mockResolvedValue({
      ...baseUser,
      profile: undefined,
    });

    const result = await getPublicProfile('usr_abc123');
    expect(result.success).toBe(true);
    expect(result.data.profile).toEqual({ bio: null, avatar: null, banner: null });
  });

  it('falls back to stored stats.totalTotems if totem query fails', async () => {
    db.getUserTotems.mockRejectedValue(new Error('DDB down'));

    const result = await getPublicProfile('usr_abc123');
    expect(result.success).toBe(true);
    expect(result.data.stats.totalTotems).toBe(5);
    // highestStageReached defaults to 0 when totem query fails
    expect(result.data.stats.highestStageReached).toBe(0);
  });
});

describe('getPublicProfile — error paths', () => {
  it('returns NOT_FOUND for unknown user', async () => {
    db.getUser.mockResolvedValue(null);
    const result = await getPublicProfile('usr_unknown');
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed userId without hitting DB', async () => {
    const result = await getPublicProfile('not-a-user-id');
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(db.getUser).not.toHaveBeenCalled();
  });

  it('rejects non-string userId', async () => {
    const result = await getPublicProfile(undefined);
    expect(result.success).toBe(false);
    expect(db.getUser).not.toHaveBeenCalled();
  });
});
