/**
 * Challenge Mastery Tests
 *
 * Covers the Challenge Mastery feature spliced into challenges-service.js:
 * - tier math boundaries (tierForCompletions)
 * - XP scaling by tier (bounded by maxScore/100 × tierMult)
 * - tier-up loot grant (mocked grantLootItem) + idempotency
 * - difficulty clamp (lower always ok, raise needs Gold+)
 * - retroactive backfill (no back-paid loot/lump)
 * - anti-farm minMasteryScorePct floor
 * - onChallengeTierReached global achievement trigger
 */

// Mock db-client (mirrors challenges-service.test.js)
jest.mock('../src/common/db-client', () => ({
  getItem: jest.fn(),
  putItem: jest.fn().mockResolvedValue({}),
  updateItem: jest.fn(),
  queryItems: jest.fn().mockResolvedValue([]),
  getUser: jest.fn(),
  getTotem: jest.fn(),
  updateTotem: jest.fn().mockResolvedValue({}),
  addEssence: jest.fn().mockResolvedValue({ newBalance: 100 }),
  TABLES: {
    CHALLENGE_PROGRESS: 'TotemBound-ChallengeProgress',
    ACHIEVEMENT_PROGRESS: 'TotemBound-AchievementProgress',
    TOTEMS: 'TotemBound-Totems',
    REWARD_STATE: 'TotemBound-RewardState',
  },
  userPK: jest.fn((id) => `USER#${id}`),
}));

// Mock achievements service — assert onChallengeTierReached fires on a crossing
jest.mock('../src/services/achievements-service', () => ({
  onChallengeCompleted: jest.fn().mockResolvedValue([]),
  onChallengeTierReached: jest.fn().mockResolvedValue([]),
}));

// Mock loot-service — assert grantLootItem(userId, boxId, 'mastery')
jest.mock('../src/services/loot-service', () => ({
  grantLootItem: jest.fn().mockImplementation((userId, boxId) =>
    Promise.resolve({ id: `loot_${boxId}`, boxId, source: 'mastery', status: 'unclaimed' })
  ),
}));

// Mock game-actions helpers
jest.mock('../src/functions/game-actions/helpers', () => ({
  checkEvolutionRequirements: jest.fn(() => ({ canEvolve: false, requirements: {} })),
}));

const {
  completeChallenge,
  getChallengeStatus,
  tierForCompletions,
  autoDifficulty,
  clampDifficulty,
  buildMasteryBlock,
  MASTERY,
} = require('../src/services/challenges-service');

const mockDbClient = require('../src/common/db-client');
const { grantLootItem } = require('../src/services/loot-service');
const { onChallengeTierReached } = require('../src/services/achievements-service');

// A stage-2 totem that qualifies for chl_totem-wrestling (req stage 1) and
// every stage<=2 challenge used below.
function strongTotem(overrides = {}) {
  return {
    id: 'ttm_456',
    userId: 'usr_123',
    stage: 2,
    experience: 0,
    stats: { strength: 30, agility: 30, wisdom: 30, happiness: 50 },
    ...overrides,
  };
}

// chl_totem-wrestling: req stage 1, maxScore 2000 (maxXP 20).
const WRESTLING = 'chl_totem-wrestling';
// chl_garden-pest-patrol: req stage 0, maxScore 1000 (maxXP 10).
const GARDEN = 'chl_garden-pest-patrol';

beforeEach(() => {
  jest.clearAllMocks();
  mockDbClient.putItem.mockResolvedValue({});
  mockDbClient.updateTotem.mockResolvedValue({});
  mockDbClient.queryItems.mockResolvedValue([]);
  mockDbClient.addEssence.mockResolvedValue({ newBalance: 100 });
  // restore config defaults each test
  MASTERY.minMasteryScorePct = 0;
});

// =============================================================================
// Tier math boundaries
// =============================================================================

