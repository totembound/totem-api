/**
 * Template render guard.
 *
 * Drives every email sender through loadTemplate (local/nodemailer path) and asserts the
 * rendered HTML, subject, and plain-text contain NO unreplaced {{placeholders}}. This
 * catches the class of bug where a template adds a {{token}} the sender doesn't supply
 * (or vice-versa) and it renders literally to the user.
 */

process.env.IS_LOCAL = 'true';

const sentMails = [];
jest.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: (opts) => {
      sentMails.push(opts);
      return Promise.resolve({ messageId: 'test-message-id' });
    },
  }),
}));

const email = require('../src/common/email');

beforeEach(() => {
  sentMails.length = 0;
});

// Matches {{token}} / {{ token }} / {{a.b}} — anything left unsubstituted.
const PLACEHOLDER = /\{\{\s*[\w.]+\s*\}\}/;

const cases = [
  ['verify', () => email.sendVerificationEmail('u@test.local', 'Tester', '123456')],
  ['reset password', () => email.sendPasswordResetEmail('u@test.local', 'Tester', '123456')],
  ['welcome (with starter totem)', () => email.sendNewUserWelcomeEmail('u@test.local', 'Tester', { speciesId: 0, nickname: 'Goosey' })],
  ['welcome (starter box)', () => email.sendNewUserWelcomeEmail('u@test.local', 'Tester', null)],
  ['subscription canceled', () => email.sendSubscriptionCanceledEmail('u@test.local', new Date('2026-07-01T00:00:00Z'), 'premium')],
  ['subscription reactivated', () => email.sendSubscriptionReactivatedEmail('u@test.local', new Date('2026-07-01T00:00:00Z'), 'vip')],
  ['gem purchase receipt', () => email.sendGemPurchaseReceiptEmail('u@test.local', 'Starter Pack', 500, 1500)],
  ['subscription confirmed', () => email.sendSubscriptionConfirmedEmail('u@test.local', 'vip', new Date('2026-07-01T00:00:00Z').toISOString())],
  ['password changed', () => email.sendPasswordChangedEmail('u@test.local', 'Tester', new Date('2026-06-06T12:00:00Z'))],
  ['payment failed (with retry date)', () => email.sendPaymentFailedEmail('u@test.local', 'premium', new Date('2026-07-01T00:00:00Z'))],
  ['payment failed (no retry date)', () => email.sendPaymentFailedEmail('u@test.local', 'premium', null)],
  ['subscription expired', () => email.sendSubscriptionExpiredEmail('u@test.local', 'vip')],
  ['renewal receipt', () => email.sendRenewalReceiptEmail('u@test.local', 'premium', 999, 'usd', new Date('2026-07-01T00:00:00Z'))],
  ['refund issued', () => email.sendRefundIssuedEmail('u@test.local', 499, 'usd', 'Starter Pack', 'We removed 500 Gems.')],
];

describe('email templates render with all placeholders substituted', () => {
  it.each(cases)('%s', async (_name, send) => {
    await send();
    const mail = sentMails[sentMails.length - 1];
    expect(mail).toBeDefined();
    expect(mail.html).toEqual(expect.any(String));
    expect(mail.html).not.toMatch(PLACEHOLDER);
    expect(mail.subject).not.toMatch(PLACEHOLDER);
    expect(typeof mail.text).toBe('string');
    expect(mail.text.length).toBeGreaterThan(0);
    expect(mail.text).not.toMatch(PLACEHOLDER);
  });
});
