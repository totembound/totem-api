/**
 * Admin Stats Trends Handler
 *
 * GET /v1/admin/stats/trends — time series from AdminStatsHistory for charts.
 *
 * Query params:
 *   granularity - hourly | daily | weekly   (default: daily)
 *   from        - ISO timestamp             (default: granularity-dependent window)
 *   to          - ISO timestamp             (default: now)
 *   metrics     - comma-separated dot paths into the snapshot
 *                 (e.g. users.activeToday,transactions.essenceVolume)
 *                 When omitted, returns the full users/totems/transactions/economy maps.
 *
 * All reads are a bounded Query on (pk, sk BETWEEN from..to) — cheap.
 */

const { queryStatsTrends } = require('../../common/db-client');

// Default lookback window per granularity (ms).
const DEFAULT_WINDOW_MS = {
  HOURLY: 24 * 60 * 60 * 1000, // 24h
  DAILY: 30 * 24 * 60 * 60 * 1000, // 30d
  WEEKLY: 12 * 7 * 24 * 60 * 60 * 1000, // 12w
};

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function get(req, res) {
  try {
    const granularity = String(req.query.granularity || 'daily').toUpperCase();
    if (!['HOURLY', 'DAILY', 'WEEKLY'].includes(granularity)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_GRANULARITY', message: 'granularity must be hourly, daily, or weekly' },
      });
    }

    const now = new Date();
    const to = req.query.to || now.toISOString();
    const from = req.query.from
      || new Date(now.getTime() - DEFAULT_WINDOW_MS[granularity]).toISOString();

    // Validate caller-supplied bounds — garbage would otherwise produce a
    // confusing empty result from the SK range query rather than an error.
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_RANGE', message: 'from/to must be valid ISO timestamps' },
      });
    }
    if (from > to) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_RANGE', message: 'from must be <= to' },
      });
    }

    const metrics = req.query.metrics
      ? String(req.query.metrics).split(',').map((m) => m.trim()).filter(Boolean)
      : null;

    const rows = await queryStatsTrends({ granularity, from, to });

    const points = rows.map((row) => {
      const ts = row.bucketStart || (row.sk || '').replace(/^TS#/, '');
      if (!metrics) {
        return {
          ts,
          users: row.users,
          totems: row.totems,
          transactions: row.transactions,
          economy: row.economy,
        };
      }
      const point = { ts };
      for (const path of metrics) {
        point[path] = getPath(row, path) ?? null;
      }
      return point;
    });

    return res.status(200).json({
      success: true,
      data: { granularity, from, to, count: points.length, points },
    });
  }
  catch (error) {
    console.error('[Admin] Stats trends error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}

module.exports = { get };
