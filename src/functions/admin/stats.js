/**
 * Admin Stats Handler
 *
 * GET /v1/admin/stats — Dashboard overview metrics
 */

const { listUsers, countTotems, listAllTransactions } = require('../../common/db-client');

async function get(req, res) {
  try {
    const [allUsers, totemCount, recentTransactions] = await Promise.all([
      listUsers(),
      countTotems(),
      listAllTransactions({ limit: 500 }),
    ]);

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    // User stats
    const activeToday = allUsers.filter((u) => u.stats?.lastLoginDate === todayStr).length;
    const activeThisWeek = allUsers.filter((u) => u.stats?.lastLoginDate >= weekAgoStr).length;
    const newToday = allUsers.filter((u) => u.createdAt && u.createdAt.startsWith(todayStr)).length;
    const bannedCount = allUsers.filter((u) => u.status === 'banned').length;

    // Transaction stats (from recent 500)
    const todayTxns = recentTransactions.filter((t) => t.ts && t.ts.startsWith(todayStr));
    const weekTxns = recentTransactions.filter((t) => t.ts && t.ts >= weekAgo.toISOString());

    // Group by type
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

    return res.status(200).json({
      success: true,
      data: {
        users: {
          total: allUsers.length,
          activeToday,
          activeThisWeek,
          newToday,
          banned: bannedCount,
        },
        totems: {
          total: totemCount,
        },
        transactions: {
          today: { count: todayTxns.length },
          thisWeek: { count: weekTxns.length },
          byType,
        },
        generatedAt: now.toISOString(),
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
