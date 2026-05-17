/**
 * Trait config + helper tests.
 */

const {
  TRAITS,
  INNATE_POOL,
  LEARNED_POOL,
  AWAKENED_POOL,
  STAGE_GATES,
  pickRandomInnate,
  buildInitialTraits,
  getTraitById,
  isValidTraitForSlot,
  getRequiredStageForSlot,
} = require('../src/config/traits');

describe('Traits config', () => {
  it('defines 30 traits across three pools', () => {
    expect(TRAITS).toHaveLength(30);
    expect(INNATE_POOL).toHaveLength(12);
    expect(LEARNED_POOL).toHaveLength(10);
    expect(AWAKENED_POOL).toHaveLength(8);
  });

  it('uses unique trait IDs', () => {
    const ids = TRAITS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps slot pools disjoint (no trait appears in more than one pool)', () => {
    const innate = new Set(INNATE_POOL);
    for (const id of LEARNED_POOL) expect(innate.has(id)).toBe(false);
    for (const id of AWAKENED_POOL) expect(innate.has(id)).toBe(false);
    const learned = new Set(LEARNED_POOL);
    for (const id of AWAKENED_POOL) expect(learned.has(id)).toBe(false);
  });

  it('declares stage gates at 2 (learned) and 4 (awakened)', () => {
    expect(STAGE_GATES.learned).toBe(2);
    expect(STAGE_GATES.awakened).toBe(4);
  });

  it('every trait has an icon name', () => {
    for (const t of TRAITS) {
      expect(typeof t.icon).toBe('string');
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('pickRandomInnate', () => {
  it('always returns a trait id from the innate pool', () => {
    for (let i = 0; i < 50; i++) {
      expect(INNATE_POOL).toContain(pickRandomInnate());
    }
  });
});

describe('buildInitialTraits', () => {
  it('returns a shape with an innate trait and null learned/awakened', () => {
    const t = buildInitialTraits();
    expect(INNATE_POOL).toContain(t.innate);
    expect(t.learned).toBeNull();
    expect(t.awakened).toBeNull();
  });
});

describe('getTraitById', () => {
  it('returns the definition for a known trait', () => {
    const t = getTraitById('trt_quick_learner');
    expect(t).not.toBeNull();
    expect(t.slot).toBe('learned');
    expect(t.name).toBe('Quick Learner');
  });

  it('returns null for unknown ids', () => {
    expect(getTraitById('trt_does_not_exist')).toBeNull();
  });
});

describe('isValidTraitForSlot', () => {
  it('accepts a learned trait for the learned slot', () => {
    expect(isValidTraitForSlot('trt_quick_learner', 'learned')).toBe(true);
  });
  it('rejects an innate trait for the learned slot', () => {
    expect(isValidTraitForSlot('trt_curious', 'learned')).toBe(false);
  });
  it('rejects a learned trait for the awakened slot', () => {
    expect(isValidTraitForSlot('trt_quick_learner', 'awakened')).toBe(false);
  });
});

describe('getRequiredStageForSlot', () => {
  it('returns 2 for learned, 4 for awakened', () => {
    expect(getRequiredStageForSlot('learned')).toBe(2);
    expect(getRequiredStageForSlot('awakened')).toBe(4);
  });
  it('returns null for innate (not a player choice)', () => {
    expect(getRequiredStageForSlot('innate')).toBeNull();
  });
});
