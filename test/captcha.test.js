/**
 * Tests for Cloudflare Turnstile captcha verification.
 *
 * Covers:
 * - requireCaptcha() middleware: skip when unconfigured, fail-closed once a
 *   secret is set (missing token → 403, invalid token → 403, network error → 503)
 * - verifyTurnstile(): siteverify request shape + result parsing
 * - getClientIp(): X-Forwarded-For first hop with fallback
 */

// Mock the SSM loader so we control whether a secret is "configured".
jest.mock('../src/common/ssm-loader', () => ({
  getSecret: jest.fn(),
}));

const { getSecret } = require('../src/common/ssm-loader');
const { requireCaptcha, verifyTurnstile, getClientIp } = require('../src/common/captcha');

// Suppress console noise from the fail paths.
jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'error').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockFetchOnce(jsonBody) {
  global.fetch = jest.fn().mockResolvedValue({ json: jest.fn().mockResolvedValue(jsonBody) });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete global.fetch;
});

describe('Turnstile captcha', () => {
  // -------------------------------------------------------
  // getClientIp
  // -------------------------------------------------------
  describe('getClientIp()', () => {
    it('uses the first hop of X-Forwarded-For', () => {
      const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' }, ip: '9.9.9.9' };
      expect(getClientIp(req)).toBe('1.2.3.4');
    });

    it('falls back to req.ip when no XFF header', () => {
      const req = { headers: {}, ip: '9.9.9.9' };
      expect(getClientIp(req)).toBe('9.9.9.9');
    });
  });

  // -------------------------------------------------------
  // verifyTurnstile
  // -------------------------------------------------------
  describe('verifyTurnstile()', () => {
    it('short-circuits as skipped when no secret is configured', async () => {
      getSecret.mockResolvedValue(null);
      const result = await verifyTurnstile('tok');
      expect(result).toEqual({ success: true, skipped: true });
      expect(global.fetch).toBeUndefined();
    });

    it('posts secret + response + remoteip to siteverify and returns success', async () => {
      getSecret.mockResolvedValue('secret-123');
      mockFetchOnce({ success: true });

      const result = await verifyTurnstile('tok-abc', '1.2.3.4');

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      expect(opts.method).toBe('POST');
      const body = opts.body.toString();
      expect(body).toContain('secret=secret-123');
      expect(body).toContain('response=tok-abc');
      expect(body).toContain('remoteip=1.2.3.4');
    });

    it('surfaces failure and error codes from siteverify', async () => {
      getSecret.mockResolvedValue('secret-123');
      mockFetchOnce({ success: false, 'error-codes': ['invalid-input-response'] });

      const result = await verifyTurnstile('bad-token');
      expect(result.success).toBe(false);
      expect(result.errorCodes).toEqual(['invalid-input-response']);
    });
  });

  // -------------------------------------------------------
  // requireCaptcha middleware
  // -------------------------------------------------------
  describe('requireCaptcha() middleware', () => {
    it('skips verification (calls next) when no secret is configured', async () => {
      getSecret.mockResolvedValue(null);
      const req = { body: {}, headers: {}, path: '/v1/auth/signup' };
      const res = mockRes();
      const next = jest.fn();

      await requireCaptcha(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(global.fetch).toBeUndefined();
    });

    it('returns 403 when secret is set but no token is provided (no Cloudflare call)', async () => {
      getSecret.mockResolvedValue('secret-123');
      const req = { body: {}, headers: {}, path: '/v1/auth/signup' };
      const res = mockRes();
      const next = jest.fn();

      await requireCaptcha(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: 'Captcha verification required',
      }));
      expect(next).not.toHaveBeenCalled();
      // Fail-closed short-circuit must not waste a Cloudflare round-trip.
      expect(global.fetch).toBeUndefined();
    });

    it('calls next when the token verifies', async () => {
      getSecret.mockResolvedValue('secret-123');
      mockFetchOnce({ success: true });
      const req = { body: { captchaToken: 'good' }, headers: { 'x-forwarded-for': '1.2.3.4' }, path: '/v1/auth/signup' };
      const res = mockRes();
      const next = jest.fn();

      await requireCaptcha(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 403 when the token fails verification', async () => {
      getSecret.mockResolvedValue('secret-123');
      mockFetchOnce({ success: false, 'error-codes': ['invalid-input-response'] });
      const req = { body: { captchaToken: 'bad' }, headers: {}, path: '/v1/auth/signup' };
      const res = mockRes();
      const next = jest.fn();

      await requireCaptcha(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: 'Captcha verification failed. Please try again.',
      }));
      expect(next).not.toHaveBeenCalled();
    });

    it('fails closed with 503 when the Cloudflare call throws', async () => {
      getSecret.mockResolvedValue('secret-123');
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
      const req = { body: { captchaToken: 'good' }, headers: {}, path: '/v1/auth/signup' };
      const res = mockRes();
      const next = jest.fn();

      await requireCaptcha(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