describe('tierForCompletions boundaries', () => {
  test('9 completions => Novice (0)', () => {
    expect(tierForCompletions(9)).toBe(0);
  });
  test('10 completions => Bronze (1)', () => {
    expect(tierForCompletions(10)).toBe(1);
  });
  test('29 => Bronze, 30 => Silver', () => {
    expect(tierForCompletions(29)).toBe(1);
    expect(tierForCompletions(30)).toBe(2);
  });
  test('74 => Silver, 75 => Gold', () => {
    expect(tierForCompletions(74)).toBe(2);
    expect(tierForCompletions(75)).toBe(3);
  });
  test('149 => Gold, 150 => Platinum', () => {
    expect(tierForCompletions(149)).toBe(3);
    expect(tierForCompletions(150)).toBe(4);
  });
  test('300 => Diamond (5)', () => {
    expect(tierForCompletions(300)).toBe(5);
    expect(tierForCompletions(99999)).toBe(5);
  });
  test('0 / negative / non-finite => Novice', () => {
    expect(tierForCompletions(0)).toBe(0);
    expect(tierForCompletions(undefined)).toBe(0);
  });
});

// =============================================================================
// buildMasteryBlock contract (frontend depends on exact field names)
// =============================================================================

describe('buildMasteryBlock', () => {
  test('Gold (82 completions) shape matches plan contract', () => {
    const m = buildMasteryBlock(82, 3);
    expect(m).toEqual({
      tier: 3,
      tierName: 'Gold',
      completions: 82,
      nextTierAt: 150,
      completionsToNext: 68,
      xpMultiplier: 2.0,
      difficultyUnlocked: true,
      maxDifficulty: 3,
      preferredDifficulty: 3,
    });
  });
  test('Novice has difficultyUnlocked false and next at 10', () => {
    const m = buildMasteryBlock(0);
    expect(m.tier).toBe(0);
    expect(m.difficultyUnlocked).toBe(false);
    expect(m.nextTierAt).toBe(10);
    expect(m.completionsToNext).toBe(10);
    expect(m.preferredDifficulty).toBeNull();
  });
  test('Diamond has null next-tier fields', () => {
    const m = buildMasteryBlock(300);
    expect(m.tier).toBe(5);
    expect(m.nextTierAt).toBeNull();
    expect(m.completionsToNext).toBeNull();
  });
});

// =============================================================================
// XP scaling by tier
// =============================================================================

describe('XP scaling by tier', () => {
  test('Novice (count 0): base run earns 1x XP', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue(null); // count 0 => Novice
    // perfect score on wrestling (maxScore 2000) => baseXp 20
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.success).toBe(true);
    expect(result.data.xpEarned).toBe(20);
    expect(result.data.mastery.xpMultiplier).toBe(1.0);
  });

  test('Bronze (count 10): base run earns 1.25x XP', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 10, masteryTier: 1 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    // 20 * 1.25 = 25
    expect(result.data.xpEarned).toBe(25);
  });

  test('Gold (count 80): base run earns 2x XP', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80, masteryTier: 3 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    // 20 * 2.0 = 40
    expect(result.data.xpEarned).toBe(40);
  });

  test('Diamond (count 305): base run earns 3x XP, bounded by maxScore/100 × tierMult', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 305, masteryTier: 5 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    // 20 * 3.0 = 60 — and (maxScore/100) × tierMult = 20 × 3 = 60 ceiling
    expect(result.data.xpEarned).toBe(60);
    expect(result.data.xpEarned).toBeLessThanOrEqual((2000 / 100) * 3.0);
  });

  test('over-cap score does not exceed the bounded XP ceiling', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 305, masteryTier: 5 });
    // submit way over maxScore; effectiveScore is capped at maxScore
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 999999);
    expect(result.data.xpEarned).toBe(60);
  });

  test('uses derived tier when masteryTier is absent (count 80 => Gold => 2x)', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80 }); // no masteryTier
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.xpEarned).toBe(40);
  });

  test('trait × tier composition: round(baseXp × tierMult × traitMult)', async () => {
    // Clever (+5% challenge XP, no score boost) at Bronze:
    // baseXp 20 × 1.25 × 1.05 = 26.25 => round => 26
    mockDbClient.getTotem.mockResolvedValue(strongTotem({ traits: { innate: 'trt_clever', learned: null, awakened: null } }));
    mockDbClient.getItem.mockResolvedValue({ completionCount: 10, masteryCount: 10, masteryTier: 1 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.xpEarned).toBe(26);
  });

  test('same submitted score yields identical XP regardless of requested difficulty', async () => {
    // Gold-mastered (raising unlocked) — difficulty changes only the run's
    // intensity, never the XP formula. Same score => same XP at 1 and 3.
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80, masteryCount: 80, masteryTier: 3 });
    const atDiff1 = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 1500, 1);
    const atDiff3 = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 1500, 3);
    // floor(1500 × 20 / 2000) = 15, × 2.0 (Gold) = 30 — both runs
    expect(atDiff1.data.xpEarned).toBe(30);
    expect(atDiff3.data.xpEarned).toBe(30);
  });
});

