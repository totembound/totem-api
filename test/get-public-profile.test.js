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

// Mock the challenges-service module so we can control the live progress
// sum without standing up CHALLENGE_PROGRESS table fixtures.
jest.mock('../src/services/challenges-service', () => ({
  getAllChallengeProgress: jest.fn(),
}));

// Mock rewards-service so we can drive bestDailyStreak directly from the
// RewardsClaims STREAK#daily.longestStreak surface.
jest.mock('../src/services/rewards-service', () => ({
  getStreakState: jest.fn(),
}));

const db = require('../src/common/db-client');
const challengesService = require('../src/services/challenges-service');
const rewardsService = require('../src/services/rewards-service');
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
  // stats.totalChallengesCompleted is intentionally low here — the live sum
  // from getAllChallengeProgress (mocked below) overrides it.
  stats: { totalTotems: 5, totalChallengesCompleted: 0 },
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
    { stage: 1 }, { stage: 3 }, { stage: 0 }, { stage: 2 }, { stage: 4, experience: 7500 },
  ]);
  // Default: 12 completions split across 3 progress records (matches what the
  // legacy stat field used to report).
  challengesService.getAllChallengeProgress.mockResolvedValue([
    { challengeId: 'chl_garden-pest-patrol', completionCount: 5 },
    { challengeId: 'chl_boulder-breaker', completionCount: 4 },
    { challengeId: 'chl_spirit-path', completionCount: 3 },
  ]);
  // Default: longestStreak of 42 daily claims.
  rewardsService.getStreakState.mockResolvedValue({
    userId: 'usr_abc123',
    rewardType: 'daily',
    currentStreak: 7,
    longestStreak: 42,
  });
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
        totalChallengesCompleted: 12, // 5+4+3 from progress records
        bestDailyStreak: 42, // from RewardsClaims longestStreak mock
        highestStageReached: 4, // max of [1,3,0,2,4]
        highestPrestigeReached: 0, // stage-4 totem has exactly BASE_ELDER_XP, no prestige yet
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
    // highestStageReached / highestPrestigeReached default to 0 when query fails
    expect(result.data.stats.highestStageReached).toBe(0);
    expect(result.data.stats.highestPrestigeReached).toBe(0);
  });
});

describe('getPublicProfile — prestige derivation', () => {
  // Prestige formula must match TotemDetailView.tsx exactly:
  //   floor((xp - 7500) / 2500) when stage >= 4 and xp > 7500
  // Otherwise 0. Public tile renders P{n} for stage 4, so this number drives
  // the user-visible label.

  it('returns 0 prestige when no totem has reached stage 4', async () => {
    db.getUserTotems.mockResolvedValue([
      { stage: 0, experience: 100 },
      { stage: 3, experience: 7499 }, // 1 XP shy of Ascended
    ]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.highestStageReached).toBe(3);
    expect(result.data.stats.highestPrestigeReached).toBe(0);
  });

  it('returns 0 prestige for a stage-4 totem with exactly 7500 XP', async () => {
    db.getUserTotems.mockResolvedValue([{ stage: 4, experience: 7500 }]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.highestStageReached).toBe(4);
    expect(result.data.stats.highestPrestigeReached).toBe(0);
  });

  it('returns P1 at exactly 10000 XP (one prestige threshold past Ascended)', async () => {
    db.getUserTotems.mockResolvedValue([{ stage: 4, experience: 10000 }]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.highestPrestigeReached).toBe(1);
  });

  it('returns P3 at 15500 XP (3 full thresholds + 500 carry)', async () => {
    db.getUserTotems.mockResolvedValue([{ stage: 4, experience: 15500 }]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.highestPrestigeReached).toBe(3);
  });

  it('picks the max prestige across multiple stage-4 totems', async () => {
    db.getUserTotems.mockResolvedValue([
      { stage: 4, experience: 8000 }, // P0 (200 below first threshold)
      { stage: 4, experience: 12500 }, // P2
      { stage: 4, experience: 10000 }, // P1
      { stage: 3, experience: 50000 }, // ignored (not stage 4)
    ]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.highestStageReached).toBe(4);
    expect(result.data.stats.highestPrestigeReached).toBe(2);
  });

  it('ignores XP on pre-Ascended totems even if XP is unusually high', async () => {
    // Defensive: a stage-3 totem with XP > 7500 should NOT influence prestige.
    // Evolution is user-gated, so this state IS reachable (player hits
    // threshold but hasn't pressed Evolve).
    db.getUserTotems.mockResolvedValue([{ stage: 3, experience: 999999 }]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.highestStageReached).toBe(3);
    expect(result.data.stats.highestPrestigeReached).toBe(0);
  });
});

