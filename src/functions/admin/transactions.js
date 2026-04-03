/**
 * Admin Transactions Handler
 *
 * GET /v1/admin/transactions — Paginated transaction log with filters
 */

const { listAllTransactions } = require('../../common/db-client');

/**
 * List transactions with filters
 *
 * Query params:
 *   page      - page number, 1-based (default 1)
 *   limit     - items per page (default 25, max 100)
 *   userId    - filter by user ID
 *   type      - filter by transaction type (e.g. admin_grant, action_feed)
 *   startTime - ISO date string (inclusive)
 *   endTime   - ISO date string (inclusive)
 */
async function list(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const userId = req.query.userId || null;
    const type = req.query.type || null;
    const startTime = req.query.startTime || null;
    const endTime = req.query.endTime || null;

    // Fetch more than we need for pagination (up to 500)
    const fetchLimit = 500;
    const allTxns = await listAllTransactions({
      limit: fetchLimit,
      userId,
      type,
      startTime,
      endTime,
    });

    const total = allTxns.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit;
    const pageTxns = allTxns.slice(start, start + limit);

    const transactions = pageTxns.map((t) => ({
      id: t.id,
      userId: t.userId,
      type: t.type,
      currency: t.currency,
      amount: t.amount,
      balanceBefore: t.balanceBefore,
      balanceAfter: t.balanceAfter,
      refType: t.refType || null,
      refName: t.refName || null,
      ts: t.ts,
    }));

    return res.status(200).json({
      success: true,
      data: { transactions },
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  }
  catch (error) {
    console.error('[Admin] Transactions error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}

module.exports = { list };
