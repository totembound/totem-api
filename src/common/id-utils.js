/**
 * ID Generation Utilities
 *
 * Uses ULID (Universally Unique Lexicographically Sortable Identifier) for dynamic entities.
 * Static/system-defined entities use semantic slugs instead.
 *
 * Benefits of ULID:
 * - Time-sortable (first 10 chars = timestamp)
 * - Extract creation time without DB query
 * - Natural sharding by time range
 * - 26 chars, URL-safe
 */

const { ulid, decodeTime } = require('ulid');

// ============================================
// Prefix Map for Dynamic Entities
// ============================================

const ID_PREFIXES = {
  // User-related
  user: 'usr_',           // User accounts

  // Totem-related
  totem: 'ttm_',          // Totem instances

  // Transactions & Commerce
  transaction: 'txn_',    // Generic transactions
  purchase: 'pur_',       // Shop purchases
  shopListing: 'lst_',    // Shop totem listings

  // Rewards
  claim: 'clm_',          // Reward claims (daily, weekly, etc.)

  // User Activity Records
  userExpedition: 'uex_', // User's expedition instance
  challengeAttempt: 'uca_', // Challenge attempt/completion
  achievementUnlock: 'uac_', // Achievement unlock record

  // Loot
  loot: 'lot_',           // Loot box item instances

  // Messaging
  msg: 'msg_',            // IoT push message IDs

  // Future
  userGear: 'ugr_',       // User's gear instance (future)
  session: 'ses_',        // Auth sessions
  apiKey: 'key_',         // API keys
};

// Reverse lookup: prefix -> type
const PREFIX_TO_TYPE = Object.fromEntries(
  Object.entries(ID_PREFIXES).map(([type, prefix]) => [prefix, type])
);

// ============================================
// Static Entity Slugs (for reference)
// ============================================

/**
 * Static entities use semantic slugs, not ULIDs.
 * These are defined in config/seed data, not generated.
 *
 * Examples:
 * - Challenges: 'whack-a-mole', 'balance-beam', 'memory-match'
 * - Achievements: 'first-totem', 'first-evolution', 'collector-10'
 * - Expeditions: 'forest-journey', 'mountain-climb'
 * - Shop Bundles: 'starter-pack', 'premium-bundle'
 * - Gear Templates: 'iron-sword', 'leather-armor'
 */

// ============================================
// ID Generation Functions
// ============================================

/**
 * Generate a new ID for a dynamic entity
 * @param {keyof typeof ID_PREFIXES} type - Entity type (e.g., 'user', 'totem')
 * @returns {string} Prefixed ULID (e.g., 'usr_01HGW2BBG53P7ZKP1WNXQ0TY4V')
 */
function generateId(type) {
  const prefix = ID_PREFIXES[type];
  if (!prefix) {
    throw new Error(`Unknown entity type: ${type}. Valid types: ${Object.keys(ID_PREFIXES).join(', ')}`);
  }
  return `${prefix}${ulid()}`;
}

/**
 * Parse an ID to extract its components
 * @param {string} id - Prefixed ID
 * @returns {{ type: string, prefix: string, ulid: string, createdAt: Date } | null}
 */
function parseId(id) {
  if (!id || typeof id !== 'string') return null;

  // Find matching prefix
  for (const [prefix, type] of Object.entries(PREFIX_TO_TYPE)) {
    if (id.startsWith(prefix)) {
      const ulidPart = id.slice(prefix.length);
      try {
        const timestamp = decodeTime(ulidPart);
        return {
          type,
          prefix,
          ulid: ulidPart,
          createdAt: new Date(timestamp),
        };
      }
      catch {
        return { type, prefix, ulid: ulidPart, createdAt: null };
      }
    }
  }

  return null;
}

/**
 * Extract creation timestamp from an ID
 * @param {string} id - Prefixed ULID
 * @returns {Date | null} Creation date or null if invalid
 */
function getIdTimestamp(id) {
  const parsed = parseId(id);
  return parsed?.createdAt || null;
}

/**
 * Validate that an ID has the expected type
 * @param {string} id - ID to validate
 * @param {keyof typeof ID_PREFIXES} expectedType - Expected entity type
 * @returns {boolean}
 */
function isValidId(id, expectedType) {
  if (!id || typeof id !== 'string') return false;
  const prefix = ID_PREFIXES[expectedType];
  if (!prefix) return false;
  return id.startsWith(prefix) && id.length === prefix.length + 26;
}

/**
 * Get the entity type from an ID
 * @param {string} id - Prefixed ID
 * @returns {string | null} Entity type or null if unknown
 */
function getIdType(id) {
  const parsed = parseId(id);
  return parsed?.type || null;
}

// ============================================
// Slug Validation (for static entities)
// ============================================

/**
 * Validate a slug format
 * @param {string} slug - Slug to validate
 * @returns {boolean} True if valid slug format
 */
function isValidSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  // Lowercase alphanumeric with hyphens, 2-50 chars
  return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]{1,2}$/.test(slug);
}

/**
 * Convert a string to a slug
 * @param {string} str - String to convert
 * @returns {string} URL-safe slug
 */
function toSlug(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Constants
  ID_PREFIXES,
  PREFIX_TO_TYPE,

  // Generation
  generateId,

  // Parsing & Validation
  parseId,
  getIdTimestamp,
  getIdType,
  isValidId,

  // Slugs
  isValidSlug,
  toSlug,
};
