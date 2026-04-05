/**
 * Admin Messaging Handler
 *
 * POST /v1/admin/broadcast/notification  — Global announcement to all connected users
 * POST /v1/admin/broadcast/app-reload    — Tell all clients to reload (post-deploy)
 * POST /v1/admin/broadcast/force-logout  — Global forced logout (security / key rotation)
 * POST /v1/admin/users/:id/notification  — Targeted notification to one user
 * POST /v1/admin/users/:id/force-logout  — Force a single user to log out
 *
 * All routes are gated by requireRole('admin') at the app.js layer.
 * Audit trail is emitted via console.log matching the existing `[Admin]` pattern.
 */

const { getUser } = require('../../common/db-client');
const {
  buildCommand,
  publishToGlobal,
  publishNotification,
  publishForceLogout,
  publishAppReload,
  publishGlobalForceLogout,
} = require('../../common/iot-publisher');

// ----------------------------------------------------------------------------
// Validation helpers
// ----------------------------------------------------------------------------

function validateNotificationBody(body) {
  const { title, message, priority } = body || {};

  if (!title || typeof title !== 'string' || title.trim().length < 1 || title.length > 80) {
    return { error: { code: 'INVALID_TITLE', message: 'Title is required (1-80 characters)' } };
  }
  if (!message || typeof message !== 'string' || message.trim().length < 1 || message.length > 500) {
    return { error: { code: 'INVALID_MESSAGE', message: 'Message is required (1-500 characters)' } };
  }
  if (priority !== undefined && !['low', 'medium', 'high'].includes(priority)) {
    return { error: { code: 'INVALID_PRIORITY', message: 'Priority must be low, medium, or high' } };
  }
  return { ok: true };
}

function validateReasonBody(body) {
  const { reason } = body || {};
  if (!reason || typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 200) {
    return { error: { code: 'INVALID_REASON', message: 'Reason is required (1-200 characters)' } };
  }
  return { ok: true };
}

function buildNotificationPayload(body) {
  return {
    notificationType: body.notificationType || 'admin',
    title: body.title.trim(),
    message: body.message.trim(),
    data: body.data && typeof body.data === 'object' ? body.data : {},
    priority: body.priority || 'medium',
    sound: body.sound !== undefined ? !!body.sound : true,
  };
}

function errorResponse(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function successResponse(res, data) {
  return res.status(200).json({ success: true, data });
}

// ----------------------------------------------------------------------------
// Global broadcast handlers
// ----------------------------------------------------------------------------

/**
 * POST /v1/admin/broadcast/notification
 */
async function broadcastNotification(req, res) {
  try {
    const v = validateNotificationBody(req.body);
    if (v.error) return errorResponse(res, 400, v.error);

    const payload = buildNotificationPayload(req.body);
    const command = buildCommand('notification', payload);
    const delivered = await publishToGlobal(command);

    const adminId = req.user.userId;
    console.log(`[Admin] ${adminId} push notification → global: ${payload.title}`);

    return successResponse(res, {
      delivered,
      topic: 'global',
      commandId: command.id,
      type: 'notification',
    });
  }
  catch (error) {
    console.error('[Admin] Broadcast notification error:', error);
    return errorResponse(res, 500, { code: 'INTERNAL_ERROR', message: error.message });
  }
}

/**
 * POST /v1/admin/broadcast/app-reload
 */
async function broadcastAppReload(req, res) {
  try {
    const v = validateReasonBody(req.body);
    if (v.error) return errorResponse(res, 400, v.error);

    const reason = req.body.reason.trim();
    const delivered = await publishAppReload(reason);

    const adminId = req.user.userId;
    console.log(`[Admin] ${adminId} push app_reload → global: ${reason}`);

    return successResponse(res, {
      delivered,
      topic: 'global',
      type: 'app_reload',
      reason,
    });
  }
  catch (error) {
    console.error('[Admin] Broadcast app-reload error:', error);
    return errorResponse(res, 500, { code: 'INTERNAL_ERROR', message: error.message });
  }
}

/**
 * POST /v1/admin/broadcast/force-logout
 */
async function broadcastForceLogout(req, res) {
  try {
    const v = validateReasonBody(req.body);
    if (v.error) return errorResponse(res, 400, v.error);

    const reason = req.body.reason.trim();
    const delivered = await publishGlobalForceLogout(reason);

    const adminId = req.user.userId;
    console.log(`[Admin] ${adminId} push force_logout → global: ${reason}`);

    return successResponse(res, {
      delivered,
      topic: 'global',
      type: 'force_logout',
      reason,
    });
  }
  catch (error) {
    console.error('[Admin] Broadcast force-logout error:', error);
    return errorResponse(res, 500, { code: 'INTERNAL_ERROR', message: error.message });
  }
}

// ----------------------------------------------------------------------------
// Per-user handlers
// ----------------------------------------------------------------------------

/**
 * POST /v1/admin/users/:id/notification
 */
async function userNotification(req, res) {
  try {
    const { id } = req.params;

    const v = validateNotificationBody(req.body);
    if (v.error) return errorResponse(res, 400, v.error);

    const user = await getUser(id);
    if (!user) {
      return errorResponse(res, 404, { code: 'NOT_FOUND', message: 'User not found' });
    }

    const payload = buildNotificationPayload(req.body);
    const delivered = await publishNotification(id, payload);

    const adminId = req.user.userId;
    console.log(`[Admin] ${adminId} push notification → user:${id}: ${payload.title}`);

    const response = {
      delivered,
      topic: `user:${id}`,
      type: 'notification',
    };
    if (!delivered) response.undeliveredReason = 'user_not_registered';

    return successResponse(res, response);
  }
  catch (error) {
    console.error('[Admin] User notification error:', error);
    return errorResponse(res, 500, { code: 'INTERNAL_ERROR', message: error.message });
  }
}

/**
 * POST /v1/admin/users/:id/force-logout
 */
async function userForceLogout(req, res) {
  try {
    const { id } = req.params;

    const v = validateReasonBody(req.body);
    if (v.error) return errorResponse(res, 400, v.error);

    const user = await getUser(id);
    if (!user) {
      return errorResponse(res, 404, { code: 'NOT_FOUND', message: 'User not found' });
    }

    const reason = req.body.reason.trim();
    const delivered = await publishForceLogout(id, reason);

    const adminId = req.user.userId;
    console.log(`[Admin] ${adminId} push force_logout → user:${id}: ${reason}`);

    const response = {
      delivered,
      topic: `user:${id}`,
      type: 'force_logout',
      reason,
    };
    if (!delivered) response.undeliveredReason = 'user_not_registered';

    return successResponse(res, response);
  }
  catch (error) {
    console.error('[Admin] User force-logout error:', error);
    return errorResponse(res, 500, { code: 'INTERNAL_ERROR', message: error.message });
  }
}

module.exports = {
  broadcastNotification,
  broadcastAppReload,
  broadcastForceLogout,
  userNotification,
  userForceLogout,
};
