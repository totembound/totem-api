/**
 * Profile Field Validation
 *
 * Pure validators for the user profile sub-object: bio, avatar, banner.
 * No DB access here — totem-ownership checks for avatar `kind: 'totem'`
 * are performed by the handler that already loads user totems.
 */

const { containsProfanity } = require('./profanity');

// Mirrors the frontend `Domain` enum in totem-app/src/types/types.ts:126
// 0=Air, 1=Earth, 2=Water, 3=Fire, 4=Spirit, 5=Shadow
const DOMAIN_ID_MIN = 0;
const DOMAIN_ID_MAX = 5;
const BIO_MAX_LENGTH = 240;

function isValidDomainId(id) {
  return Number.isInteger(id) && id >= DOMAIN_ID_MIN && id <= DOMAIN_ID_MAX;
}

// Control chars to strip: U+0000-U+0008, U+000B-U+001F, U+007F.
// Tab (U+0009) and newline (U+000A) are preserved. CR (U+000D) is normalized to LF first.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/g;

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validateBio(input) {
  if (input === null) return { valid: true, value: null };
  if (typeof input !== 'string') {
    return { valid: false, message: 'Bio must be a string or null' };
  }

  const cleaned = input.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();

  if (cleaned.length === 0) return { valid: true, value: null };
  if (cleaned.length > BIO_MAX_LENGTH) {
    return { valid: false, message: `Bio must be ${BIO_MAX_LENGTH} characters or fewer` };
  }
  if (/https?:\/\//i.test(cleaned) || /www\./i.test(cleaned)) {
    return { valid: false, message: 'Bio cannot contain links' };
  }
  if (containsProfanity(cleaned)) {
    return { valid: false, code: 'PROFANITY', message: 'Please rephrase your bio' };
  }
  return { valid: true, value: escapeHtml(cleaned) };
}

function validateAvatar(input) {
  if (input === null) return { valid: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, message: 'Avatar must be an object or null' };
  }

  if (input.kind === 'domain') {
    if (!isValidDomainId(input.id)) {
      return { valid: false, message: 'Unknown avatar domain' };
    }
    return { valid: true, value: { kind: 'domain', id: input.id } };
  }

  if (input.kind === 'totem') {
    const { speciesId, colorId, stage } = input;
    if (!Number.isInteger(speciesId) || speciesId < 0
      || !Number.isInteger(colorId) || colorId < 0
      || !Number.isInteger(stage) || stage < 0 || stage > 4) {
      return { valid: false, message: 'Invalid totem avatar reference' };
    }
    return { valid: true, value: { kind: 'totem', speciesId, colorId, stage } };
  }

  return { valid: false, message: 'Avatar kind must be "domain" or "totem"' };
}

function validateBanner(input) {
  if (input === null) return { valid: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, message: 'Banner must be an object or null' };
  }
  if (input.kind !== 'domain' || !isValidDomainId(input.id)) {
    return { valid: false, message: 'Banner must reference one of the 6 domains' };
  }
  return { valid: true, value: { kind: 'domain', id: input.id } };
}

module.exports = {
  BIO_MAX_LENGTH,
  DOMAIN_ID_MIN,
  DOMAIN_ID_MAX,
  validateBio,
  validateAvatar,
  validateBanner,
};
