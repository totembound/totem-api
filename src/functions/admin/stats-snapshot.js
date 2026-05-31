/**
 * Stats Snapshot Writer
 *
 * Computes a platform stats snapshot and persists it to AdminStatsHistory,
 * bucketed by granularity (HOURLY / DAILY / WEEKLY). This is the SINGLE SOURCE
 * OF TRUTH for snapshotting — invoked three ways:
 *   - AWS:   EventBridge schedule rules → this Lambda `handler` (granularity in
 *            the event payload).
 *   - Local: node-cron registered in local-server.js (IS_LOCAL), same cadences.
 *   - Manual: scripts/run-snapshot.js for on-demand / test runs.
 *
 * Idempotent: a duplicate fire for the same bucket is a no-op (ConditionExpression
 * on the sort key in db-client.putStatsSnapshot).
 */

const { putStatsSnapshot } = require('../../common/db-client');
const { computeSnapshot } = require('../../services/admin-stats-service');

const GRANULARITIES = ['HOURLY', 'DAILY', 'WEEKLY'];

// Retention by granularity (days). Weekly is kept indefinitely (no TTL).
const RETENTION_DAYS = { HOURLY: 90, DAILY: 730, WEEKLY: null };

/**
 * Floor `now` to the start of its bucket window for the granularity (UTC).
 */
function bucketStart(now, granularity) {
  const d = new Date(now.getTime());
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(0);
  if (granularity === 'HOURLY') return d;
  d.setUTCHours(0);
  if (granularity === 'DAILY') return d;
  // WEEKLY → back up to Sunday 00:00 UTC
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function ttlForGranularity(now, granularity) {
  const days = RETENTION_DAYS[granularity];
  if (!days) return undefined;
  return Math.floor(now.getTime() / 1000) + days * 24 * 60 * 60;
}

/**
 * Compute + persist a single snapshot.
 *
 * @param {object} opts - { granularity = 'HOURLY', now = new Date() }
 * @returns {Promise<{ granularity, bucket, written, partial }>}
 */
async function runSnapshot({ granularity = 'HOURLY', now = new Date() } = {}) {
  const gran = String(granularity).toUpperCase();
  if (!GRANULARITIES.includes(gran)) {
    throw new Error(`Invalid granularity "${granularity}" (expected one of ${GRANULARITIES.join(', ')})`);
  }

  const snapshot = await computeSnapshot();
  const bucket = bucketStart(now, gran).toISOString();

  // Never persist a partial snapshot. If a scan failed, the snapshot has null
  // sections; writing it would (a) become the bucket's canonical row and (b) be
  // frozen there by the idempotent write, so a later healthy run in the same
  // bucket couldn't replace it — and /admin/stats would serve nulls as "fresh".
  // Skip instead: a healthy run later in the same bucket writes the real row;
  // if every run in the bucket is partial, there's simply no snapshot and the
  // read endpoint falls back to a live compute.
  if (snapshot.partial && snapshot.partial.length > 0) {
    console.warn(
      `[stats-snapshot] ${gran} bucket ${bucket} → SKIPPED (partial: ${snapshot.partial.join(',')}) — not persisting incomplete data`,
    );
    return { granularity: gran, bucket, written: false, skipped: 'partial', partial: snapshot.partial };
  }

  const ttl = ttlForGranularity(now, gran);

  const item = {
    pk: `BUCKET#${gran}`,
    sk: `TS#${bucket}`,
    granularity: gran,
    bucketStart: bucket,
    users: snapshot.users,
    totems: snapshot.totems,
    transactions: snapshot.transactions,
    economy: snapshot.economy,
    generatedAt: snapshot.generatedAt,
    ...(ttl != null ? { ttl } : {}),
  };

  const { written } = await putStatsSnapshot(item);

  console.log(
    `[stats-snapshot] ${gran} bucket ${bucket} → ${written ? 'written' : 'already existed (no-op)'}`
    + `${snapshot.partial ? ` [partial: ${snapshot.partial.join(',')}]` : ''}`,
  );

  return { granularity: gran, bucket, written, partial: snapshot.partial };
}

/**
 * Lambda entry point. EventBridge rules pass `{ granularity }` in the event.
 */
async function handler(event) {
  const granularity = event?.granularity || 'HOURLY';
  try {
    return await runSnapshot({ granularity });
  }
  catch (err) {
    console.error('[stats-snapshot] failed:', err.message);
    throw err;
  }
}

module.exports = { runSnapshot, handler, bucketStart, ttlForGranularity, GRANULARITIES };
