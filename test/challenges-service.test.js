/**
 * Challenges Service Tests
 *
 * Tests for the challenges system including:
 * - Challenge definitions validation (synced with frontend challenges.json)
 * - Requirement checking (stage + stats)
 * - Daily attempt tracking
 * - XP reward calculation
 * - Challenge completion and totem XP
 */

// Mock the db-client before requiring the service
jest.mock('../src/common/db-client', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  updateItem: jest.fn(),
  queryItems: jest.fn(),
  getTotem: jest.fn(),
  updateTotem: jest.fn(),
  addEssence: jest.fn().mockResolvedValue({ newBalance: 100 }),
  TABLES: {
    CHALLENGE_PROGRESS: 'TotemBound-ChallengeProgress',
    ACHIEVEMENT_PROGRESS: 'TotemBound-AchievementProgress',
    TOTEMS: 'TotemBound-Totems',
  },
  userPK: jest.fn((id) => `USER#${id}`),
  challengeSK: jest.fn((id) => `CHALLENGE#${id}`),
}));

// Mock achievements service
jest.mock('../src/services/achievements-service', () => ({
  onChallengeCompleted: jest.fn().mockResolvedValue({}),
}));

// Mock game-actions helpers
jest.mock('../src/functions/game-actions/helpers', () => ({
  checkEvolutionRequirements: jest.fn((totem) => {
    const xp = totem.experience || 0;
    const happiness = totem.stats?.happiness || 0;
    const stage = totem.stage || 0;
    const thresholds = [0, 500, 1500, 3500, 7500];
    const xpRequired = thresholds[stage + 1] || Infinity;
    const meetsXp = xp >= xpRequired;
    const meetsHappiness = happiness >= 30;
    return {
      canEvolve: meetsXp && meetsHappiness,
      requirements: {
        experience: { required: xpRequired, current: xp, met: meetsXp },
        happiness: { required: 30, current: happiness, met: meetsHappiness },
      },
    };
  }),
}));

const {
  CHALLENGES,
  CHALLENGES_MAP,
  checkRequirements,
  checkDailyAttempts,
  calculateXpReward,
  getAvailableChallenges,
  getUnavailableChallenges,
  getChallengeById,
  getAllChallenges,
  completeChallenge,
  getChallengeStatus,
} = require('../src/services/challenges-service');

// =============================================================================
// CHALLENGE DEFINITIONS TESTS
// =============================================================================

describe('Challenge Definitions', () => {
  test('should have exactly 11 challenges', () => {
    expect(CHALLENGES).toHaveLength(11);
  });

  test('should have 3 strength challenges', () => {
    const strengthChallenges = CHALLENGES.filter((c) => c.type === 'strength');
    expect(strengthChallenges).toHaveLength(3);
  });

  test('should have 3 agility challenges', () => {
    const agilityChallenges = CHALLENGES.filter((c) => c.type === 'agility');
    expect(agilityChallenges).toHaveLength(3);
  });

  test('should have 3 wisdom challenges', () => {
    const wisdomChallenges = CHALLENGES.filter((c) => c.type === 'wisdom');
    expect(wisdomChallenges).toHaveLength(3);
  });

  test('should have 2 balance challenges', () => {
    const balanceChallenges = CHALLENGES.filter((c) => c.type === 'balance');
    expect(balanceChallenges).toHaveLength(2);
  });

  test('all challenges should have required properties', () => {
    CHALLENGES.forEach((challenge) => {
      expect(challenge).toHaveProperty('id');
      expect(challenge).toHaveProperty('name');
      expect(challenge).toHaveProperty('description');
      expect(challenge).toHaveProperty('type');
      expect(challenge).toHaveProperty('affinity');
      expect(challenge).toHaveProperty('requirements');
      expect(challenge).toHaveProperty('maxDailyAttempts');
      expect(challenge).toHaveProperty('maxScore');
      expect(challenge).toHaveProperty('xpReward');
      expect(challenge).toHaveProperty('enabled');
    });
  });

  test('challenge IDs should match frontend format', () => {
    expect(getChallengeById('chl_garden-pest-patrol')).not.toBeNull();
    expect(getChallengeById('chl_boulder-breaker')).not.toBeNull();
    expect(getChallengeById('chl_totem-wrestling')).not.toBeNull();
    expect(getChallengeById('chl_spirit-path')).not.toBeNull();
    expect(getChallengeById('chl_ancient-runes')).not.toBeNull();
  });

  test('challenge xpReward should have base and perPoint', () => {
    CHALLENGES.forEach((challenge) => {
      expect(challenge.xpReward).toHaveProperty('base');
      expect(challenge.xpReward).toHaveProperty('perPoint');
      expect(typeof challenge.xpReward.base).toBe('number');
      expect(typeof challenge.xpReward.perPoint).toBe('number');
    });
  });

  test('challenge requirements should have stage and stats', () => {
    CHALLENGES.forEach((challenge) => {
      expect(challenge.requirements).toHaveProperty('stage');
      expect(challenge.requirements).toHaveProperty('strength');
      expect(challenge.requirements).toHaveProperty('agility');
      expect(challenge.requirements).toHaveProperty('wisdom');
    });
  });
});

