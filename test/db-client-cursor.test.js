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

const {
  encodeCursor, decodeCursor, listAllTransactions, listUsers, createUser, updateUser,
} = require('../src/common/db-client');

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

describe('listUsers search', () => {
  beforeEach(() => mockSend.mockReset());

  const cmdName = (call) => call[0].constructor.name;

  it('takes the fast path (one Scan, no search filter) when search is empty', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ id: 'u1' }], LastEvaluatedKey: { pk: 'k' } });

    const result = await listUsers({ limit: 25, search: '   ' });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input.Limit).toBe(25);
    expect(mockSend.mock.calls[0][0].input.FilterExpression).toBe('sk = :profile');
    expect(result.nextCursor).not.toBeNull();
  });

  it('keeps scanning past empty pages until `limit` matches are found', async () => {
    // Regression: a single Scan with Limit 25 read 25 rows, matched none, and
    // the admin UI rendered "No users found".
    mockSend
      .mockResolvedValueOnce({ Items: [], ScannedCount: 100, LastEvaluatedKey: { pk: 'a' } })
      .mockResolvedValueOnce({ Items: [], ScannedCount: 100, LastEvaluatedKey: { pk: 'b' } })
      .mockResolvedValueOnce({ Items: [{ id: 'u9' }], ScannedCount: 40 });

    const result = await listUsers({ limit: 25, search: 'dragon' });

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(result.items.map((u) => u.id)).toEqual(['u9']);
    expect(result.nextCursor).toBeNull();
  });

  it('matches case-insensitively via the lowercased shadow fields, and raw fields for un-backfilled rows', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], ScannedCount: 3 });

    await listUsers({ limit: 25, search: '  DragonMaster ' });

    const { input } = mockSend.mock.calls[0][0];
    expect(input.FilterExpression).toContain('contains(emailLower, :search)');
    expect(input.FilterExpression).toContain('contains(displayNameLower, :search)');
    expect(input.FilterExpression).toContain('contains(displayName, :raw)');
    expect(input.ExpressionAttributeValues[':search']).toBe('dragonmaster');
    expect(input.ExpressionAttributeValues[':raw']).toBe('DragonMaster');
  });

  it('honors the safety cap on rows scanned and surfaces a cursor to continue', async () => {
    mockSend.mockResolvedValue({ Items: [], ScannedCount: 100, LastEvaluatedKey: { pk: 'more' } });

    const result = await listUsers({ limit: 25, search: 'nobody' });

    // 2000-row cap / 100 per iteration = 20 Scans, then bail.
    expect(mockSend).toHaveBeenCalledTimes(20);
    expect(mockSend.mock.calls[0][0].input.Limit).toBe(25); // first pass = page size
    expect(mockSend.mock.calls[1][0].input.Limit).toBe(100); // then widens
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).not.toBeNull();
  });

  it('resolves a full email via the email-index GSI without scanning', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ id: 'u1', sk: 'PROFILE', email: 'Dave@Example.com' }] });

    const result = await listUsers({ limit: 25, search: 'Dave@Example.com' });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(cmdName(mockSend.mock.calls[0])).toBe('QueryCommand');
    expect(mockSend.mock.calls[0][0].input.IndexName).toBe('email-index');
    expect(result).toEqual({ items: [{ id: 'u1', sk: 'PROFILE', email: 'Dave@Example.com' }], nextCursor: null });
  });

  it('tries the lowercased email, then falls back to the scan when the GSI misses', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [] }) // exact case
      .mockResolvedValueOnce({ Items: [] }) // lowercased
      .mockResolvedValueOnce({ Items: [{ id: 'u2' }], ScannedCount: 10 });

    const result = await listUsers({ limit: 25, search: 'Dave@Example.com' });

    expect(mockSend.mock.calls.map(cmdName)).toEqual(['QueryCommand', 'QueryCommand', 'ScanCommand']);
    expect(mockSend.mock.calls[1][0].input.ExpressionAttributeValues[':pk']).toBe('dave@example.com');
    expect(result.items.map((u) => u.id)).toEqual(['u2']);
  });

  it('skips the email GSI when paging with a cursor', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], ScannedCount: 10 });

    await listUsers({ limit: 25, search: 'a@b.co', cursor: encodeCursor({ pk: 'USER#x', sk: 'PROFILE' }) });

    expect(mockSend.mock.calls.map(cmdName)).toEqual(['ScanCommand']);
    expect(mockSend.mock.calls[0][0].input.ExclusiveStartKey).toEqual({ pk: 'USER#x', sk: 'PROFILE' });
  });
});

describe('user search shadow fields', () => {
  beforeEach(() => mockSend.mockReset());

  it('createUser writes emailLower / displayNameLower', async () => {
    mockSend.mockResolvedValueOnce({});

    await createUser({ id: 'usr_1', email: 'Dave@Example.com', displayName: 'DragonMaster' });

    const { Item } = mockSend.mock.calls[0][0].input;
    expect(Item.emailLower).toBe('dave@example.com');
    expect(Item.displayNameLower).toBe('dragonmaster');
  });

  it('updateUser refreshes displayNameLower on rename', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: {} });

    await updateUser('usr_1', { displayName: 'NewName' });

    const { input } = mockSend.mock.calls[0][0];
    expect(Object.values(input.ExpressionAttributeNames)).toContain('displayNameLower');
    expect(Object.values(input.ExpressionAttributeValues)).toContain('newname');
  });

  it('updateUser leaves search fields alone for unrelated updates', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: {} });

    await updateUser('usr_1', { 'stats.loginStreak': 3 });

    const names = Object.values(mockSend.mock.calls[0][0].input.ExpressionAttributeNames);
    expect(names).not.toContain('displayNameLower');
    expect(names).not.toContain('emailLower');
  });
});
