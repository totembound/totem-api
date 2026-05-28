/**
 * TotemBound Express Application
 *
 * Shared Express app used by both:
 * - local-server.js (local development with .listen())
 * - lambda.js (AWS Lambda via serverless-http)
 *
 * Contains all routes, middleware, and error handling.
 * Does NOT call app.listen() - that's the caller's responsibility.
 */

const express = require('express');
const cors = require('cors');
const { getSecret } = require('./common/ssm-loader');
const { verifyAccessToken } = require('./common/cognito-client');

// Import auth handlers
const {
  handleSignup,
  handleLogin,
  handleLogout,
  handleRefresh,
  handleGetMe,
  handleVerify,
  handleResendVerification,
  handleForgotPassword,
  handleResetPassword,
} = require('./auth');

const app = express();

// ============================================
// CORS Configuration
// ============================================
const IS_LOCAL = process.env.IS_LOCAL === 'true';

const defaultOrigins = IS_LOCAL
  ? ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3002', 'http://localhost:3003']
  : [];

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : defaultOrigins;

app.use(cors({
  // Fail closed: if no origins are configured, reject all cross-origin requests
  // rather than reflecting the caller's Origin with credentials.
  origin: corsOrigins.length > 0 ? corsOrigins : false,
  credentials: true,
  maxAge: 86400, // 24hrs - browser caches preflight, skips OPTIONS for repeat requests
}));

// JSON body parser - skip for webhook routes (need raw body for signature verification)
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') {
    next();
  }
  else {
    express.json()(req, res, next);
  }
});

// Request timing + logging
// Emits structured JSON on every response for CloudWatch Logs Insights queries.
// Tracks cold starts via global flag (reset on Lambda container init).
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
      cold: !global.__lambdaWarm,
    }));
    global.__lambdaWarm = true;
  });
  next();
});

// ============================================
// JWT Verification Middleware
// ============================================
// In local mode: decode JWT without verification (Cognito Local handles auth)
// In Lambda mode: API Gateway Cognito Authorizer validates JWT before Lambda is invoked,
//   so we read the authorizer claims from the event context.
// ============================================
const authenticateJWT = (req, res, next) => {
  // Lambda + API Gateway Cognito Authorizer path
  // serverless-http sets requestContext on req when running in Lambda
  if (!IS_LOCAL && req.requestContext && req.requestContext.authorizer) {
    const claims = req.requestContext.authorizer.claims || req.requestContext.authorizer;
    const email = claims.email || claims.username || '';
    req.user = {
      userId: claims['custom:userId'] || claims.sub,
      email: email,
      displayName: claims['custom:displayName'] || (email ? email.split('@')[0] : 'Player'),
      tier: claims['custom:tier'] || 'free',
      role: claims['custom:role'] || 'user',
    };
    return next();
  }

  // Local development path: decode JWT from header
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' }
    });
  }

  // Accept both raw token and Bearer-prefixed token (deployed uses raw, some tools use Bearer)
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;

  const result = verifyAccessToken(token);
  if (!result.valid) {
    console.error('JWT verification failed:', result.error);
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' }
    });
  }

  req.user = {
    userId: result.userId,
    email: result.email,
    displayName: result.email ? result.email.split('@')[0] : 'Player',
    tier: 'free',
    role: result.role || 'user',
  };
  console.log(`[auth] ${req.method} ${req.path} - userId: ${req.user.userId} role: ${req.user.role}`);

  next();
};

// ============================================
// Role-Based Access Control Middleware
// ============================================
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' }
      });
    }
    next();
  };
}

// ============================================
// Health
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================
// Public Routes (no auth required)
// ============================================

// ============================================
// Auth Routes (public - no Cognito authorizer)
// ============================================
app.post('/v1/auth/signup', handleSignup);
app.post('/v1/auth/login', handleLogin);
app.post('/v1/auth/verify', handleVerify);
app.post('/v1/auth/resend-verification', handleResendVerification);
app.post('/v1/auth/forgot-password', handleForgotPassword);
app.post('/v1/auth/reset-password', handleResetPassword);
app.post('/v1/auth/logout', handleLogout);
app.post('/v1/auth/refresh', handleRefresh);
app.get('/v1/auth/me', authenticateJWT, handleGetMe);