// =============================================================================
// REQUIREMENT TESTS
// =============================================================================

describe('checkRequirements', () => {
  const gardenChallenge = getChallengeById('chl_garden-pest-patrol');
  const boulderChallenge = getChallengeById('chl_boulder-breaker');

  test('should pass when totem meets all requirements', () => {
    const totem = {
      stage: 0, // Stage 1 (0-indexed)
      stats: { strength: 5, agility: 5, wisdom: 5 },
    };

    const result = checkRequirements(totem, gardenChallenge);
    expect(result.qualified).toBe(true);
  });

  test('should fail when totem stage is too low', () => {
    // Totem Wrestling requires data stage 1 (display Stage 2)
    const wrestlingChallenge = getChallengeById('chl_totem-wrestling');
    const totem = {
      stage: 0, // Hatchling — wrestling requires stage 1
      stats: { strength: 20, agility: 20, wisdom: 20 },
    };

    const result = checkRequirements(totem, wrestlingChallenge);
    expect(result.qualified).toBe(false);
    expect(result.requirement).toBe('stage');
  });

  test('should fail when totem lacks required strength', () => {
    const totem = {
      stage: 1, // Juvenile — meets boulder stage 0 requirement
      stats: { strength: 5, agility: 10, wisdom: 10 },
    };

    const result = checkRequirements(totem, boulderChallenge);
    expect(result.qualified).toBe(false);
    expect(result.requirement).toBe('strength');
    expect(result.required).toBe(10);  // Boulder breaker primary stat
    expect(result.current).toBe(5);
  });

  test('should fail when totem lacks required agility', () => {
    const totem = {
      stage: 1,
      stats: { strength: 15, agility: 2, wisdom: 10 },
    };

    const result = checkRequirements(totem, boulderChallenge);
    expect(result.qualified).toBe(false);
    expect(result.requirement).toBe('agility');
  });

  test('should fail when totem lacks required wisdom', () => {
    const totem = {
      stage: 1,
      stats: { strength: 15, agility: 10, wisdom: 2 },
    };

    const result = checkRequirements(totem, boulderChallenge);
    expect(result.qualified).toBe(false);
    expect(result.requirement).toBe('wisdom');
  });

  test('should handle missing stats as zero', () => {
    const totem = { stage: 0, stats: {} };
    const result = checkRequirements(totem, gardenChallenge);

    // Garden requires stage 0, stats 1/1/1 — empty stats treated as 0 fails strength
    expect(result.qualified).toBe(false);
  });
});

// =============================================================================
// DAILY ATTEMPTS TESTS
// =============================================================================

describe('checkDailyAttempts', () => {
  const maxDailyAttempts = 5;

  test('should allow attempts when no progress exists', () => {
    const result = checkDailyAttempts(null, maxDailyAttempts);

    expect(result.canAttempt).toBe(true);
    expect(result.attemptsToday).toBe(0);
    expect(result.attemptsRemaining).toBe(5);
  });

  test('should allow attempts when no daily attempts recorded', () => {
    const progress = { completionCount: 5 };
    const result = checkDailyAttempts(progress, maxDailyAttempts);

    expect(result.canAttempt).toBe(true);
    expect(result.attemptsToday).toBe(0);
  });

  test('should track attempts for today', () => {
    const today = new Date().toISOString().split('T')[0];
    const progress = {
      dailyAttempts: { [today]: 3 },
    };
    const result = checkDailyAttempts(progress, maxDailyAttempts);

    expect(result.canAttempt).toBe(true);
    expect(result.attemptsToday).toBe(3);
    expect(result.attemptsRemaining).toBe(2);
  });

  test('should block when daily limit reached', () => {
    const today = new Date().toISOString().split('T')[0];
    const progress = {
      dailyAttempts: { [today]: 5 },
    };
    const result = checkDailyAttempts(progress, maxDailyAttempts);

    expect(result.canAttempt).toBe(false);
    expect(result.attemptsToday).toBe(5);
    expect(result.attemptsRemaining).toBe(0);
  });

  test('should ignore yesterdays attempts', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const progress = {
      dailyAttempts: { [yesterday]: 5 },
    };
    const result = checkDailyAttempts(progress, maxDailyAttempts);

    expect(result.canAttempt).toBe(true);
    expect(result.attemptsToday).toBe(0);
  });
});

