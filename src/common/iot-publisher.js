/**
 * IoT Publisher - Dual-mode push notification transport
 *
 * Strategy Pattern: Transport is selected once at startup based on IS_LOCAL.
 *   - Local: Socket.IO (global.__socketIO room-based emit)
 *   - Production: AWS IoT Core MQTT (per-user topics via IoT Data Plane SDK)
 *
 * Publishes commands to per-user MQTT topics via AWS IoT Core.
 * Used ONLY for server-initiated events where there is no active HTTP request:
 *   - Stripe webhook: balance_update after gem purchase
 *   - Admin broadcasts: config_update, app_reload
 *   - Background: expedition timer completion (future)
 *
 * All other notifications (achievements, action results) are returned
 * in API responses and handled client-side (Phase 1).
 *
 * Topic format: user/{identityId}/commands
 * (identityId = Cognito Identity Pool ID, stored in DynamoDB Users table)
 *
 * Command object format:
 * {
 *   type: 'notification' | 'balance_update' | 'totem_update' | 'app_reload' | 'config_update' | 'sync',
 *   id: string,
 *   timestamp: string (ISO 8601),
 *   payload: { ... }
 * }
 */

const { generateId } = require('./id-utils');

const IS_LOCAL = process.env.IS_LOCAL === 'true';

// ============================================================================
// TRANSPORT LAYER — Strategy pattern (local vs production)
// ============================================================================

// Lazy-load AWS SDK (only in production, cached after first use)
let iotClient = null;
let PublishCommandClass = null;

function getIoTClient() {
  if (iotClient) return iotClient;

  const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');
  PublishCommandClass = PublishCommand;

  const endpoint = process.env.IOT_ENDPOINT;
  if (!endpoint) {
    console.warn('[IoT] IOT_ENDPOINT not set, publishing will be disabled');
    return null;
  }

  iotClient = new IoTDataPlaneClient({
    endpoint: `https://${endpoint}`,
    region: process.env.AWS_REGION || 'us-east-1',
  });

  return iotClient;
}

/**
 * Low-level publish: sends a command to a specific topic.
 * All higher-level functions route through this single transport.
 *
 * @param {string} topic - Target topic (e.g. "user:usr_123" locally, "user/{id}/commands" in prod)
 * @param {object} command - Command object with type, id, timestamp, payload
 * @returns {Promise<boolean>} true if published successfully
 */
async function publish(topic, command) {
  if (IS_LOCAL) {
    const io = global.__socketIO;
    if (io) {
      io.to(topic).emit('command', command);
    }
    console.log(`[IoT Local] → ${topic}:`, JSON.stringify(command));
    return true;
  }

  // Production: AWS IoT Core
  const client = getIoTClient();
  if (!client) {
    console.warn('[IoT] No IoT client available, skipping publish');
    return false;
  }

  try {
    await client.send(new PublishCommandClass({
      topic,
      payload: Buffer.from(JSON.stringify(command)),
      qos: 1,
    }));
    console.log(`[IoT] Published ${command.type} to ${topic}`);
    return true;
  }
  catch (err) {
    console.error(`[IoT] Failed to publish to ${topic}:`, err.message);
    return false;
  }
}

// ============================================================================
// IDENTITY RESOLUTION
// ============================================================================

/**
 * Resolve a DynamoDB userId to a Cognito Identity Pool identityId.
 * The identityId is stored in the user record when they call POST /v1/iot/register.
 *
 * @param {string} userId - DynamoDB user ID
 * @returns {Promise<string|null>} identityId or null if not registered
 */
async function resolveIdentityId(userId) {
  try {
    const { getUser } = require('./db-client');
    const user = await getUser(userId);
    return user?.iotIdentityId || null;
  }
  catch (err) {
    console.error(`[IoT] Failed to resolve identityId for ${userId}:`, err.message);
    return null;
  }
}

// ============================================================================
// COMMAND BUILDER
// ============================================================================

/**
 * Build a command object with standard envelope
 *
 * @param {string} type - Command type
 * @param {object} payload - Command-specific payload
 * @returns {object} Full command object
 */
function buildCommand(type, payload) {
  return {
    type,
    id: generateId('msg'),
    timestamp: new Date().toISOString(),
    payload,
  };
}

// ============================================================================
// CORE PUBLISHERS
// ============================================================================

