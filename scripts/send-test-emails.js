/**
 * E2E email harness — renders EVERY email template through the real sender + nodemailer
 * into MailHog (the local "email admin" at http://localhost:8025).
 *
 * Run:  IS_LOCAL=true node scripts/send-test-emails.js
 * Then open http://localhost:8025 to eyeball each rendered email (HTML + plain text).
 *
 * It does NOT touch DynamoDB/Stripe — it calls the email senders directly, so it covers
 * templates that are hard to trigger through the API (renewal receipt, dunning, refund…).
 */

process.env.IS_LOCAL = 'true';
process.env.APP_URL = process.env.APP_URL || 'http://localhost:3000';
// logoUrl intentionally left at its prod-CDN default.

const http = require('http');
const email = require('../src/common/email');

const MAILHOG = { host: 'localhost', port: 8025 };

function mailhog(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...MAILHOG, method, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body ? JSON.parse(body) : null));
    });
    req.on('error', reject);
    req.end();
  });
}

const cases = [
  ['Verify email', () => email.sendVerificationEmail('newplayer@example.com', 'NewPlayer', '123456')],
  ['Password reset code', () => email.sendPasswordResetEmail('forgot@example.com', 'ForgetfulPlayer', '654321')],
  ['Welcome (with starter totem)', () => email.sendNewUserWelcomeEmail('welcome1@example.com', 'TotemTamer', { speciesId: 0, nickname: 'Goosey' })],
  ['Welcome (starter box)', () => email.sendNewUserWelcomeEmail('welcome2@example.com', 'BoxOpener', null)],
  ['Subscription confirmed', () => email.sendSubscriptionConfirmedEmail('sub@example.com', 'vip', new Date(Date.now() + 30 * 864e5).toISOString())],
  ['Subscription canceled', () => email.sendSubscriptionCanceledEmail('cancel@example.com', new Date(Date.now() + 20 * 864e5), 'premium')],
  ['Subscription reactivated', () => email.sendSubscriptionReactivatedEmail('reactivate@example.com', new Date(Date.now() + 30 * 864e5), 'vip')],
  ['Gem purchase receipt', () => email.sendGemPurchaseReceiptEmail('gems@example.com', 'Best Value Pack', 3000, 8200)],
  // ---- NEW v1.0 emails ----
  ['Password changed (NEW)', () => email.sendPasswordChangedEmail('changed@example.com', 'SecurePlayer', new Date())],
  ['Payment failed / dunning (NEW)', () => email.sendPaymentFailedEmail('dunning@example.com', 'premium', new Date(Date.now() + 3 * 864e5))],
  ['Payment failed, no retry date (NEW)', () => email.sendPaymentFailedEmail('dunning2@example.com', 'vip', null)],
  ['Subscription expired (NEW)', () => email.sendSubscriptionExpiredEmail('expired@example.com', 'vip')],
  ['Renewal receipt (NEW)', () => email.sendRenewalReceiptEmail('renewal@example.com', 'premium', 999, 'usd', new Date(Date.now() + 30 * 864e5))],
  ['Refund issued (NEW)', () => email.sendRefundIssuedEmail('refund@example.com', 2499, 'usd', 'Best Value Pack', "We've removed 3,000 Gems associated with this refund from your account.")],
];

(async () => {
  console.log('Clearing MailHog inbox…');
  try { await mailhog('DELETE', '/api/v1/messages'); }
  catch (e) { console.error('Could not reach MailHog at :8025 — is the stack up? (docker compose up -d)'); process.exit(1); }

  console.log(`Sending ${cases.length} emails to MailHog…\n`);
  for (const [name, send] of cases) {
    try {
      await send();
      console.log(`  ✓ ${name}`);
    }
    catch (e) {
      console.log(`  ✗ ${name} — ${e.message}`);
    }
  }

  // Give MailHog a moment to index, then read back what landed.
  await new Promise((r) => setTimeout(r, 500));
  const inbox = await mailhog('GET', '/api/v2/messages');
  console.log(`\nMailHog now holds ${inbox.total} message(s):`);
  for (const m of inbox.items) {
    const subject = (m.Content.Headers.Subject || ['(no subject)'])[0];
    const to = (m.Content.Headers.To || ['?'])[0];
    console.log(`  • [${to}] ${subject}`);
  }
  console.log('\nOpen http://localhost:8025 to view the rendered HTML + plain-text of each.');
})();