// =============================================================================
// XP REWARD CALCULATION TESTS (Contract Formula)
// Formula: floor((score * maxXP) / maxScore)
// maxScore 1000 -> maxXP 10
// maxScore 2000 -> maxXP 20
// maxScore 3000 -> maxXP 30
// =============================================================================

describe('calculateXpReward', () => {
  test('should calculate XP using contract formula (stage 1)', () => {
    // Stage 1: maxScore=1000, maxXP=10
    // score=500: floor((500 * 10) / 1000) = 5
    expect(calculateXpReward(1000, 500)).toBe(5);
  });

  test('should calculate XP using contract formula (stage 2)', () => {
    // Stage 2: maxScore=2000, maxXP=20
    // score=1000: floor((1000 * 20) / 2000) = 10
    expect(calculateXpReward(2000, 1000)).toBe(10);
    // score=1500: floor((1500 * 20) / 2000) = 15
    expect(calculateXpReward(2000, 1500)).toBe(15);
  });

  test('should cap score at maxScore', () => {
    // Score over max should be capped
    // score=5000, maxScore=2000: floor((2000 * 20) / 2000) = 20
    expect(calculateXpReward(2000, 5000)).toBe(20);
  });

  test('should handle zero score', () => {
    // score=0: no XP awarded
    expect(calculateXpReward(1000, 0)).toBe(0);
  });

  test('should handle negative score as zero', () => {
    // Negative score capped to 0
    expect(calculateXpReward(1000, -500)).toBe(0);
  });

  test('should award minimum 1 XP for any positive score', () => {
    // score=1: floor((1 * 10) / 1000) = 0, but min 1 XP
    expect(calculateXpReward(1000, 1)).toBe(1);
    // score=50: floor((50 * 10) / 1000) = 0, but min 1 XP
    expect(calculateXpReward(1000, 50)).toBe(1);
    // score=99: floor((99 * 10) / 1000) = 0, but min 1 XP
    expect(calculateXpReward(1000, 99)).toBe(1);
    // score=100: floor((100 * 10) / 1000) = 1, already >= 1
    expect(calculateXpReward(1000, 100)).toBe(1);
    // score=199 on maxScore=2000: floor((199 * 20) / 2000) = 1, already >= 1
    expect(calculateXpReward(2000, 199)).toBe(1);
  });

  test('should calculate max XP for perfect score', () => {
    // Perfect score on stage 4: floor((3000 * 30) / 3000) = 30
    expect(calculateXpReward(3000, 3000)).toBe(30);
  });

  test('should scale maxXP linearly with maxScore (maxXP = maxScore / 100)', () => {
    expect(calculateXpReward(1000, 1000)).toBe(10);
    expect(calculateXpReward(2000, 2000)).toBe(20);
    expect(calculateXpReward(3000, 3000)).toBe(30);
    // Non-standard maxScore values scale instead of silently capping at 10
    expect(calculateXpReward(5000, 5000)).toBe(50);
    expect(calculateXpReward(1500, 1500)).toBe(15);
  });

  test('should return 0 for non-finite scores (NaN, Infinity)', () => {
    expect(calculateXpReward(1000, NaN)).toBe(0);
    expect(calculateXpReward(1000, Infinity)).toBe(0);
    expect(calculateXpReward(1000, -Infinity)).toBe(0);
  });

  test('should return 0 for invalid maxScore', () => {
    expect(calculateXpReward(0, 500)).toBe(0);
    expect(calculateXpReward(-1000, 500)).toBe(0);
    expect(calculateXpReward(NaN, 500)).toBe(0);
  });
});

