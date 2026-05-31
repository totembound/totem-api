#!/usr/bin/env node
/**
 * Backfill / Recompute Rarity Stats for Pre-Existing Totems
 *
 * Recomputes each totem's strength/agility/wisdom from first principles so they
 * reflect the current rarity stat-bonus ladder. Stats are fully deterministic:
 *
 *     stat = min(100, baseStats[stat] + rarityBonus + evolutionAccumulated(stage))
 *
 *   - baseStats           — from species config (src/data/totem-config.json)
 *   - rarityBonus         — RARITIES[rarityId].statBonus (the value we just changed:
 *                           Common 0, Uncommon 1, Rare 2, Epic 3, Limited 4, Legendary 6)
 *   - evolutionAccumulated — each evolution grants +newStage (stage 1→+1, 2→+2, 3→+3,
 *                            4→+4), so a totem at stage S has accumulated 1+2+...+S =
 *                            S*(S+1)/2  (0/1/3/6/10 for stages 0..4).
 *
 * Training adds no stats and prestige doesn't alter stats, so this recompute is exact.
 * happiness and hunger are dynamic (action-driven) and are LEFT UNTOUCHED.
 *
 * Idempotent: recompute is pure, so re-running converges — totems already at the
 * correct values are reported as unchanged and not rewritten.
 *
 * STAGING ONLY. Stats are denormalized at creation; prod has no data yet.
 *
 * Usage:
 *   node scripts/backfill-rarity-stats.js [--dry-run]
 *
 * Local dev:
 *   IS_LOCAL=true node scripts/backfill-rarity-stats.js --dry-run
 */

require('dotenv').config({ path: '.env.local' });

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { SPECIES, RARITIES } = require('../src/config/totem-config');

const TABLE_NAME = process.env.TOTEMS_TABLE || 'TotemBound-Totems';
const IS_LOCAL = process.env.IS_LOCAL === 'true';
const MAX_STAGE = 4;

const ddb = new DynamoDBClient(
  IS_LOCAL
    ? {
      endpoint: 'http://localhost:8000',
      region: 'us-west-2',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }
    : { region: process.env.AWS_REGION || 'us-west-2' }
);
const client = DynamoDBDocumentClient.from(ddb);

const dryRun = process.argv.includes('--dry-run');

async function scanAll() {
  const items = [];
  let lastKey;
  do {
    const r = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Cumulative evolution bonus a totem at `stage` has received: 1+2+...+stage.
function evolutionAccumulated(stage) {
  const s = Math.max(0, Math.min(MAX_STAGE, stage || 0));
  return (s * (s + 1)) / 2;
}

// Returns { stats } with recomputed str/agi/wis, or null if config can't be resolved.
function recomputeStats(totem) {
  const species = SPECIES[totem.speciesId];
  const rarity = RARITIES[totem.rarityId];
  if (!species || !species.baseStats || !rarity) return null;

  const base = species.baseStats;
  const bonus = (rarity.statBonus || 0) + evolutionAccumulated(totem.stage);
  const cur = totem.stats || {};

  return {
    ...cur,
    strength: Math.min(100, base.strength + bonus),
    agility: Math.min(100, base.agility + bonus),
    wisdom: Math.min(100, base.wisdom + bonus),
    // happiness & hunger preserved from `...cur`
  };
}

function changed(a, b) {
  return a.strength !== b.strength || a.agility !== b.agility || a.wisdom !== b.wisdom;
}

async function main() {
  console.log(`Recompute Rarity Stats — table=${TABLE_NAME} dryRun=${dryRun}`);
  const items = await scanAll();
  console.log(`Scanned ${items.length} totems.`);

  const skipped = [];
  const toUpdate = [];
  for (const t of items) {
    const next = recomputeStats(t);
    if (!next) {
      skipped.push(t);
      continue;
    }
    if (changed(t.stats || {}, next)) {
      toUpdate.push({ totem: t, next });
    }
  }

  if (skipped.length) {
    console.log(`\nWARNING: ${skipped.length} totems skipped (unknown species/rarity):`);
    for (const t of skipped.slice(0, 10)) {
      console.log(`  ${t.id} speciesId=${t.speciesId} rarityId=${t.rarityId}`);
    }
  }

  console.log(`\nNeeds recompute: ${toUpdate.length} (already-correct: ${items.length - toUpdate.length - skipped.length}).`);

  if (toUpdate.length === 0) {
    console.log('Nothing to do. Exiting.');
    return;
  }

  if (dryRun) {
    const rname = (id) => (RARITIES[id] && RARITIES[id].name) || `r${id}`;
    console.log('\nDry run — would update (showing up to 20):');
    for (const { totem: t, next } of toUpdate.slice(0, 20)) {
      const c = t.stats || {};
      console.log(
        `  ${t.id} ${rname(t.rarityId)} stage=${t.stage}  ` +
        `str ${c.strength}->${next.strength}  agi ${c.agility}->${next.agility}  wis ${c.wisdom}->${next.wisdom}`
      );
    }
    if (toUpdate.length > 20) console.log(`  ... and ${toUpdate.length - 20} more`);
    return;
  }

  // BatchWriteItem in chunks of 25
  let written = 0;
  for (const batch of chunk(toUpdate, 25)) {
    const putRequests = batch.map(({ totem, next }) => ({
      PutRequest: {
        Item: {
          ...totem,
          stats: next,
          updatedAt: new Date().toISOString(),
        },
      },
    }));

    const r = await client.send(new BatchWriteCommand({
      RequestItems: { [TABLE_NAME]: putRequests },
    }));

    written += batch.length;
    const unprocessed = r.UnprocessedItems?.[TABLE_NAME]?.length || 0;
    process.stdout.write(`\rWrote ${written}/${toUpdate.length}${unprocessed ? ` (${unprocessed} unprocessed — retrying)` : ''}`);

    if (unprocessed > 0) {
      // Simple retry: re-send unprocessed once
      await client.send(new BatchWriteCommand({
        RequestItems: r.UnprocessedItems,
      }));
    }
  }
  console.log(`\nDone. Recomputed ${written} totems.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
