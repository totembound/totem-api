/**
 * TotemBound Local Development Server
 *
 * Thin wrapper around app.js for local development.
 * Adds: dotenv, swagger UI, Socket.IO (for IoT push simulation), .listen()
 *
 * In production, app.js is loaded by lambda.js instead.
 *
 * Run: IS_LOCAL=true node src/local-server.js
 *   or: npm run dev:local
 */

// Load environment variables first (from .env.local for local development)
require('dotenv').config({ path: '.env.local' });

// Ensure IS_LOCAL is set for the app module
process.env.IS_LOCAL = 'true';

const http = require('http');
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec } = require('./config/swagger');

// Import the shared Express app and finalize function
const { app, finalize } = require('./app');

const PORT = process.env.PORT || 3001;

// ============================================
// Socket.IO - Local IoT push simulation
// ============================================
const { Server: SocketIOServer } = require('socket.io');
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:3002'],
    methods: ['GET', 'POST'],
  },
});

// Track connected users by userId
const connectedUsers = new Map(); // userId -> Set<socket.id>

io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // All clients join the global broadcast room
  socket.join('global');

  // Client authenticates by sending their userId
  socket.on('subscribe', (data) => {
    const userId = data?.userId;
    if (!userId) return;

    // Join a room named after the userId (personal topic)
    socket.join(`user:${userId}`);
    if (!connectedUsers.has(userId)) {
      connectedUsers.set(userId, new Set());
    }
    connectedUsers.get(userId).add(socket.id);
    console.log(`[Socket.IO] User ${userId} subscribed to personal + global (socket: ${socket.id})`);
  });

  socket.on('disconnect', () => {
    // Clean up user tracking
    for (const [userId, sockets] of connectedUsers.entries()) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        connectedUsers.delete(userId);
      }
    }
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

// Expose the io instance globally for the iot-publisher to use
global.__socketIO = io;

// ============================================
// Swagger API Documentation (local only)
// In production, Swagger UI is served as static files from CloudFront.
// ============================================
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  swaggerOptions: {
    persistAuthorization: true,
  },
}));

// OpenAPI spec as JSON (for external tools)
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Finalize the app (add error/404 handlers AFTER swagger routes)
finalize();

// ============================================
// Local stats-snapshot scheduler
//
// In AWS, EventBridge schedule rules invoke the stats-snapshot Lambda. Locally
// there's no EventBridge, so we register node-cron jobs at the same cadences,
// calling the SAME handler (the single source of truth). Disable with
// LOCAL_SNAPSHOT_CRON=false. For ad-hoc runs use scripts/run-snapshot.js.
// ============================================
if (process.env.LOCAL_SNAPSHOT_CRON !== 'false') {
  const cron = require('node-cron');
  const { runSnapshot } = require('./functions/admin/stats-snapshot');

  const schedules = [
    { expr: '5 * * * *', granularity: 'HOURLY' },   // every hour at :05
    { expr: '10 0 * * *', granularity: 'DAILY' },    // 00:10 UTC daily
    { expr: '15 0 * * 0', granularity: 'WEEKLY' },   // Sunday 00:15 UTC
  ];
  for (const { expr, granularity } of schedules) {
    cron.schedule(expr, () => {
      runSnapshot({ granularity }).catch((e) =>
        console.error(`[local-cron] ${granularity} snapshot failed:`, e.message));
    }, { timezone: 'UTC' });
  }

  // Prime an hourly snapshot on boot so the dashboard has data immediately
  // (idempotent — re-running within the same hour bucket is a no-op).
  runSnapshot({ granularity: 'HOURLY' })
    .then((r) => console.log(`[local-cron] startup HOURLY snapshot: ${r.written ? 'written' : 'exists'} (${r.bucket})`))
    .catch((e) => console.error('[local-cron] startup snapshot failed:', e.message));

  console.log('[local-cron] stats-snapshot scheduler registered (hourly/daily/weekly, UTC)');
}

// ============================================
// Start Server
// ============================================
server.listen(PORT, () => {
  console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551                  TotemBound Local Server                   \u2551
\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563
\u2551  API Server:        http://localhost:${PORT}                  \u2551
\u2551  Health Check:      http://localhost:${PORT}/health           \u2551
\u2551                                                            \u2551
\u2551  Auth Endpoints (v1):                                      \u2551
\u2551    POST /v1/auth/signup   - Create account                 \u2551
\u2551    POST /v1/auth/login    - Sign in                        \u2551
\u2551    POST /v1/auth/logout   - Sign out                       \u2551
\u2551    POST /v1/auth/refresh  - Refresh tokens                 \u2551
\u2551    GET  /v1/auth/me       - Get current user               \u2551
\u2551                                                            \u2551
\u2551  API Docs (Swagger): http://localhost:${PORT}/api-docs        \u2551
\u2551  DynamoDB Admin:     http://localhost:8001                 \u2551
\u2551  MailHog:            http://localhost:8025                 \u2551
\u2551                                                            \u2551
\u2551  Frontend:           http://localhost:3000                 \u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d
  `);
});

module.exports = { app, server, io };
