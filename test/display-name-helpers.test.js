/**
 * display-name helper tests — sanitize + validate
 */

jest.mock('../src/common/profanity', () => ({
  containsProfanity: jest.fn(() => false),
}));

const { containsProfanity } = require('../src/common/profanity');
const {
  validateDisplayName,
  sanitizeInboundDisplayName,
  MIN_LENGTH,
  MAX_LENGTH,
} = require('../src/common/display-name');

beforeEach(() => {
  jest.clearAllMocks();
  containsProfanity.mockReturnValue(false);
});

describe('validateDisplayName', () => {
  it('accepts a plain valid name', () => {
    expect(validateDisplayName('Wolfy', 'Old')).toEqual({ valid: true, name: 'Wolfy' });
  });

  it('trims surrounding whitespace before checking', () => {
    expect(validateDisplayName('  Wolfy  ', 'Old')).toEqual({ valid: true, name: 'Wolfy' });
  });

  it('rejects too short', () => {
    expect(validateDisplayName('ab', 'Old').valid).toBe(false);
  });

  it('rejects too long', () => {
    expect(validateDisplayName('a'.repeat(MAX_LENGTH + 1), 'Old').valid).toBe(false);
  });

  it('rejects disallowed characters', () => {
    expect(validateDisplayName('Foo!Bar', 'Old').valid).toBe(false);
  });

  it('rejects consecutive spaces', () => {
    expect(validateDisplayName('Foo  Bar', 'Old').valid).toBe(false);
  });

  it('returns NO_CHANGES when name matches current', () => {
    const r = validateDisplayName('SameName', 'SameName');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('NO_CHANGES');
  });

  it('returns PROFANITY when filter flags the name', () => {
    containsProfanity.mockReturnValue(true);
    const r = validateDisplayName('Wolfy', 'Old');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('PROFANITY');
  });

  it('does not require a currentName', () => {
    expect(validateDisplayName('Wolfy').valid).toBe(true);
  });
});

describe('sanitizeInboundDisplayName', () => {
  it('passes through a clean name unchanged', () => {
    expect(sanitizeInboundDisplayName('JohnDoe', 'fallback')).toBe('JohnDoe');
  });

  it('folds Latin diacritics to ASCII', () => {
    expect(sanitizeInboundDisplayName('José Müller', 'fb')).toBe('Jose Muller');
  });

  it('strips disallowed characters', () => {
    expect(sanitizeInboundDisplayName(`John O'Brien`, 'fb')).toBe('John OBrien');
  });

  it('truncates over-long names to MAX_LENGTH', () => {
    const out = sanitizeInboundDisplayName('A'.repeat(50), 'fb');
    expect(out.length).toBeLessThanOrEqual(MAX_LENGTH);
  });

  it('falls back when sanitized result is too short', () => {
    expect(sanitizeInboundDisplayName('!', 'GoodFallback')).toBe('GoodFallback');
  });

  it('falls back when sanitized result is profane', () => {
    containsProfanity.mockImplementation((s) => s === 'BadName');
    expect(sanitizeInboundDisplayName('BadName', 'GoodFallback')).toBe('GoodFallback');
  });

  it('uses fallback when CJK-only input is provided', () => {
    expect(sanitizeInboundDisplayName('李明', 'GoodFallback')).toBe('GoodFallback');
  });

  it('pads short fallback with random digits to satisfy MIN_LENGTH', () => {
    const out = sanitizeInboundDisplayName('', 'X');
    expect(out.length).toBeGreaterThanOrEqual(MIN_LENGTH);
  });

  it('strips leading and trailing punctuation', () => {
    expect(sanitizeInboundDisplayName('  --John--  ', 'fb')).toBe('John');
  });

  it('collapses runs of whitespace to a single space', () => {
    expect(sanitizeInboundDisplayName('John     Doe', 'fb')).toBe('John Doe');
  });
});
