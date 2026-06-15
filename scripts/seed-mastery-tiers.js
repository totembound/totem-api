/**
 * Dev-only: seed ChallengeProgress for the local test user so every mastery
 * tier (Novice → Diamond) is represented across the 12 challenges, for UI testing.
 * Run against LOCAL DynamoDB:  node scripts/seed-mastery-tiers.js
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = DynamoDBDocumentClient.from(new DynamoDBClient({
  endpoint: 'http://localhost:8000',
  region: 'us-west-2',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
}));

const TABLE = 'TotemBound-ChallengeProgress';
const userId = 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890'; // testplayer1@example.com
const now = new Date().toISOString();

// Mastery thresholds (must match MASTERY config): Novice 0, Bronze 10, Silver 30, Gold 75, Platinum 150, Diamond 300
const TIER_NAMES = ['Novice', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
function tierFor(c) {
  const T = [0, 10, 30, 75, 150, 300];
  let t = 0;
  for (let i = T.length - 1; i >= 0; i--) { if (c >= T[i]) { t = i; break; } }
  return t;
}

// completionCount chosen to land each challenge in a distinct tier (cycles twice).
// garden-pest-patrol is left at 0 (no record written) as the clean from-zero case.
const plan = [
  ['chl_garden-pest-patrol', 0],
  ['chl_boulder-breaker', 15],
  ['chl_totem-wrestling', 40],
  ['chl_rockfall-defense', 90],
  ['chl_riverside-dodge', 170],
  ['chl_spirit-path', 320],
  ['chl_spirit-labyrinth', 6],
  ['chl_aerial-ring-dive', 18],
  ['chl_spirit-dance', 45],
  ['chl_ancient-runes', 95],
  ['chl_star-mapping', 175],
  ['chl_spirit-weaving', 330],
];

(async () => {
  for (const [challengeId, completionCount] of plan) {
    if (completionCount === 0) {
      console.log(`skipped ${challengeId.padEnd(23)} count=  0 -> Novice (no record — clean from-zero case)`);
      continue;
    }
    const masteryTier = tierFor(completionCount);
    const item = {
      pk: `USER#${userId}`,
      sk: `CHALLENGE#${challengeId}`,
      userId,
      challengeId,
      completionCount,
      masteryCount: completionCount, // lockstep with the default 0 anti-farm floor
      masteryTier,
      totalAttempts: completionCount,
      totalXpEarned: completionCount * 20,
      totalScore: completionCount * 1000,
      highScore: 1500,
      lastScore: 1200,
      lastXpEarned: 20,
      dailyAttempts: {},
      preferredDifficulty: null,
      lastAttemptAt: now,
      lastCompletionAt: now,
      firstCompletedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await client.send(new PutCommand({ TableName: TABLE, Item: item }));
    console.log(`seeded ${challengeId.padEnd(24)} count=${String(completionCount).padStart(3)} -> ${TIER_NAMES[masteryTier]}`);
  }
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
