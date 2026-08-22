/**
 * Cloudflare Turnstile captcha verification.
 *
 * Protects bot-targeted auth endpoints (signup, forgot-password) from the
 * scripted crawlers we see hammering the auth surface over rotating Tor exit
 * IPs. Because the attack rotates source IPs, per-IP rate limiting is useless
 * on its own — a proof-of-humanity challenge is the durable control.
 *
 * Behaviour:
 *  - If no secret is configured (TURNSTILE_SECRET / _PARAM), verification is
 *    SKIPPED. This keeps local dev and un-provisioned environments frictionless.
 *  - Once a secret IS configured, verification FAILS CLOSED: a missing/invalid
 *    token is rejected, and even a network error talking to Cloudflare is
 *    rejected. A brief Cloudflare outage blocking new signups is an acceptable
 *    trade against letting the bot flood burn our SES sender reputation.
 */

const { getSecret } = require('./ssm-loader');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Best-effort extraction of the real client IP behind API Gateway.
 * API Gateway populates X-Forwarded-For with the caller as the first hop.
 */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || undefined;
}

/**
 * Verify a Turnstile token against Cloudflare's siteverify API.
 * @param {string} token - The cf-turnstile-response token from the widget.
 * @param {string} [remoteIp] - The client IP (optional but recommended).
 * @returns {Promise<{success: boolean, errorCodes?: string[]}>}
 */
async function verifyTurnstile(token, remoteIp) {
  const secret = await getSecret('TURNSTILE_SECRET');
  if (!secret) {
    // No secret configured — caller decides. Signalled distinctly from a
    // verification failure via the `skipped` flag.
    return { success: true, skipped: true };
  }

  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp) {
    body.append('remoteip', remoteIp);
  }

  const response = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json();
  return { success: data.success === true, errorCodes: data['error-codes'] };
}

/**
 * Express middleware enforcing Turnstile on a route.
 * Reads the token from req.body.captchaToken.
 */
async function requireCaptcha(req, res, next) {
  // Skip entirely when no secret is provisioned (local dev / not-yet-configured).
  const secret = await getSecret('TURNSTILE_SECRET');
  if (!secret) {
    return next();
  }

  const token = req.body && req.body.captchaToken;
  if (!token) {
    return res.status(403).json({
      success: false,
      error: 'Captcha verification required',
    });
  }

  try {
    const result = await verifyTurnstile(token, getClientIp(req));
    if (!result.success) {
      console.warn('[captcha] verification failed', {
        path: req.path,
        ip: getClientIp(req),
        errorCodes: result.errorCodes,
      });
      return res.status(403).json({
        success: false,
        error: 'Captcha verification failed. Please try again.',
      });
    }
    return next();
  }
  catch (err) {
    // Fail closed: a broken siteverify call must not become a bot bypass.
    console.error('[captcha] verification error:', err.message);
    return res.status(503).json({
      success: false,
      error: 'Verification temporarily unavailable. Please try again.',
    });
  }
}

module.exports = { verifyTurnstile, requireCaptcha, getClientIp };
