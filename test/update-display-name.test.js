/**
 * Update Display Name Handler Tests
 */

jest.mock('../src/common/db-client', () => ({
  getUser: jest.fn(),
  updateUser: jest.fn(),
  deductEssence: jest.fn(),
  logTransaction: jest.fn(),
}));

jest.mock('../src/common/profanity', () => ({
  containsProfanity: jest.fn(() => false),
}));

const db = require('../src/common/db-client');
const { containsProfanity } = require('../src/common/profanity');
const {
  updateDisplayName,
  COOLDOWN_MS,
  SKIP_COST,
} = require('../src/functions/user/update-display-name');

const testUser = { userId: 'usr_test123' };

const makeUserRecord = (overrides = {}) => ({
  id: 'usr_test123',
  email: 'test@example.com',
  displayName: 'OldName',
  currencies: { essence: 2000, gems: 0 },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  containsProfanity.mockReturnValue(false);
  db.getUser.mockResolvedValue(makeUserRecord());
  db.updateUser.mockResolvedValue({});
  db.logTransaction.mockResolvedValue({});
});

describe('updateDisplayName — happy paths', () => {
  it('first change is free (no cooldown set on user)', async () => {
    const result = await updateDisplayName(testUser, { displayName: 'NewName' });

    expect(result.success).toBe(true);
    expect(result.data.displayName).toBe('NewName');
    expect(result.data.skippedCooldown).toBe(false);
    expect(result.data.newEssenceBalance).toBeUndefined();
    expect(result.data.displayNameCooldown.skipCost).toBe(SKIP_COST);
    expect(typeof result.data.displayNameCooldown.readyAt).toBe('string');
    expect(db.deductEssence).not.toHaveBeenCalled();
  });

  it('writes the new name, cooldown timestamp, and previous name', async () => {
    await updateDisplayName(testUser, { displayName: 'NewName' });

    expect(db.updateUser).toHaveBeenCalledWith('usr_test123', expect.objectContaining({
      displayName: 'NewName',
      previousDisplayName: 'OldName',
      displayNameChangeReadyAt: expect.any(String),
    }));
    const writtenReadyAt = db.updateUser.mock.calls[0][1].displayNameChangeReadyAt;
    const remaining = new Date(writtenReadyAt).getTime() - Date.now();
    // Cooldown should be ~30 days from now (allow a 5s slack for test scheduling jitter)
    expect(remaining).toBeGreaterThan(COOLDOWN_MS - 5000);
    expect(remaining).toBeLessThanOrEqual(COOLDOWN_MS);
  });

  it('writes an audit transaction for the name change', async () => {
    await updateDisplayName(testUser, { displayName: 'NewName' });

    expect(db.logTransaction).toHaveBeenCalledWith('usr_test123', expect.objectContaining({
      type: 'displayname_change',
      refType: 'profile',
      ref: 'OldName -> NewName',
    }));
  });

  it('proceeds for free when cooldown has expired', async () => {
    db.getUser.mockResolvedValue(makeUserRecord({
      displayNameChangeReadyAt: new Date(Date.now() - 1000).toISOString(),
    }));

    const result = await updateDisplayName(testUser, { displayName: 'NewName' });

    expect(result.success).toBe(true);
    expect(db.deductEssence).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace before saving', async () => {
    const result = await updateDisplayName(testUser, { displayName: '  Spaced  ' });
    expect(result.success).toBe(true);
    expect(result.data.displayName).toBe('Spaced');
    expect(db.updateUser.mock.calls[0][1].displayName).toBe('Spaced');
  });
});

describe('updateDisplayName — validation', () => {
  it('rejects names shorter than 3 characters', async () => {
    const result = await updateDisplayName(testUser, { displayName: 'ab' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('rejects names longer than 20 characters', async () => {
    const result = await updateDisplayName(testUser, { displayName: 'a'.repeat(21) });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects all-whitespace names', async () => {
    const result = await updateDisplayName(testUser, { displayName: '     ' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects names that start with a non-alphanumeric character', async () => {
    const result = await updateDisplayName(testUser, { displayName: '_StartUnderscore' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects names with consecutive spaces', async () => {
    const result = await updateDisplayName(testUser, { displayName: 'Foo  Bar' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects names with disallowed characters', async () => {
    const result = await updateDisplayName(testUser, { displayName: 'Foo!Bar' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects names that match the current name (NO_CHANGES)', async () => {
    const result = await updateDisplayName(testUser, { displayName: 'OldName' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NO_CHANGES');
  });

  it('rejects names flagged by the profanity filter', async () => {
    containsProfanity.mockReturnValue(true);
    const result = await updateDisplayName(testUser, { displayName: 'BadWord' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('PROFANITY');
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('rejects missing displayName', async () => {
    const result = await updateDisplayName(testUser, {});
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('updateDisplayName — cooldown', () => {
  const futureReadyAt = () => new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  it('blocks change with COOLDOWN_ACTIVE when cooldown is active and skip not requested', async () => {
    db.getUser.mockResolvedValue(makeUserRecord({ displayNameChangeReadyAt: futureReadyAt() }));

    const result = await updateDisplayName(testUser, { displayName: 'NewName' });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('COOLDOWN_ACTIVE');
    expect(result.error.skipCost).toBe(SKIP_COST);
    expect(typeof result.error.remainingMs).toBe('number');
    expect(result.error.readyAt).toBeTruthy();
    expect(db.updateUser).not.toHaveBeenCalled();
    expect(db.deductEssence).not.toHaveBeenCalled();
  });

  it('skips cooldown when user pays essence and has sufficient balance', async () => {
    db.getUser.mockResolvedValue(makeUserRecord({ displayNameChangeReadyAt: futureReadyAt() }));
    db.deductEssence.mockResolvedValue({ success: true, newBalance: 1500, deducted: SKIP_COST });

    const result = await updateDisplayName(testUser, { displayName: 'NewName', skipCooldown: true });

    expect(result.success).toBe(true);
    expect(result.data.skippedCooldown).toBe(true);
    expect(result.data.newEssenceBalance).toBe(1500);
    expect(db.deductEssence).toHaveBeenCalledWith('usr_test123', SKIP_COST, expect.objectContaining({
      type: 'displayname_skip',
    }));
    expect(db.updateUser).toHaveBeenCalled();
  });

  it('returns INSUFFICIENT_BALANCE when skip requested but user cannot afford it', async () => {
    db.getUser.mockResolvedValue(makeUserRecord({ displayNameChangeReadyAt: futureReadyAt() }));
    db.deductEssence.mockResolvedValue({
      success: false,
      error: 'Insufficient Essence',
      required: SKIP_COST,
      available: 100,
    });

    const result = await updateDisplayName(testUser, { displayName: 'NewName', skipCooldown: true });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(result.error.required).toBe(SKIP_COST);
    expect(result.error.available).toBe(100);
    expect(db.updateUser).not.toHaveBeenCalled();
  });
});

describe('updateDisplayName — preconditions', () => {
  it('returns NOT_FOUND when user record is missing', async () => {
    db.getUser.mockResolvedValue(null);
    const result = await updateDisplayName(testUser, { displayName: 'NewName' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