// =============================================================================
// Tier-up: loot grant + lump + idempotency
// =============================================================================

describe('tier-up loot grant', () => {
  test('crossing to Bronze (count 9 -> 10) grants the XP lump only — boxes start at Silver', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 9, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);

    expect(result.data.tierUp).not.toBeNull();
    expect(result.data.tierUp.from).toBe(0);
    expect(result.data.tierUp.to).toBe(1);
    expect(result.data.tierUp.name).toBe('Bronze');
    expect(result.data.tierUp.xp).toBe(100);
    expect(grantLootItem).not.toHaveBeenCalled();
    expect(result.data.tierUp.lootBox).toBeNull();
  });

  test('crossing to Silver (count 29 -> 30) grants essence_box_small via grantLootItem(source mastery)', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 29, masteryTier: 1 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);

    expect(result.data.tierUp).not.toBeNull();
    expect(result.data.tierUp.from).toBe(1);
    expect(result.data.tierUp.to).toBe(2);
    expect(result.data.tierUp.name).toBe('Silver');
    expect(result.data.tierUp.xp).toBe(250);
    expect(grantLootItem).toHaveBeenCalledWith('usr_123', 'essence_box_small', 'mastery');
    expect(result.data.tierUp.lootBox).toEqual({
      id: 'loot_essence_box_small',
      boxId: 'essence_box_small',
      source: 'mastery',
    });
  });

  test('XP lump lands on the triggering totem (run XP + lump)', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem({ experience: 1000 }));
    mockDbClient.getItem.mockResolvedValue({ completionCount: 9, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    // run XP = 20 (Novice mult), + Bronze lump 100 = 120
    expect(result.data.xpEarned).toBe(120);
    expect(result.data.totem.newXp).toBe(1000 + 120);
  });

  test('escalating box ids: Gold crossing grants essence_box_small + difficulty unlock', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 74, masteryTier: 2 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.tierUp.to).toBe(3);
    expect(grantLootItem).toHaveBeenCalledWith('usr_123', 'essence_box_small', 'mastery');
    expect(result.data.tierUp.unlocked).toEqual(['difficulty-raise']);
    expect(result.data.mastery.difficultyUnlocked).toBe(true);
  });

  test('Diamond crossing grants essence_box_large (huge is exclusive to Grandmaster)', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 299, masteryTier: 4 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.tierUp.to).toBe(5);
    expect(grantLootItem).toHaveBeenCalledWith('usr_123', 'essence_box_large', 'mastery');
  });

  test('grantLootItem rejection does not fail the completion; tierUp returned with lootBox null', async () => {
    grantLootItem.mockRejectedValueOnce(new Error('REWARD_STATE write failed'));
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 29, masteryCount: 29, masteryTier: 1 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.success).toBe(true);
    expect(result.data.tierUp).not.toBeNull();
    expect(result.data.tierUp.to).toBe(2);
    expect(result.data.tierUp.lootBox).toBeNull();
    // the XP lump still lands and masteryTier still persists (idempotency over delivery)
    // run XP at Bronze (20 × 1.25 = 25) + Silver lump 250 = 275
    expect(result.data.xpEarned).toBe(275);
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ masteryTier: 2 })
    );
  });

  test('idempotent: re-submit at same stored tier does NOT re-grant box or lump', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    // count 10, stored tier already 1 (Bronze) — completing again => count 11, still Bronze
    mockDbClient.getItem.mockResolvedValue({ completionCount: 10, masteryTier: 1 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.tierUp).toBeNull();
    expect(grantLootItem).not.toHaveBeenCalled();
    // pure run XP only (20 × 1.25 = 25), no lump
    expect(result.data.xpEarned).toBe(25);
  });

  test('persists masteryTier on the progress record', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 9, masteryTier: 0 });
    await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ masteryTier: 1 })
    );
  });

  test('fires onChallengeTierReached on a crossing with newTier + totalTiersEarned', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 9, masteryTier: 0 });
    mockDbClient.queryItems.mockResolvedValue([
      { challengeId: WRESTLING, completionCount: 9, masteryTier: 0 },
    ]);
    await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(onChallengeTierReached).toHaveBeenCalledWith(
      'usr_123',
      expect.objectContaining({ newTier: 1, totalTiersEarned: 1, totemId: 'ttm_456' })
    );
  });

  test('does NOT fire onChallengeTierReached on a non-crossing run', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 11, masteryTier: 1 });
    await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(onChallengeTierReached).not.toHaveBeenCalled();
  });

  test('a failure in onChallengeCompleted does not suppress onChallengeTierReached', async () => {
    const { onChallengeCompleted } = require('../src/services/achievements-service');
    onChallengeCompleted.mockRejectedValueOnce(new Error('achievement check blew up'));
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 9, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.success).toBe(true);
    expect(onChallengeTierReached).toHaveBeenCalled();
  });
});