/**
 * Publish a command to a specific user's topic.
 *
 * Local: emits to Socket.IO room "user:{userId}"
 * Production: resolves userId → identityId, publishes to "user/{identityId}/commands"
 *
 * @param {string} userId - Target DynamoDB user ID
 * @param {object} command - Command object
 * @returns {Promise<boolean>} true if published successfully
 */
async function publishToUser(userId, command) {
  if (!userId || !command) {
    console.warn('[IoT] publishToUser called with missing userId or command');
    return false;
  }

  if (IS_LOCAL) {
    return publish(`user:${userId}`, command);
  }

  // Production: resolve to Cognito identityId
  const identityId = await resolveIdentityId(userId);
  if (!identityId) {
    console.warn(`[IoT] No identityId for user ${userId}, skipping publish (user has not registered for IoT)`);
    return false;
  }

  return publish(`user/${identityId}/commands`, command);
}

/**
 * Publish a command to the global broadcast topic.
 * All connected clients subscribe to this topic automatically.
 *
 * Local: emits to Socket.IO room "global"
 * Production: publishes to "global/commands"
 *
 * @param {object} command - Command object
 * @returns {Promise<boolean>} true if published successfully
 */
async function publishToGlobal(command) {
  if (!command) {
    console.warn('[IoT] publishToGlobal called with missing command');
    return false;
  }

  const topic = IS_LOCAL ? 'global' : 'global/commands';
  return publish(topic, command);
}

/**
 * Broadcast a command to multiple specific users (by userId).
 * For broadcasting to ALL connected users, use publishToGlobal() instead.
 *
 * @param {string[]} userIds - Array of user IDs
 * @param {object} command - Command object
 * @returns {Promise<number>} Number of successful publishes
 */
async function publishToMany(userIds, command) {
  const results = await Promise.allSettled(
    userIds.map(userId => publishToUser(userId, command))
  );
  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[IoT] Broadcast ${command.type} to ${succeeded}/${userIds.length} users`);
  return succeeded;
}

// ============================================================================
// CONVENIENCE PUBLISHERS — typed wrappers for common events
// ============================================================================

/**
 * Notify user of a balance update (e.g., after Stripe webhook fulfills gems)
 *
 * @param {string} userId - User ID
 * @param {object} data - { currency, amount, newBalance, reason }
 */
async function publishBalanceUpdate(userId, data) {
  const command = buildCommand('balance_update', {
    currency: data.currency,
    amount: data.amount,
    newBalance: data.newBalance,
    reason: data.reason || 'external',
  });
  return publishToUser(userId, command);
}

/**
 * Send a notification to a specific user (server-initiated)
 *
 * @param {string} userId - User ID
 * @param {object} data - { notificationType, title, message, data, priority, sound }
 */
async function publishNotification(userId, data) {
  const command = buildCommand('notification', {
    notificationType: data.notificationType,
    title: data.title,
    message: data.message,
    data: data.data || {},
    priority: data.priority || 'medium',
    sound: data.sound !== undefined ? data.sound : true,
  });
  return publishToUser(userId, command);
}

/**
 * Force a specific user to log out (e.g., after account suspension, password reset)
 *
 * @param {string} userId - User ID
 * @param {string} reason - Reason for forced logout
 */
async function publishForceLogout(userId, reason) {
  const command = buildCommand('force_logout', { reason });
  return publishToUser(userId, command);
}

/**
 * Broadcast an app reload command to ALL connected users via global topic.
 *
 * @param {string} reason - Reason for reload
 */
async function publishAppReload(reason) {
  const command = buildCommand('app_reload', { reason });
  return publishToGlobal(command);
}

/**
 * Broadcast a config update command to ALL connected users via global topic.
 *
 * @param {string[]} configKeys - Which config files changed
 */
async function publishConfigUpdate(configKeys) {
  const command = buildCommand('config_update', { configKeys });
  return publishToGlobal(command);
}

/**
 * Broadcast a force logout to ALL connected users via global topic.
 * Use for security patches, critical updates requiring re-authentication.
 *
 * @param {string} reason - Reason for forced logout
 */
async function publishGlobalForceLogout(reason) {
  const command = buildCommand('force_logout', { reason, scope: 'global' });
  return publishToGlobal(command);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core
  buildCommand,
  publishToUser,
  publishToGlobal,
  publishToMany,

  // Per-user publishers
  publishBalanceUpdate,
  publishNotification,
  publishForceLogout,

  // Global broadcast publishers (all connected users)
  publishAppReload,
  publishConfigUpdate,
  publishGlobalForceLogout,
};
