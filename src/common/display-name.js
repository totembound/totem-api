/**
 * Display Name Helpers
 *
 * Two distinct entry points:
 *   - `validateDisplayName` — strict, used when a user explicitly submits a name.
 *     Errors out so the UI can surface specific feedback.
 *   - `sanitizeInboundDisplayName` — best-effort coercer, used when we inherit
 *     a name from an external system (OAuth, email prefix). Always returns a
 *     valid string (falling back to the supplied fallback if needed) so signup
 *     never fails on a bad inherited name.
 */

const { containsProfanity } = require('./profanity');

const MIN_LENGTH = 3;
const MAX_LENGTH = 20;
const PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9 _-]*[a-zA-Z0-9])?$/;

function validateDisplayName(rawName, currentName) {
  if (typeof rawName !== 'string') {
    return { valid: false, message: 'Display name is required' };
  }
  const name = rawName.trim();
  if (name.length < MIN_LENGTH || name.length > MAX_LENGTH) {
    return {
      valid: false,
      message: `Display name must be ${MIN_LENGTH}–${MAX_LENGTH} characters`,
    };
  }
  if (!PATTERN.test(name)) {
    return {
      valid: false,
      message: 'Display name can only contain letters, numbers, spaces, hyphens, and underscores, and must start and end with a letter or number',
    };
  }
  if (name.includes('  ')) {
    return { valid: false, message: 'Display name cannot contain consecutive spaces' };
  }
  if (containsProfanity(name)) {
    return { valid: false, code: 'PROFANITY', message: 'Please choose a different name' };
  }
  if (currentName !== undefined && name === currentName) {
    return { valid: false, code: 'NO_CHANGES', message: 'New display name matches current name' };
  }
  return { valid: true, name };
}

/**
 * Coerce an externally-supplied name into our format.
 * - Folds Latin diacritics to ASCII (José → Jose).
 * - Strips disallowed characters.
 * - Collapses runs of spaces, then trims edge punctuation.
 * - Truncates to MAX_LENGTH.
 * - Pads with the fallback if the result is too short.
 * - Replaces with the fallback if the sanitized form is profane.
 *
 * Always returns a string that satisfies `validateDisplayName`.
 */
function sanitizeInboundDisplayName(raw, fallback) {
  const safeFallback = sanitizeFallback(fallback);

  if (typeof raw !== 'string' || raw.length === 0) {
    return safeFallback;
  }

  // Decompose accents (NFD) and drop combining marks → ASCII letters
  let s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Drop anything that's not in our allowed set
  s = s.replace(/[^a-zA-Z0-9 _-]/g, '');
  // Collapse internal whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Strip leading/trailing non-alphanumerics so the result satisfies PATTERN
  s = s.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '');
  // Truncate
  if (s.length > MAX_LENGTH) {
    s = s.slice(0, MAX_LENGTH).replace(/[^a-zA-Z0-9]+$/, '');
  }

  if (s.length < MIN_LENGTH || containsProfanity(s)) {
    return safeFallback;
  }

  return s;
}

function sanitizeFallback(fallback) {
  // Fallback is typically email-prefix or 'Player'. Run through the same
  // pipeline minus the profanity check (we trust our own defaults), and
  // pad with random digits if it ends up too short.
  let s = (fallback || 'Player')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '');
  if (s.length > MAX_LENGTH) {
    s = s.slice(0, MAX_LENGTH).replace(/[^a-zA-Z0-9]+$/, '');
  }
  if (s.length < MIN_LENGTH) {
    const suffix = Math.floor(1000 + Math.random() * 9000).toString();
    s = (s + suffix).slice(0, MAX_LENGTH);
  }
  return s;
}

module.exports = {
  validateDisplayName,
  sanitizeInboundDisplayName,
  MIN_LENGTH,
  MAX_LENGTH,
  PATTERN,
};