// =============================================================================
// Display tier and reward tier alignment (derived from the count)
// =============================================================================

describe('reward tier derives from the count (stored masteryTier is only the bonus floor)', () => {
  test('stale-HIGH stored tier: reward uses the derived tier; floor is not regressed', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    // hand-seeded record: stored Diamond but only 80 mastery-counted completions (Gold)
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80, masteryCount: 80, masteryTier: 5 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    // reward multiplier = DERIVED Gold 2.0x (same as the display tier), not 3.0x
    expect(result.data.xpEarned).toBe(40);
    expect(result.data.mastery.tier).toBe(3);
    expect(result.data.tierUp).toBeNull();
    expect(grantLootItem).not.toHaveBeenCalled();
    // idempotency floor stays at the stored value
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ masteryTier: 5 })
    );
  });

  test('stale-LOW stored tier: unpaid crossing fires once at the derived tier', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    // stored Bronze but 80 mastery-counted completions (derived Gold)
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80, masteryCount: 80, masteryTier: 1 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    // run XP at derived Gold (40) + the Gold lump (500)
    expect(result.data.xpEarned).toBe(540);
    expect(result.data.tierUp).toEqual(expect.objectContaining({ from: 1, to: 3 }));
    expect(grantLootItem).toHaveBeenCalledWith('usr_123', 'essence_box_small', 'mastery');
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ masteryTier: 3 })
    );
  });
});

// =============================================================================
// Retroactive backfill
// =============================================================================

