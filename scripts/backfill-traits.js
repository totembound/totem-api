#!/usr/bin/env node
/**
 * Backfill Traits for Pre-Existing Totems
 *
 * Scans TotemBound-Totems and assigns a random Innate trait to any totem
 * that doesn't already have traits.innate set. Leaves learned/awakened null
 * regardless of stage — players choose those themselves on next login (the
 * detail-page banner prompts them).
 *
 * Idempotent: re-running skips records that already have traits.innate.
 *
 * Usage:
 *   node scripts/backfill-traits.js [--dry-run]
 *
 * Local dev:
 *   IS_LOCAL=true node scripts/backfill-traits.js
 */

require('dotenv').config({ path: '.env.local' });

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { pickRandomInnate } = require('../src/config/traits');

const TABLE_NAME = process.env.TOTEMS_TABLE || 'TotemBound-Totems';
const IS_LOCAL = process.env.IS_LOCAL === 'true';

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

async function main() {
  console.log(`Backfill Traits — table=${TABLE_NAME} dryRun=${dryRun}`);
  const items = await scanAll();
  console.log(`Scanned ${items.length} totems.`);

  const toUpdate = items.filter((t) => !t.traits || !t.traits.innate);
  console.log(`Needs backfill: ${toUpdate.length} (already-traited: ${items.length - toUpdate.length}).`);

  if (toUpdate.length === 0) {
    console.log('Nothing to do. Exiting.');
    return;
  }

  if (dryRun) {
    console.log('Dry run — would update:');
    for (const t of toUpdate.slice(0, 10)) {
      console.log(`  ${t.id} stage=${t.stage}`);
    }
    if (toUpdate.length > 10) console.log(`  ... and ${toUpdate.length - 10} more`);
    return;
  }

  // BatchWriteItem in chunks of 25
  let written = 0;
  for (const batch of chunk(toUpdate, 25)) {
    const putRequests = batch.map((totem) => {
      const traits = {
        innate: (totem.traits && totem.traits.innate) || pickRandomInnate(),
        learned: (totem.traits && totem.traits.learned) || null,
        awakened: (totem.traits && totem.traits.awakened) || null,
      };
      return {
        PutRequest: {
          Item: {
            ...totem,
            traits,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });

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
  console.log(`\nDone. Backfilled ${written} totems.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
