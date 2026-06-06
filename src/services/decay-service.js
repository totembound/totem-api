/**
 * Hunger decay — the game's first time-based decay mechanic.
 *
 * Decay is computed lazily on read (no cron, no scheduled Lambda). `applyDecay`
 * is pure and side-effect-free: given a totem, it returns the totem with
 * `stats.hunger` decayed to "now" plus a corrected `hungerUpdatedAt` anchor, and
 * the bookkeeping a writer needs to persist it.
 *
 * Two properties that matter:
 *
 *  1. The decay clock is a DEDICATED `hungerUpdatedAt` field — NOT `updatedAt`.
 *     `updatedAt` is bumped by every totem write (evolve, trait choice, sanctum
 *     seat, rename…); anchoring decay on it would let any unrelated write reset
 *     the clock so the totem never decays. `hungerUpdatedAt` is only ever moved
 *     by feed/decay logic.
 *
 *  2. The anchor advances by exactly the WHOLE hours consumed, never to `now`.
 *     This preserves the sub-hour remainder, so a player taking actions every
 *     ~50 minutes still accumulates decay instead of resetting it to zero each
 *     time (the floor would otherwise round every gap down to 0 forever).
 *
 * A totem with NO `hungerUpdatedAt` is self-healing: it's anchored at `now` and
 * treated as "fed now", so it can never show retroactive decay (no fixed epoch
 * to starve from). The materialized anchor is returned so the next read — or the
 * next persisting write — decays forward from first observation. This makes a
 * missing anchor harmless instead of a time bomb, in any environment.
 */

const { HUNGER } = require('../config/totem-config');

const HOUR_MS = 3_600_000;

/**
 * @param {object} totem  a totem record (must have `stats`)
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]  injectable clock for tests
 * @param {object} [opts.bonuses]  trait bonuses; `hungerDecayRateMultiplier`
 *   (a future decay-modifying trait) scales the rate. Identity (×1) today —
 *   no shipped trait sets it, so the read path doesn't resolve bonuses yet.
 * @returns {{ totem: object, decayApplied: number, hungerUpdatedAt: string, changed: boolean }}
 */
function applyDecay(totem, { now = Date.now(), bonuses = null } = {}) {
  if (!totem || !totem.stats) {
    return { totem, decayApplied: 0, hungerUpdatedAt: totem?.hungerUpdatedAt || null, changed: false };
  }

  const stored = totem.stats.hunger ?? HUNGER.max;

  // Anchor: the dedicated `hungerUpdatedAt` clock if present. No anchor → anchor
  // at `now` (self-heal): the totem is treated as just-fed, decays 0 this read,
  // and the materialized anchor lets subsequent reads decay forward from here.
  const hasAnchor = Boolean(totem.hungerUpdatedAt);
  let anchorMs = hasAnchor ? Date.parse(totem.hungerUpdatedAt) : now;
  if (!Number.isFinite(anchorMs)) anchorMs = now;

  const rate = HUNGER.decayPerHour * (bonuses?.hungerDecayRateMultiplier ?? 1);
  const anchorIso = new Date(anchorMs).toISOString();

  // No decay this read (rate ≤ 0, future clock, or sub-hour gap): materialize the
  // anchor but DON'T advance it — preserving the remainder for next time.
  if (rate <= 0) {
    return { totem: { ...totem, hungerUpdatedAt: anchorIso }, decayApplied: 0, hungerUpdatedAt: anchorIso, changed: false };
  }

  const hoursElapsed = (now - anchorMs) / HOUR_MS;
  const decayApplied = Math.floor(hoursElapsed * rate);

  if (decayApplied <= 0) {
    return { totem: { ...totem, hungerUpdatedAt: anchorIso }, decayApplied: 0, hungerUpdatedAt: anchorIso, changed: false };
  }

  const newHunger = Math.max(HUNGER.min, stored - decayApplied);
  // Advance the anchor by exactly the consumed whole hours (remainder-preserving).
  const consumedMs = Math.floor(decayApplied / rate) * HOUR_MS;
  const newAnchorIso = new Date(anchorMs + consumedMs).toISOString();

  return {
    totem: { ...totem, stats: { ...totem.stats, hunger: newHunger }, hungerUpdatedAt: newAnchorIso },
    decayApplied,
    hungerUpdatedAt: newAnchorIso,
    changed: true,
  };
}

module.exports = { applyDecay };
