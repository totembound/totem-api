/**
 * Achievement & Challenge Handler Tests
 *
 * Tests for achievements index, challenges attempt, list, status, available, and index wrappers.
 */

// Mock db-client
jest.mock('../src/common/db-client', () => ({
  getTotem: jest.fn(),
  getUser: jest.fn(),
}));

// Mock achievements-service
jest.mock('../src/services/achievements-service', () => ({
  getAllAchievementProgress: jest.fn(),
  ACHIEVEMENT_IDS: {
    ANTI_META_COLLECTOR: 'ach_anti-meta-collector',
  },
  ACHIEVEMENT_MILESTONES: {
    'ach_collector-progression': [1, 5, 10],
    'ach_trainer-progression': [10, 50, 100],
  },
  ONETIME_ACHIEVEMENTS: ['ach_first-evolve'],
}));

// Mock challenges-service
jest.mock('../src/services/challenges-service', () => ({
  completeChallenge: jest.fn(),
  getChallengeStatus: jest.fn(),
  getAllChallenges: jest.fn(),
  getAvailableChallenges: jest.fn(),
  getUnavailableChallenges: jest.fn(),
  // status.js reads tier indices from the MASTERY config (raiseTier / top tier)
  MASTERY: {
    tiers: [
      { tier: 0, name: 'Novice' },
      { tier: 1, name: 'Bronze' },
      { tier: 2, name: 'Silver' },
      { tier: 3, name: 'Gold' },
      { tier: 4, name: 'Platinum' },
      { tier: 5, name: 'Diamond' },
    ],
    raiseTier: 3,
    maxDifficulty: 3,
  },
}));

const dbClient = require('../src/common/db-client');
const achService = require('../src/services/achievements-service');
const chalService = require('../src/services/challenges-service');

const { getAchievements, checkAchievement } = require('../src/functions/achievements/index');
const { attemptChallenge } = require('../src/functions/challenges/attempt');
const { listChallenges } = require('../src/functions/challenges/list');
const { getChallengeStatus } = require('../src/functions/challenges/status');
const { getAvailableChallenges } = require('../src/functions/challenges/available');
const { getChallenges, complete } = require('../src/functions/challenges/index');

// =============================================================================
// TEST DATA
// =============================================================================

const testUser = { userId: 'usr_test123' };

const makeChallengeStatus = (overrides = {}) => ({
  challengeId: 'challenge-0',
  name: 'Memory Match',
  description: 'Test your memory',
  type: 'memory',
  affinity: 'Wisdom',
  requirements: { stage: 1 },
  maxScore: 100,
  xpReward: 50,
  maxDailyAttempts: 3,
  completionCount: 2,
  totalAttempts: 5,
  totalXpEarned: 100,
  highScore: 85,
  lastScore: 70,
  lastAttemptAt: '2024-01-15T00:00:00.000Z',
  firstCompletedAt: '2024-01-10T00:00:00.000Z',
  attemptsToday: 1,
  attemptsRemaining: 2,
  canAttempt: true,
  ...overrides,
});

// =============================================================================
// ACHIEVEMENT TESTS
// =============================================================================

describe('Achievement Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAchievements', () => {
    it('should return achievements with milestones', async () => {
      achService.getAllAchievementProgress.mockResolvedValue([
        {
          achievementId: 'ach_collector-progression',
          currentValue: 3,
          milestones: [{ index: 0 }],
        },
      ]);

      const result = await getAchievements(testUser);
      expect(result.success).toBe(true);
      expect(result.data.achievements['ach_collector-progression']).toHaveLength(3);
      // First milestone unlocked (index 0)
      expect(result.data.achievements['ach_collector-progression'][0].unlocked).toBe(true);
      // Second not yet
      expect(result.data.achievements['ach_collector-progression'][1].unlocked).toBe(false);
      // All show current progress
      expect(result.data.achievements['ach_collector-progression'][0].progress).toBe(3);
    });

    it('should handle one-time achievements', async () => {
      achService.getAllAchievementProgress.mockResolvedValue([
        { achievementId: 'ach_first-evolve', isComplete: true },
      ]);

      const result = await getAchievements(testUser);
      expect(result.data.achievements['ach_first-evolve']).toHaveLength(1);
      expect(result.data.achievements['ach_first-evolve'][0].unlocked).toBe(true);
    });

    it('should default incomplete one-time achievements', async () => {
      achService.getAllAchievementProgress.mockResolvedValue([]);

      const result = await getAchievements(testUser);
      expect(result.data.achievements['ach_first-evolve'][0].unlocked).toBe(false);
      expect(result.data.achievements['ach_first-evolve'][0].progress).toBe(0);
    });

    it('should default zero progress for missing achievements', async () => {
      achService.getAllAchievementProgress.mockResolvedValue([]);

      const result = await getAchievements(testUser);
      expect(result.data.achievements['ach_collector-progression'][0].progress).toBe(0);
    });

    it('should handle service error', async () => {
      achService.getAllAchievementProgress.mockRejectedValue(new Error('fail'));
      const result = await getAchievements(testUser);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('FETCH_ERROR');
    });
  });

  describe('checkAchievement', () => {
    it('should return requirements met', async () => {
      const result = await checkAchievement(testUser, 'ach_test');
      expect(result.success).toBe(true);
      expect(result.data.requirementsMet).toBe(true);
      expect(result.data.achievementId).toBe('ach_test');
    });
  });
});

