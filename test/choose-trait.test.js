/**
 * choose-trait handler tests.
 *
 * Mocks the db-client so we can exercise validation without DynamoDB.
 */

jest.mock('../src/common/db-client', () => {
  const TABLES = { TOTEMS: 'TotemBound-Totems' };
  const KEY_PREFIX = { USER: 'USER#', TOTEM: 'TOTEM#' };
  return {
    TABLES,
    KEY_PREFIX,
    getTotem: jest.fn(),
    rawUpdate: jest.fn(),
  };
});

const { getTotem, rawUpdate } = require('../src/common/db-client');
const { chooseTrait } = require('../src/functions/totems/choose-trait');

const user = { userId: 'usr_test' };
const totemId = 'ttm_test';

beforeEach(() => {
  getTotem.mockReset();
  rawUpdate.mockReset();
});

describe('chooseTrait', () => {
  it('rejects an unknown slot', async () => {
    const r = await chooseTrait(user, totemId, { slot: 'bogus', traitId: 'trt_quick_learner' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('INVALID_SLOT');
    expect(getTotem).not.toHaveBeenCalled();
  });

  it('rejects the innate slot (server-only)', async () => {
    const r = await chooseTrait(user, totemId, { slot: 'innate', traitId: 'trt_curious' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('INVALID_SLOT');
  });

  it('rejects a trait from the wrong pool', async () => {
    const r = await chooseTrait(user, totemId, { slot: 'learned', traitId: 'trt_curious' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('INVALID_TRAIT');
    expect(getTotem).not.toHaveBeenCalled();
  });

  it('rejects an unknown trait id', async () => {
    const r = await chooseTrait(user, totemId, { slot: 'learned', traitId: 'trt_unknown' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('INVALID_TRAIT');
  });

  it('returns TOTEM_NOT_FOUND when the totem does not exist', async () => {
    getTotem.mockResolvedValue(null);
    const r = await chooseTrait(user, totemId, { slot: 'learned', traitId: 'trt_quick_learner' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('TOTEM_NOT_FOUND');
  });

  it('enforces the Learned stage gate (Stage 2)', async () => {
    getTotem.mockResolvedValue({ id: totemId, stage: 1, traits: { innate: 'trt_curious', learned: null, awakened: null } });
    const r = await chooseTrait(user, totemId, { slot: 'learned', traitId: 'trt_quick_learner' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('STAGE_LOCKED');
  });

  it('enforces the Awakened stage gate (Stage 4)', async () => {
    getTotem.mockResolvedValue({ id: totemId, stage: 3, traits: { innate: 'trt_curious', learned: 'trt_quick_learner', awakened: null } });
    const r = await chooseTrait(user, totemId, { slot: 'awakened', traitId: 'trt_mentor' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('STAGE_LOCKED');
  });

  it('updates the totem when the choice is legit', async () => {
    getTotem.mockResolvedValue({ id: totemId, stage: 2, traits: { innate: 'trt_curious', learned: null, awakened: null } });
    rawUpdate.mockResolvedValue({});
    const r = await chooseTrait(user, totemId, { slot: 'learned', traitId: 'trt_quick_learner' });
    expect(r.success).toBe(true);
    expect(r.data.slot).toBe('learned');
    expect(r.data.traitId).toBe('trt_quick_learner');
    expect(r.data.traitName).toBe('Quick Learner');
    expect(rawUpdate).toHaveBeenCalledTimes(1);
    const call = rawUpdate.mock.calls[0][2];
    expect(call.ConditionExpression).toContain('attribute_not_exists');
    expect(call.ExpressionAttributeNames['#slot']).toBe('learned');
    expect(call.ExpressionAttributeValues[':traitId']).toBe('trt_quick_learner');
  });

  it('returns SLOT_TAKEN when the conditional update fails', async () => {
    getTotem.mockResolvedValue({ id: totemId, stage: 4, traits: { innate: 'trt_curious', learned: 'trt_quick_learner', awakened: 'trt_mentor' } });
    const err = new Error('exists');
    err.name = 'ConditionalCheckFailedException';
    rawUpdate.mockRejectedValue(err);
    const r = await chooseTrait(user, totemId, { slot: 'awakened', traitId: 'trt_sage' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('SLOT_TAKEN');
  });
});
