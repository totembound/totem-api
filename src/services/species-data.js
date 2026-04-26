/**
 * Species Data Service
 *
 * Static species lookups (affinity / domain) for the achievements service.
 * Loaded once at module init from src/data/species.json.
 *
 * Source of truth: this file is kept in sync with totem-app/src/config/species.json.
 * Use these helpers instead of trusting client-supplied values.
 */

const speciesData = require('../data/species.json');

const byId = new Map(speciesData.species.map(s => [s.id, s]));

function getSpecies(speciesId) {
  return byId.get(speciesId) || null;
}

function getAffinity(speciesId) {
  return byId.get(speciesId)?.affinity || null;
}

function getDomain(speciesId) {
  return byId.get(speciesId)?.domain || null;
}

module.exports = {
  getSpecies,
  getAffinity,
  getDomain,
};
