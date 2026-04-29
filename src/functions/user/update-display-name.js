/**
 * Update Display Name Handler
 *
 * PUT /v1/user/displayName
 *
 * Dedicated, hardened path for changing a user's display name. Separate from
 * the generic /v1/user/profile update because it carries cooldown semantics,
 * profanity filtering, and an essence-spend "skip cooldown" flow that the
 * generic profile updater shouldn't be aware of.
 *
 * Cooldown: 30 days between free changes (first change is free — sparse field).
 * Skip cost: 500 Essence — atomic deduct via db-client.
 */

const { getUser, updateUser, deductEssence, logTransaction } = require('../../common/db-client');
const { validateDisplayName, MIN_LENGTH, MAX_LENGTH } = require('../../common/display-name');

const COOLDOWN_DAYS = 30;
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const SKIP_COST = 500;

async function updateDisplayName(user, body = {}) {
  const userId = user.userId;
  const skipCooldown = body.skipCooldown === true;

  const existingUser = await getUser(userId);
  if (!existingUser) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    };
  }

  const validation = validateDisplayName(body.displayName, existingUser.displayName);
  if (!validation.valid) {
    return {
      success: false,
      error: {
        code: validation.code || 'VALIDATION_ERROR',
        message: validation.message,
      },
    };
  }
  const newName = validation.name;

  const now = Date.now();
  const readyAt = existingUser.displayNameChangeReadyAt || null;
  const onCooldown = readyAt ? now < new Date(readyAt).getTime() : false;

  let newEssenceBalance;
  if (onCooldown) {
    if (!skipCooldown) {
      return {
        success: false,
        error: {
          code: 'COOLDOWN_ACTIVE',
          message: 'Display name change is on cooldown',
          readyAt,
          remainingMs: new Date(readyAt).getTime() - now,
          skipCost: SKIP_COST,
        },
      };
    }

    const deduct = await deductEssence(userId, SKIP_COST, {
      type: 'displayname_skip',
      ref: 'name_change_skip',
    });
    if (!deduct.success) {
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: `You need ${SKIP_COST} Essence to skip the cooldown`,
          required: deduct.required ?? SKIP_COST,
          available: deduct.available ?? 0,
        },
      };
    }
    newEssenceBalance = deduct.newBalance;
  }

  const newReadyAtIso = new Date(now + COOLDOWN_MS).toISOString();
  await updateUser(userId, {
    displayName: newName,
    displayNameChangeReadyAt: newReadyAtIso,
    previousDisplayName: existingUser.displayName,
  });

  // Audit log for moderation — admins can query type='displayname_change' via type-ts-index.
  // Currency intentionally omitted (this is a profile event, not a balance event).
  // The essence deduction itself, when skip was used, is logged separately by deductEssence.
  await logTransaction(userId, {
    type: 'displayname_change',
    amount: 0,
    balanceBefore: 0,
    balanceAfter: 0,
    refType: 'profile',
    ref: `${existingUser.displayName || ''} -> ${newName}`,
  });

  return {
    success: true,
    data: {
      displayName: newName,
      displayNameCooldown: { readyAt: newReadyAtIso, skipCost: SKIP_COST },
      skippedCooldown: onCooldown && skipCooldown,
      ...(newEssenceBalance !== undefined && { newEssenceBalance }),
    },
  };
}

module.exports = {
  updateDisplayName,
  // exported for tests
  COOLDOWN_DAYS,
  COOLDOWN_MS,
  SKIP_COST,
  MIN_LENGTH,
  MAX_LENGTH,
};
