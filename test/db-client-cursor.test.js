/**
 * Cursor pagination primitives — encode/decode roundtrip and the
 * listAllTransactions guard that forbids unbounded cross-slice queries.
 *
 * Full integration of listUsers / listAllTransactions against DynamoDB is
 * covered indirectly via admin-handlers.test.js (which mocks db-client).
 */

const { encodeCursor, decodeCursor, listAllTransactions } = require('../src/common/db-client');

describe('cursor encode/decode', () => {
  it('encodeCursor returns null for null input', () => {
    expect(encodeCursor(null)).toBeNull();
    expect(encodeCursor(undefined)).toBeNull();
  });

  it('decodeCursor returns undefined for null/empty input', () => {
    expect(decodeCursor(null)).toBeUndefined();
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
  });

  it('decodeCursor returns undefined for malformed base64/JSON', () => {
    expect(decodeCursor('not-a-real-cursor-!!!')).toBeUndefined();
    // valid base64 of non-JSON garbage
    expect(decodeCursor(Buffer.from('not json').toString('base64'))).toBeUndefined();
  });

  it('roundtrips a DynamoDB-shaped key', () => {
    const key = { pk: 'USER#usr_abc', sk: 'TOTEM#ttm_xyz' };
    const cursor = encodeCursor(key);
    expect(typeof cursor).toBe('string');
    expect(cursor).not.toContain('USER#'); // base64 is opaque
    expect(decodeCursor(cursor)).toEqual(key);
  });

  it('roundtrips a GSI-shaped key with multiple attributes', () => {
    const key = {
      pk: 'USER#usr_abc',
      sk: 'TXN#2026-05-28T00:00:00Z#aa11',
      userId: 'usr_abc',
      ts: '2026-05-28T00:00:00Z',
    };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });
});

describe('listAllTransactions guard', () => {
  it('rejects calls with no userId and no type — unbounded scans are forbidden', async () => {
    await expect(listAllTransactions({ limit: 10 })).rejects.toThrow(/userId or type/);
  });

  it('rejects calls with only a time window (no partition filter)', async () => {
    await expect(
      listAllTransactions({ startTime: '2026-01-01T00:00:00Z', endTime: '2026-02-01T00:00:00Z' }),
    ).rejects.toThrow(/userId or type/);
  });
});
