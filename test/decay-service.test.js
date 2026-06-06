/**
 * Hunger decay-service tests.
 *
 * applyDecay is pure (no I/O), so these run without DynamoDB. Covers the
 * properties that make the decay-on-read design correct: whole-hour flooring,
 * sub-hour no-op, remainder preservation across reads, anchor advancing by
 * consumed hours (not to `now`), clamping, the self-healing missing-anchor
 * fallback, and the trait decay-rate hook.
 */

const { applyDecay } = require('../src/services/decay-service');
const { HUNGER } = require('../src/config/totem-config');

const HOUR = 3_600_000;
const T0 = Date.parse('2026-07-01T00:00:00.000Z'); // well after deploy epoch

function totem(extra = {}) {
  return {
    id: 'ttm_test',
    createdAt: new Date(T0).toISOString(),
    hungerUpdatedAt: new Date(T0).toISOString(),
    stats: { hunger: 100, happiness: 50 },
    ...extra,
  };
}

describe('applyDecay', () => {
  it('decays one point per whole hour', () => {
    const r = applyDecay(totem(), { now: T0 + 24 * HOUR });
    expect(r.decayApplied).toBe(24);
    expect(r.totem.stats.hunger).toBe(76);
    expect(r.changed).toBe(true);
  });

  it('is a no-op under one hour (and does not move the anchor)', () => {
    const r = applyDecay(totem(), { now: T0 + 50 * 60 * 1000 }); // 50 min
    expect(r.decayApplied).toBe(0);
    expect(r.totem.stats.hunger).toBe(100);
    expect(r.changed).toBe(false);
    expect(Date.parse(r.hungerUpdatedAt)).toBe(T0); // unchanged
  });

  it('advances the anchor by exactly the consumed whole hours, not to now', () => {
    // 1h50m elapsed → 1 point decays, anchor moves +1h (the 50m remainder stays)
    const r = applyDecay(totem(), { now: T0 + HOUR + 50 * 60 * 1000 });
    expect(r.decayApplied).toBe(1);
    expect(Date.parse(r.hungerUpdatedAt)).toBe(T0 + HOUR);
  });

  it('preserves the sub-hour remainder across successive reads', () => {
    // Read 1 at +1h50m: decays 1, anchor → +1h
    const r1 = applyDecay(totem(), { now: T0 + HOUR + 50 * 60 * 1000 });
    // Read 2 at +2h50m, anchored on r1's result: 1h50m since anchor → decays 1 more
    const r2 = applyDecay(
      { ...totem(), hungerUpdatedAt: r1.hungerUpdatedAt, stats: { ...r1.totem.stats } },
      { now: T0 + 2 * HOUR + 50 * 60 * 1000 },
    );
    expect(r2.decayApplied).toBe(1);
    expect(r2.totem.stats.hunger).toBe(98); // 100 → 99 → 98, remainder never lost
  });

  it('clamps hunger at the floor (never below 0)', () => {
    const r = applyDecay(totem({ stats: { hunger: 5, happiness: 50 } }), { now: T0 + 100 * HOUR });
    expect(r.totem.stats.hunger).toBe(HUNGER.min);
  });

  it('treats a future clock as no decay', () => {
    const r = applyDecay(totem(), { now: T0 - HOUR });
    expect(r.decayApplied).toBe(0);
    expect(r.totem.stats.hunger).toBe(100);
  });

  it('self-heals a record with no hungerUpdatedAt: anchors at now, zero decay, no retroactive starvation', () => {
    const ancient = {
      id: 'ttm_old',
      createdAt: '2020-01-01T00:00:00.000Z', // long before hunger shipped, ignored
      stats: { hunger: 100, happiness: 50 },
    };
    const now = T0 + 10 * HOUR;
    const r = applyDecay(ancient, { now });
    // Treated as "fed now" — no decay regardless of how old createdAt is.
    expect(r.decayApplied).toBe(0);
    expect(r.totem.stats.hunger).toBe(100);
    // The anchor is materialized at `now` so future reads decay forward from here.
    expect(r.totem.hungerUpdatedAt).toBe(new Date(now).toISOString());
  });

  it('a materialized anchor is trusted and decays forward from it', () => {
    const fed = totem({ hungerUpdatedAt: new Date(T0).toISOString() });
    const r = applyDecay(fed, { now: T0 + 3 * HOUR });
    expect(r.decayApplied).toBe(3);
  });

  it('respects a trait decay-rate multiplier (future decay-modifying trait)', () => {
    const r = applyDecay(totem(), { now: T0 + 10 * HOUR, bonuses: { hungerDecayRateMultiplier: 0.5 } });
    expect(r.decayApplied).toBe(5); // 10h × 0.5
  });

  it('a zero decay rate halts decay entirely', () => {
    const r = applyDecay(totem(), { now: T0 + 100 * HOUR, bonuses: { hungerDecayRateMultiplier: 0 } });
    expect(r.decayApplied).toBe(0);
    expect(r.totem.stats.hunger).toBe(100);
  });

  it('defaults missing hunger to max before decaying', () => {
    const r = applyDecay(
      { id: 'x', hungerUpdatedAt: new Date(T0).toISOString(), stats: {} },
      { now: T0 + 5 * HOUR }
    );
    expect(r.totem.stats.hunger).toBe(HUNGER.max - 5);
  });
});
