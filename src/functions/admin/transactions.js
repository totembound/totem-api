/**
 * Admin Transactions Handler
 *
 * GET /v1/admin/transactions — Cursor-paginated transaction log with filters.
 *
 * Query params:
 *   userId    - filter by user ID (uses user-ts-index GSI)
 *   type      - filter by transaction type (uses type-ts-index GSI)
 *   currency  - filter by currency ('essence' | 'gems')
 *   startTime - ISO timestamp (inclusive lower bound)
 *   endTime   - ISO timestamp (inclusive upper bound)
 *   limit     - page size (default 25, max 100)
 *   cursor    - opaque token returned as `nextCursor` on the previous page
 *
 * Either `userId` or `type` is required — admins can't ask for an unbounded
 * cross-user, cross-type slice (a full Scan would burn unbounded RCU as the
 * ledger grows).
 */

const { listAllTransactions } = require('../../common/db-client');

async function list(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const cursor = req.query.cursor || null;
    const userId = req.query.userId || null;
    const type = req.query.type || null;
    const currency = req.query.currency || null;
    const startTime = req.query.startTime || null;
    const endTime = req.query.endTime || null;

    if (!userId && !type) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_QUERY',
          message: 'Specify userId or type — unbounded cross-slice queries are not allowed.',
        },
      });
    }

    if (currency && !['essence', 'gems'].includes(currency)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CURRENCY', message: 'currency must be "essence" or "gems"' },
      });
    }

    const { items, nextCursor } = await listAllTransactions({
      limit,
      cursor,
      userId,
      type,
      currency,
      startTime,
      endTime,
    });

    const transactions = items.map((t) => ({
      id: t.id,
      userId: t.userId,
      type: t.type,
      currency: t.currency,
      amount: t.amount,
      balanceBefore: t.balanceBefore,
      balanceAfter: t.balanceAfter,
      refType: t.refType || null,
      refId: t.refId || null,
      refName: t.refName || null,
      ts: t.ts,
    }));

    return res.status(200).json({
      success: true,
      data: { transactions },
      pagination: {
        limit,
        count: transactions.length,
        nextCursor,
        hasMore: !!nextCursor,
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