describe('getPublicProfile — challenge count live-sum', () => {
  it('sums completionCount across all challenge progress records', async () => {
    challengesService.getAllChallengeProgress.mockResolvedValue([
      { challengeId: 'chl_a', completionCount: 7 },
      { challengeId: 'chl_b', completionCount: 13 },
      { challengeId: 'chl_c', completionCount: 0 }, // attempted but never completed
    ]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.totalChallengesCompleted).toBe(20);
  });

  it('returns 0 for a brand-new player with no progress records', async () => {
    challengesService.getAllChallengeProgress.mockResolvedValue([]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.totalChallengesCompleted).toBe(0);
  });

  it('falls back to stored stats.totalChallengesCompleted on query error', async () => {
    db.getUser.mockResolvedValue({
      ...baseUser,
      stats: { ...baseUser.stats, totalChallengesCompleted: 99 },
    });
    challengesService.getAllChallengeProgress.mockRejectedValue(new Error('DDB down'));
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.totalChallengesCompleted).toBe(99);
  });

  it('treats missing completionCount as 0', async () => {
    challengesService.getAllChallengeProgress.mockResolvedValue([
      { challengeId: 'chl_a' }, // no completionCount field at all
      { challengeId: 'chl_b', completionCount: 5 },
    ]);
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.totalChallengesCompleted).toBe(5);
  });
});

describe('getPublicProfile — bestDailyStreak', () => {
  it('returns longestStreak from the daily streak record', async () => {
    rewardsService.getStreakState.mockResolvedValue({
      userId: 'usr_abc123',
      rewardType: 'daily',
      currentStreak: 3,
      longestStreak: 99,
    });
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.bestDailyStreak).toBe(99);
    expect(rewardsService.getStreakState).toHaveBeenCalledWith('usr_abc123', 'daily');
  });

  it('returns 0 when the user has never claimed a daily reward', async () => {
    // getStreakState's "default state for new users" returns longestStreak: 0.
    rewardsService.getStreakState.mockResolvedValue({
      userId: 'usr_abc123',
      rewardType: 'daily',
      currentStreak: 0,
      longestStreak: 0,
    });
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.bestDailyStreak).toBe(0);
  });

  it('returns 0 when the streak query fails (defensive)', async () => {
    rewardsService.getStreakState.mockRejectedValue(new Error('DDB down'));
    const result = await getPublicProfile('usr_abc123');
    expect(result.data.stats.bestDailyStreak).toBe(0);
  });

  it('does not leak the current-streak value (only the peak)', async () => {
    // currentStreak is privacy-adjacent (reveals very recent activity);
    // longestStreak is engagement-level data. Only the latter is exposed.
    rewardsService.getStreakState.mockResolvedValue({
      userId: 'usr_abc123',
      rewardType: 'daily',
      currentStreak: 1, // user just resumed today after a long break
      longestStreak: 200,
    });
    const result = await getPublicProfile('usr_abc123');
    const json = JSON.stringify(result);
    expect(result.data.stats.bestDailyStreak).toBe(200);
    expect(json).not.toContain('currentStreak');
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