// =============================================================================
// AVAILABLE CHALLENGES TESTS
// =============================================================================

describe('getAvailableChallenges', () => {
  test('should return only stage 1 challenge for stage 0 totem with minimal stats', () => {
    const totem = {
      stage: 0,
      stats: { strength: 5, agility: 5, wisdom: 5 },
    };
    const available = getAvailableChallenges(totem);

    // Only Garden Pest Patrol (stage 1, all stats 1)
    expect(available).toHaveLength(1);
    expect(available[0].id).toBe('chl_garden-pest-patrol');
  });

  test('should return more challenges for higher stage totem', () => {
    const totem = {
      stage: 1, // Stage 2
      stats: { strength: 15, agility: 15, wisdom: 15 },
    };
    const available = getAvailableChallenges(totem);

    // Should include stage 1 and stage 2 challenges
    expect(available.length).toBeGreaterThan(1);
  });

  test('should return all challenges for max stats and stage', () => {
    const totem = {
      stage: 4, // Stage 5
      stats: { strength: 50, agility: 50, wisdom: 50 },
    };
    const available = getAvailableChallenges(totem);

    expect(available).toHaveLength(11);
  });

  test('should exclude disabled challenges', () => {
    const totem = {
      stage: 4,
      stats: { strength: 100, agility: 100, wisdom: 100 },
    };
    const available = getAvailableChallenges(totem);

    // All challenges are enabled in our config
    expect(available.every((c) => c.enabled !== false)).toBe(true);
  });
});

describe('getUnavailableChallenges', () => {
  test('should return challenges totem does not qualify for', () => {
    const totem = {
      stage: 0,
      stats: { strength: 1, agility: 1, wisdom: 1 },
    };
    const unavailable = getUnavailableChallenges(totem);

    // Should be 10 (all except garden pest patrol)
    expect(unavailable).toHaveLength(10);
    unavailable.forEach((c) => {
      expect(c).toHaveProperty('reason');
      expect(c).toHaveProperty('unmetRequirement');
    });
  });

  test('should return empty array for max stats totem', () => {
    const totem = {
      stage: 4,
      stats: { strength: 50, agility: 50, wisdom: 50 },
    };
    const unavailable = getUnavailableChallenges(totem);

    expect(unavailable).toHaveLength(0);
  });
});

// =============================================================================
// HELPER FUNCTION TESTS
// =============================================================================

describe('getChallengeById', () => {
  test('should return challenge for valid ID', () => {
    const challenge = getChallengeById('chl_garden-pest-patrol');

    expect(challenge).not.toBeNull();
    expect(challenge.name).toBe('Garden Pest Patrol');
  });

  test('should return null for invalid ID', () => {
    const challenge = getChallengeById('invalid_id');

    expect(challenge).toBeNull();
  });
});

describe('getAllChallenges', () => {
  test('should return all enabled challenges', () => {
    const challenges = getAllChallenges();

    expect(challenges).toHaveLength(11);
  });
});

// =============================================================================
// COMPLETE CHALLENGE TESTS (Integration)
// =============================================================================

