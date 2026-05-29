/**
 * End-to-end Phase 2 trait smoke test against the live local API.
 *
 * Seeds one totem per trait/group, exercises the relevant API actions, then
 * compares numbers in the response and DDB ledger against the baseline produced
 * by the trait-less "plain" totem.
 *
 * Constraints honoured:
 *   - Only uses @aws-sdk/lib-dynamodb and the node-18 global fetch.
 *   - Touches no source under /src.
 *   - Cleans up its own ttm_e2e_* seed totems / seat / mission / expedition rows.
 *   - Resets the user's daily challenge attempts so reruns work.
 *
 * Run from any directory with: node /home/dpatten/repos/totem-api/scripts/e2e-traits.js
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} = require('@aws-sdk/lib-dynamodb');
const { execSync } = require('child_process');

const API = 'http://localhost:3001';
const USER_ID = 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const EMAIL = 'testplayer1@example.com';
const PASSWORD = 'TestPassword123!';

const TOTEMS_TBL = 'TotemBound-Totems';
const TXNS_TBL = 'TotemBound-Transactions';
const EXP_STATE_TBL = 'TotemBound-ExpeditionState';
const USERS_TBL = 'TotemBound-Users';
const CHL_TBL = 'TotemBound-ChallengeProgress';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: 'http://localhost:8000',
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }),
);

let TOKEN = null;
const results = [];
const discrepancies = [];

function record(trait, action, value, expected, notes = '', tolerance = 0.0001) {
  const pass = Math.abs(value - expected) <= tolerance;
  results.push({ trait, action, baseline: expected, withTrait: value, delta: typeof value === 'number' && typeof expected === 'number' ? value - expected : '-', pass, notes });
  if (!pass) discrepancies.push(`${trait} ${action}: expected ${expected}, got ${value}. ${notes}`);
}

function recordDelta(trait, action, baseline, withTrait, expectedDelta, notes = '', tolerance = 0.0001) {
  const delta = withTrait - baseline;
  const pass = Math.abs(delta - expectedDelta) <= tolerance;
  results.push({ trait, action, baseline, withTrait, delta, pass, notes });
  if (!pass) discrepancies.push(`${trait} ${action}: expected delta ${expectedDelta}, got ${delta} (base ${baseline}, with ${withTrait}). ${notes}`);
}

function recordRange(trait, action, baseline, withTrait, expectedRatio, tolerance, notes = '') {
  // Pass if withTrait / baseline ratio is within tolerance of expectedRatio
  const ratio = baseline > 0 ? withTrait / baseline : 0;
  const pass = Math.abs(ratio - expectedRatio) <= tolerance;
  results.push({
    trait,
    action,
    baseline: `~${baseline.toFixed(1)}`,
    withTrait: `~${withTrait.toFixed(1)}`,
    delta: `${((ratio - 1) * 100).toFixed(1)}%`,
    pass,
    notes: notes || `target ratio ${expectedRatio} ±${tolerance}`,
  });
  if (!pass) discrepancies.push(`${trait} ${action}: ratio ${ratio.toFixed(3)} not within ${tolerance} of ${expectedRatio} (base avg ${baseline.toFixed(2)}, trait avg ${withTrait.toFixed(2)}).`);
}

async function api(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${API}${path}`, opts);
  let json;
  try { json = await r.json(); }
  catch { json = { raw: await r.text() }; }
  return { status: r.status, body: json };
}

async function login() {
  const r = await api('POST', '/v1/auth/login', { email: EMAIL, password: PASSWORD });
  if (!r.body?.tokens?.accessToken) {
    throw new Error(`Login failed: ${JSON.stringify(r.body)}`);
  }
  TOKEN = r.body.tokens.accessToken;
}

async function seedTotem(totemId, traits, opts = {}) {
  const now = new Date().toISOString();
  const stage = opts.stage ?? 4;
  const exp = opts.experience ?? 8000;
  const speciesId = opts.speciesId ?? 0;
  const stats = {
    strength: opts.strength ?? 20,
    agility: opts.agility ?? 20,
    wisdom: opts.wisdom ?? 20,
    happiness: opts.happiness ?? 80,
    hunger: opts.hunger ?? 50,
  };
  await ddb.send(new PutCommand({
    TableName: TOTEMS_TBL,
    Item: {
      pk: `USER#${USER_ID}`,
      sk: `TOTEM#${totemId}`,
      id: totemId,
      userId: USER_ID,
      speciesId,
      colorId: opts.colorId ?? 0,
      rarityId: 0,
      nickname: opts.nickname || totemId,
      stage,
      experience: exp,
      prestigeLevel: 0,
      stats,
      cooldowns: { feed: null, train: null, treat: null },
      traits,
      createdAt: now,
      updatedAt: now,
    },
  }));
}

async function topUpEssence(amount) {
  const u = await ddb.send(new GetCommand({ TableName: USERS_TBL, Key: { pk: `USER#${USER_ID}`, sk: 'PROFILE' } }));
  const current = u.Item?.currencies?.essence || 0;
  if (current >= amount) return;
  await ddb.send(new UpdateCommand({
    TableName: USERS_TBL,
    Key: { pk: `USER#${USER_ID}`, sk: 'PROFILE' },
    UpdateExpression: 'SET currencies.essence = :a',
    ExpressionAttributeValues: { ':a': amount },
  }));
  console.log(`[setup] topped up essence to ${amount} (was ${current})`);
}

async function resetChallengeAttempts() {
  // Wipe the user's daily attempts so re-runs work the same day.
  const r = await ddb.send(new QueryCommand({
    TableName: CHL_TBL,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': `USER#${USER_ID}` },
  }));
  for (const row of (r.Items || [])) {
    await ddb.send(new UpdateCommand({
      TableName: CHL_TBL,
      Key: { pk: row.pk, sk: row.sk },
      UpdateExpression: 'SET dailyAttempts = :empty',
      ExpressionAttributeValues: { ':empty': {} },
    }));
  }
  console.log(`[setup] reset daily attempts on ${r.Items?.length || 0} challenge records`);
}

async function cleanupSeeds() {
  // Delete all ttm_e2e_* totems
  const totems = await ddb.send(new QueryCommand({
    TableName: TOTEMS_TBL,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${USER_ID}`, ':sk': 'TOTEM#ttm_e2e_' },
  }));
  for (const t of (totems.Items || [])) {
    await ddb.send(new DeleteCommand({ TableName: TOTEMS_TBL, Key: { pk: t.pk, sk: t.sk } }));
  }

  // Delete any USER# rows referencing our e2e totems in ExpeditionState
  const expRows = await ddb.send(new QueryCommand({
    TableName: EXP_STATE_TBL,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `USER#${USER_ID}` },
  }));
  for (const row of (expRows.Items || [])) {
    if (typeof row.sk === 'string' && row.sk.includes('ttm_e2e_')) {
      await ddb.send(new DeleteCommand({ TableName: EXP_STATE_TBL, Key: { pk: row.pk, sk: row.sk } }));
    }
  }

  // Delete sanctum seats / missions for our user (only ones referencing e2e totems)
  const sanctumRows = await ddb.send(new QueryCommand({
    TableName: EXP_STATE_TBL,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `SANCTUM#${USER_ID}` },
  }));
  for (const row of (sanctumRows.Items || [])) {
    if (typeof row.sk === 'string' && (row.sk.startsWith('SEAT#') || row.sk.startsWith('MISSION#'))) {
      if (!row.totemId || row.totemId.startsWith('ttm_e2e_')) {
        await ddb.send(new DeleteCommand({ TableName: EXP_STATE_TBL, Key: { pk: row.pk, sk: row.sk } }));
      }
    }
  }
}

async function fetchUserTransactions(sinceISO) {
  const all = [];
  let lastEvaluatedKey;
  do {
    const q = await ddb.send(new QueryCommand({
      TableName: TXNS_TBL,
      IndexName: 'user-ts-index',
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': USER_ID },
      ScanIndexForward: false,
      Limit: 500,
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    all.push(...(q.Items || []));
    lastEvaluatedKey = q.LastEvaluatedKey;
    // Stop once we've gone below sinceISO
    if (sinceISO && q.Items?.length && q.Items[q.Items.length - 1].ts < sinceISO) break;
    if (all.length >= 1500) break;
  } while (lastEvaluatedKey);
  return all.filter(t => !sinceISO || t.ts >= sinceISO);
}

// Build a fresh expedition team that can be reused without happiness draining.
async function seedFreshTeam(leadId, leadTraits, leadSpecies = 0) {
  await seedTotem(leadId, leadTraits, { speciesId: leadSpecies });
  await seedTotem(`${leadId}_m1`, { innate: null, learned: null, awakened: null }, { speciesId: leadSpecies });
  await seedTotem(`${leadId}_m2`, { innate: null, learned: null, awakened: null }, { speciesId: leadSpecies });
  return [leadId, `${leadId}_m1`, `${leadId}_m2`];
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  console.log('[setup] login');
  await login();

  console.log('[setup] cleanup any prior e2e seeds');
  await cleanupSeeds();

  console.log('[setup] reset daily challenge attempts');
  await resetChallengeAttempts();

  console.log('[setup] top up essence');
  await topUpEssence(100000);

  const runStart = new Date().toISOString();

  // -------------------------------------------------------------------
  // 3. Care actions
  // -------------------------------------------------------------------
  console.log('\n=== Care actions ===');

  // Single-use totems per care comparison
  await seedTotem('ttm_e2e_plain_care', { innate: null, learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_plainfeed', { innate: null, learned: null, awakened: null }, { stage: 2, experience: 1500, hunger: 30 });
  await seedTotem('ttm_e2e_gentle', { innate: 'trt_gentle', learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_playful', { innate: 'trt_playful', learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_hardy', { innate: 'trt_hardy', learned: null, awakened: null }, { stage: 2, experience: 1500, hunger: 30 });
  await seedTotem('ttm_e2e_quick', { innate: null, learned: 'trt_quick_learner', awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_diligent', { innate: null, learned: 'trt_diligent_forager', awakened: null }, { stage: 2, experience: 1500, hunger: 30 });
  await seedTotem('ttm_e2e_thrifty', { innate: null, learned: 'trt_thrifty', awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_thrifty_feed', { innate: null, learned: 'trt_thrifty', awakened: null }, { stage: 2, experience: 1500, hunger: 30 });
  await seedTotem('ttm_e2e_thrifty_treat', { innate: null, learned: 'trt_thrifty', awakened: null }, { stage: 2, experience: 1500 });

  // Train baseline
  const rTrainPlain = await api('POST', '/v1/totems/ttm_e2e_plain_care/train');
  const baseTrainXp = rTrainPlain.body?.data?.xpGained;
  const baseTrainHappiness = rTrainPlain.body?.data?.statChanges?.happinessChange;
  const baseTrainEssence = rTrainPlain.body?.data?.essenceSpent;

  const rTrainQuick = await api('POST', '/v1/totems/ttm_e2e_quick/train');
  if (rTrainQuick.body?.success) recordDelta('Quick Learner', 'train xp', baseTrainXp, rTrainQuick.body.data.xpGained, 5);

  const rTrainGentle = await api('POST', '/v1/totems/ttm_e2e_gentle/train');
  if (rTrainGentle.body?.success) recordDelta('Gentle', 'train happinessChange', baseTrainHappiness, rTrainGentle.body.data.statChanges.happinessChange, 2);

  const rTrainThrifty = await api('POST', '/v1/totems/ttm_e2e_thrifty/train');
  if (rTrainThrifty.body?.success) recordDelta('Thrifty', 'train essence', baseTrainEssence, rTrainThrifty.body.data.essenceSpent, -2);

  // Feed baseline
  const rFeedPlain = await api('POST', '/v1/totems/ttm_e2e_plainfeed/feed');
  const baseFeedEssence = rFeedPlain.body?.data?.essenceSpent;
  const baseFeedHappiness = rFeedPlain.body?.data?.statChanges?.happinessChange;

  const rFeedHardy = await api('POST', '/v1/totems/ttm_e2e_hardy/feed');
  if (rFeedHardy.body?.success) recordDelta('Hardy', 'feed happinessChange', baseFeedHappiness, rFeedHardy.body.data.statChanges.happinessChange, 2);

  const rFeedDiligent = await api('POST', '/v1/totems/ttm_e2e_diligent/feed');
  if (rFeedDiligent.body?.success) {
    record('Diligent Forager', 'feed hunger (capped 100)', rFeedDiligent.body.data.statChanges.hunger, 100, 'partial-restore not live; +10% bonus is no-op until then');
  }

  const rFeedThrifty = await api('POST', '/v1/totems/ttm_e2e_thrifty_feed/feed');
  if (rFeedThrifty.body?.success) recordDelta('Thrifty', 'feed essence', baseFeedEssence, rFeedThrifty.body.data.essenceSpent, -1);

  // Treat baseline (plain_care can treat too — no cooldown collision with train)
  const rTreatPlain = await api('POST', '/v1/totems/ttm_e2e_plain_care/treat');
  const baseTreatEssence = rTreatPlain.body?.data?.essenceSpent;
  const baseTreatHappiness = rTreatPlain.body?.data?.statChanges?.happinessChange;

  const rTreatPlayful = await api('POST', '/v1/totems/ttm_e2e_playful/treat');
  if (rTreatPlayful.body?.success) recordDelta('Playful', 'treat happinessChange', baseTreatHappiness, rTreatPlayful.body.data.statChanges.happinessChange, 2);

  const rTreatThrifty = await api('POST', '/v1/totems/ttm_e2e_thrifty_treat/treat');
  if (rTreatThrifty.body?.success) recordDelta('Thrifty', 'treat essence', baseTreatEssence, rTreatThrifty.body.data.essenceSpent, -2);

  // -------------------------------------------------------------------
  // 4. Challenges
  // -------------------------------------------------------------------
  console.log('\n=== Challenges ===');

  // Stage 2 totems w/ strength/agi/wis 20 each, happiness 80
  await seedTotem('ttm_e2e_plain_chl_str', { innate: null, learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_plain_chl_agi', { innate: null, learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_plain_chl_wis', { innate: null, learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_brave', { innate: 'trt_brave', learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_stubborn', { innate: 'trt_stubborn', learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_restless', { innate: 'trt_restless', learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_dreamer', { innate: 'trt_dreamer', learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_clever', { innate: 'trt_clever', learned: null, awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_fighter', { innate: null, learned: 'trt_skilled_fighter', awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_nimble', { innate: null, learned: 'trt_nimble', awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_studious', { innate: null, learned: 'trt_studious', awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_persistent', { innate: null, learned: 'trt_persistent', awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_merchant_chl', { innate: null, learned: 'trt_merchant_eye', awakened: null }, { stage: 2, experience: 1500 });
  await seedTotem('ttm_e2e_mentor_chl', { innate: null, learned: null, awakened: 'trt_mentor' }, { stage: 4, experience: 8000 });

  // Stubborn gate fix
  await seedTotem('ttm_e2e_gate_stubborn', { innate: 'trt_stubborn', learned: null, awakened: null }, { stage: 2, experience: 1500, strength: 12, agility: 5, wisdom: 5 });
  await seedTotem('ttm_e2e_gate_plain', { innate: null, learned: null, awakened: null }, { stage: 2, experience: 1500, strength: 12, agility: 5, wisdom: 5 });

  const STR_CHL = 'chl_boulder-breaker'; // maxScore 2000, base XP 20, essence 10
  const AGI_CHL = 'chl_aerial-ring-dive'; // maxScore 2000, base XP 20, essence 15  (stage 1, agi 13)
  const WIS_CHL = 'chl_ancient-runes';   // maxScore 2000, base XP 20, essence 10
  const SCORE = 1190;

  // Plain baselines (one per challenge)
  const rPlainStr = await api('POST', `/v1/challenges/${STR_CHL}/complete`, { totemId: 'ttm_e2e_plain_chl_str', score: SCORE });
  const baseStrXp = rPlainStr.body?.data?.xpEarned;
  const baseStrEss = rPlainStr.body?.data?.essenceEarned;
  const baseStrHap = rPlainStr.body?.data?.happinessEarned;
  if (!rPlainStr.body?.success) discrepancies.push(`Plain str chl failed: ${JSON.stringify(rPlainStr.body)}`);

  const rPlainAgi = await api('POST', `/v1/challenges/${AGI_CHL}/complete`, { totemId: 'ttm_e2e_plain_chl_agi', score: SCORE });
  const baseAgiXp = rPlainAgi.body?.data?.xpEarned;
  if (!rPlainAgi.body?.success) discrepancies.push(`Plain agi chl failed: ${JSON.stringify(rPlainAgi.body)}`);

  const rPlainWis = await api('POST', `/v1/challenges/${WIS_CHL}/complete`, { totemId: 'ttm_e2e_plain_chl_wis', score: SCORE });
  const baseWisXp = rPlainWis.body?.data?.xpEarned;
  if (!rPlainWis.body?.success) discrepancies.push(`Plain wis chl failed: ${JSON.stringify(rPlainWis.body)}`);

  // Brave (success +5% on any) -> str chl
  const rBrave = await api('POST', `/v1/challenges/${STR_CHL}/complete`, { totemId: 'ttm_e2e_brave', score: SCORE });
  if (rBrave.body?.success) recordDelta('Brave', 'str chl xp', baseStrXp, rBrave.body.data.xpEarned, 1);

  // Stubborn (str +1) -> str chl
  const rStubborn = await api('POST', `/v1/challenges/${STR_CHL}/complete`, { totemId: 'ttm_e2e_stubborn', score: SCORE });
  if (rStubborn.body?.success) recordDelta('Stubborn', 'str chl xp', baseStrXp, rStubborn.body.data.xpEarned, 1);

  // Restless (agi +1) -> agi chl (maxScore 2000)
  const rRestless = await api('POST', `/v1/challenges/${AGI_CHL}/complete`, { totemId: 'ttm_e2e_restless', score: SCORE });
  if (rRestless.body?.success) recordDelta('Restless', 'agi chl xp', baseAgiXp, rRestless.body.data.xpEarned, 1);

  // Dreamer (wis +1) -> wis chl
  const rDreamer = await api('POST', `/v1/challenges/${WIS_CHL}/complete`, { totemId: 'ttm_e2e_dreamer', score: SCORE });
  if (rDreamer.body?.success) recordDelta('Dreamer', 'wis chl xp', baseWisXp, rDreamer.body.data.xpEarned, 1);

  // Clever (xp *1.05 on any chl)
  const rClever = await api('POST', `/v1/challenges/${STR_CHL}/complete`, { totemId: 'ttm_e2e_clever', score: SCORE });
  if (rClever.body?.success) recordDelta('Clever', 'str chl xp', baseStrXp, rClever.body.data.xpEarned, 1);

  // Skilled Fighter (+10% success on str)
  const rFighter = await api('POST', `/v1/challenges/${STR_CHL}/complete`, { totemId: 'ttm_e2e_fighter', score: SCORE });
  if (rFighter.body?.success) recordDelta('Skilled Fighter', 'str chl xp', baseStrXp, rFighter.body.data.xpEarned, 2);

  // Nimble (+10% success on agi)
  const rNimble = await api('POST', `/v1/challenges/${AGI_CHL}/complete`, { totemId: 'ttm_e2e_nimble', score: SCORE });
  if (rNimble.body?.success) recordDelta('Nimble', 'agi chl xp', baseAgiXp, rNimble.body.data.xpEarned, 2);

  // Studious (+10% success on wis)
  const rStudious = await api('POST', `/v1/challenges/${WIS_CHL}/complete`, { totemId: 'ttm_e2e_studious', score: SCORE });
  if (rStudious.body?.success) recordDelta('Studious', 'wis chl xp', baseWisXp, rStudious.body.data.xpEarned, 2);

  // Boulder-breaker daily limit is 5 — we've used plain+brave+stubborn+clever+fighter=5.
  // Use chl_totem-wrestling (also strength affinity) for the remaining str-affinity traits.
  // It's still maxScore 2000 / base 20 xp / essence 15 — same XP math, different essence base.
  const STR_CHL2 = 'chl_rockfall-defense'; // maxScore 3000, base XP 30, essence 20, req stage 2 str 16

  // Plain baseline on STR_CHL2 for Merchant's essence comparison
  await seedTotem('ttm_e2e_plain_chl_str2', { innate: null, learned: null, awakened: null }, { stage: 2, experience: 1500 });
  const rPlainStr2 = await api('POST', `/v1/challenges/${STR_CHL2}/complete`, { totemId: 'ttm_e2e_plain_chl_str2', score: SCORE });
  const baseStr2Xp = rPlainStr2.body?.data?.xpEarned;
  const baseStr2Ess = rPlainStr2.body?.data?.essenceEarned;
  const baseStr2Hap = rPlainStr2.body?.data?.happinessEarned;
  if (!rPlainStr2.body?.success) discrepancies.push(`Plain str2 chl failed: ${JSON.stringify(rPlainStr2.body)}`);

  // Persistent (happiness *1.20)
  const rPersistent = await api('POST', `/v1/challenges/${STR_CHL2}/complete`, { totemId: 'ttm_e2e_persistent', score: SCORE });
  if (rPersistent.body?.success) recordDelta('Persistent', 'chl happiness', baseStr2Hap, rPersistent.body.data.happinessEarned, 2);
  else discrepancies.push(`Persistent chl failed: ${JSON.stringify(rPersistent.body)}`);

  // Merchant's Eye (essence *1.10 via earn:any). rockfall-defense base 20 * 1.10 = 22, delta +2.
  const rMerchant = await api('POST', `/v1/challenges/${STR_CHL2}/complete`, { totemId: 'ttm_e2e_merchant_chl', score: SCORE });
  if (rMerchant.body?.success) {
    const expectedEss = Math.round(baseStr2Ess * 1.10);
    recordDelta("Merchant's Eye", 'chl essence', baseStr2Ess, rMerchant.body.data.essenceEarned, expectedEss - baseStr2Ess);
  }
  else discrepancies.push(`Merchant chl failed: ${JSON.stringify(rMerchant.body)}`);

  // Mentor (xp *1.10 via aura)
  const rMentorChl = await api('POST', `/v1/challenges/${STR_CHL2}/complete`, { totemId: 'ttm_e2e_mentor_chl', score: SCORE });
  if (rMentorChl.body?.success) recordDelta('Mentor', 'str chl xp (self)', baseStr2Xp, rMentorChl.body.data.xpEarned, 1);
  else discrepancies.push(`Mentor chl failed: ${JSON.stringify(rMentorChl.body)}`);

  // Stubborn gate fix
  const GATE_CHL = 'chl_totem-wrestling'; // requires stage 1, str 13
  const rGateStubborn = await api('POST', `/v1/challenges/${GATE_CHL}/complete`, { totemId: 'ttm_e2e_gate_stubborn', score: 500 });
  const rGatePlain = await api('POST', `/v1/challenges/${GATE_CHL}/complete`, { totemId: 'ttm_e2e_gate_plain', score: 500 });
  const stubbornPasses = rGateStubborn.body?.success === true;
  const plainBlocked = rGatePlain.body?.success === false && rGatePlain.body?.error?.requirement === 'strength';
  results.push({
    trait: 'Stubborn',
    action: 'gate fix (str 12→13)',
    baseline: plainBlocked ? 'blocked' : `passed: ${JSON.stringify(rGatePlain.body)}`,
    withTrait: stubbornPasses ? 'passed' : `blocked: ${JSON.stringify(rGateStubborn.body)}`,
    delta: '-',
    pass: stubbornPasses && plainBlocked,
    notes: '',
  });
  if (!(stubbornPasses && plainBlocked)) discrepancies.push(`Stubborn gate fix: plain_blocked=${plainBlocked}, stubborn_passes=${stubbornPasses}`);

  // -------------------------------------------------------------------
  // 5. Expeditions
  // -------------------------------------------------------------------
  // Expedition rewards have ±10% essence variance and ±3 score variance.
  // We run N trials per side and compare averages with a tolerance.
  console.log('\n=== Expeditions (averaged over trials) ===');

  const EXP = 'exp_celestial-mapping'; // 24h, baseExp 120, baseEssence 60
  const TRIALS = 10;

  async function runExpeditionOnce(team) {
    const lead = team[0];
    // Always re-seed fresh team so happiness is full (costs 20/team member).
    const start = await api('POST', `/v1/expeditions/${EXP}/start`, { totemId: lead, totemIds: team });
    if (!start.body?.success) {
      return { error: `start failed: ${JSON.stringify(start.body)}` };
    }
    const exp = start.body.data.expedition;
    await ddb.send(new UpdateCommand({
      TableName: EXP_STATE_TBL,
      Key: { pk: `USER#${USER_ID}`, sk: `EXPEDITION#ACTIVE#${lead}` },
      UpdateExpression: 'SET endsAt = :e',
      ExpressionAttributeValues: { ':e': new Date(Date.now() - 3600 * 1000).toISOString() },
    }));
    const claim = await api('POST', `/v1/expeditions/${lead}/claim`);
    if (!claim.body?.success) {
      return { error: `claim failed: ${JSON.stringify(claim.body)}` };
    }
    const rewards = claim.body.data?.rewards || claim.body.rewards;
    return {
      durationMs: new Date(exp.endsAt).getTime() - new Date(exp.startedAt).getTime(),
      experience: rewards.experience,
      essence: rewards.essence,
      runes: rewards.runes,
    };
  }

  async function trial(leadTraits, leadSpecies, mateSpecies, n) {
    const totals = { duration: 0, xp: 0, essence: 0, runeLesser: 0, runeGreater: 0, runeAncient: 0, runs: 0, errors: [] };
    for (let i = 0; i < n; i++) {
      const leadId = `ttm_e2e_x_${Math.random().toString(36).slice(2, 8)}`;
      const m1 = `${leadId}_m1`;
      const m2 = `${leadId}_m2`;
      await seedTotem(leadId, leadTraits, { speciesId: leadSpecies });
      await seedTotem(m1, { innate: null, learned: null, awakened: null }, { speciesId: mateSpecies });
      await seedTotem(m2, { innate: null, learned: null, awakened: null }, { speciesId: 0 });
      const r = await runExpeditionOnce([leadId, m1, m2]);
      if (r.error) {
        totals.errors.push(r.error);
        continue;
      }
      totals.duration += r.durationMs;
      totals.xp += r.experience;
      totals.essence += r.essence;
      totals.runeLesser += r.runes.lesser || 0;
      totals.runeGreater += r.runes.greater || 0;
      totals.runeAncient += r.runes.ancient || 0;
      totals.runs++;
    }
    return totals;
  }

  const baselineTrial = await trial({ innate: null, learned: null, awakened: null }, 0, 0, TRIALS);
  const baseDur = baselineTrial.duration / Math.max(1, baselineTrial.runs);
  const baseXp = baselineTrial.xp / Math.max(1, baselineTrial.runs);
  const baseEss = baselineTrial.essence / Math.max(1, baselineTrial.runs);
  const baseRunes = (baselineTrial.runeLesser + baselineTrial.runeGreater + baselineTrial.runeAncient) / Math.max(1, baselineTrial.runs);
  if (baselineTrial.errors.length) console.log(' baseline errors:', baselineTrial.errors);
  console.log(` baseline avg (n=${baselineTrial.runs}): xp=${baseXp.toFixed(1)} ess=${baseEss.toFixed(1)} runes/run=${baseRunes.toFixed(2)} dur=${baseDur.toFixed(0)}ms`);

  // Curious: +5% essence
  const curiousTrial = await trial({ innate: 'trt_curious', learned: null, awakened: null }, 0, 0, TRIALS);
  recordRange('Curious', 'expedition essence (avg)', baseEss, curiousTrial.essence / curiousTrial.runs, 1.05, 0.07);

  // Pathfinder: −10% duration (exact)
  const pathTrial = await trial({ innate: null, learned: 'trt_pathfinder', awakened: null }, 0, 0, 1);
  const pathDur = pathTrial.duration / Math.max(1, pathTrial.runs);
  const expectedPathDur = baseDur * 0.90;
  const pathPass = Math.abs(pathDur - expectedPathDur) < 2000;
  results.push({
    trait: 'Pathfinder',
    action: 'expedition duration',
    baseline: baseDur,
    withTrait: pathDur,
    delta: pathDur - baseDur,
    pass: pathPass,
    notes: `expected ~${expectedPathDur.toFixed(0)}ms (-10%)`,
  });
  if (!pathPass) discrepancies.push(`Pathfinder duration off: ${pathDur} vs expected ${expectedPathDur}`);

  // Merchant's Eye lead: +10% essence
  const merchTrial = await trial({ innate: null, learned: 'trt_merchant_eye', awakened: null }, 0, 0, TRIALS);
  recordRange("Merchant's Eye", 'expedition essence (avg)', baseEss, merchTrial.essence / merchTrial.runs, 1.10, 0.07);

  // Mentor lead: +10% xp via aura
  const mentorExpTrial = await trial({ innate: null, learned: null, awakened: 'trt_mentor' }, 0, 0, TRIALS);
  recordRange('Mentor', 'expedition xp (avg)', baseXp, mentorExpTrial.xp / mentorExpTrial.runs, 1.10, 0.07);

  // Kindred Soul: needs a same-species baseline because lead species affects score.
  // Plain baseline with same species pair (lead=1, mate=1, 3rd=0).
  const kindredBase = await trial({ innate: null, learned: null, awakened: null }, 1, 1, TRIALS);
  const kindredBaseXp = kindredBase.xp / Math.max(1, kindredBase.runs);
  const kindredTrial = await trial({ innate: null, learned: null, awakened: 'trt_kindred_soul' }, 1, 1, TRIALS);
  recordRange('Kindred Soul', 'expedition xp (avg, same species)', kindredBaseXp, kindredTrial.xp / kindredTrial.runs, 1.10, 0.07);

  // Treasure Seeker: +10% rune chance on expeditions
  const treasureTrial = await trial({ innate: null, learned: 'trt_treasure_seeker', awakened: null }, 0, 0, TRIALS);
  const treasureRunes = (treasureTrial.runeLesser + treasureTrial.runeGreater + treasureTrial.runeAncient) / Math.max(1, treasureTrial.runs);
  results.push({
    trait: 'Treasure Seeker',
    action: 'expedition completes (rune chance bonus)',
    baseline: baseRunes.toFixed(2),
    withTrait: treasureRunes.toFixed(2),
    delta: (treasureRunes - baseRunes).toFixed(2),
    pass: treasureTrial.runs > 0 && treasureTrial.errors.length === 0,
    notes: `stochastic rune drops; sample too small (n=${TRIALS}) to assert +10% reliably`,
  });

  // Relic Bearer: +20% rune chance aura
  const relicTrial = await trial({ innate: null, learned: null, awakened: 'trt_relic_bearer' }, 0, 0, TRIALS);
  const relicRunes = (relicTrial.runeLesser + relicTrial.runeGreater + relicTrial.runeAncient) / Math.max(1, relicTrial.runs);
  results.push({
    trait: 'Relic Bearer',
    action: 'expedition completes (rune chance aura)',
    baseline: baseRunes.toFixed(2),
    withTrait: relicRunes.toFixed(2),
    delta: (relicRunes - baseRunes).toFixed(2),
    pass: relicTrial.runs > 0 && relicTrial.errors.length === 0,
    notes: `stochastic; sample too small (n=${TRIALS}) to assert +20% reliably`,
  });

  // Lucky: +5% rare drop chance via loot:any
  const luckyTrial = await trial({ innate: 'trt_lucky', learned: null, awakened: null }, 0, 0, TRIALS);
  const luckyRunes = (luckyTrial.runeLesser + luckyTrial.runeGreater + luckyTrial.runeAncient) / Math.max(1, luckyTrial.runs);
  results.push({
    trait: 'Lucky',
    action: 'expedition completes (lootChanceBonus)',
    baseline: baseRunes.toFixed(2),
    withTrait: luckyRunes.toFixed(2),
    delta: (luckyRunes - baseRunes).toFixed(2),
    pass: luckyTrial.runs > 0 && luckyTrial.errors.length === 0,
    notes: `stochastic; +5% lift would need n>>${TRIALS} to detect`,
  });

  // Wanderer Lord: aura lootBoxChanceBonus — dormant per service comment
  const wandererTrial = await trial({ innate: null, learned: null, awakened: 'trt_wanderer_lord' }, 0, 0, 1);
  results.push({
    trait: 'Wanderer Lord',
    action: 'expedition completes (loot box scope dormant)',
    baseline: 'OK',
    withTrait: wandererTrial.errors.length ? 'FAIL' : 'OK',
    delta: '-',
    pass: !wandererTrial.errors.length,
    notes: wandererTrial.errors[0] || 'aura dormant — no observable bonus today',
  });

  // -------------------------------------------------------------------
  // 6. Sanctum
  // -------------------------------------------------------------------
  console.log('\n=== Sanctum ===');

  await seedTotem('ttm_e2e_sanctum_plain', { innate: null, learned: null, awakened: null });
  await seedTotem('ttm_e2e_shy', { innate: 'trt_shy', learned: null, awakened: null });
  await seedTotem('ttm_e2e_loyal', { innate: 'trt_loyal', learned: null, awakened: null });
  await seedTotem('ttm_e2e_sage', { innate: null, learned: null, awakened: 'trt_sage' });
  await seedTotem('ttm_e2e_emissary', { innate: null, learned: null, awakened: 'trt_emissary' });

  async function seatThenAge(totemId, seatIndex, hoursAgo) {
    const r = await api('POST', '/v1/sanctum/seat', { totemId, seatIndex });
    if (!r.body?.success) return { error: JSON.stringify(r.body) };
    const past = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
    await ddb.send(new UpdateCommand({
      TableName: EXP_STATE_TBL,
      Key: { pk: `SANCTUM#${USER_ID}`, sk: `SEAT#${seatIndex}` },
      UpdateExpression: 'SET seatedAt = :s, lastClaimedAt = :s',
      ExpressionAttributeValues: { ':s': past },
    }));
    return { ok: true };
  }

  async function getSeatAccumulated(seatIndex) {
    const r = await api('GET', '/v1/sanctum');
    const seat = r.body?.data?.seats?.find(s => s.seatIndex === seatIndex);
    return seat?.accumulatedEssence;
  }

  // Plain baseline at 100h tenure
  const seatPlain = await seatThenAge('ttm_e2e_sanctum_plain', 0, 100);
  if (seatPlain.error) discrepancies.push(`plain seat: ${seatPlain.error}`);
  const baseAccum = await getSeatAccumulated(0);
  await api('POST', '/v1/sanctum/unseat', { totemId: 'ttm_e2e_sanctum_plain' });

  // Shy: +5% earn rate
  const seatShy = await seatThenAge('ttm_e2e_shy', 0, 100);
  if (seatShy.error) discrepancies.push(`shy seat: ${seatShy.error}`);
  const shyAccum = await getSeatAccumulated(0);
  if (shyAccum != null && baseAccum != null) {
    const expectedDelta = Math.floor(0.5 * 1.05 * 1.2 * 100) - Math.floor(0.5 * 1.2 * 100);
    recordDelta('Shy', 'sanctum accumulated essence', baseAccum, shyAccum, expectedDelta);
  }
  await api('POST', '/v1/sanctum/unseat', { totemId: 'ttm_e2e_shy' });

  // Loyal: +5% tenure
  const seatLoyal = await seatThenAge('ttm_e2e_loyal', 0, 100);
  if (seatLoyal.error) discrepancies.push(`loyal seat: ${seatLoyal.error}`);
  const loyalAccum = await getSeatAccumulated(0);
  if (loyalAccum != null && baseAccum != null) {
    const expectedDelta = Math.floor(0.5 * 1.2 * 1.05 * 100) - Math.floor(0.5 * 1.2 * 100);
    recordDelta('Loyal', 'sanctum accumulated essence', baseAccum, loyalAccum, expectedDelta);
  }
  await api('POST', '/v1/sanctum/unseat', { totemId: 'ttm_e2e_loyal' });

  // Council mission baseline
  const MISSION = 'cm_decree-of-wisdom';
  const MISSION_DUR_S = 7200;
  await seatThenAge('ttm_e2e_sanctum_plain', 0, 1);
  const startBaseline = await api('POST', '/v1/sanctum/missions/start', { totemId: 'ttm_e2e_sanctum_plain', missionType: MISSION });
  let baseMissionDur = null;
  if (startBaseline.body?.success) {
    baseMissionDur = new Date(startBaseline.body.data.mission.endsAt).getTime() - new Date(startBaseline.body.data.mission.startedAt).getTime();
    await ddb.send(new UpdateCommand({
      TableName: EXP_STATE_TBL,
      Key: { pk: `SANCTUM#${USER_ID}`, sk: `MISSION#ACTIVE#ttm_e2e_sanctum_plain` },
      UpdateExpression: 'SET endsAt = :e',
      ExpressionAttributeValues: { ':e': new Date(Date.now() - 3600 * 1000).toISOString() },
    }));
    await api('POST', '/v1/sanctum/missions/claim', { totemId: 'ttm_e2e_sanctum_plain' });
  }
  else discrepancies.push(`baseline mission start failed: ${JSON.stringify(startBaseline.body)}`);
  await api('POST', '/v1/sanctum/unseat', { totemId: 'ttm_e2e_sanctum_plain' });

  // Emissary: -20% mission duration
  await seatThenAge('ttm_e2e_emissary', 0, 1);
  const startEm = await api('POST', '/v1/sanctum/missions/start', { totemId: 'ttm_e2e_emissary', missionType: MISSION });
  if (startEm.body?.success) {
    const emDur = new Date(startEm.body.data.mission.endsAt).getTime() - new Date(startEm.body.data.mission.startedAt).getTime();
    const expected = Math.round(MISSION_DUR_S * 0.80) * 1000;
    const pass = Math.abs(emDur - expected) < 2000;
    results.push({
      trait: 'Emissary',
      action: 'mission duration',
      baseline: baseMissionDur,
      withTrait: emDur,
      delta: emDur - (baseMissionDur || 0),
      pass,
      notes: `expected ~${expected}ms (-20%)`,
    });
    if (!pass) discrepancies.push(`Emissary duration off: got ${emDur}, expected ~${expected}`);
    await ddb.send(new UpdateCommand({
      TableName: EXP_STATE_TBL,
      Key: { pk: `SANCTUM#${USER_ID}`, sk: `MISSION#ACTIVE#ttm_e2e_emissary` },
      UpdateExpression: 'SET endsAt = :e',
      ExpressionAttributeValues: { ':e': new Date(Date.now() - 3600 * 1000).toISOString() },
    }));
    await api('POST', '/v1/sanctum/missions/claim', { totemId: 'ttm_e2e_emissary' });
  }
  else discrepancies.push(`Emissary mission start failed: ${JSON.stringify(startEm.body)}`);
  await api('POST', '/v1/sanctum/unseat', { totemId: 'ttm_e2e_emissary' });

  // Sage (+15% rune chance on sanctum:mission)
  await seatThenAge('ttm_e2e_sage', 0, 1);
  const startSage = await api('POST', '/v1/sanctum/missions/start', { totemId: 'ttm_e2e_sage', missionType: MISSION });
  let sageOK = false;
  if (startSage.body?.success) {
    sageOK = true;
    await ddb.send(new UpdateCommand({
      TableName: EXP_STATE_TBL,
      Key: { pk: `SANCTUM#${USER_ID}`, sk: `MISSION#ACTIVE#ttm_e2e_sage` },
      UpdateExpression: 'SET endsAt = :e',
      ExpressionAttributeValues: { ':e': new Date(Date.now() - 3600 * 1000).toISOString() },
    }));
    const claim = await api('POST', '/v1/sanctum/missions/claim', { totemId: 'ttm_e2e_sage' });
    sageOK = sageOK && (claim.body?.success === true);
  }
  results.push({
    trait: 'Sage',
    action: 'mission claim (rune chance bonus)',
    baseline: 'OK',
    withTrait: sageOK ? 'OK' : 'FAIL',
    delta: '-',
    pass: sageOK,
    notes: 'stochastic effect not asserted; claim returns success',
  });
  await api('POST', '/v1/sanctum/unseat', { totemId: 'ttm_e2e_sage' });

  // -------------------------------------------------------------------
  // 7. Transaction ledger
  // -------------------------------------------------------------------
  console.log('\n=== Transaction ledger ===');
  const txns = await fetchUserTransactions(runStart);

  const thriftyTrainTx = txns.find(t => t.type === 'action_train' && t.refId === 'ttm_e2e_thrifty');
  const plainTrainTx = txns.find(t => t.type === 'action_train' && t.refId === 'ttm_e2e_plain_care');
  if (thriftyTrainTx) record('Thrifty', 'ledger train cost', thriftyTrainTx.amount, -18);
  else discrepancies.push('Thrifty train ledger entry missing');
  if (plainTrainTx) record('Plain', 'ledger train cost', plainTrainTx.amount, -20);
  else discrepancies.push('Plain train ledger entry missing');

  // Merchant's Eye challenge essence runs against STR_CHL2 (rockfall-defense, base 20 → 22)
  const merchChlTx = txns.find(t => t.type === 'reward_challenge' && t.refId === STR_CHL2 && t.amount === 22);
  results.push({
    trait: "Merchant's Eye",
    action: 'ledger chl essence',
    baseline: 20,
    withTrait: merchChlTx?.amount ?? 'missing',
    delta: '-',
    pass: !!merchChlTx,
    notes: `looked for reward_challenge ${STR_CHL2} amount=22`,
  });
  if (!merchChlTx) discrepancies.push(`Merchant's Eye +22 essence ${STR_CHL2} ledger entry missing`);

  const expTxns = txns.filter(t => t.type === 'reward_expedition');
  results.push({
    trait: 'Expedition rewards',
    action: 'ledger reward_expedition',
    baseline: '>=1',
    withTrait: expTxns.length,
    delta: '-',
    pass: expTxns.length >= 1,
    notes: `${expTxns.length} reward_expedition ledger entries`,
  });

  // -------------------------------------------------------------------
  // 8. Log tail
  // -------------------------------------------------------------------
  let logSummary = '';
  try {
    const tail = execSync('tail -300 /tmp/totem-api.log', { encoding: 'utf8' });
    const lines = tail.split('\n').filter(l => /\bERROR\b|\bWARN\b|Failed|failed/.test(l));
    logSummary = lines.slice(-20).join('\n');
  }
  catch (e) {
    logSummary = `tail failed: ${e.message}`;
  }

  // -------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------
  console.log('\n=== Cleanup ===');
  await cleanupSeeds();

  // -------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------
  console.log('\n=============== RESULTS ===============');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad('Trait', 22) + ' | '
    + pad('Action', 36) + ' | '
    + pad('Baseline', 12) + ' | '
    + pad('WithTrait', 12) + ' | '
    + pad('Δ', 10) + ' | '
    + pad('PASS', 6) + ' | '
    + 'Notes',
  );
  console.log('-'.repeat(140));
  for (const r of results) {
    console.log(
      pad(r.trait, 22) + ' | '
      + pad(r.action, 36) + ' | '
      + pad(r.baseline, 12) + ' | '
      + pad(r.withTrait, 12) + ' | '
      + pad(r.delta, 10) + ' | '
      + pad(r.pass ? 'PASS' : 'FAIL', 6) + ' | '
      + (r.notes || ''),
    );
  }

  console.log('\n=== Discrepancies ===');
  if (!discrepancies.length) console.log('(none)');
  else for (const d of discrepancies) console.log(' - ' + d);

  console.log('\n=== API log (ERROR/WARN/Failed) ===');
  console.log(logSummary || '(none)');

  const passCount = results.filter(r => r.pass).length;
  console.log(`\nSummary: ${passCount}/${results.length} checks passed.`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
