/**
 * Trait effect resolver — unit tests.
 *
 * Resolver mechanics use a synthetic trait map (jest.mock) so they don't
 * couple to real magnitudes. A second suite runs against the real config
 * to lock in the §3 table values from `docs/totem-traits-phase2-plan.md`.
 */

jest.mock('../src/config/traits', () => {
  const TRAIT_BY_ID = {
    trt_xp_train: {
      id: 'trt_xp_train',
      slot: 'learned',
      effects: [{ type: 'xpMultiplier', value: 1.1, scope: 'action:train' }],
    },
    trt_xp_train_extra: {
      id: 'trt_xp_train_extra',
      slot: 'innate',
      effects: [{ type: 'xpMultiplier', value: 1.05, scope: 'action:train' }],
    },
    trt_thrifty_like: {
      id: 'trt_thrifty_like',
      slot: 'learned',
      effects: [
        {
          type: 'essenceCostMultiplier',
          value: 0.9,
          scope: ['action:feed', 'action:train', 'action:treat'],
        },
      ],
    },
    trt_str_chal: {
      id: 'trt_str_chal',
      slot: 'innate',
      effects: [
        { type: 'statBonus', value: { strength: 1 }, scope: 'challenge:strength' },
      ],
    },
    trt_any_chal: {
      id: 'trt_any_chal',
      slot: 'innate',
      effects: [{ type: 'successChanceBonus', value: 0.05, scope: 'challenge:any' }],
    },
    trt_aura_xp: {
      id: 'trt_aura_xp',
      slot: 'awakened',
      effects: [{ type: 'xpMultiplier', value: 1.1, scope: 'aura' }],
    },
    trt_aura_combat_def: {
      id: 'trt_aura_combat_def',
      slot: 'awakened',
      effects: [{ type: 'defenseBonus', value: 0.05, scope: 'aura:combat' }],
    },
    trt_kindred_like: {
      id: 'trt_kindred_like',
      slot: 'awakened',
      effects: [
        {
          type: 'xpMultiplier',
          value: 1.1,
          scope: 'aura',
          condition: 'same_species_teammate',
        },
      ],
    },
    trt_unknown_key: {
      id: 'trt_unknown_key',
      slot: 'innate',
      effects: [{ type: 'mysteryMultiplier', value: 2, scope: 'action:train' }],
    },
    trt_bad_condition: {
      id: 'trt_bad_condition',
      slot: 'innate',
      effects: [
        { type: 'xpMultiplier', value: 9, scope: 'aura', condition: 'never_seen' },
      ],
    },
  };
  return { TRAIT_BY_ID };
});

const { resolveTraitBonuses, EMPTY_BONUSES } = require('../src/config/trait-effects');

function totem(overrides = {}) {
  return {
    id: 't1',
    speciesId: 0,
    traits: { innate: null, learned: null, awakened: null },
    ...overrides,
  };
}

describe('resolveTraitBonuses — identity', () => {
  it('returns identity bonuses when no traits are filled', () => {
    const b = resolveTraitBonuses(totem(), { action: 'train' });
    expect(b).toEqual(EMPTY_BONUSES);
  });

  it('returns identity bonuses when totem is null/undefined', () => {
    expect(resolveTraitBonuses(null, { action: 'train' })).toEqual(EMPTY_BONUSES);
    expect(resolveTraitBonuses([null, undefined], { action: 'train' })).toEqual(
      EMPTY_BONUSES,
    );
  });

  it('returns a fresh object — does not mutate EMPTY_BONUSES', () => {
    const b = resolveTraitBonuses(
      totem({ traits: { innate: null, learned: 'trt_xp_train', awakened: null } }),
      { action: 'train' },
    );
    b.xpMultiplier = 99;
    expect(EMPTY_BONUSES.xpMultiplier).toBe(1);
  });
});

describe('resolveTraitBonuses — scope filter', () => {
  it('applies xpMultiplier when scope matches', () => {
    const b = resolveTraitBonuses(
      totem({ traits: { learned: 'trt_xp_train' } }),
      { action: 'train' },
    );
    expect(b.xpMultiplier).toBeCloseTo(1.1, 5);
  });

  it('skips xpMultiplier when scope does not match', () => {
    const b = resolveTraitBonuses(
      totem({ traits: { learned: 'trt_xp_train' } }),
      { action: 'feed' },
    );
    expect(b.xpMultiplier).toBe(1);
  });

  it('matches array-scoped effects across all listed scopes', () => {
    const t = totem({ traits: { learned: 'trt_thrifty_like' } });
    for (const action of ['feed', 'train', 'treat']) {
      const b = resolveTraitBonuses(t, { action });
      expect(b.essenceCostMultiplier).toBeCloseTo(0.9, 5);
    }
    expect(resolveTraitBonuses(t, { action: 'evolve' }).essenceCostMultiplier).toBe(
      1,
    );
  });

  it('challenge:any wildcard matches every challenge stat', () => {
    const t = totem({ traits: { innate: 'trt_any_chal' } });
    for (const challenge of ['strength', 'agility', 'wisdom']) {
      const b = resolveTraitBonuses(t, { challenge });
      expect(b.successChanceBonus).toBeCloseTo(0.05, 5);
    }
  });

  it('aura scope token matches every context', () => {
    const t = totem({ traits: { awakened: 'trt_aura_xp' } });
    expect(resolveTraitBonuses(t, { action: 'feed' }).xpMultiplier).toBeCloseTo(
      1.1,
      5,
    );
    expect(
      resolveTraitBonuses(t, { system: 'expedition' }).xpMultiplier,
    ).toBeCloseTo(1.1, 5);
  });

  it('aura:combat narrows to challenges/arena, not feed', () => {
    const t = totem({ traits: { awakened: 'trt_aura_combat_def' } });
    expect(
      resolveTraitBonuses(t, { challenge: 'strength' }).defenseBonus,
    ).toBeCloseTo(0.05, 5);
    expect(resolveTraitBonuses(t, { combat: true }).defenseBonus).toBeCloseTo(
      0.05,
      5,
    );
    expect(resolveTraitBonuses(t, { action: 'feed' }).defenseBonus).toBe(0);
  });
});