describe('completeChallenge', () => {
  const mockDbClient = require('../src/common/db-client');
  const { onChallengeCompleted } = require('../src/services/achievements-service');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should reject invalid challenge ID', async () => {
    const result = await completeChallenge('usr_123', 'invalid_challenge', 'ttm_456', 500);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_CHALLENGE');
  });

  test('should reject invalid totem ID format', async () => {
    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'invalid_totem', 500);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_TOTEM_ID');
  });

  test('should reject invalid score', async () => {
    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', -100);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_SCORE');
  });

  test('should reject zero score (cannot submit 0)', async () => {
    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 0);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_SCORE');
    expect(result.error.message).toBe('Score must be a positive number');
  });

  test('should reject NaN score (would otherwise corrupt totem XP)', async () => {
    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', NaN);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_SCORE');
  });

  test('should reject Infinity score', async () => {
    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', Infinity);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_SCORE');
  });

  test('should reject non-numeric score (string)', async () => {
    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', '500');

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_SCORE');
  });

  test('should reject when totem not found', async () => {
    mockDbClient.getTotem.mockResolvedValue(null);

    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TOTEM_NOT_FOUND');
  });

  test('should reject when totem lacks required stage', async () => {
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0, // Hatchling — wrestling requires data stage 1
      stats: { strength: 20, agility: 20, wisdom: 20 },
    });

    const result = await completeChallenge('usr_123', 'chl_totem-wrestling', 'ttm_456', 500);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('REQUIREMENT_NOT_MET');
    expect(result.error.requirement).toBe('stage');
  });

  test('should reject when daily limit reached', async () => {
    const today = new Date().toISOString().split('T')[0];

    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      stats: { strength: 5, agility: 5, wisdom: 5 },
    });

    mockDbClient.getItem.mockResolvedValue({
      pk: 'USER#usr_123',
      sk: 'CHALLENGE#chl_garden-pest-patrol',
      dailyAttempts: { [today]: 5 }, // Already at max
    });

    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('DAILY_LIMIT_REACHED');
  });

  test('should award XP and happiness to totem on completion', async () => {
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      experience: 100,
      stats: { strength: 5, agility: 5, wisdom: 5, happiness: 50 },
    });

    mockDbClient.getItem.mockResolvedValue(null); // No prior progress
    mockDbClient.putItem.mockResolvedValue({});
    mockDbClient.updateTotem.mockResolvedValue({});

    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    expect(result.success).toBe(true);
    expect(result.data.xpEarned).toBeGreaterThan(0);
    expect(result.data.happinessEarned).toBe(10); // Fixed +10 happiness
    expect(result.data.totem.previousXp).toBe(100);
    expect(result.data.totem.newXp).toBeGreaterThan(100);
    expect(result.data.totem.previousHappiness).toBe(50);
    expect(result.data.totem.newHappiness).toBe(60);

    // Verify updateTotem was called with new XP and happiness
    expect(mockDbClient.updateTotem).toHaveBeenCalledWith(
      'usr_123',
      'ttm_456',
      expect.objectContaining({
        experience: expect.any(Number),
        'stats.happiness': 60,
      })
    );
  });

  test('should cap happiness at 100', async () => {
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      experience: 0,
      stats: { strength: 5, agility: 5, wisdom: 5, happiness: 95 },
    });

    mockDbClient.getItem.mockResolvedValue(null);
    mockDbClient.putItem.mockResolvedValue({});
    mockDbClient.updateTotem.mockResolvedValue({});

    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    expect(result.success).toBe(true);
    expect(result.data.totem.previousHappiness).toBe(95);
    expect(result.data.totem.newHappiness).toBe(100); // Capped at 100, not 105
  });

  test('should track daily attempts and totalScore correctly', async () => {
    const today = new Date().toISOString().split('T')[0];

    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      experience: 0,
      stats: { strength: 5, agility: 5, wisdom: 5, happiness: 50 },
    });

    mockDbClient.getItem.mockResolvedValue({
      pk: 'USER#usr_123',
      sk: 'CHALLENGE#chl_garden-pest-patrol',
      dailyAttempts: { [today]: 2 },
      completionCount: 5,
      totalAttempts: 10,
      totalScore: 2500,
    });

    mockDbClient.putItem.mockResolvedValue({});
    mockDbClient.updateTotem.mockResolvedValue({});

    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    expect(result.success).toBe(true);
    expect(result.data.progress.attemptsToday).toBe(3);
    expect(result.data.progress.attemptsRemaining).toBe(2);
    expect(result.data.progress.completionCount).toBe(6);
    expect(result.data.progress.totalAttempts).toBe(11);
    expect(result.data.progress.totalScore).toBe(3000); // 2500 + 500
  });

  test('should trigger achievement check on completion with GLOBAL count', async () => {
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      experience: 0,
      stats: { strength: 5, agility: 5, wisdom: 5, happiness: 50 },
    });

    mockDbClient.getItem.mockResolvedValue(null); // No prior progress for this challenge
    mockDbClient.putItem.mockResolvedValue({});
    mockDbClient.updateTotem.mockResolvedValue({});

    // Mock getAllChallengeProgress - user has completed other challenges before
    mockDbClient.queryItems.mockResolvedValue([
      { challengeId: 'chl_boulder-breaker', completionCount: 5 },
      { challengeId: 'chl_spirit-path', completionCount: 3 },
    ]);

    await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    // Should pass GLOBAL total: 5 + 3 + 1 (new) = 9
    expect(onChallengeCompleted).toHaveBeenCalledWith('usr_123', 9, 'ttm_456');
  });

  test('should trigger achievement check with count 1 for first ever challenge', async () => {
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      experience: 0,
      stats: { strength: 5, agility: 5, wisdom: 5, happiness: 50 },
    });

    mockDbClient.getItem.mockResolvedValue(null);
    mockDbClient.putItem.mockResolvedValue({});
    mockDbClient.updateTotem.mockResolvedValue({});

    // No prior challenges at all
    mockDbClient.queryItems.mockResolvedValue([]);

    await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    // First challenge ever = 1
    expect(onChallengeCompleted).toHaveBeenCalledWith('usr_123', 1, 'ttm_456');
  });

  test('should calculate XP based on score using contract formula', async () => {
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      experience: 0,
      stats: { strength: 5, agility: 5, wisdom: 5, happiness: 50 },
    });

    mockDbClient.getItem.mockResolvedValue(null);
    mockDbClient.putItem.mockResolvedValue({});
    mockDbClient.updateTotem.mockResolvedValue({});

    // Garden challenge: maxScore=1000, maxXP=10
    // Score 500: floor((500 * 10) / 1000) = 5 XP
    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    expect(result.success).toBe(true);
    expect(result.data.xpEarned).toBe(5);
  });

  test('should track high score and isNewHighScore flag', async () => {
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      experience: 0,
      stats: { strength: 5, agility: 5, wisdom: 5, happiness: 50 },
    });

    mockDbClient.getItem.mockResolvedValue({
      highScore: 300,
      completionCount: 5,
    });

    mockDbClient.putItem.mockResolvedValue({});
    mockDbClient.updateTotem.mockResolvedValue({});

    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    expect(result.success).toBe(true);
    expect(result.data.progress.highScore).toBe(500);
    expect(result.data.progress.isNewHighScore).toBe(true);
  });

  test('should NOT set isNewHighScore when score is lower', async () => {
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      experience: 0,
      stats: { strength: 5, agility: 5, wisdom: 5, happiness: 50 },
    });

    mockDbClient.getItem.mockResolvedValue({
      highScore: 800,
      completionCount: 5,
    });

    mockDbClient.putItem.mockResolvedValue({});
    mockDbClient.updateTotem.mockResolvedValue({});

    const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);

    expect(result.success).toBe(true);
    expect(result.data.progress.highScore).toBe(800);
    expect(result.data.progress.isNewHighScore).toBe(false);
  });

  // ===========================================================================
  // Trait effects — Phase 2
  // ===========================================================================
  describe('with trait bonuses', () => {
    const baseStats = { strength: 5, agility: 5, wisdom: 5, happiness: 50 };
    const baseTotem = (overrides = {}) => ({
      id: 'ttm_456',
      userId: 'usr_123',
      speciesId: 0,
      stage: 0,
      experience: 0,
      stats: baseStats,
      traits: { innate: null, learned: null, awakened: null },
      ...overrides,
    });

    beforeEach(() => {
      mockDbClient.getItem.mockResolvedValue(null);
      mockDbClient.putItem.mockResolvedValue({});
      mockDbClient.updateTotem.mockResolvedValue({});
      mockDbClient.queryItems.mockResolvedValue([]);
    });

    test('Clever (+5% XP on challenges) bumps a 10-XP win to 11', async () => {
      // Garden Pest Patrol score=1000 → base 10 XP × 1.05 = 10.5 → round → 11
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({ traits: { innate: 'trt_clever', learned: null, awakened: null } }),
      );
      const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 1000);
      expect(result.success).toBe(true);
      expect(result.data.xpEarned).toBe(11);
    });

    test('Persistent (+20% happiness) raises challenge happiness reward 10 → 12', async () => {
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({ traits: { innate: null, learned: 'trt_persistent', awakened: null } }),
      );
      const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);
      expect(result.success).toBe(true);
      expect(result.data.happinessEarned).toBe(12);
      expect(result.data.totem.newHappiness).toBe(62);
    });

    test("Merchant's Eye (+10% earn:any) raises Essence reward 5 → 6", async () => {
      // Garden challenge essenceReward=5 × 1.10 = 5.5 → round → 6
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({ traits: { innate: null, learned: 'trt_merchant_eye', awakened: null } }),
      );
      const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 500);
      expect(result.success).toBe(true);
      expect(result.data.essenceEarned).toBe(6);
    });

    test('Mentor aura (+10% XP) folds on the acting totem too (self-scope via aura token)', async () => {
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({ traits: { innate: null, learned: null, awakened: 'trt_mentor' } }),
      );
      const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 1000);
      expect(result.success).toBe(true);
      // base 10 × 1.10 = 11
      expect(result.data.xpEarned).toBe(11);
    });

    test('no traits → baseline rewards unchanged', async () => {
      mockDbClient.getTotem.mockResolvedValue(baseTotem());
      const result = await completeChallenge('usr_123', 'chl_garden-pest-patrol', 'ttm_456', 1000);
      expect(result.success).toBe(true);
      expect(result.data.xpEarned).toBe(10);
      expect(result.data.happinessEarned).toBe(10);
      expect(result.data.essenceEarned).toBe(5);
    });

    // successChanceBonus inflates the score server-side so every mini-game gets
    // the boost without touching its container. XP comes from the boosted score.
    test('Brave (+5% score → more XP) on a strength challenge: 1190 → +5% → 12 XP (baseline 11)', async () => {
      // Boulder Breaker: maxScore=2000, maxXP=20. score 1190 baseline floor((1190*20)/2000)=11.
      // boosted score 1190*1.05 = 1249.5 → 1250 → floor((1250*20)/2000) = 12.
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({
          stats: { strength: 15, agility: 15, wisdom: 15, happiness: 50 },
          traits: { innate: 'trt_brave', learned: null, awakened: null },
        }),
      );
      const result = await completeChallenge('usr_123', 'chl_boulder-breaker', 'ttm_456', 1190);
      expect(result.success).toBe(true);
      expect(result.data.xpEarned).toBe(12);
    });

    test('Skilled Fighter score boost is strength-only', async () => {
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({
          stats: { strength: 15, agility: 15, wisdom: 15, happiness: 50 },
          traits: { innate: null, learned: 'trt_skilled_fighter', awakened: null },
        }),
      );
      // Wisdom challenge — Skilled Fighter doesn't fire, baseline XP.
      const wisdom = await completeChallenge('usr_123', 'chl_ancient-runes', 'ttm_456', 1000);
      expect(wisdom.data.xpEarned).toBe(10);
      // Strength challenge — score 1000 × 1.10 = 1100 → 11 XP.
      const strength = await completeChallenge('usr_123', 'chl_boulder-breaker', 'ttm_456', 1000);
      expect(strength.data.xpEarned).toBe(11);
    });

    test('score boost caps at maxScore (no overflow XP)', async () => {
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({
          stats: { strength: 15, agility: 15, wisdom: 15, happiness: 50 },
          traits: { innate: null, learned: 'trt_skilled_fighter', awakened: null },
        }),
      );
      // Already at maxScore — boost can't lift XP past maxXP.
      const result = await completeChallenge('usr_123', 'chl_boulder-breaker', 'ttm_456', 2000);
      expect(result.data.xpEarned).toBe(20);
    });

    test('Stubborn (+1 strength) gives +1% score on strength challenges', async () => {
      // Boulder Breaker maxScore=2000, maxXP=20. Score 1190 → +1% → 1202 →
      // floor((1202*20)/2000) = 12, vs baseline 11.
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({
          stats: { strength: 15, agility: 15, wisdom: 15, happiness: 50 },
          traits: { innate: 'trt_stubborn', learned: null, awakened: null },
        }),
      );
      const result = await completeChallenge('usr_123', 'chl_boulder-breaker', 'ttm_456', 1190);
      expect(result.data.xpEarned).toBe(12);
    });

    test('Stubborn (+1 strength) lets a 12-strength totem clear a 13-strength gate', async () => {
      // Boulder Breaker: requirements.strength = 10 (already met by base 12).
      // Synthesize the gate effect by checking checkRequirements directly is cleaner;
      // here we use a closer-to-real flow: a totem at exactly the boundary.
      const { checkRequirements } = require('../src/services/challenges-service');
      const challenge = {
        affinity: 'strength',
        requirements: { stage: 0, strength: 13, agility: 5, wisdom: 5 },
      };
      const baseTotem12 = {
        stage: 2,
        stats: { strength: 12, agility: 12, wisdom: 12 },
        traits: { innate: null, learned: null, awakened: null },
      };
      const stubborn12 = {
        ...baseTotem12,
        traits: { innate: 'trt_stubborn', learned: null, awakened: null },
      };
      expect(checkRequirements(baseTotem12, challenge).qualified).toBe(false);
      expect(checkRequirements(stubborn12, challenge).qualified).toBe(true);
    });

    test('Restless statBonus does NOT fire on wisdom challenges', async () => {
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({
          stats: { strength: 15, agility: 15, wisdom: 15, happiness: 50 },
          traits: { innate: 'trt_restless', learned: null, awakened: null },
        }),
      );
      const result = await completeChallenge('usr_123', 'chl_ancient-runes', 'ttm_456', 1000);
      expect(result.data.xpEarned).toBe(10);
    });

    test('cumulative totalScore stays on the raw submission, not the boosted value', async () => {
      mockDbClient.getTotem.mockResolvedValue(
        baseTotem({
          stats: { strength: 15, agility: 15, wisdom: 15, happiness: 50 },
          traits: { innate: 'trt_brave', learned: null, awakened: null },
        }),
      );
      const result = await completeChallenge('usr_123', 'chl_boulder-breaker', 'ttm_456', 1000);
      expect(result.data.progress.totalScore).toBe(1000);
    });
  });
});

