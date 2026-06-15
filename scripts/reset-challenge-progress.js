/**
 * Reset all challenge progress — one-time op for the Challenge Mastery launch.
 *
 * Deletes every record in TotemBound-ChallengeProgress so all players start
 * the mastery climb from zero (completionCount, masteryCount, masteryTier,
 * preferredDifficulty, daily attempts, and high scores all reset; records
 * recreate cleanly on the next attempt). Achievement records are untouched:
 * already-unlocked milestones persist (milestoneIndex watermark prevents
 * double-awards when counts re-climb), and paid rewards are not clawed back.
 *
 * Pass --achievements to ALSO delete the 5 challenge-related achievement
 * records (Initiate, Progression, Mastery Climber, First Gold, Grandmaster)
 * so milestones re-earn from zero — without it, the milestone watermark means
 * a re-climbing tester never sees those achievements fire again. Rewards
 * re-pay on re-earn (acceptable for staging test accounts).
 *
 * DRY RUN BY DEFAULT — prints what would be deleted. Pass --apply to delete.
 *
 *   Local:    node scripts/reset-challenge-progress.js [--achievements] [--apply]
 *   Staging:  IS_LOCAL=false AWS_REGION=us-west-2 AWS_PROFILE=<staging-profile> \
 *               node scripts/reset-challenge-progress.js [--achievements] [--apply]
 *
 * IS_LOCAL=false is required for staging (defaults to local otherwise). The
 * AWS SDK default credential chain honors AWS_PROFILE, so the staging profile
 * needs no code support. Staging table names match the hardcoded defaults
 * (core.yml TablePrefix=TotemBound); override via DYNAMODB_CHALLENGES_TABLE /
 * DYNAMODB_ACHIEVEMENTS_TABLE if that ever changes.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, ScanCommand, BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const IS_LOCAL = process.env.IS_LOCAL !== 'false';
const TABLE = process.env.DYNAMODB_CHALLENGES_TABLE || 'TotemBound-ChallengeProgress';
const ACHIEVEMENTS_TABLE = process.env.DYNAMODB_ACHIEVEMENTS_TABLE || 'TotemBound-AchievementProgress';
const APPLY = process.argv.includes('--apply');
const INCLUDE_ACHIEVEMENTS = process.argv.includes('--achievements');

// The 5 challenge-related achievements (achievements-service.js ACHIEVEMENT_IDS)
const CHALLENGE_ACHIEVEMENT_SKS = [
  'ACH#ach_challenge-initiate',
  'ACH#ach_challenge-progression',
  'ACH#ach_challenge-mastery',
  'ACH#ach_challenge-gold',
  'ACH#ach_challenge-grandmaster',
];

const client = DynamoDBDocumentClient.from(new DynamoDBClient(
  IS_LOCAL
    ? {
      endpoint: 'http://localhost:8000',
      region: 'us-west-2',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }
    : { region: process.env.AWS_REGION || 'us-west-2' },
));

(async () => {
  console.log(`Target: ${IS_LOCAL ? 'LOCAL (localhost:8000)' : `AWS ${process.env.AWS_REGION || 'us-west-2'}`} — ${APPLY ? 'APPLY (deleting)' : 'DRY RUN (pass --apply to delete)'}`);

  // Full scan — table is small (≤12 records per user).
  const keys = [];
  const perUser = {};
  let lastKey;
  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: 'pk, sk',
      ExclusiveStartKey: lastKey,
    }));
    for (const item of page.Items || []) {
      keys.push({ pk: item.pk, sk: item.sk });
      perUser[item.pk] = (perUser[item.pk] || 0) + 1;
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  for (const [pk, count] of Object.entries(perUser)) {
    console.log(`  ${pk.replace('USER#', '').padEnd(45)} ${count} challenge record(s)`);
  }
  console.log(`Total: ${keys.length} record(s) across ${Object.keys(perUser).length} user(s)`);

  // Optionally collect the 5 challenge-related achievement records too.
  const achievementKeys = [];
  if (INCLUDE_ACHIEVEMENTS) {
    let lastAchKey;
    do {
      const page = await client.send(new ScanCommand({
        TableName: ACHIEVEMENTS_TABLE,
        ProjectionExpression: 'pk, sk',
        ExclusiveStartKey: lastAchKey,
      }));
      for (const item of page.Items || []) {
        if (CHALLENGE_ACHIEVEMENT_SKS.includes(item.sk)) {
          achievementKeys.push({ pk: item.pk, sk: item.sk });
          console.log(`  ${item.pk.replace('USER#', '').padEnd(45)} ${item.sk.replace('ACH#', '')}`);
        }
      }
      lastAchKey = page.LastEvaluatedKey;
    } while (lastAchKey);
    console.log(`Achievements: ${achievementKeys.length} challenge achievement record(s)`);
  }

  if (!APPLY) return;

  // BatchWrite in chunks of 25 (DynamoDB limit), retrying unprocessed keys.
  const deleteAll = async (tableName, tableKeys) => {
    for (let i = 0; i < tableKeys.length; i += 25) {
      let requests = tableKeys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
      while (requests.length > 0) {
        const res = await client.send(new BatchWriteCommand({
          RequestItems: { [tableName]: requests },
        }));
        requests = res.UnprocessedItems?.[tableName] || [];
        if (requests.length > 0) await new Promise((r) => setTimeout(r, 250));
      }
    }
  };

  if (keys.length > 0) await deleteAll(TABLE, keys);
  if (achievementKeys.length > 0) await deleteAll(ACHIEVEMENTS_TABLE, achievementKeys);
  console.log(`Deleted ${keys.length} progress + ${achievementKeys.length} achievement record(s). All players start mastery from zero.`);
})().catch((e) => { console.error(e); process.exit(1); });
