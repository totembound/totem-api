/**
 * Game Actions Helpers Tests
 *
 * Tests for all pure helper functions in game-actions/helpers.js
 * Covers: cooldowns, time windows, XP/happiness calculations,
 * stage progression, evolution requirements, stat changes, action results.
 */

const {
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
  TIME_WINDOWS,
  DEFAULT_STAGE_NAMES,
  MAX_STAGE,
  getStageName,
  checkCooldown,
  checkFeedTimeWindow,
  formatCooldownRemaining,
  getXpGain,
  getHappinessChange,
  getActionCost,
  getMinHappiness,
  calculateStage,
  getXpToNextStage,
  checkEvolutionRequirements,
  calculateStatChanges,
  buildActionResult,
} = require('../src/functions/game-actions/helpers');

// =============================================================================
// CONFIGURATION TESTS
// =============================================================================

describe('Game Actions Helpers', () => {
  describe('ACTION_CONFIGS', () => {
    it('should have configs for all 4 action types', () => {
      expect(ACTION_CONFIGS).toHaveProperty('feed');
      expect(ACTION_CONFIGS).toHaveProperty('train');
      expect(ACTION_CONFIGS).toHaveProperty('treat');
      expect(ACTION_CONFIGS).toHaveProperty('evolve');
    });

    it('should have correct feed config (10 cost, 0 XP, +10 happiness)', () => {
      expect(ACTION_CONFIGS.feed.cost).toBe(10);
      expect(ACTION_CONFIGS.feed.experienceGain).toBe(0);
      expect(ACTION_CONFIGS.feed.happinessChange).toBe(10);
      expect(ACTION_CONFIGS.feed.maxDaily).toBe(3);
      expect(ACTION_CONFIGS.feed.cooldown).toBe(0);
    });

    it('should have correct train config (20 cost, 50 XP, -10 happiness)', () => {
      expect(ACTION_CONFIGS.train.cost).toBe(20);
      expect(ACTION_CONFIGS.train.experienceGain).toBe(50);
      expect(ACTION_CONFIGS.train.happinessChange).toBe(-10);
      expect(ACTION_CONFIGS.train.minHappiness).toBe(20);
      expect(ACTION_CONFIGS.train.cooldown).toBe(0);
    });

    it('should have correct treat config (20 cost, 0 XP, +10 happiness, 4hr CD)', () => {
      expect(ACTION_CONFIGS.treat.cost).toBe(20);
      expect(ACTION_CONFIGS.treat.experienceGain).toBe(0);
      expect(ACTION_CONFIGS.treat.happinessChange).toBe(10);
      expect(ACTION_CONFIGS.treat.cooldown).toBe(14400); // 4 hours in seconds
    });

    it('should have correct evolve config (0 cost, 30 min happiness)', () => {
      expect(ACTION_CONFIGS.evolve.cost).toBe(0);
      expect(ACTION_CONFIGS.evolve.experienceGain).toBe(0);
      expect(ACTION_CONFIGS.evolve.minHappiness).toBe(30);
    });
  });

  describe('STAGE_THRESHOLDS', () => {
    it('should have 5 stage thresholds', () => {
      expect(STAGE_THRESHOLDS).toHaveLength(5);
    });

    it('should match contract values [0, 500, 1500, 3500, 7500]', () => {
      expect(STAGE_THRESHOLDS).toEqual([0, 500, 1500, 3500, 7500]);
    });
  });

  describe('Constants', () => {
    it('MAX_STAGE should be 4', () => {
      expect(MAX_STAGE).toBe(4);
    });

    it('PRESTIGE_XP_REQUIREMENT should be 2500', () => {
      expect(PRESTIGE_XP_REQUIREMENT).toBe(2500);
    });

    it('DEFAULT_STAGE_NAMES should have 5 names', () => {
      expect(DEFAULT_STAGE_NAMES).toEqual(['Hatchling', 'Chick', 'Juvenile', 'Adult', 'Wise Elder']);
    });

    it('TIME_WINDOWS should have 3 8-hour windows', () => {
      expect(TIME_WINDOWS.windowsPerDay).toBe(3);
      expect(TIME_WINDOWS.windowDuration).toBe(28800);
      expect(TIME_WINDOWS.windows).toHaveLength(3);
    });
  });

  // =============================================================================
  // COOLDOWN TESTS
  // =============================================================================

  describe('checkCooldown', () => {
    it('should return not on cooldown when no last action time', () => {
      const result = checkCooldown(null, 'treat');
      expect(result.onCooldown).toBe(false);
      expect(result.remainingMs).toBe(0);
    });

    it('should return not on cooldown for actions with 0 cooldown (train)', () => {
      const result = checkCooldown(new Date().toISOString(), 'train');
      expect(result.onCooldown).toBe(false);
    });

    it('should return on cooldown when treat was just used', () => {
      const justNow = new Date().toISOString();
      const result = checkCooldown(justNow, 'treat');
      expect(result.onCooldown).toBe(true);
      expect(result.remainingMs).toBeGreaterThan(0);
      expect(result.readyAt).toBeInstanceOf(Date);
    });

    it('should return not on cooldown when treat cooldown has expired', () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const result = checkCooldown(fiveHoursAgo, 'treat');
      expect(result.onCooldown).toBe(false);
    });

    it('should handle unknown action type gracefully', () => {
      const result = checkCooldown(new Date().toISOString(), 'nonexistent');
      expect(result.onCooldown).toBe(false);
    });

    it('should calculate remaining ms correctly for treat (4hr = 14400s)', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const result = checkCooldown(twoHoursAgo, 'treat');
      expect(result.onCooldown).toBe(true);
      // ~2 hours remaining (14400s - 7200s = 7200s = 7200000ms)
      expect(result.remainingMs).toBeGreaterThan(7000000);
      expect(result.remainingMs).toBeLessThan(7400000);
    });
  });

  // =============================================================================
  // FEED TIME WINDOW TESTS
  // =============================================================================

  describe('checkFeedTimeWindow', () => {
    it('should allow feeding with empty history', () => {
      const result = checkFeedTimeWindow([]);
      expect(result.canFeed).toBe(true);
      expect(result.feedsToday).toBe(0);
      expect(result.maxDaily).toBe(3);
    });

    it('should allow feeding with no history', () => {
      const result = checkFeedTimeWindow();
      expect(result.canFeed).toBe(true);
    });

    it('should block feeding at max daily (3 feeds today)', () => {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const secondsSinceMidnight = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

      // Determine current window so we can place all 3 feeds in OTHER windows
      let currentWindow = 0;
      if (secondsSinceMidnight >= 28800 && secondsSinceMidnight < 57600) currentWindow = 1;
      else if (secondsSinceMidnight >= 57600) currentWindow = 2;

      const otherWindows = [0, 1, 2].filter(w => w !== currentWindow);
      const windowTimes = { 0: '01:00:00.000', 1: '09:00:00.000', 2: '17:00:00.000' };

      // 3 feeds in non-current windows: 2 in first other window, 1 in second
      const history = [
        { timestamp: `${todayStr}T${windowTimes[otherWindows[0]]}Z`, window: otherWindows[0] },
        { timestamp: `${todayStr}T${windowTimes[otherWindows[0]]}Z`, window: otherWindows[0] },
        { timestamp: `${todayStr}T${windowTimes[otherWindows[1]]}Z`, window: otherWindows[1] },
      ];
      const result = checkFeedTimeWindow(history);
      expect(result.canFeed).toBe(false);
      expect(result.reason).toBe('Maximum daily feeds reached');
    });

    it('should report currentWindow as a number', () => {
      const result = checkFeedTimeWindow([]);
      expect(typeof result.currentWindow).toBe('number');
      expect(result.currentWindow).toBeGreaterThanOrEqual(0);
      expect(result.currentWindow).toBeLessThanOrEqual(2);
    });

    it('should ignore feeds from previous days', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const history = [
        { timestamp: yesterday.toISOString(), window: 0 },
        { timestamp: yesterday.toISOString(), window: 1 },
        { timestamp: yesterday.toISOString(), window: 2 },
      ];
      const result = checkFeedTimeWindow(history);
      expect(result.canFeed).toBe(true);
      expect(result.feedsToday).toBe(0);
    });
  });

  // =============================================================================
  // FORMAT COOLDOWN TESTS
  // =============================================================================

  describe('formatCooldownRemaining', () => {
    it('should format hours and minutes', () => {
      const threeHoursMs = 3 * 60 * 60 * 1000 + 30 * 60 * 1000;
      expect(formatCooldownRemaining(threeHoursMs)).toBe('3h 30m');
    });

    it('should format minutes only when under 1 hour', () => {
      const thirtyMin = 30 * 60 * 1000;
      expect(formatCooldownRemaining(thirtyMin)).toBe('30m');
    });

    it('should format 0 minutes', () => {
      expect(formatCooldownRemaining(0)).toBe('0m');
    });

    it('should handle exact hours', () => {
      const twoHours = 2 * 60 * 60 * 1000;
      expect(formatCooldownRemaining(twoHours)).toBe('2h 0m');
    });
  });

  // =============================================================================
  // ACTION VALUE GETTERS
  // =============================================================================

  describe('getXpGain', () => {
    it('should return 0 for feed', () => {
      expect(getXpGain('feed')).toBe(0);
    });

    it('should return 50 for train', () => {
      expect(getXpGain('train')).toBe(50);
    });

    it('should return 0 for treat', () => {
      expect(getXpGain('treat')).toBe(0);
    });

    it('should return 0 for evolve', () => {
      expect(getXpGain('evolve')).toBe(0);
    });

    it('should return 0 for unknown action', () => {
      expect(getXpGain('nonexistent')).toBe(0);
    });
  });

  describe('getHappinessChange', () => {
    it('should return +10 for feed', () => {
      expect(getHappinessChange('feed')).toBe(10);
    });

    it('should return -10 for train', () => {
      expect(getHappinessChange('train')).toBe(-10);
    });

    it('should return +10 for treat', () => {
      expect(getHappinessChange('treat')).toBe(10);
    });
  });

  describe('getActionCost', () => {
    it('should return 10 for feed', () => {
      expect(getActionCost('feed')).toBe(10);
    });

    it('should return 20 for train', () => {
      expect(getActionCost('train')).toBe(20);
    });

    it('should return 20 for treat', () => {
      expect(getActionCost('treat')).toBe(20);
    });

    it('should return 0 for evolve', () => {
      expect(getActionCost('evolve')).toBe(0);
    });
  });

  describe('getMinHappiness', () => {
    it('should return 0 for feed', () => {
      expect(getMinHappiness('feed')).toBe(0);
    });

    it('should return 20 for train', () => {
      expect(getMinHappiness('train')).toBe(20);
    });

    it('should return 30 for evolve', () => {
      expect(getMinHappiness('evolve')).toBe(30);
    });
  });

  // =============================================================================
  // STAGE PROGRESSION TESTS
  // =============================================================================

  describe('calculateStage', () => {
    it('should return stage 0 for 0 XP', () => {
      expect(calculateStage(0)).toBe(0);
    });

    it('should return stage 0 for 499 XP', () => {
      expect(calculateStage(499)).toBe(0);
    });

    it('should return stage 1 for 500 XP', () => {
      expect(calculateStage(500)).toBe(1);
    });

    it('should return stage 2 for 1500 XP', () => {
      expect(calculateStage(1500)).toBe(2);
    });

    it('should return stage 3 for 3500 XP', () => {
      expect(calculateStage(3500)).toBe(3);
    });

    it('should return stage 4 (max) for 7500 XP', () => {
      expect(calculateStage(7500)).toBe(4);
    });

    it('should return stage 4 for XP far above max', () => {
      expect(calculateStage(99999)).toBe(4);
    });
  });

  describe('getXpToNextStage', () => {
    it('should return 500 XP needed from 0 XP at stage 0', () => {
      expect(getXpToNextStage(0, 0)).toBe(500);
    });

    it('should return 200 XP needed from 300 XP at stage 0', () => {
      expect(getXpToNextStage(300, 0)).toBe(200);
    });

    it('should return 1000 XP needed from 500 XP at stage 1', () => {
      expect(getXpToNextStage(500, 1)).toBe(1000);
    });

    it('should return 0 at max stage', () => {
      expect(getXpToNextStage(10000, 4)).toBe(0);
    });
  });

  // =============================================================================
  // EVOLUTION REQUIREMENTS TESTS
  // =============================================================================

  describe('checkEvolutionRequirements', () => {
    it('should not allow evolution at max stage', () => {
      const totem = { stage: 4, experience: 99999, stats: { happiness: 100 } };
      const result = checkEvolutionRequirements(totem);
      expect(result.canEvolve).toBe(false);
      expect(result.reason).toContain('maximum stage');
    });

    it('should not allow evolution with insufficient XP', () => {
      const totem = { stage: 0, experience: 100, stats: { happiness: 50 } };
      const result = checkEvolutionRequirements(totem);
      expect(result.canEvolve).toBe(false);
      expect(result.reason).toContain('XP');
      expect(result.requirements.experience.met).toBe(false);
    });

    it('should not allow evolution with insufficient happiness', () => {
      const totem = { stage: 0, experience: 600, stats: { happiness: 10 } };
      const result = checkEvolutionRequirements(totem);
      expect(result.canEvolve).toBe(false);
      expect(result.reason).toContain('happiness');
      expect(result.requirements.happiness.met).toBe(false);
    });

    it('should allow evolution when all requirements met (stage 0 → 1)', () => {
      const totem = { stage: 0, experience: 500, stats: { happiness: 50 } };
      const result = checkEvolutionRequirements(totem);
      expect(result.canEvolve).toBe(true);
      expect(result.requirements.experience.met).toBe(true);
      expect(result.requirements.happiness.met).toBe(true);
    });

    it('should require 1500 XP for stage 1 → 2', () => {
      const totem = { stage: 1, experience: 1500, stats: { happiness: 50 } };
      const result = checkEvolutionRequirements(totem);
      expect(result.canEvolve).toBe(true);
      expect(result.requirements.experience.required).toBe(1500);
    });

    it('should require 3500 XP for stage 2 → 3', () => {
      const totem = { stage: 2, experience: 3500, stats: { happiness: 50 } };
      const result = checkEvolutionRequirements(totem);
      expect(result.canEvolve).toBe(true);
      expect(result.requirements.experience.required).toBe(3500);
    });

    it('should require 7500 XP for stage 3 → 4', () => {
      const totem = { stage: 3, experience: 7500, stats: { happiness: 50 } };
      const result = checkEvolutionRequirements(totem);
      expect(result.canEvolve).toBe(true);
      expect(result.requirements.experience.required).toBe(7500);
    });

    it('should handle missing stats gracefully', () => {
      const totem = { stage: 0, experience: 600 }; // no stats
      const result = checkEvolutionRequirements(totem);
      // happiness defaults to 0, which is < 30
      expect(result.canEvolve).toBe(false);
    });
  });

  // =============================================================================
  // STAT CHANGES TESTS
  // =============================================================================

  describe('calculateStatChanges', () => {
    const baseTotem = { stats: { happiness: 50, hunger: 80 } };

    it('should increase happiness by 10 for feed', () => {
      const result = calculateStatChanges('feed', baseTotem);
      expect(result.happiness).toBe(60);
      expect(result.happinessChange).toBe(10);
    });

    it('should reset hunger to 100 for feed', () => {
      const result = calculateStatChanges('feed', baseTotem);
      expect(result.hunger).toBe(100);
    });

    it('should decrease happiness by 10 for train', () => {
      const result = calculateStatChanges('train', baseTotem);
      expect(result.happiness).toBe(40);
      expect(result.happinessChange).toBe(-10);
    });

    it('should not include hunger for train', () => {
      const result = calculateStatChanges('train', baseTotem);
      expect(result.hunger).toBeUndefined();
    });

    it('should increase happiness by 10 for treat', () => {
      const result = calculateStatChanges('treat', baseTotem);
      expect(result.happiness).toBe(60);
      expect(result.happinessChange).toBe(10);
    });

    it('should cap happiness at 100', () => {
      const happyTotem = { stats: { happiness: 95 } };
      const result = calculateStatChanges('feed', happyTotem);
      expect(result.happiness).toBe(100);
    });

    it('should not go below 0 happiness', () => {
      const sadTotem = { stats: { happiness: 5 } };
      const result = calculateStatChanges('train', sadTotem);
      expect(result.happiness).toBe(0);
    });

    it('should default happiness to 50 if stats missing', () => {
      const noStats = {};
      const result = calculateStatChanges('feed', noStats);
      expect(result.happiness).toBe(60); // 50 + 10
    });

    it('should return empty object for unknown action', () => {
      const result = calculateStatChanges('nonexistent', baseTotem);
      expect(result).toEqual({});
    });
  });

  // =============================================================================
  // BUILD ACTION RESULT TESTS
  // =============================================================================

  describe('buildActionResult', () => {
    const totem = { id: 'ttm_test', experience: 100 };
    const statChanges = { happiness: 60, happinessChange: 10 };

    it('should include action type', () => {
      const result = buildActionResult('feed', totem, statChanges, 0);
      expect(result.action).toBe('feed');
    });

    it('should include totem ID', () => {
      const result = buildActionResult('feed', totem, statChanges, 0);
      expect(result.totemId).toBe('ttm_test');
    });

    it('should calculate new experience', () => {
      const result = buildActionResult('train', totem, statChanges, 50);
      expect(result.newExperience).toBe(150); // 100 + 50
    });

    it('should include cooldown for treat (has cooldown)', () => {
      const result = buildActionResult('treat', totem, statChanges, 0);
      expect(result.cooldown).toBeDefined();
      expect(result.cooldown.type).toBe('treat');
      expect(result.cooldown.duration).toBe(14400);
      expect(result.cooldown.readyAt).toBeDefined();
    });

    it('should NOT include cooldown for train (no cooldown)', () => {
      const result = buildActionResult('train', totem, statChanges, 50);
      expect(result.cooldown).toBeUndefined();
    });

    it('should NOT include cooldown for feed (no cooldown)', () => {
      const result = buildActionResult('feed', totem, statChanges, 0);
      expect(result.cooldown).toBeUndefined();
    });

    it('should include statChanges', () => {
      const result = buildActionResult('feed', totem, statChanges, 0);
      expect(result.statChanges).toEqual(statChanges);
    });
  });

  // =============================================================================
  // STAGE NAME TESTS
  // =============================================================================

  describe('getStageName', () => {
    it('should return default stage names when species data not available', () => {
      expect(getStageName(999, 0)).toBe('Hatchling');
      expect(getStageName(999, 1)).toBe('Chick');
      expect(getStageName(999, 2)).toBe('Juvenile');
      expect(getStageName(999, 3)).toBe('Adult');
      expect(getStageName(999, 4)).toBe('Wise Elder');
    });

    it('should return last default name for out-of-range stage', () => {
      expect(getStageName(999, 99)).toBe('Wise Elder');
    });

    it('should default to stage 0 when no stage provided', () => {
      expect(getStageName(999)).toBe('Hatchling');
    });
  });
});
