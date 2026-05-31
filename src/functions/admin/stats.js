/**
 * Admin Stats Handler
 *
 * GET /v1/admin/stats — Dashboard overview metrics
 *
 * The counts come from walk-all scans (users + totems) plus a recent-transactions
 * scan — inherently expensive at scale. NOTE: the API runs on Lambda, so an
 * in-process cache is NOT a valid fix here (per-container memory, wiped on cold
 * starts, not shared across concurrent containers). The durable fix is to read a
 * PRECOMPUTED snapshot from the AdminStatsHistory table written by the scheduled
 * stats-snapshot Lambda (scaling plan P2 / analytics-pipeline tasks) — a single
 * cheap Query shared across the whole fleet, instead of scanning live on every
 * request. Until that lands, this endpoint live-scans, hardened two ways:
 *   1. Per-metric resilience (allSettled) so one slow/failed scan returns partial
 *      data (that section nulled + a `partial` marker) instead of 500-ing.
 *   2. A safety cap on the unbounded user scan (in db-client), logged when hit.
 */

const { scanAllUsers, countTotems, scanRecentTransactions } = require('../../common/db-client');

async function get(req, res) {
  try {
    // Each expensive source is isolated: a single failure degrades to nulls for
    // that section rather than failing the whole response.
    const [usersRes, totemsRes, txRes] = await Promise.allSettled([
      scanAllUsers(),
      countTotems(),
      scanRecentTransactions({ limit: 500 }),
    ]);

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    const partial = [];

    // --- Users -------------------------------------------------------------
    let users;
    if (usersRes.status === 'fulfilled') {
      const allUsers = usersRes.value;
      users = {
        total: allUsers.length,
        activeToday: allUsers.filter((u) => u.stats?.lastLoginDate === todayStr).length,
        activeThisWeek: allUsers.filter((u) => u.stats?.lastLoginDate >= weekAgoStr).length,
        newToday: allUsers.filter((u) => u.createdAt && u.createdAt.startsWith(todayStr)).length,
        banned: allUsers.filter((u) => u.status === 'banned').length,
      };
    }
    else {
      console.error('[Admin] stats: scanAllUsers failed:', usersRes.reason?.message);
      partial.push('users');
      users = { total: null, activeToday: null, activeThisWeek: null, newToday: null, banned: null };
    }

    // --- Totems ------------------------------------------------------------
    let totems;
    if (totemsRes.status === 'fulfilled') {
      totems = { total: totemsRes.value };
    }
    else {
      console.error('[Admin] stats: countTotems failed:', totemsRes.reason?.message);
      partial.push('totems');
      totems = { total: null };
    }

    // --- Transactions ------------------------------------------------------
    let transactions;
    if (txRes.status === 'fulfilled') {
      const recentTransactions = txRes.value;
      const todayTxns = recentTransactions.filter((t) => t.ts && t.ts.startsWith(todayStr));
      const weekTxns = recentTransactions.filter((t) => t.ts && t.ts >= weekAgo.toISOString());

      const byType = {};
      for (const t of recentTransactions) {
        if (!byType[t.type]) {
          byType[t.type] = { count: 0, essenceVolume: 0, gemsVolume: 0 };
        }
        byType[t.type].count++;
        if (t.currency === 'essence') {
          byType[t.type].essenceVolume += Math.abs(t.amount || 0);
        }
        else if (t.currency === 'gems') {
          byType[t.type].gemsVolume += Math.abs(t.amount || 0);
        }
      }

      transactions = {
        today: { count: todayTxns.length },
        thisWeek: { count: weekTxns.length },
        byType,
      };
    }
    else {
      console.error('[Admin] stats: scanRecentTransactions failed:', txRes.reason?.message);
      partial.push('transactions');
      transactions = { today: { count: null }, thisWeek: { count: null }, byType: {} };
    }

    return res.status(200).json({
      success: true,
      data: {
        users,
        totems,
        transactions,
        generatedAt: now.toISOString(),
        ...(partial.length > 0 ? { partial } : {}),
      },
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
