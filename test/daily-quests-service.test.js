/**
 * Daily Quests Service Tests
 *
 * Covers theme math, slot selection, progress increments via action hooks,
 * batch claim transactions, and the UTC-day skip-fast.
 */

jest.mock('../src/common/db-client', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  rawUpdate: jest.fn(),
  updateUser: jest.fn(),
  addEssence: jest.fn(),
  addRunes: jest.fn(),
  getUserTotems: jest.fn(),
  getUser: jest.fn(),
  TABLES: { REWARD_STATE: 'TotemBound-RewardState', USERS: 'TotemBound-Users' },
  userPK: (id) => `USER#${id}`,
}));

jest.mock('../src/services/achievements-service', () => ({
  onQuestSetClaimed: jest.fn().mockResolvedValue([]),
  onQuestThemedClaimed: jest.fn().mockResolvedValue([]),
}));

const svc = require('../src/services/daily-quests-service');
const db = require('../src/common/db-client');
const ach = require('../src/services/achievements-service');

const USER_ID = 'usr_test_quests';

describe('Daily Quests Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    svc._resetCatalogCacheForTests();
  });

  // =============================================================================
  // THEME MATH
  // =============================================================================

  describe('computeDayOfYear', () => {
    it('returns 1 for January 1', () => {
      expect(svc.computeDayOfYear(new Date('2026-01-01T00:00:00Z'))).toBe(1);
    });

    it('returns 136 for May 16, 2026 (non-leap)', () => {
      expect(svc.computeDayOfYear(new Date('2026-05-16T12:00:00Z'))).toBe(136);
    });

    it('handles leap-year February 29 correctly', () => {
      expect(svc.computeDayOfYear(new Date('2028-02-29T00:00:00Z'))).toBe(60);
    });
  });

  describe('getDailyTheme', () => {
    it('returns wisdom/water/treat for 2026-05-16 (plan smoke test)', () => {
      const t = svc.getDailyTheme(new Date('2026-05-16T12:00:00Z'));
      expect(t).toEqual({ affinity: 'wisdom', domain: 'water', action: 'treat' });
    });

    it('rolls to strength/air/feed the next day', () => {
      const t = svc.getDailyTheme(new Date('2026-05-17T12:00:00Z'));
      expect(t).toEqual({ affinity: 'strength', domain: 'air', action: 'feed' });
    });

    it('cycles every 3 days', () => {
      const a = svc.getDailyTheme(new Date('2026-05-16T12:00:00Z'));
      const b = svc.getDailyTheme(new Date('2026-05-19T12:00:00Z'));
      expect(a).toEqual(b);
    });
  });

  describe('getTodayUTCDateString', () => {
    it('returns YYYY-MM-DD in UTC', () => {
      expect(svc.getTodayUTCDateString(new Date('2026-05-16T23:59:00Z'))).toBe('2026-05-16');
    });
  });

  describe('getNextUTCMidnight', () => {
    it('returns next UTC midnight as ISO', () => {
      const next = svc.getNextUTCMidnight(new Date('2026-05-16T08:00:00Z'));
      expect(next).toBe('2026-05-17T00:00:00.000Z');
    });
  });

  // =============================================================================
  // SELECTION ALGORITHM
  // =============================================================================

  describe('generateDailyQuestSet', () => {
    const theme = { affinity: 'wisdom', domain: 'water', action: 'treat' };
    const baseCaps = svc.getPlayerCapabilities({});

    it('returns 5 quests in slot order 1..5', () => {
      const set = svc.generateDailyQuestSet({ theme, playerCaps: baseCaps, rng: () => 0 });
      expect(set).toHaveLength(5);
      expect(set.map(q => q.slot)).toEqual([1, 2, 3, 4, 5]);
    });

    it('slot 1 deterministically matches theme.action', () => {
      const set = svc.generateDailyQuestSet({ theme, playerCaps: baseCaps, rng: () => 0 });
      expect(set[0].id).toBe('dq_treat_2');
    });

    it('slot 3 deterministically matches theme.affinity', () => {
      const set = svc.generateDailyQuestSet({ theme, playerCaps: baseCaps, rng: () => 0 });
      expect(set[2].id).toBe('dq_challenge_wisdom');
    });

    it('slot 4 quests are domain-matched (water)', () => {
      const set = svc.generateDailyQuestSet({ theme, playerCaps: baseCaps, rng: () => 0 });
      expect(['dq_expedition_start_water', 'dq_expedition_claim_water']).toContain(set[3].id);
    });

    it('rng=0 picks first hard candidate in slot 5', () => {
      const set = svc.generateDailyQuestSet({ theme, playerCaps: baseCaps, rng: () => 0 });
      expect(set[4].tier).toBe('hard');
    });

    it('excludes yesterdayIds from slot 2 and slot 5', () => {
      // Run twice with rng forced to 0 to get deterministic first pick, then
      // exclude that pick and verify a different one is selected.
      const first = svc.generateDailyQuestSet({ theme, playerCaps: baseCaps, rng: () => 0 });
      const yesterdayIds = [first[1].id, first[4].id];
      const second = svc.generateDailyQuestSet({ theme, playerCaps: baseCaps, yesterdayIds, rng: () => 0 });
      expect(second[1].id).not.toBe(first[1].id);
      expect(second[4].id).not.toBe(first[4].id);
    });

    it('returns a slot 5 hard quest for low-capability players (scope is actions/challenges/expeditions, no caps gates)', () => {
      const caps = svc.getPlayerCapabilities({ stats: { highestStage: 0 } });
      const set = svc.generateDailyQuestSet({ theme, playerCaps: caps, rng: () => 0 });
      expect(set[4]).toBeDefined();
      expect(set[4].tier).toBe('hard');
      // Catalog v1.1.0 has no caps-gated hard quests, so any of the 3 is valid.
      expect(['dq_expedition_24h', 'dq_expedition_claim_2', 'dq_challenge_3']).toContain(set[4].id);
    });
  });

  // =============================================================================
  // QUEST MATCHER
  // =============================================================================

  describe('questMatches', () => {
    it('matches trigger + empty filters', () => {
      const q = { id: 'dq_feed_3' };
      expect(svc.questMatches(q, 'ACTION_FEED', { totemId: 'ttm_x' })).toBe(true);
    });

    it('matches trigger + matching affinity filter', () => {
      const q = { id: 'dq_challenge_wisdom' };
      expect(svc.questMatches(q, 'CHALLENGE_COMPLETED', { affinity: 'wisdom' })).toBe(true);
    });

    it('returns false when filter value mismatches', () => {
      const q = { id: 'dq_challenge_wisdom' };
      expect(svc.questMatches(q, 'CHALLENGE_COMPLETED', { affinity: 'strength' })).toBe(false);
    });

    it('returns false when trigger mismatches', () => {
      const q = { id: 'dq_feed_3' };
      expect(svc.questMatches(q, 'ACTION_TRAIN', {})).toBe(false);
    });
  });

  // =============================================================================
  // SKIP-FAST
  // =============================================================================

  describe('shouldSkipQuestProgress', () => {
    it('returns true when lastQuestDate is stale', () => {
      expect(svc.shouldSkipQuestProgress({ lastQuestDate: '2026-05-15' }, '2026-05-16')).toBe(true);
    });

    it('returns false when lastQuestDate matches today', () => {
      expect(svc.shouldSkipQuestProgress({ lastQuestDate: '2026-05-16' }, '2026-05-16')).toBe(false);
    });

    it('returns true when user or todayUTC is missing', () => {
      expect(svc.shouldSkipQuestProgress(null, '2026-05-16')).toBe(true);
      expect(svc.shouldSkipQuestProgress({ lastQuestDate: '2026-05-16' }, null)).toBe(true);
    });
  });

  // =============================================================================
  // PERSISTENCE — generateAndPersist
  // =============================================================================

  describe('generateAndPersist', () => {
    it('writes a record with theme, quests array, bonus, and 48h TTL', async () => {
      db.getItem.mockResolvedValue(null);
      db.getUserTotems.mockResolvedValue([]);
      db.putItem.mockResolvedValue(undefined);
      db.updateUser.mockResolvedValue(undefined);

      const now = new Date('2026-05-16T12:00:00Z');
      const item = await svc.generateAndPersist(USER_ID, { stats: {} }, now);

      expect(db.putItem).toHaveBeenCalledTimes(1);
      expect(item.quests).toHaveLength(5);
      expect(item.theme).toEqual({ affinity: 'wisdom', domain: 'water', action: 'treat' });
      expect(item.bonus.reward.essence).toBe(75);
      expect(item.bonus.claimed).toBe(false);
      expect(item.ttl).toBe(Math.floor(now.getTime() / 1000) + 48 * 3600);
      expect(item.sk).toBe('QUEST#daily#2026-05-16');
    });

    it('updates the user record with lastQuestDate', async () => {
      db.getItem.mockResolvedValue(null);
      db.getUserTotems.mockResolvedValue([]);
      const now = new Date('2026-05-16T12:00:00Z');
      await svc.generateAndPersist(USER_ID, { stats: {} }, now);
      expect(db.updateUser).toHaveBeenCalledWith(USER_ID, { lastQuestDate: '2026-05-16' });
    });
  });

  // =============================================================================
  // PERSISTENCE — onQuestProgress (action-hook path)
  // =============================================================================

  describe('onQuestProgress', () => {
    const TODAY = '2026-05-16';
    const NOW = new Date(`${TODAY}T12:00:00Z`);

    it('skip-fasts when user.lastQuestDate is stale (zero DB calls)', async () => {
      const user = { lastQuestDate: '2026-05-15' };
      const result = await svc.onQuestProgress(USER_ID, user, 'ACTION_FEED', {}, NOW);
      expect(result).toEqual([]);
      expect(db.getItem).not.toHaveBeenCalled();
      expect(db.rawUpdate).not.toHaveBeenCalled();
    });

    it('increments matching slots and clamps at goal', async () => {
      const user = { lastQuestDate: TODAY };
      db.getItem.mockResolvedValue({
        date: TODAY,
        quests: [
          { slot: 1, id: 'dq_feed_3', progress: 2, goal: 3, claimed: false },
          { slot: 2, id: 'dq_train_diff_2', progress: 0, goal: 2, claimed: false },
        ],
      });
      const updates = await svc.onQuestProgress(USER_ID, user, 'ACTION_FEED', {}, NOW);
      expect(updates).toEqual([{ slot: 1, newProgress: 3 }]);
      expect(db.rawUpdate).toHaveBeenCalledTimes(1);
    });

    it('non-matching trigger is a no-op (no rawUpdate fired)', async () => {
      const user = { lastQuestDate: TODAY };
      db.getItem.mockResolvedValue({
        date: TODAY,
        quests: [{ slot: 1, id: 'dq_feed_3', progress: 0, goal: 3, claimed: false }],
      });
      const updates = await svc.onQuestProgress(USER_ID, user, 'EXPEDITION_STARTED', { domain: 'water' }, NOW);
      expect(updates).toEqual([]);
      expect(db.rawUpdate).not.toHaveBeenCalled();
    });
  });

  // =============================================================================
  // PERSISTENCE — batchClaim
  // =============================================================================

  describe('batchClaim', () => {
    const TODAY = '2026-05-16';
    const NOW = new Date(`${TODAY}T12:00:00Z`);

    it('returns empty when no record exists', async () => {
      db.getItem.mockResolvedValue(null);
      const r = await svc.batchClaim(USER_ID, TODAY, NOW);
      expect(r).toEqual({ claimed: [], bonusClaimed: false, totalEssenceAwarded: 0 });
      expect(db.rawUpdate).not.toHaveBeenCalled();
      expect(db.addEssence).not.toHaveBeenCalled();
    });

    it('is idempotent — no claimable + no bonus returns empty', async () => {
      db.getItem.mockResolvedValue({
        date: TODAY,
        quests: [
          { slot: 1, id: 'dq_feed_3',  progress: 1, goal: 3, claimed: false, reward: { essence: 15 } },
          { slot: 2, id: 'dq_expedition_claim_1',   progress: 1, goal: 1, claimed: true,  reward: { essence: 15 } },
        ],
        bonus: { reward: { essence: 75 }, claimed: false },
      });
      const r = await svc.batchClaim(USER_ID, TODAY, NOW);
      expect(r.claimed).toEqual([]);
      expect(r.bonusClaimed).toBe(false);
      expect(db.addEssence).not.toHaveBeenCalled();
    });

    it('flips completed-unclaimed slots and credits Essence', async () => {
      db.getItem.mockResolvedValue({
        date: TODAY,
        quests: [
          { slot: 1, id: 'dq_feed_3',         progress: 3, goal: 3, claimed: false, reward: { essence: 15 } },
          { slot: 2, id: 'dq_train_diff_2',   progress: 2, goal: 2, claimed: false, reward: { essence: 15 } },
          { slot: 3, id: 'dq_challenge_wisdom', progress: 0, goal: 1, claimed: false, reward: { essence: 25 } },
          { slot: 4, id: 'dq_expedition_start_water', progress: 1, goal: 1, claimed: false, reward: { essence: 25 } },
          { slot: 5, id: 'dq_challenge_3',        progress: 0, goal: 1, claimed: false, reward: { essence: 40 } },
        ],
        bonus: { reward: { essence: 75 }, claimed: false },
      });
      db.rawUpdate.mockResolvedValue(undefined);
      db.addEssence.mockResolvedValue({ success: true, newBalance: 4500 });
      db.getUser.mockResolvedValue({ stats: {} });
      db.updateUser.mockResolvedValue(undefined);

      const r = await svc.batchClaim(USER_ID, TODAY, NOW);
      expect(r.claimed.map(c => c.questId).sort()).toEqual([
        'dq_expedition_start_water', 'dq_feed_3', 'dq_train_diff_2',
      ]);
      expect(r.bonusClaimed).toBe(false);
      expect(r.totalEssenceAwarded).toBe(15 + 15 + 25); // 55
      expect(db.addEssence).toHaveBeenCalledWith(USER_ID, 55, expect.objectContaining({ type: 'reward_quest' }));
    });

    it('auto-claims bonus when batch completes the full set + grants a rune', async () => {
      db.getItem.mockResolvedValue({
        date: TODAY,
        quests: [
          { slot: 1, id: 'dq_feed_3',         progress: 3, goal: 3, claimed: true,  reward: { essence: 15 } },
          { slot: 2, id: 'dq_expedition_claim_1',          progress: 1, goal: 1, claimed: true,  reward: { essence: 15 } },
          { slot: 3, id: 'dq_challenge_wisdom', progress: 1, goal: 1, claimed: true,  reward: { essence: 25 } },
          { slot: 4, id: 'dq_expedition_start_water', progress: 1, goal: 1, claimed: true,  reward: { essence: 25 } },
          { slot: 5, id: 'dq_challenge_3',        progress: 1, goal: 1, claimed: false, reward: { essence: 40 } },
        ],
        bonus: { reward: { essence: 75 }, claimed: false },
      });
      db.rawUpdate.mockResolvedValue(undefined);
      db.addEssence.mockResolvedValue({ success: true, newBalance: 5000 });
      db.addRunes.mockResolvedValue({ success: true });
      db.getUser.mockResolvedValue({ stats: { totalQuestSetsCompleted: 0, totalThemedQuestClaims: 0 } });
      db.updateUser.mockResolvedValue(undefined);

      const r = await svc.batchClaim(USER_ID, TODAY, NOW);
      expect(r.bonusClaimed).toBe(true);
      expect(r.totalEssenceAwarded).toBe(40 + 75); // last quest + bonus
      expect(ach.onQuestSetClaimed).toHaveBeenCalledWith(USER_ID, { totalQuestSetCount: 1 });
      // Bonus claim grants exactly one rune
      expect(db.addRunes).toHaveBeenCalledTimes(1);
      expect(r.runesAwarded).toBeTruthy();
      const totalRunes = (r.runesAwarded.lesser || 0) + (r.runesAwarded.greater || 0) + (r.runesAwarded.ancient || 0);
      expect(totalRunes).toBe(1);
    });

    it('does not grant a rune when only individual quests are claimed (no bonus flip)', async () => {
      db.getItem.mockResolvedValue({
        date: TODAY,
        quests: [
          { slot: 1, id: 'dq_feed_3', progress: 3, goal: 3, claimed: false, reward: { essence: 15 } },
          { slot: 2, id: 'dq_expedition_claim_1', progress: 0, goal: 1, claimed: false, reward: { essence: 15 } },
        ],
        bonus: { reward: { essence: 75 }, claimed: false },
      });
      db.rawUpdate.mockResolvedValue(undefined);
      db.addEssence.mockResolvedValue({ success: true, newBalance: 5000 });
      db.getUser.mockResolvedValue({ stats: {} });
      db.updateUser.mockResolvedValue(undefined);

      const r = await svc.batchClaim(USER_ID, TODAY, NOW);
      expect(r.bonusClaimed).toBe(false);
      expect(r.runesAwarded).toBeNull();
      expect(db.addRunes).not.toHaveBeenCalled();
    });

    it('handles ConditionalCheckFailedException gracefully (race)', async () => {
      db.getItem.mockResolvedValue({
        date: TODAY,
        quests: [{ slot: 1, id: 'dq_feed_3', progress: 3, goal: 3, claimed: false, reward: { essence: 15 } }],
        bonus: { reward: { essence: 75 }, claimed: false },
      });
      const err = new Error('check failed');
      err.name = 'ConditionalCheckFailedException';
      db.rawUpdate.mockRejectedValue(err);

      const r = await svc.batchClaim(USER_ID, TODAY, NOW);
      expect(r.claimed).toEqual([]);
      expect(db.addEssence).not.toHaveBeenCalled();
    });

    it('fires themed-claim achievement for slot 3 or 4 claims', async () => {
      db.getItem.mockResolvedValue({
        date: TODAY,
        quests: [
          { slot: 3, id: 'dq_challenge_wisdom', progress: 1, goal: 1, claimed: false, reward: { essence: 25 } },
        ],
        bonus: { reward: { essence: 75 }, claimed: false },
      });
      db.rawUpdate.mockResolvedValue(undefined);
      db.addEssence.mockResolvedValue({ success: true, newBalance: 1000 });
      db.getUser.mockResolvedValue({ stats: { totalThemedQuestClaims: 4 } });
      db.updateUser.mockResolvedValue(undefined);

      await svc.batchClaim(USER_ID, TODAY, NOW);
      expect(ach.onQuestThemedClaimed).toHaveBeenCalledWith(USER_ID, { totalThemedClaimCount: 5 });
    });
  });
});
