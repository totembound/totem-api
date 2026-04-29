/**
 * Profile Validation Tests
 *
 * Pure validators for bio / avatar / banner fields. No DB access; ownership
 * checks for `kind: 'totem'` avatars are exercised separately in the
 * update-profile handler test.
 */

jest.mock('../src/common/profanity', () => ({
  containsProfanity: jest.fn(() => false),
}));

const { containsProfanity } = require('../src/common/profanity');
const {
  validateBio,
  validateAvatar,
  validateBanner,
  BIO_MAX_LENGTH,
} = require('../src/common/profile-validation');

beforeEach(() => {
  jest.clearAllMocks();
  containsProfanity.mockReturnValue(false);
});

describe('validateBio', () => {
  it('accepts null (clear bio)', () => {
    expect(validateBio(null)).toEqual({ valid: true, value: null });
  });

  it('accepts empty / whitespace string and normalizes to null', () => {
    expect(validateBio('')).toEqual({ valid: true, value: null });
    expect(validateBio('   \n\t   ')).toEqual({ valid: true, value: null });
  });

  it('accepts plain text + emoji + multi-line', () => {
    const r = validateBio('hello world 🐺\nsecond line');
    expect(r.valid).toBe(true);
    expect(r.value).toBe('hello world 🐺\nsecond line');
  });

  it('rejects non-string input', () => {
    expect(validateBio(123).valid).toBe(false);
    expect(validateBio({}).valid).toBe(false);
    expect(validateBio([]).valid).toBe(false);
  });

  it(`rejects bios over ${BIO_MAX_LENGTH} chars`, () => {
    const long = 'a'.repeat(BIO_MAX_LENGTH + 1);
    expect(validateBio(long).valid).toBe(false);
  });

  it('rejects http(s) links', () => {
    expect(validateBio('check http://evil.com').valid).toBe(false);
    expect(validateBio('see https://example.com').valid).toBe(false);
    expect(validateBio('visit www.example.com').valid).toBe(false);
  });

  it('escapes HTML entities so bios always render as plain text', () => {
    const r = validateBio('<script>alert(1)</script>');
    expect(r.valid).toBe(true);
    expect(r.value).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('strips control chars but preserves \\n and \\t', () => {
    const r = validateBio('hello\x00\x07world\nnext\tcol');
    expect(r.valid).toBe(true);
    expect(r.value).toBe('helloworld\nnext\tcol');
  });

  it('normalizes CRLF to LF', () => {
    const r = validateBio('a\r\nb\rc');
    expect(r.valid).toBe(true);
    expect(r.value).toBe('a\nb\nc');
  });

  it('rejects profanity', () => {
    containsProfanity.mockReturnValue(true);
    const r = validateBio('rude content');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('PROFANITY');
  });
});

describe('validateAvatar', () => {
  it('accepts null', () => {
    expect(validateAvatar(null)).toEqual({ valid: true, value: null });
  });

  it('accepts kind=domain with valid integer id 0-5', () => {
    for (let id = 0; id <= 5; id++) {
      const r = validateAvatar({ kind: 'domain', id });
      expect(r.valid).toBe(true);
      expect(r.value).toEqual({ kind: 'domain', id });
    }
  });

  it('rejects domain id outside 0-5', () => {
    expect(validateAvatar({ kind: 'domain', id: 6 }).valid).toBe(false);
    expect(validateAvatar({ kind: 'domain', id: -1 }).valid).toBe(false);
    expect(validateAvatar({ kind: 'domain', id: 'air' }).valid).toBe(false);
  });

  it('accepts kind=totem with valid integer triple', () => {
    const r = validateAvatar({ kind: 'totem', speciesId: 0, colorId: 4, stage: 2 });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ kind: 'totem', speciesId: 0, colorId: 4, stage: 2 });
  });

  it('rejects totem with non-integer fields', () => {
    expect(validateAvatar({ kind: 'totem', speciesId: 1.5, colorId: 0, stage: 0 }).valid).toBe(false);
    expect(validateAvatar({ kind: 'totem', speciesId: 0, colorId: 0, stage: 5 }).valid).toBe(false);
    expect(validateAvatar({ kind: 'totem', speciesId: -1, colorId: 0, stage: 0 }).valid).toBe(false);
  });

  it('rejects unknown kinds', () => {
    expect(validateAvatar({ kind: 'upload', url: 'whatever' }).valid).toBe(false);
    expect(validateAvatar({}).valid).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateAvatar('air').valid).toBe(false);
    expect(validateAvatar(['domain', 0]).valid).toBe(false);
  });
});

describe('validateBanner', () => {
  it('accepts null', () => {
    expect(validateBanner(null)).toEqual({ valid: true, value: null });
  });

  it('accepts kind=domain with valid integer id', () => {
    const r = validateBanner({ kind: 'domain', id: 3 });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ kind: 'domain', id: 3 });
  });

  it('rejects kind=totem (banner is domain-only in v1)', () => {
    expect(validateBanner({ kind: 'totem', speciesId: 0, colorId: 0, stage: 0 }).valid).toBe(false);
  });

  it('rejects unknown kinds and out-of-range ids', () => {
    expect(validateBanner({ kind: 'whatever', id: 0 }).valid).toBe(false);
    expect(validateBanner({ kind: 'domain', id: 99 }).valid).toBe(false);
  });
});
