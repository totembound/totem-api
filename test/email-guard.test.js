/**
 * Tests for the non-routable email guard in sendEmail (Lambda/SES branch).
 * Ensures CI/synthetic addresses (RFC 2606/6761) never hit SES, preventing
 * MessageRejected errors and SES quota waste.
 */

const mockSesSend = jest.fn();

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn().mockImplementation((params) => ({ __cmd: 'SendEmail', params })),
}));

describe('sendEmail — non-routable guard (SES branch)', () => {
  let email;

  beforeAll(() => {
    delete process.env.IS_LOCAL; // Force SES branch
  });

  beforeEach(() => {
    jest.resetModules();
    mockSesSend.mockReset();
    mockSesSend.mockResolvedValue({ MessageId: 'msg_123' });
    email = require('../src/common/email');
  });

  const cases = [
    ['example.com', 'testplayer1@example.com'],
    ['example.net', 'user@example.net'],
    ['example.org', 'foo@example.org'],
    ['.test TLD', 'alice@qa.test'],
    ['.invalid TLD', 'bob@something.invalid'],
    ['.localhost', 'x@box.localhost'],
    ['.local', 'svc@dev.local'],
    ['case-insensitive', 'Upper@EXAMPLE.COM'],
  ];

  test.each(cases)('skips SES for %s (%s)', async (_label, addr) => {
    const result = await email.sendSubscriptionConfirmedEmail(addr, 'vip', '2026-05-01');
    expect(result).toEqual({ skipped: true, reason: 'non-routable', to: addr });
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it('still sends via SES for routable addresses', async () => {
    await email.sendSubscriptionConfirmedEmail('real@totembound.com', 'vip', '2026-05-01');
    expect(mockSesSend).toHaveBeenCalledTimes(1);
  });

  it('does not reject addresses that merely contain "example" in the local-part', async () => {
    // "example" in local-part is fine; only the domain matters.
    await email.sendSubscriptionConfirmedEmail('example@totembound.com', 'vip', '2026-05-01');
    expect(mockSesSend).toHaveBeenCalledTimes(1);
  });
});
