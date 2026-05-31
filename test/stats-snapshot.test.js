/**
 * Unit tests for the analytics-pipeline snapshot logic — the bug-prone bits:
 * UTC bucket flooring, retention TTL, and the partial-skip data-integrity guard.
 */

jest.mock('../src/common/db-client', () => ({
  putStatsSnapshot: jest.fn(),
}));
jest.mock('../src/services/admin-stats-service', () => ({
  computeSnapshot: jest.fn(),
}));

const db = require('../src/common/db-client');
const svc = require('../src/services/admin-stats-service');
const { runSnapshot, bucketStart, ttlForGranularity } = require('../src/functions/admin/stats-snapshot');

jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();

const HEALTHY = {
  users: { total: 2 },
  totems: { total: 3 },
  transactions: { byType: {} },
  economy: { essenceInCirculation: 100 },
  generatedAt: '2026-05-31T00:05:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  db.putStatsSnapshot.mockResolvedValue({ written: true });
  svc.computeSnapshot.mockResolvedValue(HEALTHY);
});

describe('bucketStart (UTC flooring)', () => {
  test('HOURLY floors to the top of the hour', () => {
    const now = new Date('2026-05-31T13:47:22.500Z');
    expect(bucketStart(now, 'HOURLY').toISOString()).toBe('2026-05-31T13:00:00.000Z');
  });

  test('DAILY floors to midnight UTC', () => {
    const now = new Date('2026-05-31T13:47:22.500Z');
    expect(bucketStart(now, 'DAILY').toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  test('WEEKLY anchors to the preceding Sunday 00:00 UTC', () => {
    // 2026-05-31 is a Sunday → anchors to itself.
    expect(bucketStart(new Date('2026-05-31T13:00:00Z'), 'WEEKLY').toISOString()).toBe('2026-05-31T00:00:00.000Z');
    // 2026-06-03 is a Wednesday → back to Sun 2026-05-31.
    expect(bucketStart(new Date('2026-06-03T09:00:00Z'), 'WEEKLY').toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  test('WEEKLY rolls back across a month boundary', () => {
    // 2026-06-02 (Tue) → back to Sun 2026-05-31.
    expect(bucketStart(new Date('2026-06-02T00:30:00Z'), 'WEEKLY').toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  test('does not mutate the input date', () => {
    const now = new Date('2026-05-31T13:47:22.500Z');
    const copy = now.getTime();
    bucketStart(now, 'WEEKLY');
    expect(now.getTime()).toBe(copy);
  });
});

describe('ttlForGranularity', () => {
  const now = new Date('2026-05-31T00:00:00Z');
  const base = Math.floor(now.getTime() / 1000);

  test('HOURLY = +90 days', () => {
    expect(ttlForGranularity(now, 'HOURLY')).toBe(base + 90 * 86400);
  });
  test('DAILY = +730 days', () => {
    expect(ttlForGranularity(now, 'DAILY')).toBe(base + 730 * 86400);
  });
  test('WEEKLY = no TTL (kept indefinitely)', () => {
    expect(ttlForGranularity(now, 'WEEKLY')).toBeUndefined();
  });
});

describe('runSnapshot', () => {
  test('writes a healthy snapshot with the right key + TTL', async () => {
    const res = await runSnapshot({ granularity: 'hourly', now: new Date('2026-05-31T13:47:00Z') });
    expect(res.written).toBe(true);
    expect(res.bucket).toBe('2026-05-31T13:00:00.000Z');
    const item = db.putStatsSnapshot.mock.calls[0][0];
    expect(item.pk).toBe('BUCKET#HOURLY');
    expect(item.sk).toBe('TS#2026-05-31T13:00:00.000Z');
    expect(item.ttl).toBeGreaterThan(0);
    expect(item.economy.essenceInCirculation).toBe(100);
  });

  test('WEEKLY item has no ttl', async () => {
    await runSnapshot({ granularity: 'weekly', now: new Date('2026-05-31T13:00:00Z') });
    const item = db.putStatsSnapshot.mock.calls[0][0];
    expect(item.ttl).toBeUndefined();
  });

  test('SKIPS persisting a partial snapshot (data-integrity guard)', async () => {
    svc.computeSnapshot.mockResolvedValue({ ...HEALTHY, partial: ['users'] });
    const res = await runSnapshot({ granularity: 'hourly', now: new Date('2026-05-31T13:00:00Z') });
    expect(res.written).toBe(false);
    expect(res.skipped).toBe('partial');
    expect(db.putStatsSnapshot).not.toHaveBeenCalled();
  });

  test('reports written:false when the bucket already exists (idempotent)', async () => {
    db.putStatsSnapshot.mockResolvedValue({ written: false });
    const res = await runSnapshot({ granularity: 'hourly', now: new Date('2026-05-31T13:00:00Z') });
    expect(res.written).toBe(false);
  });

  test('rejects an invalid granularity', async () => {
    await expect(runSnapshot({ granularity: 'yearly' })).rejects.toThrow(/Invalid granularity/);
  });
});
