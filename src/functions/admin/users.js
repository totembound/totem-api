/**
 * Admin Users Handler
 *
 * GET  /v1/admin/users           — List users with page/limit pagination and search
 * GET  /v1/admin/users/:id       — Full user detail + totems + recent transactions
 * PUT  /v1/admin/users/:id/currencies — Grant/deduct essence or gems (with ledger entry)
 * PUT  /v1/admin/users/:id/status     — Ban or unban a user
 */

const {
  listUsers,
  getUser,
  updateUser,
  getUserTotems,
  getTransactionHistory,
  addEssence,
  deductEssence,
  addGems,
  deductGems,
} = require('../../common/db-client');

/**
 * List users (paginated, searchable)
 *
 * Query params:
 *   page   - page number, 1-based (default 1)
 *   limit  - items per page (default 25, max 100)
 *   search - filter by email or displayName (contains match)
 */
async function list(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const search = req.query.search || null;

    const allUsers = await listUsers({ search });

    const total = allUsers.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit;
    const pageUsers = allUsers.slice(start, start + limit);

    const users = pageUsers.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role || 'user',
      tier: u.tier || 'free',
      essence: u.currencies?.essence || 0,
      gems: u.currencies?.gems || 0,
      loginStreak: u.stats?.loginStreak || 0,
      lastLoginDate: u.stats?.lastLoginDate || null,
      createdAt: u.createdAt,
    }));

    return res.status(200).json({
      success: true,
      data: { users },
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  }
  catch (error) {
    console.error('[Admin] List users error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}

/**
 * Get full user detail
 *
 * Returns user profile, totems, and recent transactions.
 */
async function getDetail(req, res) {
  try {
    const { id } = req.params;

    const user = await getUser(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }

    const [totems, transactions] = await Promise.all([
      getUserTotems(id),
      getTransactionHistory(id, 20),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role || 'user',
          tier: user.tier || 'free',
          currencies: user.currencies || { essence: 0, gems: 0 },
          stats: user.stats || {},
          settings: user.settings || {},
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
        totems: totems.map((t) => ({
          id: t.id,
          speciesId: t.speciesId,
          colorId: t.colorId,
          rarityId: t.rarityId,
          nickname: t.nickname,
          stage: t.stage,
          experience: t.experience,
          stats: t.stats,
          createdAt: t.createdAt,
        })),
        recentTransactions: transactions.map((t) => ({
          id: t.id,
          type: t.type,
          currency: t.currency,
          amount: t.amount,
          balanceBefore: t.balanceBefore,
          balanceAfter: t.balanceAfter,
          refType: t.refType || null,
          refName: t.refName || null,
          ts: t.ts,
        })),
      },
    });
  }
  catch (error) {
    console.error('[Admin] Get user detail error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}

/**
 * Adjust user currencies (grant or deduct)
 *
 * Body:
 *   currency - "essence" or "gems"
 *   amount   - positive to grant, negative to deduct
 *   reason   - required note for the ledger (e.g. "CS refund for lost totem")
 */
async function adjustCurrencies(req, res) {
  try {
    const { id } = req.params;
    const { currency, amount, reason } = req.body;

    // Validate input
    if (!currency || !['essence', 'gems'].includes(currency)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CURRENCY', message: 'Currency must be "essence" or "gems"' },
      });
    }

    if (typeof amount !== 'number' || amount === 0 || !Number.isInteger(amount)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_AMOUNT', message: 'Amount must be a non-zero integer' },
      });
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      return res.status(400).json({
        success: false,
        error: { code: 'REASON_REQUIRED', message: 'Reason is required (min 3 characters)' },
      });
    }

    // Verify user exists
    const user = await getUser(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }

    const adminId = req.user.userId;
    const refName = `Admin: ${reason.trim()} (by ${adminId})`;

    let result;
    if (currency === 'essence') {
      result = amount > 0
        ? await addEssence(id, amount, { type: 'admin_grant', ref: adminId, refType: 'admin', refName })
        : await deductEssence(id, Math.abs(amount), { type: 'admin_deduct', ref: adminId, refType: 'admin', refName });
    }
    else {
      result = amount > 0
        ? await addGems(id, amount, { type: 'admin_grant', ref: adminId, refType: 'admin', refName })
        : await deductGems(id, Math.abs(amount), { type: 'admin_deduct', ref: adminId, refType: 'admin', refName });
    }

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'ADJUSTMENT_FAILED', message: result.error },
      });
    }

    console.log(`[Admin] ${adminId} adjusted ${currency} by ${amount} for user ${id}: ${reason}`);

    return res.status(200).json({
      success: true,
      data: {
        userId: id,
        currency,
        amount,
        newBalance: result.newBalance,
        reason: reason.trim(),
      },
    });
  }
  catch (error) {
    console.error('[Admin] Adjust currencies error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}

/**
 * Ban or unban a user
 *
 * Body:
 *   status - "banned" or "active"
 *   reason - required note for the audit trail
 */
async function setStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!status || !['banned', 'active'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Status must be "banned" or "active"' },
      });
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      return res.status(400).json({
        success: false,
        error: { code: 'REASON_REQUIRED', message: 'Reason is required (min 3 characters)' },
      });
    }

    const user = await getUser(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }

    const currentStatus = user.status || 'active';
    if (currentStatus === status) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_CHANGE', message: `User is already ${status}` },
      });
    }

    // Prevent banning yourself
    const adminId = req.user.userId;
    if (id === adminId) {
      return res.status(400).json({
        success: false,
        error: { code: 'SELF_BAN', message: 'Cannot change your own status' },
      });
    }

    await updateUser(id, { status });

    console.log(`[Admin] ${adminId} set user ${id} status to ${status}: ${reason}`);

    return res.status(200).json({
      success: true,
      data: {
        userId: id,
        status,
        reason: reason.trim(),
      },
    });
  }
  catch (error) {
    console.error('[Admin] Set status error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}

module.exports = { list, getDetail, adjustCurrencies, setStatus };
