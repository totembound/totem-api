/**
 * Sanctum Service Tests
 *
 * Tests for the Elder Sanctum feature including seat management,
 * passive earnings, and council missions.
 */

// Mock the db-client before requiring the service
jest.mock('../src/common/db-client', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  deleteItem: jest.fn(),
  queryItems: jest.fn(),
  getTotem: jest.fn(),
  updateTotem: jest.fn(),
  addEssence: jest.fn(),
  addRunes: jest.fn(),
  deductEssence: jest.fn(),
  getUserTotems: jest.fn(),
  getUser: jest.fn(),
  transactWrite: jest.fn(),
  logTransaction: jest.fn(),
  userPK: jest.fn((userId) => `USER#${userId}`),
  TABLES: {
    USERS: 'TotemBound-Users',
    TOTEMS: 'TotemBound-Totems',
    EXPEDITION_STATE: 'TotemBound-ExpeditionState',
    TRANSACTIONS: 'TotemBound-Transactions',
  },
}));

const sanctumService = require('../src/services/sanctum-service');
const dbClient = require('../src/common/db-client');

describe('Sanctum Service', () => {
  const testUserId = 'usr_test123';
  const testTotemId = 'ttm_test456';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // ===========================================================================
  // getTenureMultiplier
  // ===========================================================================

  describe('getTenureMultiplier', () => {
    it('should return 1.0 for 0 hours', () => {
      expect(sanctumService.getTenureMultiplier(0)).toBe(1.0);
    });

    it('should return 1.0 for 23 hours (under 24hr threshold)', () => {
      expect(sanctumService.getTenureMultiplier(23)).toBe(1.0);
    });

    it('should return 1.1 at exactly 24 hours', () => {
      expect(sanctumService.getTenureMultiplier(24)).toBe(1.1);
    });

    it('should return 1.2 at exactly 72 hours', () => {
      expect(sanctumService.getTenureMultiplier(72)).toBe(1.2);
    });

    it('should return 1.3 at exactly 168 hours', () => {
      expect(sanctumService.getTenureMultiplier(168)).toBe(1.3);
    });

    it('should return 1.5 at 720+ hours', () => {
      expect(sanctumService.getTenureMultiplier(720)).toBe(1.5);
      expect(sanctumService.getTenureMultiplier(1000)).toBe(1.5);
    });
  });

  // ===========================================================================
  // calculateSeatEarnings
  // ===========================================================================

  describe('calculateSeatEarnings', () => {
    it('should return 0 for a just-seated totem (no time elapsed)', () => {
      const now = new Date('2026-03-28T12:00:00Z');
      const seat = {
        seatedAt: now.toISOString(),
        lastClaimedAt: now.toISOString(),
      };
      expect(sanctumService.calculateSeatEarnings(seat, now)).toBe(0);
    });

    it('should calculate correct earnings at 36hr with 1.2x multiplier', () => {
      // 36 hours since claim, tenure 72+ hours => 1.2x
      const seatedAt = new Date('2026-03-24T00:00:00Z'); // seated 4 days ago (96 hrs)
      const lastClaimed = new Date('2026-03-27T00:00:00Z'); // claimed 36 hrs ago
      const now = new Date('2026-03-28T12:00:00Z');

      const seat = {
        seatedAt: seatedAt.toISOString(),
        lastClaimedAt: lastClaimed.toISOString(),
      };

      // tenureHours = 108 => 1.2x multiplier
      // hoursSinceLastClaim = 36, capped at 36 (under 168)
      // floor(0.5 * 1.2 * 36) = floor(21.6) = 21
      expect(sanctumService.calculateSeatEarnings(seat, now)).toBe(21);
    });

    it('should cap accumulation at 168 hours', () => {
      const seatedAt = new Date('2026-03-01T00:00:00Z'); // seated long ago (648 hrs)
      const lastClaimed = new Date('2026-03-01T00:00:00Z'); // never re-claimed
      const now = new Date('2026-03-28T00:00:00Z'); // 648 hours later

      const seat = {
        seatedAt: seatedAt.toISOString(),
        lastClaimedAt: lastClaimed.toISOString(),
      };

      // tenureHours = 648 => 1.4x (>=336, <720)
      // hoursSinceLastClaim = 648, capped at 168
      // floor(0.5 * 1.4 * 168) = floor(117.6) = 117
      expect(sanctumService.calculateSeatEarnings(seat, now)).toBe(117);
    });

    it('should floor the result to an integer', () => {
      // 10 hours since claim, tenure < 24hrs => 1.0x
      const now = new Date('2026-03-28T10:00:00Z');
      const seatedAt = new Date('2026-03-28T00:00:00Z');
      const lastClaimed = new Date('2026-03-28T00:00:00Z');

      const seat = {
        seatedAt: seatedAt.toISOString(),
        lastClaimedAt: lastClaimed.toISOString(),
      };

      // floor(0.5 * 1.0 * 10) = floor(5.0) = 5
      expect(sanctumService.calculateSeatEarnings(seat, now)).toBe(5);
    });

    // Phase 2 trait effects (Shy / Loyal)
    it('Shy seatEarnRateMultiplier ×1.05 raises earnings', () => {
      // 100 hours since claim, tenure 100 hrs → 1.2x
      const now = new Date('2026-03-28T12:00:00Z');
      const seatedAt = new Date('2026-03-24T08:00:00Z'); // ~100h ago
      const lastClaimed = new Date('2026-03-24T08:00:00Z');
      const seat = { seatedAt: seatedAt.toISOString(), lastClaimedAt: lastClaimed.toISOString() };
      const baseline = sanctumService.calculateSeatEarnings(seat, now);
      const boosted = sanctumService.calculateSeatEarnings(seat, now, {
        seatEarnRateMultiplier: 1.05,
        tenureBonusMultiplier: 1,
      });
      expect(boosted).toBeGreaterThan(baseline);
    });

    it('Loyal tenureBonusMultiplier ×1.05 raises earnings', () => {
      const now = new Date('2026-03-28T12:00:00Z');
      const seatedAt = new Date('2026-03-24T08:00:00Z'); // ~100h ago
      const lastClaimed = new Date('2026-03-24T08:00:00Z');
      const seat = { seatedAt: seatedAt.toISOString(), lastClaimedAt: lastClaimed.toISOString() };
      const baseline = sanctumService.calculateSeatEarnings(seat, now);
      const boosted = sanctumService.calculateSeatEarnings(seat, now, {
        seatEarnRateMultiplier: 1,
        tenureBonusMultiplier: 1.05,
      });
      expect(boosted).toBeGreaterThan(baseline);
    });

    it('null/undefined bonuses → behaves like baseline (identity)', () => {
      const now = new Date('2026-03-28T12:00:00Z');
      const seatedAt = new Date('2026-03-24T08:00:00Z');
      const lastClaimed = new Date('2026-03-24T08:00:00Z');
      const seat = { seatedAt: seatedAt.toISOString(), lastClaimedAt: lastClaimed.toISOString() };
      expect(sanctumService.calculateSeatEarnings(seat, now, null)).toBe(
        sanctumService.calculateSeatEarnings(seat, now),
      );
    });
  });

  // ===========================================================================
  // seatTotem - validation
  // ===========================================================================

  describe('seatTotem - validation', () => {
    it('should reject when totem is not found', async () => {
      dbClient.getTotem.mockResolvedValue(null);

      const result = await sanctumService.seatTotem(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('should reject when totem is below Stage 4 (under 3500 XP)', async () => {
      dbClient.getTotem.mockResolvedValue({ experience: 2000, species: 'fox' });

      const result = await sanctumService.seatTotem(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_ASCENDED');
    });

    it('should reject when totem is already seated', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        sanctum: { seated: true, seatIndex: 0 },
      });

      const result = await sanctumService.seatTotem(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ALREADY_SEATED');
    });

    it('should reject when totem is on an expedition', async () => {
      dbClient.getTotem.mockResolvedValue({ experience: 8000, species: 'fox' });
      dbClient.getItem.mockResolvedValue({ pk: 'USER#usr_test123', sk: `EXPEDITION#ACTIVE#${testTotemId}` });

      const result = await sanctumService.seatTotem(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ON_EXPEDITION');
    });

    it('should reject when user has no Stage 4 totems (maxSeats=0)', async () => {
      dbClient.getTotem.mockResolvedValue({ experience: 8000, species: 'fox' });
      dbClient.getItem.mockResolvedValue(null); // no expedition
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });
      dbClient.getUserTotems.mockResolvedValue([]); // no totems at all

      const result = await sanctumService.seatTotem(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_STAGE4_TOTEMS');
    });

    it('should reject when all seats are occupied', async () => {
      dbClient.getTotem.mockResolvedValue({ experience: 8000, species: 'fox' });
      dbClient.getItem.mockResolvedValue(null); // no expedition
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });
      // Only 1 stage4 totem => maxSeats = 1
      dbClient.getUserTotems.mockResolvedValue([{ experience: 8000 }]);
      // Seat 0 already occupied by a different totem
      dbClient.queryItems.mockResolvedValue([{ seatIndex: 0, totemId: 'ttm_other' }]);

      const result = await sanctumService.seatTotem(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NO_AVAILABLE_SEAT');
    });
  });

  // ===========================================================================
  // seatTotem - success
  // ===========================================================================

  describe('seatTotem - success', () => {
    it('should seat a totem successfully and return sanctum state', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        name: 'Foxy',
        rarity: 'Rare',
      });
      dbClient.getItem.mockResolvedValue(null); // no expedition
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 }, subscription: { tier: 0 } });
      dbClient.getUserTotems.mockResolvedValue([{ experience: 8000 }]); // 1 stage4 => 1 seat
      dbClient.queryItems
        .mockResolvedValueOnce([]) // no existing seats (for seatTotem)
        .mockResolvedValueOnce([]); // getSanctum query after seat
      dbClient.putItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});

      const result = await sanctumService.seatTotem(testUserId, testTotemId);
      expect(result.success).toBe(true);
      expect(dbClient.putItem).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        expect.objectContaining({
          pk: `SANCTUM#${testUserId}`,
          sk: 'SEAT#0',
          totemId: testTotemId,
          seatIndex: 0,
          onMission: false,
        }),
      );
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        expect.objectContaining({
          sanctum: expect.objectContaining({
            seated: true,
            seatIndex: 0,
            onMission: false,
          }),
        }),
      );
    });

    it('should auto-assign to seat index 1 when seat 0 is taken', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        name: 'Foxy',
        rarity: 'Rare',
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 }, subscription: { tier: 1 } });
      // 3 stage4 totems + tier 1 => 2 seats
      dbClient.getUserTotems.mockResolvedValue([
        { experience: 8000 },
        { experience: 9000 },
        { experience: 10000 },
      ]);
      dbClient.queryItems
        .mockResolvedValueOnce([{ seatIndex: 0, totemId: 'ttm_other' }]) // seat 0 occupied
        .mockResolvedValueOnce([]); // getSanctum query
      dbClient.putItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});

      const result = await sanctumService.seatTotem(testUserId, testTotemId);
      expect(result.success).toBe(true);
      expect(dbClient.putItem).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        expect.objectContaining({
          sk: 'SEAT#1',
          seatIndex: 1,
        }),
      );
    });
  });

  // ===========================================================================
  // unseatTotem
  // ===========================================================================

  describe('unseatTotem', () => {
    it('should reject when totem is not seated', async () => {
      dbClient.getTotem.mockResolvedValue({ experience: 8000, species: 'fox' });

      const result = await sanctumService.unseatTotem(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_SEATED');
    });

    it('should reject when totem is on a council mission', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        sanctum: { seated: true, seatIndex: 0, onMission: true },
      });

      const result = await sanctumService.unseatTotem(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ON_MISSION');
    });

    it('should unseat successfully and clear sanctum field', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        sanctum: { seated: true, seatIndex: 1, onMission: false },
      });
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.queryItems.mockResolvedValue([]); // getSanctum returns empty after unseat
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });
      dbClient.getUserTotems.mockResolvedValue([{ experience: 8000 }]);

      const result = await sanctumService.unseatTotem(testUserId, testTotemId);
      expect(result.success).toBe(true);
      expect(dbClient.deleteItem).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        { pk: `SANCTUM#${testUserId}`, sk: 'SEAT#1' },
      );
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        { sanctum: null },
      );
    });

    it('should clear sanctum field on totem when unseating', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        sanctum: { seated: true, seatIndex: 2, onMission: false },
      });
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.queryItems.mockResolvedValue([]);
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });
      dbClient.getUserTotems.mockResolvedValue([{ experience: 8000 }]);

      await sanctumService.unseatTotem(testUserId, testTotemId);

      // Verify updateTotem is called with { sanctum: null } to fully clear the field
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        { sanctum: null },
      );
    });
  });

  // ===========================================================================
  // claimSanctum
  // ===========================================================================

  describe('claimSanctum', () => {
    it('should reject when no seats exist', async () => {
      dbClient.queryItems.mockResolvedValue([]);

      const result = await sanctumService.claimSanctum(testUserId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOTHING_TO_CLAIM');
    });

    it('should reject when earnings are less than 1 Essence', async () => {
      const now = new Date();
      // Just seated 1 minute ago => earnings = floor(0.5 * 1.0 * (1/60)) = 0
      dbClient.queryItems.mockResolvedValue([{
        seatIndex: 0,
        totemId: testTotemId,
        totemName: 'Foxy',
        seatedAt: now.toISOString(),
        lastClaimedAt: now.toISOString(),
      }]);

      const result = await sanctumService.claimSanctum(testUserId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOTHING_TO_CLAIM');
    });

    it('should compute correct amounts and use transactWrite', async () => {
      const seatedAt = new Date('2026-03-20T00:00:00Z');
      const lastClaimed = new Date('2026-03-27T00:00:00Z');

      dbClient.queryItems.mockResolvedValue([{
        seatIndex: 0,
        totemId: testTotemId,
        totemName: 'Foxy',
        seatedAt: seatedAt.toISOString(),
        lastClaimedAt: lastClaimed.toISOString(),
      }]);
      dbClient.transactWrite.mockResolvedValue({});
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 500 } });

      const result = await sanctumService.claimSanctum(testUserId);
      expect(result.success).toBe(true);
      expect(result.data.totalClaimed).toBeGreaterThanOrEqual(1);
      expect(dbClient.transactWrite).toHaveBeenCalledTimes(1);

      // Verify transactWrite includes user Essence update + seat lastClaimedAt update
      const transactItems = dbClient.transactWrite.mock.calls[0][0];
      expect(transactItems).toHaveLength(2); // 1 user update + 1 seat update
      expect(transactItems[0].Update.TableName).toBe('TotemBound-Users');
      expect(transactItems[1].Update.TableName).toBe('TotemBound-ExpeditionState');
    });

    it('should log the Essence credit to the ledger (chain reconciliation)', async () => {
      // Regression: claimSanctum used to credit Essence via transactWrite without
      // calling logTransaction, leaving a hole in the per-user ledger chain.
      const seatedAt = new Date('2026-03-20T00:00:00Z');
      const lastClaimed = new Date('2026-03-27T00:00:00Z');

      dbClient.queryItems.mockResolvedValue([{
        seatIndex: 0,
        totemId: testTotemId,
        totemName: 'Foxy',
        seatedAt: seatedAt.toISOString(),
        lastClaimedAt: lastClaimed.toISOString(),
      }]);
      dbClient.transactWrite.mockResolvedValue({});
      // Post-credit balance returned by getUser; the log row's balanceBefore
      // should equal balanceAfter - amount so chain queries stitch through.
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 500 } });

      const result = await sanctumService.claimSanctum(testUserId);
      expect(result.success).toBe(true);
      const totalClaimed = result.data.totalClaimed;

      expect(dbClient.logTransaction).toHaveBeenCalledWith(testUserId, expect.objectContaining({
        type: 'reward_sanctum',
        currency: 'essence',
        amount: totalClaimed,
        balanceBefore: 500 - totalClaimed,
        balanceAfter: 500,
        refType: 'sanctum',
        refName: expect.stringContaining('Sanctum Claim'),
      }));
    });

    it('should update all lastClaimedAt for multiple seats', async () => {
      const seatedAt = new Date('2026-03-20T00:00:00Z');
      const lastClaimed = new Date('2026-03-27T00:00:00Z');

      dbClient.queryItems.mockResolvedValue([
        {
          seatIndex: 0,
          totemId: 'ttm_a',
          totemName: 'Alpha',
          seatedAt: seatedAt.toISOString(),
          lastClaimedAt: lastClaimed.toISOString(),
        },
        {
          seatIndex: 1,
          totemId: 'ttm_b',
          totemName: 'Beta',
          seatedAt: seatedAt.toISOString(),
          lastClaimedAt: lastClaimed.toISOString(),
        },
      ]);
      dbClient.transactWrite.mockResolvedValue({});
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 500 } });

      const result = await sanctumService.claimSanctum(testUserId);
      expect(result.success).toBe(true);

      // 1 user update + 2 seat updates = 3 items
      const transactItems = dbClient.transactWrite.mock.calls[0][0];
      expect(transactItems).toHaveLength(3);
    });
  });

  // ===========================================================================
  // startCouncilMission - validation
  // ===========================================================================

  describe('startCouncilMission - validation', () => {
    it('should reject invalid mission type', async () => {
      const result = await sanctumService.startCouncilMission(testUserId, testTotemId, 'cm_nonexistent');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_MISSION');
    });

    it('should reject when totem is not seated', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        happiness: 50,
      });

      const result = await sanctumService.startCouncilMission(testUserId, testTotemId, 'cm_decree-of-wisdom');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_SEATED');
    });

    it('should reject when totem stage is too low for diplomacy/legacy missions', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 5000,
        stage: 3, // Adult (UI Stage 4) — not Ascended
        species: 'fox',
        happiness: 50,
        sanctum: { seated: true, seatIndex: 0, onMission: false },
      });

      const result = await sanctumService.startCouncilMission(testUserId, testTotemId, 'cm_peace-summit');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_STAGE');
    });

    it('should allow governance missions for Stage 4 (Adult) totems', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 5000,
        stage: 3, // Adult (UI Stage 4)
        species: 'fox',
        stats: { happiness: 50 },
        sanctum: { seated: true, seatIndex: 0, onMission: false },
      });
      dbClient.getItem.mockResolvedValue(null); // no active mission
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });
      dbClient.deductEssence.mockResolvedValue({ success: true, newBalance: 990 });
      dbClient.putItem.mockResolvedValue();
      dbClient.updateTotem.mockResolvedValue();

      const result = await sanctumService.startCouncilMission(testUserId, testTotemId, 'cm_decree-of-wisdom');
      // Should NOT fail with INSUFFICIENT_STAGE — governance only needs stage 3
      expect(result.error?.code).not.toBe('INSUFFICIENT_STAGE');
    });

    it('should reject when totem is already on a mission', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        stage: 4,
        species: 'fox',
        happiness: 50,
        sanctum: { seated: true, seatIndex: 0, onMission: false },
      });
      dbClient.getItem.mockResolvedValue({
        pk: `SANCTUM#${testUserId}`,
        sk: `MISSION#ACTIVE#${testTotemId}`,
        status: 'in_progress',
      });

      const result = await sanctumService.startCouncilMission(testUserId, testTotemId, 'cm_decree-of-wisdom');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('ALREADY_ON_MISSION');
    });

    it('should start even with zero Essence (missions cost happiness + time only)', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        stage: 4,
        species: 'fox',
        happiness: 50,
        sanctum: { seated: true, seatIndex: 0, onMission: false },
      });
      dbClient.getItem.mockResolvedValue(null); // no active mission
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 0 } }); // broke, but missions are free
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.putItem.mockResolvedValue({});

      const result = await sanctumService.startCouncilMission(testUserId, testTotemId, 'cm_decree-of-wisdom');
      expect(result.success).toBe(true);
      expect(dbClient.deductEssence).not.toHaveBeenCalled();
    });

    it('should reject when totem has insufficient happiness', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        stage: 4,
        species: 'fox',
        happiness: 2, // need 5 for Decree of Wisdom
        sanctum: { seated: true, seatIndex: 0, onMission: false },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });

      const result = await sanctumService.startCouncilMission(testUserId, testTotemId, 'cm_decree-of-wisdom');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INSUFFICIENT_HAPPINESS');
    });
  });

  // ===========================================================================
  // startCouncilMission - success
  // ===========================================================================

  describe('startCouncilMission - success', () => {
    it('should create mission record and deduct happiness only (no Essence)', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        stage: 4,
        species: 'fox',
        happiness: 50,
        sanctum: { seated: true, seatIndex: 0, onMission: false },
      });
      dbClient.getItem.mockResolvedValue(null); // no active mission
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.putItem.mockResolvedValue({});

      const result = await sanctumService.startCouncilMission(
        testUserId,
        testTotemId,
        'cm_decree-of-wisdom',
      );

      expect(result.success).toBe(true);
      expect(result.data.mission.missionType).toBe('cm_decree-of-wisdom');
      expect(result.data.mission.name).toBe('Decree of Wisdom');
      expect(dbClient.deductEssence).not.toHaveBeenCalled();

      // Verify happiness deduction (50 - 5 = 45)
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        { 'stats.happiness': 45 },
      );

      // Verify mission record creation
      expect(dbClient.putItem).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        expect.objectContaining({
          pk: `SANCTUM#${testUserId}`,
          sk: `MISSION#ACTIVE#${testTotemId}`,
          totemId: testTotemId,
          missionType: 'cm_decree-of-wisdom',
          status: 'in_progress',
          claimed: false,
        }),
      );
    });

    it('should set missionEndsAt on totem when starting mission', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        stage: 4,
        species: 'fox',
        happiness: 50,
        sanctum: { seated: true, seatIndex: 0, onMission: false },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });
      dbClient.deductEssence.mockResolvedValue({ success: true, newBalance: 990 });
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.putItem.mockResolvedValue({});

      const result = await sanctumService.startCouncilMission(
        testUserId,
        testTotemId,
        'cm_decree-of-wisdom',
      );

      expect(result.success).toBe(true);

      // Verify updateTotem was called with sanctum containing missionEndsAt
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        {
          sanctum: expect.objectContaining({
            onMission: true,
            missionEndsAt: expect.any(String),
          }),
        },
      );
    });

    it('should set endsAt based on mission duration', async () => {
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        stage: 4,
        species: 'fox',
        happiness: 50,
        sanctum: { seated: true, seatIndex: 0, onMission: false },
      });
      dbClient.getItem.mockResolvedValue(null);
      dbClient.getUser.mockResolvedValue({ currencies: { essence: 1000 } });
      dbClient.deductEssence.mockResolvedValue({ success: true, newBalance: 955 });
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.putItem.mockResolvedValue({});

      const result = await sanctumService.startCouncilMission(
        testUserId,
        testTotemId,
        'cm_peace-summit',
      );

      expect(result.success).toBe(true);
      expect(result.data.mission.duration).toBe(21600); // 6 hours

      // Verify endsAt is ~6 hours from now
      const startedAt = new Date(result.data.mission.startedAt).getTime();
      const endsAt = new Date(result.data.mission.endsAt).getTime();
      expect(endsAt - startedAt).toBe(21600 * 1000);
    });
  });

  // ===========================================================================
  // claimCouncilMission
  // ===========================================================================

  describe('claimCouncilMission', () => {
    it('should reject when no active mission exists', async () => {
      dbClient.getItem.mockResolvedValue(null);

      const result = await sanctumService.claimCouncilMission(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSION_NOT_FOUND');
    });

    it('should reject when mission is not yet complete', async () => {
      const futureEndsAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      dbClient.getItem.mockResolvedValue({
        pk: `SANCTUM#${testUserId}`,
        sk: `MISSION#ACTIVE#${testTotemId}`,
        totemId: testTotemId,
        missionType: 'cm_decree-of-wisdom',
        endsAt: futureEndsAt,
        status: 'in_progress',
      });

      const result = await sanctumService.claimCouncilMission(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSION_NOT_COMPLETE');
    });

    it('should award XP and rune drops when mission is complete', async () => {
      const pastEndsAt = new Date(Date.now() - 1000).toISOString(); // ended 1 second ago
      dbClient.getItem.mockResolvedValue({
        pk: `SANCTUM#${testUserId}`,
        sk: `MISSION#ACTIVE#${testTotemId}`,
        totemId: testTotemId,
        missionType: 'cm_decree-of-wisdom',
        endsAt: pastEndsAt,
        status: 'in_progress',
      });
      dbClient.getTotem.mockResolvedValue({
        id: testTotemId,
        experience: 8000,
        species: 'fox',
        sanctum: { seated: true, seatIndex: 0, onMission: true },
      });
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.addRunes.mockResolvedValue({
        success: true,
        newBalances: { lesser: 5, greater: 2, ancient: 0 },
      });
      dbClient.deleteItem.mockResolvedValue({});

      const result = await sanctumService.claimCouncilMission(testUserId, testTotemId);

      expect(result.success).toBe(true);
      expect(result.data.rewards.xp).toBe(20); // Decree of Wisdom XP
      expect(result.data.rewards.runesEarned).toBeDefined();

      // Verify XP was added to totem (8000 + 20)
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        { experience: 8020 },
      );

      // Verify mission record was deleted
      expect(dbClient.deleteItem).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        {
          pk: `SANCTUM#${testUserId}`,
          sk: `MISSION#ACTIVE#${testTotemId}`,
        },
      );

      // Verify onMission flag cleared
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        { sanctum: expect.objectContaining({ onMission: false }) },
      );
    });

    it('should clear onMission and missionEndsAt on totem when claiming', async () => {
      const pastEndsAt = new Date(Date.now() - 5000).toISOString();
      dbClient.getItem.mockResolvedValue({
        pk: `SANCTUM#${testUserId}`,
        sk: `MISSION#ACTIVE#${testTotemId}`,
        totemId: testTotemId,
        missionType: 'cm_territorial-survey',
        endsAt: pastEndsAt,
        status: 'in_progress',
      });
      dbClient.getTotem.mockResolvedValue({
        id: testTotemId,
        experience: 9000,
        species: 'wolf',
        sanctum: { seated: true, seatIndex: 1, onMission: true, missionEndsAt: pastEndsAt },
      });
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.addRunes.mockResolvedValue({
        success: true,
        newBalances: { lesser: 0, greater: 0, ancient: 0 },
      });
      dbClient.deleteItem.mockResolvedValue({});

      const result = await sanctumService.claimCouncilMission(testUserId, testTotemId);
      expect(result.success).toBe(true);

      // Verify updateTotem clears both onMission and missionEndsAt
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        {
          sanctum: expect.objectContaining({
            onMission: false,
            missionEndsAt: null,
          }),
        },
      );
    });
  });

  // ===========================================================================
  // claimCouncilMission - rune balance shape (regression for fix/mission-runes #146)
  //
  // The frontend (GameContext.claimCouncilMission) reads
  // response.data.newRuneBalances and feeds it directly into setRuneBalances.
  // It MUST be either:
  //   - the unwrapped balances object: { lesser, greater, ancient }
  //   - null (when no runes dropped)
  //
  // Previously sanctum-service assigned the addRunes() wrapper
  // ({ success, newBalances }) to newRuneBalances. The frontend then read
  // .lesser/.greater/.ancient (undefined) and reset all rune balances to 0
  // until reload. These tests lock in the correct shape.
  // ===========================================================================

  describe('claimCouncilMission - rune balance shape', () => {
    const pastEndsAt = new Date(Date.now() - 1000).toISOString();

    function mockReadyMission(missionType = 'cm_decree-of-wisdom') {
      dbClient.getItem.mockResolvedValue({
        pk: `SANCTUM#${testUserId}`,
        sk: `MISSION#ACTIVE#${testTotemId}`,
        totemId: testTotemId,
        missionType,
        endsAt: pastEndsAt,
        status: 'in_progress',
      });
      dbClient.getTotem.mockResolvedValue({
        id: testTotemId,
        experience: 8000,
        species: 'fox',
        sanctum: { seated: true, seatIndex: 0, onMission: true },
      });
      dbClient.updateTotem.mockResolvedValue({});
      dbClient.deleteItem.mockResolvedValue({});
    }

    afterEach(() => {
      if (Math.random.mockRestore) Math.random.mockRestore();
    });

    it('should return unwrapped { lesser, greater, ancient } when runes drop', async () => {
      mockReadyMission('cm_founding-ritual'); // greater: 75, ancient: 20
      jest.spyOn(Math, 'random').mockReturnValue(0.01); // force every drop
      dbClient.addRunes.mockResolvedValue({
        success: true,
        newBalances: { lesser: 12, greater: 4, ancient: 1 },
      });

      const result = await sanctumService.claimCouncilMission(testUserId, testTotemId);

      expect(result.success).toBe(true);
      expect(result.data.newRuneBalances).toEqual({ lesser: 12, greater: 4, ancient: 1 });
    });

    it('should NOT leak the addRunes wrapper into newRuneBalances', async () => {
      mockReadyMission('cm_decree-of-wisdom'); // lesser: 50
      jest.spyOn(Math, 'random').mockReturnValue(0.01); // force drop
      dbClient.addRunes.mockResolvedValue({
        success: true,
        newBalances: { lesser: 7, greater: 0, ancient: 0 },
      });

      const result = await sanctumService.claimCouncilMission(testUserId, testTotemId);

      // Regression guard: response must be the unwrapped balances, never the
      // { success, newBalances } envelope that addRunes returns internally.
      expect(result.data.newRuneBalances).not.toHaveProperty('success');
      expect(result.data.newRuneBalances).not.toHaveProperty('newBalances');
      expect(result.data.newRuneBalances).toHaveProperty('lesser');
      expect(result.data.newRuneBalances).toHaveProperty('greater');
      expect(result.data.newRuneBalances).toHaveProperty('ancient');
    });

    it('should return null newRuneBalances when no runes drop', async () => {
      mockReadyMission('cm_decree-of-wisdom'); // lesser: 50
      jest.spyOn(Math, 'random').mockReturnValue(0.99); // force no drop

      const result = await sanctumService.claimCouncilMission(testUserId, testTotemId);

      expect(result.success).toBe(true);
      expect(result.data.newRuneBalances).toBeNull();
      expect(result.data.rewards.runesEarned).toEqual({ lesser: 0, greater: 0, ancient: 0 });
      expect(dbClient.addRunes).not.toHaveBeenCalled();
    });

    it('should call addRunes with the rolled drop counts', async () => {
      mockReadyMission('cm_peace-summit'); // greater: 50
      jest.spyOn(Math, 'random').mockReturnValue(0.01); // force drop
      dbClient.addRunes.mockResolvedValue({
        success: true,
        newBalances: { lesser: 0, greater: 1, ancient: 0 },
      });

      await sanctumService.claimCouncilMission(testUserId, testTotemId);

      expect(dbClient.addRunes).toHaveBeenCalledWith(
        testUserId,
        { lesser: 0, greater: 1, ancient: 0 },
        expect.objectContaining({ type: 'council_mission_claim' }),
      );
    });

    it('should leave newRuneBalances null if addRunes fails', async () => {
      mockReadyMission('cm_decree-of-wisdom');
      jest.spyOn(Math, 'random').mockReturnValue(0.01); // force drop attempt
      dbClient.addRunes.mockResolvedValue({ success: false, error: 'User not found' });

      const result = await sanctumService.claimCouncilMission(testUserId, testTotemId);

      expect(result.success).toBe(true);
      expect(result.data.newRuneBalances).toBeNull();
    });
  });

  // ===========================================================================
  // cancelCouncilMission
  // ===========================================================================

  describe('cancelCouncilMission', () => {
    it('should reject when no active mission exists', async () => {
      dbClient.getItem.mockResolvedValue(null);

      const result = await sanctumService.cancelCouncilMission(testUserId, testTotemId);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSION_NOT_FOUND');
    });

    it('should cancel successfully without giving rewards', async () => {
      dbClient.getItem.mockResolvedValue({
        pk: `SANCTUM#${testUserId}`,
        sk: `MISSION#ACTIVE#${testTotemId}`,
        totemId: testTotemId,
        missionType: 'cm_peace-summit',
        status: 'in_progress',
      });
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        sanctum: { seated: true, seatIndex: 0, onMission: true },
      });
      dbClient.updateTotem.mockResolvedValue({});

      const result = await sanctumService.cancelCouncilMission(testUserId, testTotemId);

      expect(result.success).toBe(true);
      expect(result.data.cancelled).toBe(true);
      expect(result.data.missionType).toBe('cm_peace-summit');

      // Verify no Essence was added
      expect(dbClient.addEssence).not.toHaveBeenCalled();

      // Verify mission record was deleted
      expect(dbClient.deleteItem).toHaveBeenCalledWith(
        'TotemBound-ExpeditionState',
        {
          pk: `SANCTUM#${testUserId}`,
          sk: `MISSION#ACTIVE#${testTotemId}`,
        },
      );

      // Verify onMission flag cleared
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        { sanctum: expect.objectContaining({ onMission: false }) },
      );
    });

    it('should clear onMission and missionEndsAt on totem when cancelling', async () => {
      dbClient.getItem.mockResolvedValue({
        pk: `SANCTUM#${testUserId}`,
        sk: `MISSION#ACTIVE#${testTotemId}`,
        totemId: testTotemId,
        missionType: 'cm_territorial-survey',
        status: 'in_progress',
      });
      dbClient.deleteItem.mockResolvedValue({});
      dbClient.getTotem.mockResolvedValue({
        experience: 8000,
        species: 'fox',
        sanctum: { seated: true, seatIndex: 0, onMission: true, missionEndsAt: '2026-03-29T00:00:00Z' },
      });
      dbClient.updateTotem.mockResolvedValue({});

      const result = await sanctumService.cancelCouncilMission(testUserId, testTotemId);
      expect(result.success).toBe(true);

      // Verify updateTotem clears both onMission and missionEndsAt
      expect(dbClient.updateTotem).toHaveBeenCalledWith(
        testUserId,
        testTotemId,
        {
          sanctum: expect.objectContaining({
            onMission: false,
            missionEndsAt: null,
          }),
        },
      );
    });
  });

  // ===========================================================================
  // getCouncilMissions
  // ===========================================================================

  describe('getCouncilMissions', () => {
    it('should return missions grouped by tier', () => {
      const grouped = sanctumService.getCouncilMissions();
      expect(grouped.governance).toHaveLength(3);
      expect(grouped.diplomacy).toHaveLength(3);
      expect(grouped.legacy).toHaveLength(3);
    });

    it('should include correct mission IDs per tier', () => {
      const grouped = sanctumService.getCouncilMissions();
      const govIds = grouped.governance.map(m => m.id);
      expect(govIds).toContain('cm_decree-of-wisdom');
      expect(govIds).toContain('cm_territorial-survey');
      expect(govIds).toContain('cm_spirit-audience');

      const dipIds = grouped.diplomacy.map(m => m.id);
      expect(dipIds).toContain('cm_peace-summit');
      expect(dipIds).toContain('cm_alliance-forging');
      expect(dipIds).toContain('cm_elder-exchange');

      const legIds = grouped.legacy.map(m => m.id);
      expect(legIds).toContain('cm_rite-of-passage');
      expect(legIds).toContain('cm_ancient-convocation');
      expect(legIds).toContain('cm_founding-ritual');
    });
  });

  // ===========================================================================
  // COUNCIL_MISSIONS constant
  // ===========================================================================

  describe('COUNCIL_MISSIONS constant', () => {
    it('should have 9 missions defined', () => {
      expect(Object.keys(sanctumService.COUNCIL_MISSIONS)).toHaveLength(9);
    });

    it('should have increasing happiness costs by tier', () => {
      const missions = sanctumService.COUNCIL_MISSIONS;
      // Governance < Diplomacy < Legacy
      expect(missions['cm_decree-of-wisdom'].cost.happiness).toBeLessThan(
        missions['cm_peace-summit'].cost.happiness,
      );
      expect(missions['cm_peace-summit'].cost.happiness).toBeLessThan(
        missions['cm_rite-of-passage'].cost.happiness,
      );
    });

    it('should not charge Essence for any mission', () => {
      const missions = sanctumService.COUNCIL_MISSIONS;
      for (const mission of Object.values(missions)) {
        expect(mission.cost.essence).toBeUndefined();
      }
    });

    it('should progress monotonically by duration (no dominated missions)', () => {
      // Ordered by duration, longer missions must never cost less happiness or grant
      // less XP than a shorter one — otherwise the shorter one is strictly dominated.
      const ordered = Object.values(sanctumService.COUNCIL_MISSIONS)
        .sort((a, b) => a.duration - b.duration);

      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const cur = ordered[i];
        expect(cur.duration).toBeGreaterThan(prev.duration);
        expect(cur.cost.happiness).toBeGreaterThanOrEqual(prev.cost.happiness);
        expect(cur.rewards.xp).toBeGreaterThanOrEqual(prev.rewards.xp);
      }
    });

    it('should ramp rune odds within each tier as duration grows', () => {
      const byTier = (tier) => Object.values(sanctumService.COUNCIL_MISSIONS)
        .filter((m) => m.tier === tier)
        .sort((a, b) => a.duration - b.duration);

      // Governance ramps Lesser, Diplomacy ramps Greater across their durations.
      const govLesser = byTier('governance').map((m) => m.rewards.runes.lesser);
      const dipGreater = byTier('diplomacy').map((m) => m.rewards.runes.greater);
      for (let i = 1; i < govLesser.length; i++) {
        expect(govLesser[i]).toBeGreaterThanOrEqual(govLesser[i - 1]);
      }
      for (let i = 1; i < dipGreater.length; i++) {
        expect(dipGreater[i]).toBeGreaterThanOrEqual(dipGreater[i - 1]);
      }
    });
  });
});
