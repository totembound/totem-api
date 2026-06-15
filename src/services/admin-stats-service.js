/**
 * Admin Stats Service
 *
 * Single source of truth for computing the platform stats snapshot. Used by both
 * the live GET /v1/admin/stats endpoint (as a fallback) and the scheduled
 * stats-snapshot writer that persists time-bucketed snapshots to
 * AdminStatsHistory for trend charts.
 *
 * Users + totems are still walk-all scans (slated for counter rows — scaling plan
 * P2), each isolated with allSettled so one slow/failed scan degrades that section
 * to nulls (+ a `partial` marker) rather than failing everything.
 *
 * Transactions are NOT scanned. They are aggregated incrementally:
 *   - each HOURLY snapshot stores `txWindow` = the just-completed clock hour's
 *     aggregate (one bounded date-ts-index query, ~1h of rows);
 *   - today / thisWeek are rolled up by summing the stored hourly `txWindow`
 *     slices for the trailing 7 days (one bounded Query of ≤~170 tiny rows) plus
 *     the current partial hour read live (another ~1h query).
 * Cost is therefore flat regardless of how large the Transactions table grows —
 * we never re-read a week of raw ledger rows.
 */

const {
  scanAllUsers, countTotems, aggregateTransactions, queryStatsTrends,
} = require('../common/db-client');

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Fold a set of {count, byType, essenceVolume, gemsVolume} slices into one total. */
function foldSlices(slices) {
  const out = { count: 0, byType: {}, essenceVolume: 0, gemsVolume: 0 };
  for (const s of slices) {
    out.count += s.count || 0;
    out.essenceVolume += s.essenceVolume || 0;
    out.gemsVolume += s.gemsVolume || 0;
    for (const [type, v] of Object.entries(s.byType || {})) {
      if (!out.byType[type]) out.byType[type] = { count: 0, essenceVolume: 0, gemsVolume: 0 };
      out.byType[type].count += v.count || 0;
      out.byType[type].essenceVolume += v.essenceVolume || 0;
      out.byType[type].gemsVolume += v.gemsVolume || 0;
    }
  }
  return out;
}

/**
 * Roll up the transaction display object (today + thisWeek) from stored hourly
 * slices + the two live boundary hours, and return the slice to persist for this
 * bucket (`txWindow` = the completed clock hour ending at `hourStart`).
 *
 * Slices are clock-hour aligned, so day/week boundaries are exact (a clock hour
 * never straddles midnight). The current partial hour is read live so the figures
 * are current to within the snapshot's own freshness, not an hour stale.
 */
async function computeTransactions(now) {
  const hourStart = new Date(now); hourStart.setUTCMinutes(0, 0, 0);
  const prevHourStart = new Date(hourStart.getTime() - HOUR_MS);
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - WEEK_MS);

  const hourStartIso = hourStart.toISOString();
  const prevHourStartIso = prevHourStart.toISOString();
  const todayStartIso = todayStart.toISOString();
  const weekStartIso = weekStart.toISOString();

  // Boundary hours read live: the just-completed clock hour (persisted as this
  // bucket's txWindow) and the in-progress hour (display only, never stored).
  const [prevHour, currHour, buckets] = await Promise.all([
    aggregateTransactions({ startTime: prevHourStartIso, endTime: hourStartIso }),
    aggregateTransactions({ startTime: hourStartIso, endTime: now.toISOString() }),
    // Stored hourly slices strictly before this run's completed hour, back a week.
    queryStatsTrends({ granularity: 'HOURLY', from: weekStartIso, to: prevHourStartIso }),
  ]);

  // Assemble the contiguous, non-overlapping slice set: stored history + the two
  // boundary hours. Dedupe by fromTs in case a retry already stored this hour.
  const byFrom = new Map();
  for (const b of buckets) {
    if (b.txWindow && b.txWindow.fromTs) byFrom.set(b.txWindow.fromTs, b.txWindow);
  }
  byFrom.set(prevHourStartIso, { ...prevHour, fromTs: prevHourStartIso, toTs: hourStartIso });
  byFrom.set(hourStartIso, { ...currHour, fromTs: hourStartIso, toTs: now.toISOString() });
  const slices = [...byFrom.values()];

  const week = foldSlices(slices.filter((s) => s.fromTs >= weekStartIso));
  const today = foldSlices(slices.filter((s) => s.fromTs >= todayStartIso));

  const display = {
    today: { count: today.count },
    thisWeek: { count: week.count },
    byType: week.byType,
    essenceVolume: week.essenceVolume,
    gemsVolume: week.gemsVolume,
  };
  const txWindow = { ...prevHour, fromTs: prevHourStartIso, toTs: hourStartIso };
  return { display, txWindow };
}

async function computeSnapshot({ now = new Date() } = {}) {
  const [usersRes, totemsRes, txRes] = await Promise.allSettled([
    scanAllUsers(),
    countTotems(),
    computeTransactions(now),
  ]);

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
      // Activity is keyed off updatedAt (bumped by every user mutation: game
      // actions, daily claims, currency changes) rather than lastLoginDate, which
      // is only written on a fresh login and goes stale for persisted/token
      // sessions — undercounting active players to ~0.
      activeToday: allUsers.filter((u) => u.updatedAt?.startsWith(todayStr)).length,
      activeThisWeek: allUsers.filter((u) => u.updatedAt >= weekAgoStr).length,
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

  // --- Transactions (incremental rollup) -----------------------------------
  let transactions;
  let txWindow;
  if (txRes.status === 'fulfilled') {
    transactions = txRes.value.display;
    txWindow = txRes.value.txWindow;
  }
  else {
    console.error('[stats-service] transaction rollup failed:', txRes.reason?.message);
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
    // Internal: the completed-clock-hour slice the HOURLY writer persists so the
    // next rollup is cheap. Omitted on partial transactions; ignored by callers
    // other than the snapshot writer.
    ...(txWindow ? { txWindow } : {}),
    generatedAt: now.toISOString(),
    ...(partial.length > 0 ? { partial } : {}),
  };
}

module.exports = { computeSnapshot };
