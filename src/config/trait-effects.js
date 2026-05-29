/**
 * Trait effect resolver — Phase 2 (Decision 1).
 *
 * One pure, synchronous function `resolveTraitBonuses(input, context)` collects
 * the (≤3 per totem) in-scope effects from `traits.json` and folds them into a
 * flat `EMPTY_BONUSES`-shaped object. No I/O, no stored state.
 *
 * - `input` is a single totem (self scope: care/challenge actions) OR an array
 *   of totems (team scope: expeditions now, arena in Q3 2026). Same function.
 * - Effects union across the party, **de-duped by trait id** (two Mentors on a
 *   team → one Mentor bonus).
 * - `aura` is just a scope token — there is no account-wide layer.
 *
 * See `docs/totem-traits-phase2-plan.md` §§4–6 and
 * `docs/totem-traits-resolver-plan.md` for the canonical spec.
 */

const { TRAIT_BY_ID } = require('./traits');

const EMPTY_BONUSES = {
  xpMultiplier: 1,
  essenceRewardMultiplier: 1,
  essenceCostMultiplier: 1,
  durationMultiplier: 1,
  successChanceBonus: 0,
  statBonus: { strength: 0, agility: 0, wisdom: 0 },
  happinessFlat: 0,
  happinessRewardMultiplier: 1,
  hungerRestoreBonusPct: 0,
  seatEarnRateMultiplier: 1,
  tenureBonusMultiplier: 1,
  runeChanceBonus: 0,
  lootChanceBonus: 0,
  lootBoxChanceBonus: 0,
  offenseBonus: 0,
  defenseBonus: 0,
  flags: {},
};

function freshBonuses() {
  // Structured clone keeps callers safe from accidental cross-action mutation.
  return structuredClone(EMPTY_BONUSES);
}

function expandScopes(context) {
  const tokens = new Set(['aura']); // every context can receive a general Aura
  if (context.action) tokens.add(`action:${context.action}`);
  if (context.challenge) {
    tokens.add(`challenge:${context.challenge}`);
    tokens.add('challenge:any');
    tokens.add('aura:combat');
  }
  if (context.loot) {
    tokens.add(`loot:${context.loot}`);
    tokens.add('loot:any');
  }
  if (context.system) tokens.add(`system:${context.system}`);
  if (context.system && context.sub) tokens.add(`${context.system}:${context.sub}`);
  if (context.earnsEssence) tokens.add('earn:any');
  if (context.combat) tokens.add('aura:combat');
  return tokens;
}

function conditionMet(condition, sourceTotem, party) {
  if (!condition) return true;
  if (condition === 'same_species_teammate') {
    return party.some(
      (t) => t && t !== sourceTotem && t.speciesId === sourceTotem.speciesId,
    );
  }
  return false; // unknown condition → fail safe
}

function applyEffect(bonuses, effect) {
  const t = effect.type;
  if (t === 'flag') {
    bonuses.flags[effect.value] = true;
    return;
  }
  if (t === 'statBonus') {
    for (const [stat, n] of Object.entries(effect.value || {})) {
      bonuses.statBonus[stat] = (bonuses.statBonus[stat] || 0) + n;
    }
    return;
  }
  if (t.endsWith('Multiplier')) {
    if (typeof bonuses[t] !== 'number') return; // unknown key → ignore
    bonuses[t] *= effect.value;
    return;
  }
  // *Bonus / *Pct / *Flat → add
  if (typeof bonuses[t] !== 'number') return;
  bonuses[t] += effect.value;
}

/**
 * Resolve trait bonuses for an action/system context.
 *
 * @param {object|object[]} input   acting totem, or the team (1–3 totems)
 * @param {object} [context]        { action?, challenge?, loot?, system?, sub?,
 *                                    earnsEssence?, combat? }
 * @returns {typeof EMPTY_BONUSES}  always the full shape (identity defaults)
 */
function resolveTraitBonuses(input, context = {}) {
  const party = Array.isArray(input) ? input : [input];
  const bonuses = freshBonuses();
  const wanted = expandScopes(context);
  const seenTraitIds = new Set();

  for (const totem of party) {
    if (!totem || !totem.traits) continue;
    for (const slot of ['innate', 'learned', 'awakened']) {
      const id = totem.traits[slot];
      if (!id || seenTraitIds.has(id)) continue;
      seenTraitIds.add(id);
      const def = TRAIT_BY_ID[id];
      if (!def || !Array.isArray(def.effects)) continue;
      for (const effect of def.effects) {
        const scopes = Array.isArray(effect.scope) ? effect.scope : [effect.scope];
        if (!scopes.some((s) => wanted.has(s))) continue;
        if (!conditionMet(effect.condition, totem, party)) continue;
        applyEffect(bonuses, effect);
      }
    }
  }
  return bonuses;
}

module.exports = {
  resolveTraitBonuses,
  EMPTY_BONUSES,
};