// =============================================================================
// GET CHALLENGE STATUS TESTS
// =============================================================================

describe('getChallengeStatus', () => {
  const mockDbClient = require('../src/common/db-client');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should return status for all 11 challenges', async () => {
    mockDbClient.queryItems.mockResolvedValue([]);

    const statuses = await getChallengeStatus('usr_123');

    expect(statuses).toHaveLength(11);
    statuses.forEach((status) => {
      expect(status).toHaveProperty('challengeId');
      expect(status).toHaveProperty('name');
      expect(status).toHaveProperty('type');
      expect(status).toHaveProperty('requirements');
      expect(status).toHaveProperty('xpReward');
      expect(status).toHaveProperty('maxDailyAttempts');
      expect(status).toHaveProperty('completionCount');
      expect(status).toHaveProperty('attemptsToday');
      expect(status).toHaveProperty('canAttempt');
    });
  });

  test('should merge progress data with challenge definitions', async () => {
    const today = new Date().toISOString().split('T')[0];

    mockDbClient.queryItems.mockResolvedValue([
      {
        challengeId: 'chl_garden-pest-patrol',
        completionCount: 5,
        totalAttempts: 8,
        totalXpEarned: 75,
        highScore: 800,
        dailyAttempts: { [today]: 2 },
      },
    ]);

    const statuses = await getChallengeStatus('usr_123');

    const gardenStatus = statuses.find((s) => s.challengeId === 'chl_garden-pest-patrol');
    expect(gardenStatus.completionCount).toBe(5);
    expect(gardenStatus.totalAttempts).toBe(8);
    expect(gardenStatus.totalXpEarned).toBe(75);
    expect(gardenStatus.highScore).toBe(800);
    expect(gardenStatus.attemptsToday).toBe(2);
    expect(gardenStatus.canAttempt).toBe(true);
  });

  test('should correctly identify when daily limit is reached', async () => {
    const today = new Date().toISOString().split('T')[0];

    mockDbClient.queryItems.mockResolvedValue([
      {
        challengeId: 'chl_garden-pest-patrol',
        dailyAttempts: { [today]: 5 },
      },
    ]);

    const statuses = await getChallengeStatus('usr_123');

    const gardenStatus = statuses.find((s) => s.challengeId === 'chl_garden-pest-patrol');
    expect(gardenStatus.canAttempt).toBe(false);
    expect(gardenStatus.attemptsRemaining).toBe(0);
  });

  test('should include requirement status when totem is provided', async () => {
    mockDbClient.queryItems.mockResolvedValue([]);
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      stage: 0,
      stats: { strength: 5, agility: 5, wisdom: 5 },
    });

    const statuses = await getChallengeStatus('usr_123', 'ttm_456');

    // Garden should be qualified
    const gardenStatus = statuses.find((s) => s.challengeId === 'chl_garden-pest-patrol');
    expect(gardenStatus.requirementStatus).not.toBeNull();
    expect(gardenStatus.requirementStatus.qualified).toBe(true);

    // Boulder should NOT be qualified (needs stage 2)
    const boulderStatus = statuses.find((s) => s.challengeId === 'chl_boulder-breaker');
    expect(boulderStatus.requirementStatus.qualified).toBe(false);
  });
});
