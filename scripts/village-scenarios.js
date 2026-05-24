/**
 * Village test scenarios — apply a named DynamoDB state to the dev test user
 * so the village UI can be verified under specific conditions. Scenarios are
 * documented in totem-app/docs/village-test-scenarios.md.
 *
 * Usage:
 *   node scripts/village-scenarios.js <scenario>
 *   node scripts/village-scenarios.js list
 *
 * Examples:
 *   node scripts/village-scenarios.js clean-slate
 *   node scripts/village-scenarios.js forge-ready
 *   node scripts/village-scenarios.js weekly-phantom    # regression test
 *
 * After applying, refresh http://localhost:3000/keepers-village in the browser
 * and verify per the scenario's "Verify" steps in the docs.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand,
} = require('@aws-sdk/lib-dynamodb');

// DynamoDB Local ignores credentials but the AWS SDK still requires them to be
// present, so we pass dummy values. Mirrors the pattern used by docker-compose
// + the local API server.
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: 'http://localhost:8000',
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
);

const USER_ID = 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const PK = `USER#${USER_ID}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function wipePartition(table) {
  const out = await client.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': PK },
  }));
  for (const item of out.Items ?? []) {
    await client.send(new DeleteCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk } }));
  }
}

async function resetUserState() {
  await Promise.all([
    wipePartition('TotemBound-Totems'),
    wipePartition('TotemBound-RewardsClaims'),
    wipePartition('TotemBound-ExpeditionState'),
    wipePartition('TotemBound-ChallengeProgress'),
  ]);
}

async function setUserCurrencies(essence, gems) {
  await client.send(new PutCommand({
    TableName: 'TotemBound-Users',
    Item: {
      pk: PK, sk: 'PROFILE',
      userId: USER_ID,
      email: 'testplayer1@example.com',
      displayName: 'TestPlayer1',
      tier: 'free',
      currencies: { essence, gems },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }));
}

function makeTotem(idx, { speciesId, colorId, rarityId, stage = 0, experience = 0 }) {
  const now = new Date().toISOString();
  return {
    pk: PK, sk: `TOTEM#ttm_test${String(idx).padStart(3, '0')}`,
    id: `ttm_test${String(idx).padStart(3, '0')}`,
    userId: USER_ID,
    speciesId, colorId, rarityId,
    nickname: null, stage, experience, prestigeLevel: 0,
    stats: { strength: 5, agility: 5, wisdom: 5, happiness: 80, hunger: 100 },
    cooldowns: { feed: null, train: null, treat: null },
    createdAt: now, updatedAt: now,
  };
}

async function seedTotems(totems) {
  for (const t of totems) {
    await client.send(new PutCommand({ TableName: 'TotemBound-Totems', Item: t }));
  }
}

// NOTE: streak + expedition seed helpers were removed because the field names
// they wrote (lastClaimAt, bestStreak, sk=EXPEDITION#${id}) didn't match the
// API's read paths (lastClaimTimestamp, longestStreak, sk=EXPEDITION#ACTIVE#).
// Streak and expedition scenarios should be exercised through the UI from a
// clean-slate base instead — see docs/village-test-scenarios.md.

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario_cleanSlate() {
  await resetUserState();
  await setUserCurrencies(0, 0);
}

async function scenario_forgeReady() {
  await resetUserState();
  await setUserCurrencies(500, 0);
  await seedTotems([
    makeTotem(1, { speciesId: 0, colorId: 0, rarityId: 0 }),
    makeTotem(2, { speciesId: 1, colorId: 1, rarityId: 0 }),
    makeTotem(3, { speciesId: 2, colorId: 2, rarityId: 0 }),
  ]);
}

async function scenario_elderReady() {
  await resetUserState();
  await setUserCurrencies(500, 0);
  await seedTotems([
    makeTotem(1, { speciesId: 0, colorId: 8, rarityId: 2, stage: 4, experience: 8000 }),
  ]);
}

async function scenario_sanctuaryRich() {
  await resetUserState();
  await setUserCurrencies(2000, 0);
  await seedTotems([
    makeTotem(1, { speciesId: 0, colorId: 0, rarityId: 0, stage: 0 }),
    makeTotem(2, { speciesId: 1, colorId: 1, rarityId: 0, stage: 1, experience: 600 }),
    makeTotem(3, { speciesId: 2, colorId: 2, rarityId: 1, stage: 2, experience: 1700 }),
    makeTotem(4, { speciesId: 3, colorId: 4, rarityId: 1, stage: 3, experience: 4000 }),
    makeTotem(5, { speciesId: 4, colorId: 8, rarityId: 2, stage: 4, experience: 8000 }),
  ]);
}

async function scenario_bazaarFlush() {
  await resetUserState();
  await setUserCurrencies(99999, 500);
}

const SCENARIOS = {
  'clean-slate':    scenario_cleanSlate,
  'forge-ready':    scenario_forgeReady,
  'elder-ready':    scenario_elderReady,
  'sanctuary-rich': scenario_sanctuaryRich,
  'bazaar-flush':   scenario_bazaarFlush,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === 'list' || arg === '--help') {
    console.error('Village test scenarios');
    console.error('Usage: node scripts/village-scenarios.js <scenario>\n');
    console.error('Available scenarios:');
    for (const name of Object.keys(SCENARIOS)) console.error(`  - ${name}`);
    console.error('\nDocs: totem-app/docs/village-test-scenarios.md');
    process.exit(arg === 'list' || arg === '--help' ? 0 : 1);
  }
  const fn = SCENARIOS[arg];
  if (!fn) {
    console.error(`Unknown scenario: ${arg}`);
    console.error(`Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  await fn();
  console.log(`✅ Applied scenario: ${arg}`);
  console.log(`Refresh http://localhost:3000/keepers-village to see the result.`);
}

main().catch((err) => {
  console.error('❌ Scenario failed:', err);
  process.exit(1);
});