describe('resolveTraitBonuses — folding math', () => {
  it('multipliers multiply when two traits stack on one totem', () => {
    const b = resolveTraitBonuses(
      totem({
        traits: { innate: 'trt_xp_train_extra', learned: 'trt_xp_train' },
      }),
      { action: 'train' },
    );
    expect(b.xpMultiplier).toBeCloseTo(1.1 * 1.05, 5);
  });

  it('statBonus adds per stat key, not just numerically', () => {
    const b = resolveTraitBonuses(
      totem({ traits: { innate: 'trt_str_chal' } }),
      { challenge: 'strength' },
    );
    expect(b.statBonus.strength).toBe(1);
    expect(b.statBonus.agility).toBe(0);
    expect(b.statBonus.wisdom).toBe(0);
  });

  it('successChanceBonus adds across traits in scope', () => {
    const b = resolveTraitBonuses(
      totem({ traits: { innate: 'trt_any_chal' } }),
      { challenge: 'strength' },
    );
    expect(b.successChanceBonus).toBeCloseTo(0.05, 5);
  });
});

describe('resolveTraitBonuses — team / de-dupe', () => {
  it('applies a team aura to the whole team', () => {
    const mentor = totem({
      id: 't_mentor',
      traits: { awakened: 'trt_aura_xp' },
    });
    const plain = totem({ id: 't_plain' });
    const b = resolveTraitBonuses([mentor, plain, plain], {
      system: 'expedition',
    });
    expect(b.xpMultiplier).toBeCloseTo(1.1, 5);
  });

  it('de-dupes the same trait id across the team (two Mentors → one bonus)', () => {
    const mentor = totem({
      id: 't_a',
      traits: { awakened: 'trt_aura_xp' },
    });
    const mentor2 = totem({
      id: 't_b',
      traits: { awakened: 'trt_aura_xp' },
    });
    const b = resolveTraitBonuses([mentor, mentor2], { system: 'expedition' });
    expect(b.xpMultiplier).toBeCloseTo(1.1, 5);
  });

  it('stacks different aura traits across the team', () => {
    const mentor = totem({
      id: 't_a',
      traits: { awakened: 'trt_aura_xp' },
    });
    const trainBoost = totem({
      id: 't_b',
      traits: { learned: 'trt_xp_train' },
    });
    const b = resolveTraitBonuses([mentor, trainBoost], { action: 'train' });
    expect(b.xpMultiplier).toBeCloseTo(1.1 * 1.1, 5);
  });
});

describe('resolveTraitBonuses — conditional same_species_teammate', () => {
  it('applies when another teammate shares the species', () => {
    const kindred = totem({
      id: 'k1',
      speciesId: 3,
      traits: { awakened: 'trt_kindred_like' },
    });
    const sameSpecies = totem({ id: 'k2', speciesId: 3 });
    const b = resolveTraitBonuses([kindred, sameSpecies], { system: 'expedition' });
    expect(b.xpMultiplier).toBeCloseTo(1.1, 5);
  });

  it('does NOT apply when no teammate shares the species', () => {
    const kindred = totem({
      id: 'k1',
      speciesId: 3,
      traits: { awakened: 'trt_kindred_like' },
    });
    const other = totem({ id: 'k2', speciesId: 7 });
    const b = resolveTraitBonuses([kindred, other], { system: 'expedition' });
    expect(b.xpMultiplier).toBe(1);
  });

  it('does NOT apply when the totem is alone on the team', () => {
    const kindred = totem({
      id: 'k1',
      speciesId: 3,
      traits: { awakened: 'trt_kindred_like' },
    });
    const b = resolveTraitBonuses(kindred, { system: 'expedition' });
    expect(b.xpMultiplier).toBe(1);
  });

  it('does NOT count itself as the teammate (different totem instance required)', () => {
    const kindred = totem({
      id: 'k1',
      speciesId: 3,
      traits: { awakened: 'trt_kindred_like' },
    });
    const b = resolveTraitBonuses([kindred, kindred], { system: 'expedition' });
    expect(b.xpMultiplier).toBe(1);
  });

  it('fail-safes on unknown condition (does not apply)', () => {
    const t = totem({ traits: { innate: 'trt_bad_condition' } });
    const b = resolveTraitBonuses(t, { system: 'expedition' });
    expect(b.xpMultiplier).toBe(1);
  });
});

describe('resolveTraitBonuses — robustness', () => {
  it('ignores unknown trait ids on the totem', () => {
    const b = resolveTraitBonuses(
      totem({ traits: { learned: 'trt_not_in_config' } }),
      { action: 'train' },
    );
    expect(b).toEqual(EMPTY_BONUSES);
  });

  it('ignores effect.type values it does not recognise', () => {
    const b = resolveTraitBonuses(
      totem({ traits: { innate: 'trt_unknown_key' } }),
      { action: 'train' },
    );
    expect(b).toEqual(EMPTY_BONUSES);
  });
});