// OAuth social login
const { handleOAuthCallback } = require('./auth/oauth');
app.post('/v1/auth/oauth/callback', handleOAuthCallback);

// ============================================
// Protected Routes
// ============================================

// Import route handlers
let userRoutes, totemRoutes, gameActionRoutes, challengeRoutes,
  expeditionRoutes, rewardRoutes, achievementRoutes, shopRoutes, sanctumRoutes;

const loadRoutes = () => {
  const tryRequire = (path, name) => {
    try {
      return require(path);
    }
    catch (error) {
      console.warn(`Route not yet implemented: ${name}`);
      return null;
    }
  };

  userRoutes = tryRequire('./functions/user', 'user');
  totemRoutes = tryRequire('./functions/totems', 'totems');
  gameActionRoutes = tryRequire('./functions/game-actions', 'game-actions');
  challengeRoutes = tryRequire('./functions/challenges', 'challenges');
  expeditionRoutes = tryRequire('./functions/expeditions', 'expeditions');
  rewardRoutes = tryRequire('./functions/rewards', 'rewards');
  achievementRoutes = tryRequire('./functions/achievements', 'achievements');
  shopRoutes = tryRequire('./functions/shop', 'shop');
  sanctumRoutes = tryRequire('./functions/sanctum', 'sanctum');

  console.log('Loaded routes:', {
    user: !!userRoutes,
    totems: !!totemRoutes,
    gameActions: !!gameActionRoutes,
    challenges: !!challengeRoutes,
    expeditions: !!expeditionRoutes,
    rewards: !!rewardRoutes,
    achievements: !!achievementRoutes,
    shop: !!shopRoutes,
    sanctum: !!sanctumRoutes,
  });
};

loadRoutes();

