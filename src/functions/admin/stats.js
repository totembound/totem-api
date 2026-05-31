/**
 * Admin Stats Handler
 *
 * GET /v1/admin/stats — Dashboard overview metrics.
 *
 * The API runs on Lambda, so the durable "cache" is NOT in-process — it's the
 * latest precomputed snapshot in AdminStatsHistory, written on a cron by the
 * stats-snapshot Lambda (see functions/admin/stats-snapshot.js). This endpoint:
 *   1. Reads the most recent HOURLY snapshot (a single cheap Query, shared across
 *      the whole fleet) and returns it when it's recent enough.
 *   2. Falls back to a LIVE compute (the expensive scans, hardened with
 *      allSettled + a user-scan safety cap) when there's no snapshot yet or the
 *      latest is stale — or when `?fresh=1` forces it.
 * The response carries `source` ('snapshot' | 'live') and `generatedAt` so the
 * UI can show freshness.
 */

const { getLatestSnapshot } = require('../../common/db-client');
const { computeSnapshot } = require('../../services/admin-stats-service');

// How old the latest hourly snapshot may be before we recompute live. Hourly
// snapshots land ~once an hour, so allow a little slack.
const SNAPSHOT_MAX_AGE_MS = parseInt(process.env.ADMIN_STATS_SNAPSHOT_MAX_AGE_MS, 10)
  || 90 * 60 * 1000; // 90 min

function snapshotIsFresh(snapshot) {
  if (!snapshot?.generatedAt) return false;
  const age = Date.now() - new Date(snapshot.generatedAt).getTime();
  return age >= 0 && age <= SNAPSHOT_MAX_AGE_MS;
}

async function get(req, res) {
  try {
    const bypass = req.query.fresh === '1' || req.query.fresh === 'true';

    if (!bypass) {
      let latest = null;
      try {
        latest = await getLatestSnapshot('HOURLY');
      }
      catch (err) {
        // Table missing / read error → just fall through to live compute.
        console.warn('[Admin] stats: snapshot read failed, computing live:', err.message);
      }

      if (latest && snapshotIsFresh(latest)) {
        return res.status(200).json({
          success: true,
          data: {
            users: latest.users,
            totems: latest.totems,
            transactions: latest.transactions,
            economy: latest.economy,
            generatedAt: latest.generatedAt,
            source: 'snapshot',
            ...(latest.partial ? { partial: latest.partial } : {}),
          },
        });
      }
    }

    const snapshot = await computeSnapshot();
    return res.status(200).json({
      success: true,
      data: { ...snapshot, source: 'live' },
    });
  }
  catch (error) {
    console.error('[Admin] Stats error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}

module.exports = { get };
