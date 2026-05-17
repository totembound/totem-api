/**
 * Traits config — single source of truth for trait definitions on the API.
 *
 * Mirrors `totem-app/src/config/traits.ts`. Update both files together when
 * adding traits or changing pools.
 */

const crypto = require('crypto');
const traitsData = require('../data/traits.json');

const TRAITS = traitsData.traits;
const TRAIT_BY_ID = Object.fromEntries(TRAITS.map((t) => [t.id, t]));

const INNATE_POOL   = TRAITS.filter((t) => t.slot === 'innate').map((t) => t.id);
const LEARNED_POOL  = TRAITS.filter((t) => t.slot === 'learned').map((t) => t.id);
const AWAKENED_POOL = TRAITS.filter((t) => t.slot === 'awakened').map((t) => t.id);

const STAGE_GATES = traitsData.stageGates; // { learned: 2, awakened: 4 }

/**
 * Pick a random innate trait ID using CSPRNG (same pattern as rarity rolls).
 * @returns {string} A trait ID from the innate pool.
 */
function pickRandomInnate() {
  return INNATE_POOL[crypto.randomInt(0, INNATE_POOL.length)];
}

/**
 * Build the default traits shape for a freshly created totem.
 * Innate is always set; the other two are null until the player chooses.
 * @returns {{innate: string, learned: null, awakened: null}}
 */
function buildInitialTraits() {
  return {
    innate: pickRandomInnate(),
    learned: null,
    awakened: null,
  };
}

function getTraitById(traitId) {
  return TRAIT_BY_ID[traitId] || null;
}

function getPoolForSlot(slot) {
  if (slot === 'innate') return INNATE_POOL;
  if (slot === 'learned') return LEARNED_POOL;
  if (slot === 'awakened') return AWAKENED_POOL;
  return null;
}

function isValidTraitForSlot(traitId, slot) {
  const pool = getPoolForSlot(slot);
  return pool ? pool.includes(traitId) : false;
}

function getRequiredStageForSlot(slot) {
  return STAGE_GATES[slot] ?? null;
}

module.exports = {
  TRAITS,
  TRAIT_BY_ID,
  INNATE_POOL,
  LEARNED_POOL,
  AWAKENED_POOL,
  STAGE_GATES,
  pickRandomInnate,
  buildInitialTraits,
  getTraitById,
  getPoolForSlot,
  isValidTraitForSlot,
  getRequiredStageForSlot,
};
