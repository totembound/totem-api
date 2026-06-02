/**
 * Totem Creation Service Tests
 *
 * Tests for rarity determination, color selection, species validation,
 * stats calculation, and full totem creation.
 */

// Mock id-utils for deterministic IDs
const mockTotemId = 'ttm_01TEST000000000000000000TEST';
jest.mock('../src/common/id-utils', () => ({
  generateId: jest.fn(() => mockTotemId),
}));

const {
  // Main creation
  createTotem,
  createStarterTotem,
  // Individual functions
  determineRarity,
  selectColor,
  selectLimitedColor,
  selectRandomSpecies,
  getSpecies,
  isSpeciesAvailable,
  calculateInitialStats,
  getStageNameForSpecies,
  // Config constants
  RARITIES,
  COLORS_BY_RARITY,
  SPECIES,
  SPECIES_DISPLAY_NAMES,
  AVAILABLE_SPECIES_IDS,
  ACTION_CONFIGS,
  STAGE_THRESHOLDS,
  PRESTIGE_XP_REQUIREMENT,
} = require('../src/services/totem-creation');

// =============================================================================
// TESTS
// =============================================================================

describe('Totem Creation Service', () => {

  // =============================================================================
  // STATIC CONFIG TESTS
  // =============================================================================

  describe('Static Configuration', () => {
    it('should define 6 rarities', () => {
      expect(RARITIES).toHaveLength(6);
      expect(RARITIES[0].name).toBe('Common');
      expect(RARITIES[5].name).toBe('Limited');
    });

    it('should have rarity drop chances summing to 100%', () => {
      const droppable = RARITIES.filter(r => r.dropChance > 0);
      const total = droppable.reduce((sum, r) => sum + r.dropChance, 0);
      expect(total).toBe(100);
    });

    it('should have Limited rarity with 0% drop chance', () => {
      const limited = RARITIES.find(r => r.name === 'Limited');
      expect(limited.dropChance).toBe(0);
    });

    it('should define stat bonuses per rarity', () => {
      expect(RARITIES[0].statBonus).toBe(0);  // Common
      expect(RARITIES[1].statBonus).toBe(1);  // Uncommon
      expect(RARITIES[2].statBonus).toBe(2);  // Rare
      expect(RARITIES[3].statBonus).toBe(3);  // Epic
      expect(RARITIES[4].statBonus).toBe(6);  // Legendary
      expect(RARITIES[5].statBonus).toBe(4);  // Limited
    });

    it('should define 12 species', () => {
      expect(SPECIES).toHaveLength(12);
    });

    it('should have matching display names', () => {
      expect(SPECIES_DISPLAY_NAMES).toHaveLength(12);
      expect(SPECIES_DISPLAY_NAMES[0]).toBe('Goose');
      expect(SPECIES_DISPLAY_NAMES[11]).toBe('Owl');
    });

    it('should have available species with base stats summing to 24', () => {
      SPECIES.forEach(s => {
        const total = s.baseStats.strength + s.baseStats.agility + s.baseStats.wisdom;
        expect(total).toBe(24);
      });
    });

    it('should have color pools for all rarity tiers', () => {
      expect(COLORS_BY_RARITY.common.length).toBeGreaterThan(0);
      expect(COLORS_BY_RARITY.uncommon.length).toBeGreaterThan(0);
      expect(COLORS_BY_RARITY.rare.length).toBeGreaterThan(0);
      expect(COLORS_BY_RARITY.epic.length).toBeGreaterThan(0);
      expect(COLORS_BY_RARITY.legendary.length).toBeGreaterThan(0);
      expect(COLORS_BY_RARITY.limited.length).toBeGreaterThan(0);
    });

    it('should have unique color IDs across all tiers', () => {
      const allIds = Object.values(COLORS_BY_RARITY)
        .flat()
        .map(c => c.id);
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });

    it('should define correct stage thresholds', () => {
      expect(STAGE_THRESHOLDS).toEqual([0, 500, 1500, 3500, 7500]);
    });

    it('should define action configs for feed, train, treat, evolve', () => {
      expect(ACTION_CONFIGS.feed).toBeDefined();
      expect(ACTION_CONFIGS.train).toBeDefined();
      expect(ACTION_CONFIGS.treat).toBeDefined();
      expect(ACTION_CONFIGS.evolve).toBeDefined();
    });

    it('should have correct action costs', () => {
      expect(ACTION_CONFIGS.feed.cost).toBe(10);
      expect(ACTION_CONFIGS.train.cost).toBe(20);
      expect(ACTION_CONFIGS.treat.cost).toBe(20);
      expect(ACTION_CONFIGS.evolve.cost).toBe(0);
    });

    it('should have correct XP gains', () => {
      expect(ACTION_CONFIGS.feed.experienceGain).toBe(0);
      expect(ACTION_CONFIGS.train.experienceGain).toBe(50);
      expect(ACTION_CONFIGS.treat.experienceGain).toBe(0);
    });

    it('should have correct happiness changes', () => {
      expect(ACTION_CONFIGS.feed.happinessChange).toBe(10);
      expect(ACTION_CONFIGS.train.happinessChange).toBe(-10);
      expect(ACTION_CONFIGS.treat.happinessChange).toBe(10);
    });

    it('should define prestige XP requirement', () => {
      expect(PRESTIGE_XP_REQUIREMENT).toBe(2500);
    });
  });

  // =============================================================================
  // AVAILABLE SPECIES TESTS
  // =============================================================================

  describe('Available Species', () => {
    it('should include only species marked as available', () => {
      AVAILABLE_SPECIES_IDS.forEach(id => {
        expect(SPECIES[id].available).toBe(true);
      });
    });

    it('should have 11 available species', () => {
      // 0 Goose, 1 Otter, 2 Wolf, 3 Falcon, 4 Beaver, 5 Deer, 6 Woodpecker, 7 Turtle, 8 Bear, 9 Raven, 11 Owl
      expect(AVAILABLE_SPECIES_IDS).toHaveLength(11);
    });

    it('should exclude unavailable species', () => {
      const unavailable = SPECIES.filter(s => !s.available).map(s => s.id);
      unavailable.forEach(id => {
        expect(AVAILABLE_SPECIES_IDS).not.toContain(id);
      });
    });
  });

  // =============================================================================
  // RARITY DETERMINATION TESTS
  // =============================================================================

  describe('determineRarity', () => {
    it('should return an object with rarityId, rarityName, statBonus', () => {
      const result = determineRarity();
      expect(result).toHaveProperty('rarityId');
      expect(result).toHaveProperty('rarityName');
      expect(result).toHaveProperty('statBonus');
    });

    it('should only return droppable rarities (not Limited)', () => {
      // Run many times to check distribution
      for (let i = 0; i < 100; i++) {
        const result = determineRarity();
        expect(result.rarityId).toBeLessThanOrEqual(4);
        expect(result.rarityName).not.toBe('Limited');
      }
    });

    it('should heavily favor Common rarity (75% chance)', () => {
      let commonCount = 0;
      const iterations = 10000;
      for (let i = 0; i < iterations; i++) {
        if (determineRarity().rarityId === 0) commonCount++;
      }
      // Should be roughly 75%, allow wide margin
      expect(commonCount / iterations).toBeGreaterThan(0.6);
      expect(commonCount / iterations).toBeLessThan(0.9);
    });

    it('should respect luck bonus shifting towards rarer', () => {
      let nonCommonCount = 0;
      const iterations = 10000;
      for (let i = 0; i < iterations; i++) {
        if (determineRarity(50).rarityId > 0) nonCommonCount++;
      }
      const nonCommonRate = nonCommonCount / iterations;
      // With 50% luck bonus, should have more non-commons than base 25%
      expect(nonCommonRate).toBeGreaterThan(0.25);
    });

    it('should have correct statBonus for each rarity', () => {
      const expectedBonuses = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 6 };
      for (let i = 0; i < 1000; i++) {
        const result = determineRarity();
        expect(result.statBonus).toBe(expectedBonuses[result.rarityId]);
      }
    });
  });

  // =============================================================================
  // COLOR SELECTION TESTS
  // =============================================================================

  describe('selectColor', () => {
    it('should return a color from the correct rarity pool', () => {
      const commonColor = selectColor(0);
      const commonIds = COLORS_BY_RARITY.common.map(c => c.id);
      expect(commonIds).toContain(commonColor.colorId);
    });

    it('should return Rare colors for rarityId 2', () => {
      const color = selectColor(2);
      const rareIds = COLORS_BY_RARITY.rare.map(c => c.id);
      expect(rareIds).toContain(color.colorId);
    });

    it('should return Epic colors for rarityId 3', () => {
      const color = selectColor(3);
      const epicIds = COLORS_BY_RARITY.epic.map(c => c.id);
      expect(epicIds).toContain(color.colorId);
    });

    it('should return object with colorId and colorName', () => {
      const color = selectColor(0);
      expect(typeof color.colorId).toBe('number');
      expect(typeof color.colorName).toBe('string');
    });
  });

  describe('selectLimitedColor', () => {
    it('should return specific limited color by ID', () => {
      const color = selectLimitedColor(16); // FrostbiteBlue
      expect(color.colorId).toBe(16);
      expect(color.colorName).toBe('FrostbiteBlue');
    });

    it('should return null for invalid color ID', () => {
      expect(selectLimitedColor(999)).toBeNull();
    });

    it('should return null for non-limited color ID', () => {
      expect(selectLimitedColor(0)).toBeNull(); // 0 = Brown (common)
    });
  });

  // =============================================================================
  // SPECIES SELECTION TESTS
  // =============================================================================

  describe('selectRandomSpecies', () => {
    it('should return a species from the available pool', () => {
      const species = selectRandomSpecies();
      expect(AVAILABLE_SPECIES_IDS).toContain(species.speciesId);
    });

    it('should return speciesId, speciesName, and baseStats', () => {
      const species = selectRandomSpecies();
      expect(typeof species.speciesId).toBe('number');
      expect(typeof species.speciesName).toBe('string');
      expect(species.baseStats).toHaveProperty('strength');
      expect(species.baseStats).toHaveProperty('agility');
      expect(species.baseStats).toHaveProperty('wisdom');
    });

    it('should use display name (not full name)', () => {
      const species = selectRandomSpecies();
      expect(SPECIES_DISPLAY_NAMES).toContain(species.speciesName);
    });
  });

  describe('getSpecies', () => {
    it('should return available species', () => {
      const species = getSpecies(0); // Mystic Goose - available
      expect(species).not.toBeNull();
      expect(species.speciesId).toBe(0);
    });

    it('should return null for unavailable species with availability check', () => {
      expect(getSpecies(10)).toBeNull(); // Snake - unavailable
    });

    it('should return unavailable species when check is disabled', () => {
      const species = getSpecies(10, false);
      expect(species).not.toBeNull();
      expect(species.speciesId).toBe(10);
    });

    it('should return null for invalid species ID', () => {
      expect(getSpecies(999)).toBeNull();
    });
  });

  describe('isSpeciesAvailable', () => {
    it('should return true for available species', () => {
      expect(isSpeciesAvailable(0)).toBe(true); // Goose
      expect(isSpeciesAvailable(2)).toBe(true); // Wolf
      expect(isSpeciesAvailable(11)).toBe(true); // Owl
    });

    it('should return true for newly activated species', () => {
      expect(isSpeciesAvailable(7)).toBe(true);   // Turtle
    });

    it('should return false for unavailable species', () => {
      expect(isSpeciesAvailable(10)).toBe(false);  // Snake
    });
  });

  // =============================================================================
  // STATS CALCULATION TESTS
  // =============================================================================

  describe('calculateInitialStats', () => {
    it('should return base stats with no bonus for Common', () => {
      const baseStats = { strength: 8, agility: 6, wisdom: 10 };
      const stats = calculateInitialStats(baseStats, 0);

      expect(stats.strength).toBe(8);
      expect(stats.agility).toBe(6);
      expect(stats.wisdom).toBe(10);
    });

    it('should add rarity bonus to all stat types', () => {
      const baseStats = { strength: 8, agility: 6, wisdom: 10 };
      const stats = calculateInitialStats(baseStats, 3); // Epic bonus

      expect(stats.strength).toBe(11);
      expect(stats.agility).toBe(9);
      expect(stats.wisdom).toBe(13);
    });

    it('should start with happiness 50 and hunger 70', () => {
      const stats = calculateInitialStats({ strength: 5, agility: 5, wisdom: 5 });

      expect(stats.happiness).toBe(50);
      expect(stats.hunger).toBe(70);
    });

    it('should add Legendary bonus (+6) correctly', () => {
      const baseStats = { strength: 12, agility: 5, wisdom: 7 }; // Bear
      const stats = calculateInitialStats(baseStats, 6);

      expect(stats.strength).toBe(18);
      expect(stats.agility).toBe(11);
      expect(stats.wisdom).toBe(13);
    });
  });

  // =============================================================================
  // STAGE NAME TESTS
  // =============================================================================

  describe('getStageNameForSpecies', () => {
    it('should return default stage names when species data not found', () => {
      const name = getStageNameForSpecies(999, 0);
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    });

    it('should return a string for valid stage', () => {
      const name = getStageNameForSpecies(0, 0);
      expect(typeof name).toBe('string');
    });
  });

  // =============================================================================
  // CREATE TOTEM TESTS
  // =============================================================================

  describe('createTotem', () => {
    it('should create a totem with all required fields', () => {
      const totem = createTotem({ userId: 'usr_test123' });

      expect(totem.pk).toBe('USER#usr_test123');
      expect(totem.sk).toBe(`TOTEM#${mockTotemId}`);
      expect(totem.id).toBe(mockTotemId);
      expect(totem.userId).toBe('usr_test123');
      expect(totem.stage).toBe(0);
      expect(totem.experience).toBe(0);
      expect(totem.prestigeLevel).toBe(0);
      expect(totem.cooldowns).toEqual({ feed: null, train: null, treat: null });
      expect(totem.createdAt).toBeDefined();
      expect(totem.updatedAt).toBeDefined();
    });

    it('should stamp an innate trait at creation, with learned/awakened null', () => {
      const { INNATE_POOL } = require('../src/config/traits');
      const totem = createTotem({ userId: 'usr_test123' });
      expect(totem.traits).toBeDefined();
      expect(INNATE_POOL).toContain(totem.traits.innate);
      expect(totem.traits.learned).toBeNull();
      expect(totem.traits.awakened).toBeNull();
    });

    it('starter totem also gets an innate trait', () => {
      const { INNATE_POOL } = require('../src/config/traits');
      const totem = createStarterTotem('usr_test123');
      expect(INNATE_POOL).toContain(totem.traits.innate);
      expect(totem.traits.learned).toBeNull();
      expect(totem.traits.awakened).toBeNull();
    });

    it('should select random species when not specified', () => {
      const totem = createTotem({ userId: 'usr_test123' });
      expect(AVAILABLE_SPECIES_IDS).toContain(totem.speciesId);
    });

    it('should use specified species', () => {
      const totem = createTotem({ userId: 'usr_test123', speciesId: 2 }); // Wolf
      expect(totem.speciesId).toBe(2);
    });

    it('should throw for unavailable species', () => {
      expect(() => {
        createTotem({ userId: 'usr_test123', speciesId: 10 }); // Snake - unavailable
      }).toThrow('Species 10 is not available');
    });

    it('should set nickname when name provided', () => {
      const totem = createTotem({ userId: 'usr_test123', name: 'Fluffy' });
      expect(totem.nickname).toBe('Fluffy');
    });

    it('should set nickname to null when no name provided', () => {
      const totem = createTotem({ userId: 'usr_test123' });
      expect(totem.nickname).toBeNull();
    });

    it('should force Limited rarity when isLimited is true', () => {
      const totem = createTotem({ userId: 'usr_test123', isLimited: true });
      expect(totem.rarityId).toBe(5);
    });

    it('should use specific limited color when provided', () => {
      const totem = createTotem({
        userId: 'usr_test123',
        isLimited: true,
        limitedColorId: 16, // FrostbiteBlue
      });
      expect(totem.colorId).toBe(16);
    });

    it('should throw for invalid limited color ID', () => {
      expect(() => {
        createTotem({ userId: 'usr_test123', isLimited: true, limitedColorId: 999 });
      }).toThrow('Limited color 999 not found');
    });

    it('should apply rarity stat bonus to all stats', () => {
      // Force a specific species for consistent test
      const totem = createTotem({ userId: 'usr_test123', speciesId: 0, isLimited: true });
      // Limited = +4 bonus. Goose base: 8/6/10
      expect(totem.stats.strength).toBe(12);
      expect(totem.stats.agility).toBe(10);
      expect(totem.stats.wisdom).toBe(14);
    });

    it('should set happiness to 50 and hunger to 70', () => {
      const totem = createTotem({ userId: 'usr_test123' });
      expect(totem.stats.happiness).toBe(50);
      expect(totem.stats.hunger).toBe(70);
    });

    it('should anchor the hunger decay clock at creation', () => {
      const totem = createTotem({ userId: 'usr_test123' });
      expect(typeof totem.hungerUpdatedAt).toBe('string');
      expect(totem.hungerUpdatedAt).toBe(totem.createdAt);
    });
  });

  // =============================================================================
  // CREATE STARTER TOTEM TESTS
  // =============================================================================

  describe('createStarterTotem', () => {
    it('should create an Uncommon rarity totem', () => {
      const totem = createStarterTotem('usr_new');
      expect(totem.rarityId).toBe(1);
    });

    it('should select random available species', () => {
      const totem = createStarterTotem('usr_new');
      expect(AVAILABLE_SPECIES_IDS).toContain(totem.speciesId);
    });

    it('should use Uncommon color pool', () => {
      const totem = createStarterTotem('usr_new');
      const uncommonIds = COLORS_BY_RARITY.uncommon.map(c => c.id);
      expect(uncommonIds).toContain(totem.colorId);
    });

    it('should have Uncommon stat bonus (+1)', () => {
      const totem = createStarterTotem('usr_new');
      const species = SPECIES[totem.speciesId];
      expect(totem.stats.strength).toBe(species.baseStats.strength + 1);
      expect(totem.stats.agility).toBe(species.baseStats.agility + 1);
      expect(totem.stats.wisdom).toBe(species.baseStats.wisdom + 1);
    });

    it('should start at stage 0 with 0 XP', () => {
      const totem = createStarterTotem('usr_new');
      expect(totem.stage).toBe(0);
      expect(totem.experience).toBe(0);
      expect(totem.prestigeLevel).toBe(0);
    });

    it('should have null nickname', () => {
      const totem = createStarterTotem('usr_new');
      expect(totem.nickname).toBeNull();
    });

    it('should have correct DynamoDB keys', () => {
      const totem = createStarterTotem('usr_new');
      expect(totem.pk).toBe('USER#usr_new');
      expect(totem.sk).toMatch(/^TOTEM#/);
      expect(totem.userId).toBe('usr_new');
    });

    it('should initialize all cooldowns to null', () => {
      const totem = createStarterTotem('usr_new');
      expect(totem.cooldowns).toEqual({ feed: null, train: null, treat: null });
    });
  });
});