// =============================================================================
// CHALLENGE ATTEMPT TESTS
// =============================================================================

describe('Challenge Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('attemptChallenge', () => {
    it('should complete a challenge successfully', async () => {
      chalService.completeChallenge.mockResolvedValue({
        success: true,
        data: { challengeId: 'challenge-0', xpAwarded: 50, essenceAwarded: 100 },
      });
      dbClient.getTotem.mockResolvedValue({
        id: 'ttm_abc',
        stats: { strength: 10, agility: 8 },
      });

      const result = await attemptChallenge(testUser, {
        totemId: 'ttm_abc',
        challengeId: 'challenge-0',
        score: 85,
      });
      expect(result.success).toBe(true);
      expect(result.data.totemStats).toBeDefined();
    });

    it('should require totemId', async () => {
      const result = await attemptChallenge(testUser, { challengeId: 'c-0', score: 50 });
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should require challengeId', async () => {
      const result = await attemptChallenge(testUser, { totemId: 'ttm_abc', score: 50 });
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should require score', async () => {
      const result = await attemptChallenge(testUser, { totemId: 'ttm_abc', challengeId: 'c-0' });
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should reject invalid totemId format', async () => {
      const result = await attemptChallenge(testUser, {
        totemId: 'bad', challengeId: 'c-0', score: 50,
      });
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should reject negative score', async () => {
      const result = await attemptChallenge(testUser, {
        totemId: 'ttm_abc', challengeId: 'c-0', score: -5,
      });
      expect(result.error.code).toBe('INVALID_SCORE');
    });

    it('should reject NaN score', async () => {
      const result = await attemptChallenge(testUser, {
        totemId: 'ttm_abc', challengeId: 'c-0', score: 'abc',
      });
      expect(result.error.code).toBe('INVALID_SCORE');
    });

    it('should pass through service failure', async () => {
      chalService.completeChallenge.mockResolvedValue({
        success: false,
        error: { code: 'CHALLENGE_LIMIT', message: 'Daily limit reached' },
      });
      const result = await attemptChallenge(testUser, {
        totemId: 'ttm_abc', challengeId: 'c-0', score: 50,
      });
      expect(result.success).toBe(false);
    });
  });

  // ===========================================================================
  // LIST CHALLENGES
  // ===========================================================================

  describe('listChallenges', () => {
    it('should return challenges with progress', async () => {
      chalService.getChallengeStatus.mockResolvedValue([makeChallengeStatus()]);
      chalService.getAllChallenges.mockReturnValue([{ id: 'challenge-0' }]);

      const result = await listChallenges(testUser);
      expect(result.success).toBe(true);
      expect(result.data.challenges).toHaveLength(1);
      expect(result.data.challenges[0].progress.completionCount).toBe(2);
      expect(result.data.challenges[0].daily.attemptsRemaining).toBe(2);
    });

    it('should include summary stats', async () => {
      chalService.getChallengeStatus.mockResolvedValue([
        makeChallengeStatus({ completionCount: 3, totalXpEarned: 150 }),
      ]);
      chalService.getAllChallenges.mockReturnValue([{ id: 'challenge-0' }]);

      const result = await listChallenges(testUser);
      expect(result.data.summary.totalCompletions).toBe(3);
      expect(result.data.summary.totalXpEarned).toBe(150);
      expect(result.data.summary.uniqueChallengesCompleted).toBe(1);
    });

    it('should group by type', async () => {
      chalService.getChallengeStatus.mockResolvedValue([
        makeChallengeStatus({ type: 'memory' }),
        makeChallengeStatus({ challengeId: 'challenge-1', type: 'reflex' }),
      ]);
      chalService.getAllChallenges.mockReturnValue([
        { id: 'challenge-0' },
        { id: 'challenge-1' },
      ]);

      const result = await listChallenges(testUser);
      expect(result.data.byType.memory).toHaveLength(1);
      expect(result.data.byType.reflex).toHaveLength(1);
    });
  });

  // ===========================================================================
  // CHALLENGE STATUS
  // ===========================================================================

  describe('getChallengeStatus', () => {
    beforeEach(() => {
      chalService.getChallengeStatus.mockResolvedValue([makeChallengeStatus()]);
      chalService.getAllChallenges.mockReturnValue([{ id: 'challenge-0' }]);
      dbClient.getUser.mockResolvedValue({ stats: { totalChallengeCount: 10 } });
    });

    it('should return challenge statuses', async () => {
      const result = await getChallengeStatus(testUser);
      expect(result.success).toBe(true);
      expect(result.data.challenges).toHaveLength(1);
      expect(result.data.challenges[0].completionCount).toBe(2);
    });

    it('should include summary', async () => {
      const result = await getChallengeStatus(testUser);
      expect(result.data.summary.totalChallenges).toBe(1);
      expect(result.data.summary.totalCompletions).toBe(2);
      expect(result.data.summary.totalChallengeCount).toBe(10);
    });

    it('should handle getUser failure gracefully', async () => {
      dbClient.getUser.mockRejectedValue(new Error('fail'));
      const result = await getChallengeStatus(testUser);
      expect(result.success).toBe(true); // still succeeds
    });
  });

  // ===========================================================================
  // AVAILABLE CHALLENGES
  // ===========================================================================

  describe('getAvailableChallenges', () => {
    beforeEach(() => {
      dbClient.getTotem.mockResolvedValue({
        id: 'ttm_abc',
        stage: 1,
        name: 'Wolfie',
        stats: { strength: 10 },
      });
      chalService.getAvailableChallenges.mockReturnValue([
        { id: 'c-0', name: 'Memory', description: 'Test', type: 'memory', affinity: 'Wisdom',
          requirements: { stage: 1 }, maxScore: 100, xpReward: 50, maxDailyAttempts: 3 },
      ]);
      chalService.getUnavailableChallenges.mockReturnValue([
        { id: 'c-5', name: 'Hard', description: 'Locked', type: 'logic', affinity: 'Wisdom',
          requirements: { stage: 4 }, maxScore: 100, xpReward: 100, maxDailyAttempts: 2,
          reason: 'Stage too low', unmetRequirement: 'stage' },
      ]);
      chalService.getChallengeStatus.mockResolvedValue([]);
      chalService.getAllChallenges.mockReturnValue([{ id: 'c-0' }, { id: 'c-5' }]);
    });

    it('should return available and locked challenges', async () => {
      const result = await getAvailableChallenges(testUser, 'ttm_abc');
      expect(result.success).toBe(true);
      expect(result.data.available).toHaveLength(1);
      expect(result.data.locked).toHaveLength(1);
      expect(result.data.locked[0].status).toBe('locked');
    });

    it('should include summary', async () => {
      const result = await getAvailableChallenges(testUser, 'ttm_abc');
      expect(result.data.summary.totalChallenges).toBe(2);
      expect(result.data.summary.availableCount).toBe(1);
      expect(result.data.summary.lockedCount).toBe(1);
    });

    it('should reject invalid totemId', async () => {
      const result = await getAvailableChallenges(testUser, 'bad');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should reject missing totemId', async () => {
      const result = await getAvailableChallenges(testUser, null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should return NOT_FOUND when totem missing', async () => {
      dbClient.getTotem.mockResolvedValue(null);
      const result = await getAvailableChallenges(testUser, 'ttm_missing');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // ===========================================================================
  // INDEX WRAPPERS
  // ===========================================================================

  describe('index wrappers', () => {
    it('getChallenges should delegate to listChallenges', async () => {
      chalService.getChallengeStatus.mockResolvedValue([]);
      chalService.getAllChallenges.mockReturnValue([]);
      const result = await getChallenges(testUser);
      expect(result.success).toBe(true);
    });

    it('complete should merge challengeId from param', async () => {
      chalService.completeChallenge.mockResolvedValue({
        success: true,
        data: { challengeId: 'c-0', xpAwarded: 50 },
      });
      dbClient.getTotem.mockResolvedValue({ id: 'ttm_abc', stats: {} });

      await complete(testUser, 'c-0', { totemId: 'ttm_abc', score: 85 });
      // 5th arg is the optional difficulty (undefined when omitted)
      expect(chalService.completeChallenge).toHaveBeenCalledWith(
        testUser.userId, 'c-0', 'ttm_abc', 85, undefined
      );
    });

    it('complete should thread difficulty from body', async () => {
      chalService.completeChallenge.mockResolvedValue({
        success: true,
        data: { challengeId: 'c-0', xpAwarded: 50 },
      });
      dbClient.getTotem.mockResolvedValue({ id: 'ttm_abc', stats: {} });

      await complete(testUser, 'c-0', { totemId: 'ttm_abc', score: 85, difficulty: 3 });
      expect(chalService.completeChallenge).toHaveBeenCalledWith(
        testUser.userId, 'c-0', 'ttm_abc', 85, 3
      );
    });
  });
});
