/**
 * Totem Choose Trait Handler
 *
 * POST /v1/totems/:id/traits/choose
 *
 * Lets the owner pick a trait for the Learned (Stage 2+) or Awakened (Stage 4+) slot.
 * Innate is set at creation and cannot be chosen.
 *
 * Body:
 *   {
 *     slot: 'learned' | 'awakened',
 *     traitId: string
 *   }
 *
 * Error codes:
 *   - INVALID_SLOT      (400) — slot must be 'learned' or 'awakened'
 *   - INVALID_TRAIT     (400) — traitId is unknown or not in the slot's pool
 *   - TOTEM_NOT_FOUND   (404)
 *   - STAGE_LOCKED      (403) — totem hasn't reached the required stage
 *   - SLOT_TAKEN        (409) — slot already filled (caught via condition expression)
 */

const {
  getTotem,
  rawUpdate,
  TABLES,
  KEY_PREFIX,
} = require('../../common/db-client');

const {
  isValidTraitForSlot,
  getRequiredStageForSlot,
  getTraitById,
} = require('../../config/traits');

const userPK = (userId) => `${KEY_PREFIX.USER}${userId}`;
const totemSK = (totemId) => `${KEY_PREFIX.TOTEM}${totemId}`;

const VALID_SLOTS = ['learned', 'awakened'];

async function chooseTrait(user, totemId, body = {}) {
  const userId = user.userId;
  const { slot, traitId } = body;

  // 1. Slot validation
  if (!slot || !VALID_SLOTS.includes(slot)) {
    return {
      success: false,
      error: { code: 'INVALID_SLOT', message: `Slot must be one of: ${VALID_SLOTS.join(', ')}` },
    };
  }

  // 2. Trait id validation against the slot's pool
  if (!traitId || typeof traitId !== 'string' || !isValidTraitForSlot(traitId, slot)) {
    return {
      success: false,
      error: { code: 'INVALID_TRAIT', message: `Trait '${traitId}' is not valid for slot '${slot}'` },
    };
  }

  // 3. Load totem (scoped to this user via PK — can't choose for someone else's totem)
  const totem = await getTotem(userId, totemId);
  if (!totem) {
    return {
      success: false,
      error: { code: 'TOTEM_NOT_FOUND', message: 'Totem not found' },
    };
  }

  // 4. Stage gate check
  const requiredStage = getRequiredStageForSlot(slot);
  const currentStage = totem.stage || 0;
  if (currentStage < requiredStage) {
    return {
      success: false,
      error: {
        code: 'STAGE_LOCKED',
        message: `Slot '${slot}' unlocks at stage ${requiredStage}; totem is at stage ${currentStage}`,
      },
    };
  }

  // 5. Conditional update: only succeed if the slot is still empty.
  // This handles double-choice races without a separate read-then-write.
  const now = new Date().toISOString();
  try {
    await rawUpdate(
      TABLES.TOTEMS,
      { pk: userPK(userId), sk: totemSK(totemId) },
      {
        UpdateExpression: 'SET #traits.#slot = :traitId, #updatedAt = :now',
        ConditionExpression: 'attribute_exists(#traits) AND (attribute_not_exists(#traits.#slot) OR #traits.#slot = :null)',
        ExpressionAttributeNames: {
          '#traits': 'traits',
          '#slot': slot,
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':traitId': traitId,
          ':null': null,
          ':now': now,
        },
      }
    );
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return {
        success: false,
        error: { code: 'SLOT_TAKEN', message: `Slot '${slot}' has already been chosen` },
      };
    }
    throw err;
  }

  const traitDef = getTraitById(traitId);

  return {
    success: true,
    data: {
      totemId,
      slot,
      traitId,
      traitName: traitDef?.name,
      updatedAt: now,
    },
  };
}

module.exports = { chooseTrait };
