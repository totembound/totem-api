/**
 * Admin Stats Service
 *
 * Single source of truth for computing the platform stats snapshot. Used by both
 * the live GET /v1/admin/stats endpoint (as a fallback) and the scheduled
 * stats-snapshot writer that persists time-bucketed snapshots to
 * AdminStatsHistory for trend charts.
 *
 * The underlying reads are walk-all scans (users + totems) plus a recent
 * transactions scan — expensive at scale, which is exactly why the snapshot
 * writer runs them on a cron and the live endpoint prefers the stored snapshot.
 * Each source is isolated with allSettled so one slow/failed scan degrades that
 * section to nulls (+ a `partial` marker) rather than failing everything.
 */

const { scanAllUsers, countTotems, scanRecentTransactions } = require('../common/db-client');

async function computeSnapshot() {
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

  // --- Users + economy (both derived from the user scan) -------------------
  let users;
  let economy;
  if (usersRes.status === 'fulfilled') {
    const allUsers = usersRes.value;

    const byTier = {};
    let essenceInCirculation = 0;
    let gemsInCirculation = 0;
    for (const u of allUsers) {
      const tier = u.tier || 'free';
      byTier[tier] = (byTier[tier] || 0) + 1;
      essenceInCirculation += u.currencies?.essence || 0;
      gemsInCirculation += u.currencies?.gems || 0;
    }

    users = {
      total: allUsers.length,
      activeToday: allUsers.filter((u) => u.stats?.lastLoginDate === todayStr).length,
      activeThisWeek: allUsers.filter((u) => u.stats?.lastLoginDate >= weekAgoStr).length,
      newToday: allUsers.filter((u) => u.createdAt && u.createdAt.startsWith(todayStr)).length,
      banned: allUsers.filter((u) => u.status === 'banned').length,
      byTier,
    };
    economy = { essenceInCirculation, gemsInCirculation };
  }
  else {
    console.error('[stats-service] scanAllUsers failed:', usersRes.reason?.message);
    partial.push('users');
    users = { total: null, activeToday: null, activeThisWeek: null, newToday: null, banned: null, byTier: {} };
    economy = { essenceInCirculation: null, gemsInCirculation: null };
  }

  // --- Totems --------------------------------------------------------------
  let totems;
  if (totemsRes.status === 'fulfilled') {
    totems = { total: totemsRes.value };
  }
  else {
    console.error('[stats-service] countTotems failed:', totemsRes.reason?.message);
    partial.push('totems');
    totems = { total: null };
  }

  // --- Transactions --------------------------------------------------------
  let transactions;
  if (txRes.status === 'fulfilled') {
    const recentTransactions = txRes.value;
    const todayTxns = recentTransactions.filter((t) => t.ts && t.ts.startsWith(todayStr));
    const weekTxns = recentTransactions.filter((t) => t.ts && t.ts >= weekAgo.toISOString());

    const byType = {};
    let essenceVolume = 0;
    let gemsVolume = 0;
    for (const t of recentTransactions) {
      if (!byType[t.type]) {
        byType[t.type] = { count: 0, essenceVolume: 0, gemsVolume: 0 };
      }
      byType[t.type].count++;
      const amt = Math.abs(t.amount || 0);
      if (t.currency === 'essence') {
        byType[t.type].essenceVolume += amt;
        essenceVolume += amt;
      }
      else if (t.currency === 'gems') {
        byType[t.type].gemsVolume += amt;
        gemsVolume += amt;
      }
    }

    transactions = {
      today: { count: todayTxns.length },
      thisWeek: { count: weekTxns.length },
      byType,
      essenceVolume,
      gemsVolume,
    };
  }
  else {
    console.error('[stats-service] scanRecentTransactions failed:', txRes.reason?.message);
    partial.push('transactions');
    transactions = {
      today: { count: null },
      thisWeek: { count: null },
      byType: {},
      essenceVolume: null,
      gemsVolume: null,
    };
  }

  return {
    users,
    totems,
    transactions,
    economy,
    generatedAt: now.toISOString(),
    ...(partial.length > 0 ? { partial } : {}),
  };
}

module.exports = { computeSnapshot };
