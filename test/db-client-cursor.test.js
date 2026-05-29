/**
 * Cursor pagination primitives — encode/decode roundtrip, the
 * listAllTransactions guard that forbids unbounded cross-slice queries, and
 * the filter-aware iteration that makes type/currency filters return useful
 * page sizes (instead of N matches from N rows scanned).
 *
 * Full integration of listUsers / listAllTransactions against DynamoDB is
 * covered indirectly via admin-handlers.test.js (which mocks db-client).
 */

// Mock docClient before requiring db-client so the filter-aware iteration tests
// can drive it. The throw-guard and cursor tests don't actually hit it.
const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

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

describe('listAllTransactions filter-aware iteration', () => {
  beforeEach(() => mockSend.mockReset());

  it('keeps querying past filtered-out pages until `limit` matches are collected', async () => {
    // Three Query iterations simulating: page 1 has 0 matches, page 2 has 2,
    // page 3 has 1 (and ends). Expected: 3 collected, nextCursor null.
    mockSend
      .mockResolvedValueOnce({ Items: [], ScannedCount: 5, LastEvaluatedKey: { pk: 'a' } })
      .mockResolvedValueOnce({ Items: [{ id: '1' }, { id: '2' }], ScannedCount: 5, LastEvaluatedKey: { pk: 'b' } })
      .mockResolvedValueOnce({ Items: [{ id: '3' }], ScannedCount: 5 }); // no LastEvaluatedKey

    const result = await listAllTransactions({ userId: 'usr_x', type: 'protection_purchase', limit: 3 });

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(result.items.map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(result.nextCursor).toBeNull();
  });

  it('stops iterating once limit is satisfied and returns a cursor for resumption', async () => {
    // First iteration yields enough matches — should NOT make a second call.
    mockSend.mockResolvedValueOnce({
      Items: [{ id: '1' }, { id: '2' }, { id: '3' }],
      ScannedCount: 25,
      LastEvaluatedKey: { pk: 'next' },
    });

    const result = await listAllTransactions({ userId: 'usr_x', type: 'protection_purchase', limit: 3 });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).not.toBeNull();
  });

  it('honors the safety cap on rows scanned (bails before runaway cost)', async () => {
    // Always return 0 matches with more data — should stop at MAX_SCAN.
    mockSend.mockResolvedValue({
      Items: [],
      ScannedCount: 100,
      LastEvaluatedKey: { pk: 'more' },
    });

    const result = await listAllTransactions({ userId: 'usr_x', type: 'never_matches', limit: 10 });

    // limit=10 → MAX_SCAN = max(100, 200) = 200. PER_ITER = max(10, 25) = 25.
    // We bail when scanned >= MAX_SCAN. With ScannedCount: 100 per iter, that's 2 iterations.
    expect(mockSend.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).not.toBeNull(); // cursor surfaced so caller can retry
  });

  it('takes the fast path (one Query) when no FilterExpression is needed', async () => {
    // userId only, no type/currency → no FilterExpression → single Query.
    mockSend.mockResolvedValueOnce({ Items: [{ id: '1' }, { id: '2' }], LastEvaluatedKey: null });

    const result = await listAllTransactions({ userId: 'usr_x', limit: 5 });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });
});