describe('retroactive backfill', () => {
  test('veteran with completionCount 200 and no masteryTier sets Platinum WITHOUT granting box/lump', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    // count 200 => derived tier 4 (Platinum); no stored masteryTier => retro-init
    mockDbClient.getItem.mockResolvedValue({ completionCount: 200 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);

    // newCount 201 still Platinum => no crossing => no tierUp / loot / lump
    expect(result.data.tierUp).toBeNull();
    expect(grantLootItem).not.toHaveBeenCalled();
    // pure run XP at Platinum (2.5×): 20 × 2.5 = 50, no lump
    expect(result.data.xpEarned).toBe(50);
    // masteryTier persisted as 4 (backfilled)
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ masteryTier: 4 })
    );
  });

  test('subsequent crossing from a backfilled tier DOES grant (299 stored Platinum -> Diamond)', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 299, masteryTier: 4 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.tierUp.to).toBe(5);
    expect(grantLootItem).toHaveBeenCalledWith('usr_123', 'essence_box_large', 'mastery');
  });
});

// =============================================================================
// Difficulty clamp
// =============================================================================

describe('difficulty clamp', () => {
  test('autoDifficulty = clamp(displayStage - reqStage, 1, 3) with displayStage = stage + 1', () => {
    // stage 2 (display 3), garden req stage 0 => 3
    expect(autoDifficulty({ stage: 2 }, { requirements: { stage: 0 } })).toBe(3);
    // stage 4 (display 5), req 0 => clamped to 3
    expect(autoDifficulty({ stage: 4 }, { requirements: { stage: 0 } })).toBe(3);
    // stage 0 (display 1), req 0 => 1
    expect(autoDifficulty({ stage: 0 }, { requirements: { stage: 0 } })).toBe(1);
  });

  test('matches frontend getGameDifficulty exactly at boundary stages', () => {
    // Canonical frontend formula (totem-app/src/utils/totems.tsx:268):
    // clamp((stored stage + 1) − reqStage, 1, 3)
    const frontend = (stage, reqStage) =>
      Math.min(3, Math.max(1, (stage + 1) - reqStage));
    for (const reqStage of [0, 1, 2]) {
      // exactly at the challenge's min stage, one above, and max stage (4)
      for (const stage of [reqStage, reqStage + 1, 4]) {
        expect(autoDifficulty({ stage }, { requirements: { stage: reqStage } }))
          .toBe(frontend(stage, reqStage));
      }
    }
    // a totem exactly at min stage is never forced above difficulty 1+1
    expect(autoDifficulty({ stage: 2 }, { requirements: { stage: 2 } })).toBe(1);
    expect(autoDifficulty({ stage: 3 }, { requirements: { stage: 2 } })).toBe(2);
    expect(autoDifficulty({ stage: 4 }, { requirements: { stage: 2 } })).toBe(3);
  });

  test('clampDifficulty rounds non-integer requests before clamping (2.7 => 3)', () => {
    expect(clampDifficulty(2.7, 1, 3)).toBe(3);
    expect(clampDifficulty(1.4, 1, 3)).toBe(1);
    expect(clampDifficulty(2.7, 1, 2)).toBe(2); // rounded then clamped to ceiling
  });

  test('non-integer difficulty in a completion is rounded (2.7 => 3 at Gold+)', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem({ stage: 1, stats: { strength: 30, agility: 30, wisdom: 30, happiness: 50 } }));
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80, masteryTier: 3 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000, 2.7);
    expect(result.data.mastery.preferredDifficulty).toBe(3);
  });

  test('below Gold: requested difficulty above auto is clamped to auto', async () => {
    // stage 1 totem on wrestling (req 1) => auto = 1; Novice => maxSel = auto = 1
    mockDbClient.getTotem.mockResolvedValue(strongTotem({ stage: 1, stats: { strength: 30, agility: 30, wisdom: 30, happiness: 50 } }));
    mockDbClient.getItem.mockResolvedValue({ completionCount: 0, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000, 3);
    expect(result.data.mastery.preferredDifficulty).toBe(1);
  });

  test('below Gold: lowering is allowed (req 1 honored)', async () => {
    // stage 2 totem => auto 2; request 1 => allowed (lowering)
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 0, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000, 1);
    expect(result.data.mastery.preferredDifficulty).toBe(1);
  });

  test('Gold+: raising to 3 is allowed even when auto is 1', async () => {
    // stage 1 totem (auto 1) but Gold mastered => maxSel = 3
    mockDbClient.getTotem.mockResolvedValue(strongTotem({ stage: 1, stats: { strength: 30, agility: 30, wisdom: 30, happiness: 50 } }));
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80, masteryTier: 3 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000, 3);
    expect(result.data.mastery.preferredDifficulty).toBe(3);
  });

  test('out-of-range (>3) clamps to 3 at Gold+', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem({ stage: 1, stats: { strength: 30, agility: 30, wisdom: 30, happiness: 50 } }));
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80, masteryTier: 3 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000, 99);
    expect(result.data.mastery.preferredDifficulty).toBe(3);
  });

  test('out-of-range (<1) clamps to 1', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 0, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000, -5);
    expect(result.data.mastery.preferredDifficulty).toBe(1);
  });

  test('omitted difficulty runs at auto but does NOT persist a preference', async () => {
    // stage 2 totem on wrestling (req 1) => auto = 2; no saved preference
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 0, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.mastery.preferredDifficulty).toBeNull();
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ preferredDifficulty: null })
    );
  });

  test('omitted difficulty preserves the saved preferredDifficulty', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 20, masteryTier: 1, preferredDifficulty: 2 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.mastery.preferredDifficulty).toBe(2);
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ preferredDifficulty: 2 })
    );
  });

  test('persists preferredDifficulty on the progress record when explicitly provided', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 0, masteryTier: 0 });
    await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000, 1);
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ preferredDifficulty: 1 })
    );
  });

  test('entry requirement gate still blocks an unqualified totem regardless of difficulty', async () => {
    // stage 0 totem cannot enter wrestling (req stage 1) even at difficulty 1
    mockDbClient.getTotem.mockResolvedValue({
      id: 'ttm_456',
      userId: 'usr_123',
      stage: 0,
      stats: { strength: 30, agility: 30, wisdom: 30, happiness: 50 },
    });
    mockDbClient.getItem.mockResolvedValue({ completionCount: 80, masteryTier: 3 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000, 1);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('REQUIREMENT_NOT_MET');
  });
});