// User routes
app.get('/v1/user/profile', authenticateJWT, async (req, res) => {
  try {
    if (userRoutes?.getProfile) {
      const result = await userRoutes.getProfile(req.user);
      res.json(result);
    }
    else {
      res.json({
        success: true,
        data: {
          id: req.user.userId,
          email: req.user.email,
          displayName: req.user.displayName,
          tier: req.user.tier,
          currencies: { essence: 2000, gems: 0 },
          stats: { totalTotems: 0, totalChallengesCompleted: 0, loginStreak: 1 },
          settings: { notifications: true, darkMode: 'dark' },
        }
      });
    }
  }
  catch (error) {
    console.error('Error in getProfile:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.put('/v1/user/profile', authenticateJWT, async (req, res) => {
  try {
    if (userRoutes?.updateProfile) {
      const result = await userRoutes.updateProfile(req.user, req.body);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { ...req.body } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.put('/v1/user/displayName', authenticateJWT, async (req, res) => {
  try {
    if (!userRoutes?.updateDisplayName) {
      return res.status(503).json({
        success: false,
        error: { code: 'NOT_IMPLEMENTED', message: 'Display name update not available' },
      });
    }
    const result = await userRoutes.updateDisplayName(req.user, req.body);
    if (result.success) {
      return res.json(result);
    }
    const statusByCode = {
      VALIDATION_ERROR: 400,
      NO_CHANGES: 400,
      PROFANITY: 400,
      COOLDOWN_ACTIVE: 409,
      INSUFFICIENT_BALANCE: 402,
      NOT_FOUND: 404,
    };
    const statusCode = statusByCode[result.error?.code] || 400;
    res.status(statusCode).json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Public profile route — viewable by any authenticated player. The handler
// returns only whitelisted public-safe fields (no email/currencies/etc) so
// the auth requirement is defense-in-depth, not a privacy boundary. We still
// require auth because the only entry point (marketplace) is auth-only and
// there's no benefit in exposing a scrapable endpoint to anonymous traffic.
app.get('/v1/players/:userId/public', authenticateJWT, async (req, res) => {
  try {
    if (!userRoutes?.getPublicProfile) {
      return res.status(503).json({
        success: false,
        error: { code: 'NOT_IMPLEMENTED', message: 'Public profile not available' },
      });
    }
    const result = await userRoutes.getPublicProfile(req.params.userId);
    if (!result.success) {
      const status = result.error?.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json(result);
    }
    return res.json(result);
  }
  catch (error) {
    console.error('Error in getPublicProfile:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Totem routes
app.get('/v1/totems', authenticateJWT, async (req, res) => {
  try {
    if (totemRoutes?.getTotems) {
      const result = await totemRoutes.getTotems(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: [] });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/totems/:id', authenticateJWT, async (req, res) => {
  try {
    if (totemRoutes?.getTotem) {
      const result = await totemRoutes.getTotem(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Totem not found' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Totem purchase routes
app.get('/v1/totems/purchase/info', authenticateJWT, async (req, res) => {
  try {
    if (totemRoutes?.getPurchaseInfo) {
      const result = totemRoutes.getPurchaseInfo();
      res.json(result);
    }
    else {
      res.json({
        success: true,
        data: { cost: 500, currency: 'essence', availableSpecies: [] }
      });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/totems/purchase', authenticateJWT, async (req, res) => {
  try {
    if (totemRoutes?.purchaseTotem) {
      const result = await totemRoutes.purchaseTotem(req.user, req.body);
      if (result.success) {
        res.status(201).json(result);
      }
      else {
        const statusCode = result.error?.code === 'INSUFFICIENT_FUNDS' ? 402 : 400;
        res.status(statusCode).json(result);
      }
    }
    else {
      res.json({ success: true, data: { message: 'Purchase totem (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Totem forge route
app.post('/v1/totems/forge', authenticateJWT, async (req, res) => {
  try {
    if (totemRoutes?.forgeTotem) {
      const result = await totemRoutes.forgeTotem(req.user, req.body);
      if (result.success) {
        res.status(201).json(result);
      }
      else {
        const statusMap = {
          NOT_FOUND: 404,
          ON_EXPEDITION: 409,
          RARITY_MISMATCH: 400,
          MAX_RARITY: 400,
          INVALID_IDS: 400,
          TRANSACTION_FAILED: 409,
          SERVICE_UNAVAILABLE: 503,
        };
        const statusCode = statusMap[result.error?.code] || 400;
        res.status(statusCode).json(result);
      }
    }
    else {
      res.json({ success: true, data: { message: 'Forge (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Game action routes
app.post('/v1/totems/:id/feed', authenticateJWT, async (req, res) => {
  try {
    if (gameActionRoutes?.feed) {
      const result = await gameActionRoutes.feed(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Feed action (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/totems/:id/train', authenticateJWT, async (req, res) => {
  try {
    if (gameActionRoutes?.train) {
      const result = await gameActionRoutes.train(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Train action (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/totems/:id/treat', authenticateJWT, async (req, res) => {
  try {
    if (gameActionRoutes?.treat) {
      const result = await gameActionRoutes.treat(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Treat action (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/totems/:id/evolve', authenticateJWT, async (req, res) => {
  try {
    if (gameActionRoutes?.evolve) {
      const result = await gameActionRoutes.evolve(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Evolve action (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Choose a trait for Learned or Awakened slot
app.post('/v1/totems/:id/traits/choose', authenticateJWT, async (req, res) => {
  try {
    if (totemRoutes?.chooseTrait) {
      const result = await totemRoutes.chooseTrait(req.user, req.params.id, req.body);
      if (!result.success && result.error?.code) {
        const status =
          result.error.code === 'TOTEM_NOT_FOUND' ? 404 :
            result.error.code === 'STAGE_LOCKED' ? 403 :
              result.error.code === 'SLOT_TAKEN' ? 409 :
                400;
        return res.status(status).json(result);
      }
      res.json(result);
    }
    else {
      res.status(503).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'chooseTrait handler missing' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Set totem nickname
app.post('/v1/totems/:id/nickname', authenticateJWT, async (req, res) => {
  try {
    if (gameActionRoutes?.setNickname) {
      const result = await gameActionRoutes.setNickname(req.user, req.params.id, req.body.nickname);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Set nickname (stub)', totemId: req.params.id, nickname: req.body.nickname } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Get totem cooldowns
app.get('/v1/totems/:id/cooldowns', authenticateJWT, async (req, res) => {
  try {
    if (gameActionRoutes?.getCooldowns) {
      const result = await gameActionRoutes.getCooldowns(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.json({
        success: true,
        data: {
          totemId: req.params.id,
          cooldowns: {
            feed: { onCooldown: false, readyAt: null, remainingMs: 0 },
            train: { onCooldown: false, readyAt: null, remainingMs: 0 },
            treat: { onCooldown: false, readyAt: null, remainingMs: 0 },
          }
        }
      });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Get evolution status
app.get('/v1/totems/:id/evolution', authenticateJWT, async (req, res) => {
  try {
    if (gameActionRoutes?.getEvolutionStatus) {
      const result = await gameActionRoutes.getEvolutionStatus(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.json({
        success: true,
        data: {
          totemId: req.params.id,
          currentStage: 0,
          canEvolve: false,
          requirements: null
        }
      });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Get totem status summary
app.get('/v1/totems/:id/status', authenticateJWT, async (req, res) => {
  try {
    if (gameActionRoutes?.getTotemStatus) {
      const result = await gameActionRoutes.getTotemStatus(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { totemId: req.params.id } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Challenge routes
app.get('/v1/challenges', authenticateJWT, async (req, res) => {
  try {
    if (challengeRoutes?.getChallenges) {
      const result = await challengeRoutes.getChallenges(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: [] });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/challenges/status', authenticateJWT, async (req, res) => {
  try {
    if (challengeRoutes?.getStatus) {
      const result = await challengeRoutes.getStatus(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: {} });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/challenges/:id/complete', authenticateJWT, async (req, res) => {
  try {
    if (challengeRoutes?.complete) {
      const result = await challengeRoutes.complete(req.user, req.params.id, req.body);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Challenge completed (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Expedition routes
app.get('/v1/expeditions', authenticateJWT, async (req, res) => {
  try {
    if (expeditionRoutes?.getExpeditions) {
      const result = await expeditionRoutes.getExpeditions(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { available: [], active: [] } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/expeditions/active', authenticateJWT, async (req, res) => {
  try {
    if (expeditionRoutes?.active) {
      const result = await expeditionRoutes.active(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { expeditions: [], summary: { total: 0, claimable: 0 } } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/expeditions/:id/start', authenticateJWT, async (req, res) => {
  try {
    if (expeditionRoutes?.start) {
      const result = await expeditionRoutes.start(req.user, req.params.id, req.body);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Expedition started (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/expeditions/:id/claim', authenticateJWT, async (req, res) => {
  try {
    if (expeditionRoutes?.claim) {
      const result = await expeditionRoutes.claim(req.user, req.params.id);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Expedition claimed (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Sanctum routes
const SANCTUM_ERROR_STATUS = {
  NO_STAGE4_TOTEMS: 403,
  NOT_FOUND: 404,
  NOT_ASCENDED: 400,
  NO_AVAILABLE_SEAT: 400,
  NOT_SEATED: 400,
  NOTHING_TO_CLAIM: 400,
  ALREADY_SEATED: 409,
  ON_EXPEDITION: 409,
  ON_MISSION: 409,
  INVALID_MISSION: 400,
  INSUFFICIENT_ESSENCE: 400,
  INSUFFICIENT_HAPPINESS: 400,
  ALREADY_ON_MISSION: 409,
  MISSION_NOT_FOUND: 404,
  MISSION_NOT_COMPLETE: 400,
  INSUFFICIENT_STAGE: 400,
};

app.get('/v1/sanctum', authenticateJWT, async (req, res) => {
  try {
    if (sanctumRoutes?.getSanctum) {
      const result = await sanctumRoutes.getSanctum(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { seats: [], filledSeats: 0, maxSeats: 0, totalPendingEarnings: 0 } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/sanctum/seat', authenticateJWT, async (req, res) => {
  try {
    if (sanctumRoutes?.seatTotem) {
      const result = await sanctumRoutes.seatTotem(req.user, req.body);
      if (!result.success && result.error?.code) {
        const status = SANCTUM_ERROR_STATUS[result.error.code] || 400;
        return res.status(status).json(result);
      }
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Seat totem (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/sanctum/unseat', authenticateJWT, async (req, res) => {
  try {
    if (sanctumRoutes?.unseatTotem) {
      const result = await sanctumRoutes.unseatTotem(req.user, req.body);
      if (!result.success && result.error?.code) {
        const status = SANCTUM_ERROR_STATUS[result.error.code] || 400;
        return res.status(status).json(result);
      }
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Unseat totem (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/sanctum/claim', authenticateJWT, async (req, res) => {
  try {
    if (sanctumRoutes?.claimSanctum) {
      const result = await sanctumRoutes.claimSanctum(req.user);
      if (!result.success && result.error?.code) {
        const status = SANCTUM_ERROR_STATUS[result.error.code] || 400;
        return res.status(status).json(result);
      }
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Claim sanctum (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/sanctum/missions', authenticateJWT, async (req, res) => {
  try {
    if (sanctumRoutes?.getCouncilMissions) {
      const result = await sanctumRoutes.getCouncilMissions(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Council missions (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/sanctum/missions/start', authenticateJWT, async (req, res) => {
  try {
    if (sanctumRoutes?.startCouncilMission) {
      const result = await sanctumRoutes.startCouncilMission(req.user, req.body);
      if (!result.success && result.error?.code) {
        const status = SANCTUM_ERROR_STATUS[result.error.code] || 400;
        return res.status(status).json(result);
      }
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Start mission (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/sanctum/missions/claim', authenticateJWT, async (req, res) => {
  try {
    if (sanctumRoutes?.claimCouncilMission) {
      const result = await sanctumRoutes.claimCouncilMission(req.user, req.body);
      if (!result.success && result.error?.code) {
        const status = SANCTUM_ERROR_STATUS[result.error.code] || 400;
        return res.status(status).json(result);
      }
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Claim mission (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/sanctum/missions/cancel', authenticateJWT, async (req, res) => {
  try {
    if (sanctumRoutes?.cancelCouncilMission) {
      const result = await sanctumRoutes.cancelCouncilMission(req.user, req.body);
      if (!result.success && result.error?.code) {
        const status = SANCTUM_ERROR_STATUS[result.error.code] || 400;
        return res.status(status).json(result);
      }
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Cancel mission (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Reward routes
app.get('/v1/rewards', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.getStatus) {
      const result = await rewardRoutes.getStatus(req.user);
      res.json(result);
    }
    else {
      res.json({
        success: true,
        data: {
          daily: { canClaim: true, streakDays: 0, bestStreak: 0, nextClaimTime: null, isProtected: false, protectionExpiry: null },
          weekly: { canClaim: false, weeklyStreak: 0, bestStreak: 0, nextClaimTime: null, isProtected: false, protectionExpiry: null, isUnlocked: false }
        }
      });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/rewards/status', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.getStatus) {
      const result = await rewardRoutes.getStatus(req.user);
      res.json(result);
    }
    else {
      res.json({
        success: true,
        data: {
          daily: { canClaim: true, streakDays: 0, bestStreak: 0, nextClaimTime: null, isProtected: false, protectionExpiry: null },
          weekly: { canClaim: false, weeklyStreak: 0, bestStreak: 0, nextClaimTime: null, isProtected: false, protectionExpiry: null, isUnlocked: false }
        }
      });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/rewards/daily', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.claimDaily) {
      const result = await rewardRoutes.claimDaily(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { claimed: true, reward: { essence: 10 } } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/rewards/daily/claim', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.claimDaily) {
      const result = await rewardRoutes.claimDaily(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { claimed: true, reward: { amount: 10, streakDays: 1 } } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/rewards/weekly', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.claimWeekly) {
      const result = await rewardRoutes.claimWeekly(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { claimed: true, reward: { essence: 100 } } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/rewards/weekly/claim', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.claimWeekly) {
      const result = await rewardRoutes.claimWeekly(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { claimed: true, reward: { amount: 100, weeklyStreak: 1 } } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Protection purchase routes
app.post('/v1/rewards/daily/protection', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.purchaseProtection) {
      const result = await rewardRoutes.purchaseProtection(req.user, req.body, 'daily');
      if (result.success) {
        res.json(result);
      }
      else {
        const statusCode = result.error?.code === 'INSUFFICIENT_ESSENCE' ? 402 :
          result.error?.code === 'CHARGES_FULL' || result.error?.code === 'EXCEEDS_CAP' ? 409 :
            result.error?.code === 'INSUFFICIENT_STREAK' ? 403 : 400;
        res.status(statusCode).json(result);
      }
    }
    else {
      res.json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Protection not implemented' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/rewards/weekly/protection', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.purchaseProtection) {
      const result = await rewardRoutes.purchaseProtection(req.user, req.body, 'weekly');
      if (result.success) {
        res.json(result);
      }
      else {
        const statusCode = result.error?.code === 'INSUFFICIENT_ESSENCE' ? 402 :
          result.error?.code === 'CHARGES_FULL' || result.error?.code === 'EXCEEDS_CAP' ? 409 :
            result.error?.code === 'INSUFFICIENT_STREAK' ? 403 : 400;
        res.status(statusCode).json(result);
      }
    }
    else {
      res.json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Protection not implemented' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Tutorial reward routes
app.get('/v1/rewards/tutorial/progress', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.getTutorialProgress) {
      const result = await rewardRoutes.getTutorialProgress(req.user);
      res.json(result);
    }
    else {
      res.json({
        success: true,
        data: {
          completedSteps: [],
          totalSteps: 6,
          nextStep: 1,
          rewards: {},
          totalEssenceEarned: 0,
          totalExperienceEarned: 0,
          claimedRewards: []
        }
      });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/rewards/tutorial', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.claimTutorial) {
      const result = await rewardRoutes.claimTutorial(req.user, req.body);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { claimed: true, reward: { essence: 25 } } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Daily Quests routes
app.get('/v1/rewards/quests', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.getDailyQuests) {
      const result = await rewardRoutes.getDailyQuests(req.user);
      res.json(result);
    }
    else {
      res.json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Daily quests not implemented' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/rewards/quests/claim', authenticateJWT, async (req, res) => {
  try {
    if (rewardRoutes?.claimDailyQuests) {
      const result = await rewardRoutes.claimDailyQuests(req.user);
      res.json(result);
    }
    else {
      res.json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Daily quests not implemented' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Achievement routes
app.get('/v1/achievements', authenticateJWT, async (req, res) => {
  try {
    if (achievementRoutes?.getAchievements) {
      const result = await achievementRoutes.getAchievements(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: [] });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Shop routes
app.get('/v1/shop/config', authenticateJWT, async (req, res) => {
  try {
    if (shopRoutes?.getConfig) {
      const result = await shopRoutes.getConfig(req.user);
      res.json(result);
    }
    else {
      res.json({
        success: true,
        data: {
          listing: { fee: 100, minPrice: 50, maxPrice: 1000000 },
          purchase: { feePercent: 5 },
        },
      });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/shop/listings', authenticateJWT, async (req, res) => {
  try {
    if (shopRoutes?.getListings) {
      const result = await shopRoutes.getListings(req.user, req.query);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { listings: [], pagination: { count: 0, hasMore: false } } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/shop/list', authenticateJWT, async (req, res) => {
  try {
    if (shopRoutes?.listTotem) {
      const result = await shopRoutes.listTotem(req.user, req.body);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'List totem (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/shop/purchase', authenticateJWT, async (req, res) => {
  try {
    if (shopRoutes?.purchase) {
      const result = await shopRoutes.purchase(req.user, req.body);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Purchase completed (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/shop/cancel', authenticateJWT, async (req, res) => {
  try {
    if (shopRoutes?.cancel) {
      const result = await shopRoutes.cancel(req.user, req.body);
      res.json(result);
    }
    else {
      res.json({ success: true, data: { message: 'Cancel listing (stub)' } });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/shop', authenticateJWT, async (req, res) => {
  try {
    if (shopRoutes?.getItems) {
      const result = await shopRoutes.getItems(req.user);
      res.json(result);
    }
    else {
      res.json({ success: true, data: [] });
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// ============================================
// Special Offer Bundle Routes
// ============================================
const bundleRoutes = require('./functions/shop/purchase-bundle');

app.get('/v1/shop/bundles', async (req, res) => {
  try {
    const result = await bundleRoutes.getSpecialOfferBundles();
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/shop/bundles/purchase', authenticateJWT, async (req, res) => {
  try {
    const result = await bundleRoutes.purchaseBundle(req.user, req.body);
    if (result.success) {
      res.status(201).json(result);
    }
    else {
      const statusCode = result.error?.code === 'INSUFFICIENT_GEMS' ? 402 :
        result.error?.code === 'DAILY_LIMIT_REACHED' ? 409 : 400;
      res.status(statusCode).json(result);
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// ============================================
// Subscription Routes
// ============================================
const subscriptionRoutes = require('./functions/subscriptions');

app.post('/v1/subscription/checkout', authenticateJWT, async (req, res) => {
  try {
    const result = await subscriptionRoutes.createSubscriptionCheckout(req.user, req.body);
    if (result.success) {
      res.json(result);
    }
    else {
      const statusCode = result.error?.code === 'ALREADY_SUBSCRIBED' ? 409 : 400;
      res.status(statusCode).json(result);
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/subscription/status', authenticateJWT, async (req, res) => {
  try {
    const result = await subscriptionRoutes.getSubscriptionStatus(req.user);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/subscription/cancel', authenticateJWT, async (req, res) => {
  try {
    const result = await subscriptionRoutes.cancelSubscription(req.user);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/subscription/reactivate', authenticateJWT, async (req, res) => {
  try {
    const result = await subscriptionRoutes.reactivateSubscription(req.user);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/subscription/portal', authenticateJWT, async (req, res) => {
  try {
    const result = await subscriptionRoutes.getBillingPortal(req.user, req.query);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.get('/v1/subscription/bonus-status', authenticateJWT, async (req, res) => {
  try {
    const result = await subscriptionRoutes.getSubscriptionBonusStatus(req.user);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/subscription/claim-bonus', authenticateJWT, async (req, res) => {
  try {
    const result = await subscriptionRoutes.claimSubscriptionBonus(req.user);
    if (result.success) {
      res.json(result);
    }
    else {
      const statusCode = result.error?.code === 'ALREADY_CLAIMED' ? 409 :
        result.error?.code === 'NOT_SUBSCRIBED' ? 403 : 400;
      res.status(statusCode).json(result);
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// ============================================
// Gem Purchase Routes
// ============================================
const gemRoutes = require('./functions/shop/purchase-gems');
const exchangeRoutes = require('./functions/shop/exchange-gems');

app.get('/v1/shop/gems/packages', async (req, res) => {
  try {
    const result = await gemRoutes.getGemPackages();
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/shop/gems/checkout', authenticateJWT, async (req, res) => {
  try {
    const result = await gemRoutes.createCheckoutSession(req.user, req.body);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/shop/gems/fulfill', authenticateJWT, async (req, res) => {
  try {
    const result = await gemRoutes.fulfillGemPurchase(req.user, req.body);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Stripe webhook (raw body, no auth)
// JSON parser is skipped for this path (see conditional middleware above)
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    const webhookSecret = await getSecret('STRIPE_WEBHOOK_SECRET');
    const stripeKey = await getSecret('STRIPE_SECRET_KEY');

    if (!stripeKey || !webhookSecret || webhookSecret === 'whsec_your_webhook_secret_here') {
      console.warn('[Webhook] Stripe not configured, ignoring webhook');
      return res.json({ success: true, message: 'Webhook ignored (not configured)' });
    }

    // Construct and verify event once
    const stripeLib = require('stripe')(stripeKey);
    let event;
    try {
      event = stripeLib.webhooks.constructEvent(req.body, signature, webhookSecret);
    }
    catch (err) {
      console.error('[Webhook] Signature verification failed:', err.message);
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    console.log(`[Webhook] Received event: ${event.type}`);

    // Subscription events
    const subscriptionEvents = [
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ];
    if (subscriptionEvents.includes(event.type)) {
      const result = await subscriptionRoutes.handleSubscriptionWebhook(event);
      return res.json(result || { success: true });
    }

    // checkout.session.completed - dispatch by mode
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'subscription') {
        const result = await subscriptionRoutes.handleSubscriptionWebhook(event);
        return res.json(result || { success: true });
      }
      // payment mode (gem purchases) - fall through to gem handler
    }

    // Gem purchase events (checkout.session.completed payment mode, charge.refunded)
    const result = await gemRoutes.handleStripeWebhook(req.body, signature);
    return res.json(result);
  }
  catch (error) {
    console.error('[Webhook] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// IoT Push Notification Routes
// ============================================
const iotRoutes = require('./functions/iot');

app.get('/v1/iot/config', authenticateJWT, async (req, res) => {
  try {
    const result = await iotRoutes.getIoTConfig(req.user);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/iot/register', authenticateJWT, async (req, res) => {
  try {
    const result = await iotRoutes.registerIoT(req.user, req.body);
    if (result.success) {
      res.json(result);
    }
    else {
      res.status(400).json(result);
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// ============================================
// Loot Box Routes
// ============================================
const lootRoutes = require('./functions/loot');

app.get('/v1/loot/items', authenticateJWT, async (req, res) => {
  try {
    const result = await lootRoutes.getLootItems(req.user);
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/loot/claim', authenticateJWT, async (req, res) => {
  try {
    const result = await lootRoutes.claimLoot(req.user, req.body);
    if (result.success) {
      res.json(result);
    }
    else {
      const statusCode = result.error?.code === 'MISSING_PARAM' ? 400 : 422;
      res.status(statusCode).json(result);
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// ============================================
// Gem to Essence Exchange Routes
// ============================================
app.get('/v1/shop/exchange/bundles', async (req, res) => {
  try {
    const result = await exchangeRoutes.getExchangeBundles();
    res.json(result);
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

app.post('/v1/shop/exchange', authenticateJWT, async (req, res) => {
  try {
    const result = await exchangeRoutes.exchangeGemsForEssence(req.user, req.body);
    if (result.success) {
      res.json(result);
    }
    else {
      const statusCode = result.error?.code === 'INSUFFICIENT_GEMS' ? 402 : 400;
      res.status(statusCode).json(result);
    }
  }
  catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// ============================================
// Admin Routes — require authentication + admin role
// ============================================
const adminUsers = require('./functions/admin/users');
const adminStats = require('./functions/admin/stats');
const adminTransactions = require('./functions/admin/transactions');
const adminMessaging = require('./functions/admin/messaging');

app.get('/v1/admin/stats', authenticateJWT, requireRole('admin'), adminStats.get);
app.get('/v1/admin/users', authenticateJWT, requireRole('admin'), adminUsers.list);
app.get('/v1/admin/users/:id', authenticateJWT, requireRole('admin'), adminUsers.getDetail);
app.put('/v1/admin/users/:id/currencies', authenticateJWT, requireRole('admin'), adminUsers.adjustCurrencies);
app.put('/v1/admin/users/:id/status', authenticateJWT, requireRole('admin'), adminUsers.setStatus);
app.get('/v1/admin/transactions', authenticateJWT, requireRole('admin'), adminTransactions.list);
app.post('/v1/admin/broadcast/notification', authenticateJWT, requireRole('admin'), adminMessaging.broadcastNotification);
app.post('/v1/admin/broadcast/app-reload',   authenticateJWT, requireRole('admin'), adminMessaging.broadcastAppReload);
app.post('/v1/admin/broadcast/force-logout', authenticateJWT, requireRole('admin'), adminMessaging.broadcastForceLogout);
app.post('/v1/admin/users/:id/notification', authenticateJWT, requireRole('admin'), adminMessaging.userNotification);
app.post('/v1/admin/users/:id/force-logout', authenticateJWT, requireRole('admin'), adminMessaging.userForceLogout);

// ============================================
// Finalize - adds error/404 handlers (must be called last)
// ============================================
// Callers (local-server.js, lambda.js) MUST call finalize() after adding
// any additional routes (e.g., swagger). Error/404 handlers must be last
// in the Express middleware chain or they'll swallow legitimate routes.
function finalize() {
  // Error handler
  app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: IS_LOCAL ? err.message : 'An unexpected error occurred'
      }
    });
  });

  // 404 Handler
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` }
    });
  });
}

module.exports = { app, finalize };