// =============================================================================
// Anti-farm minMasteryScorePct
// =============================================================================

describe('anti-farm minMasteryScorePct', () => {
  test('default (0): any score>0 advances both counters in lockstep', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 5, masteryCount: 5, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 1);
    expect(result.data.mastery.completions).toBe(6); // masteryCount advanced
    expect(result.data.progress.completionCount).toBe(6); // lockstep at floor 0
  });

  test('with floor set: sub-threshold score does NOT advance mastery but completionCount and the attempt still count', async () => {
    MASTERY.minMasteryScorePct = 0.1; // 10% of maxScore 2000 = 200
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 5, masteryCount: 5, masteryTier: 0, totalAttempts: 5 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 100); // below 200
    // masteryCount NOT advanced — the tier never moves on farmed runs
    expect(result.data.mastery.completions).toBe(5);
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ masteryCount: 5, completionCount: 6 })
    );
    // completionCount ALWAYS increments (global achievements + player stat)
    expect(result.data.progress.completionCount).toBe(6);
    // attempt still recorded
    expect(result.data.progress.totalAttempts).toBe(6);
  });

  test('with floor set: at/above threshold advances mastery', async () => {
    MASTERY.minMasteryScorePct = 0.1; // 200
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 5, masteryCount: 5, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 500); // above 200
    expect(result.data.mastery.completions).toBe(6);
  });

  test('floor compares the RAW score, not the trait-boosted effectiveScore', async () => {
    MASTERY.minMasteryScorePct = 0.1; // 200
    // Brave (+5% score boost on challenge:any): raw 195 boosts to ~205 >= 200,
    // but the floor must gate on the raw submission.
    mockDbClient.getTotem.mockResolvedValue(strongTotem({ traits: { innate: 'trt_brave', learned: null, awakened: null } }));
    mockDbClient.getItem.mockResolvedValue({ completionCount: 5, masteryCount: 5, masteryTier: 0 });
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 195);
    expect(result.data.mastery.completions).toBe(5); // not advanced
    expect(result.data.progress.completionCount).toBe(6); // still counted
  });

  test('legacy record without masteryCount initializes it from completionCount', async () => {
    mockDbClient.getTotem.mockResolvedValue(strongTotem());
    mockDbClient.getItem.mockResolvedValue({ completionCount: 40, masteryTier: 2 }); // no masteryCount
    const result = await completeChallenge('usr_123', WRESTLING, 'ttm_456', 2000);
    expect(result.data.mastery.completions).toBe(41); // 40 (fallback) + 1
    expect(mockDbClient.putItem).toHaveBeenCalledWith(
      'TotemBound-ChallengeProgress',
      expect.objectContaining({ masteryCount: 41, completionCount: 41 })
    );
  });
});

// =============================================================================
// list/status mastery block
// =============================================================================

describe('getChallengeStatus mastery block', () => {
  test('each challenge carries a mastery block derived from the mastery count', async () => {
    mockDbClient.queryItems.mockResolvedValue([
      { challengeId: WRESTLING, completionCount: 75, masteryCount: 75, masteryTier: 3, preferredDifficulty: 2 },
    ]);
    const statuses = await getChallengeStatus('usr_123');
    const wrestling = statuses.find((s) => s.challengeId === WRESTLING);
    expect(wrestling.mastery.tier).toBe(3);
    expect(wrestling.mastery.tierName).toBe('Gold');
    expect(wrestling.mastery.xpMultiplier).toBe(2.0);
    expect(wrestling.mastery.difficultyUnlocked).toBe(true);
    expect(wrestling.mastery.preferredDifficulty).toBe(2);
    // a challenge with no progress defaults to Novice
    const garden = statuses.find((s) => s.challengeId === GARDEN);
    expect(garden.mastery.tier).toBe(0);
    expect(garden.mastery.preferredDifficulty).toBeNull();
  });

  test('tier derives from masteryCount when it lags completionCount (anti-farm)', async () => {
    mockDbClient.queryItems.mockResolvedValue([
      // 80 raw completions but only 29 cleared the floor => Bronze, not Gold
      { challengeId: WRESTLING, completionCount: 80, masteryCount: 29, masteryTier: 1 },
    ]);
    const statuses = await getChallengeStatus('usr_123');
    const wrestling = statuses.find((s) => s.challengeId === WRESTLING);
    expect(wrestling.mastery.tier).toBe(1);
    expect(wrestling.mastery.completions).toBe(29);
    expect(wrestling.completionCount).toBe(80); // player-visible stat untouched
  });
});

// =============================================================================
// status handler mastery summary (totalTiersEarned / challengesAtGold / challengesAtDiamond)
// =============================================================================

describe('status summary mastery fields', () => {
  const { getChallengeStatus: statusHandler } = require('../src/functions/challenges/status');

  test('computes totalTiersEarned, challengesAtGold and challengesAtDiamond from config-driven tiers', async () => {
    mockDbClient.getUser.mockResolvedValue({ stats: {} });
    mockDbClient.queryItems.mockResolvedValue([
      { challengeId: WRESTLING, completionCount: 80, masteryCount: 80, masteryTier: 3 },   // Gold (3)
      { challengeId: GARDEN, completionCount: 320, masteryCount: 320, masteryTier: 5 },    // Diamond (5)
      { challengeId: 'chl_boulder-breaker', completionCount: 12, masteryCount: 12, masteryTier: 1 }, // Bronze (1)
    ]);

    const result = await statusHandler({ userId: 'usr_123' });
    expect(result.success).toBe(true);
    const { summary } = result.data;
    expect(summary.totalTiersEarned).toBe(3 + 5 + 1);
    expect(summary.challengesAtGold).toBe(2);    // Gold + Diamond are both >= raiseTier
    expect(summary.challengesAtDiamond).toBe(1); // only the top tier
  });
});
