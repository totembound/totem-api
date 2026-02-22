/**
 * API Documentation - JSDoc comments for Swagger
 *
 * This file contains OpenAPI/Swagger documentation for all API endpoints.
 * The actual route implementations are in app.js and function handlers.
 *
 * Total: 65 endpoints across 14 tags
 */

// ============================================
// Auth Endpoints (9)
// ============================================

/**
 * @swagger
 * /v1/auth/signup:
 *   post:
 *     tags: [Auth]
 *     summary: Create a new account
 *     description: Register a new user with email and password. Creates user record with 2000 Essence starter balance and grants an Uncommon Totem loot box.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, displayName]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: player@example.com
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: SecurePassword123!
 *               displayName:
 *                 type: string
 *                 example: TotemMaster
 *     responses:
 *       200:
 *         description: Account created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Account created successfully" }
 *       400:
 *         description: Invalid input or email already exists
 */

/**
 * @swagger
 * /v1/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in with email/password
 *     description: Authenticate and receive JWT tokens
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: player@example.com
 *               password:
 *                 type: string
 *                 example: SecurePassword123!
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken: { type: string, description: "JWT for API calls" }
 *                     refreshToken: { type: string, description: "Token for refreshing access" }
 *                     expiresIn: { type: number, example: 86400 }
 *                     user: { $ref: '#/components/schemas/User' }
 *       401:
 *         description: Invalid credentials
 */

/**
 * @swagger
 * /v1/auth/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Verify email address
 *     description: Confirm account with verification code sent to email. In local dev, code is always 123456.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: player@example.com
 *               code:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Email verified successfully
 *       400:
 *         description: Invalid or expired code
 */

/**
 * @swagger
 * /v1/auth/resend-verification:
 *   post:
 *     tags: [Auth]
 *     summary: Resend verification code
 *     description: Resend the email verification code. Always returns success to prevent user enumeration.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: player@example.com
 *     responses:
 *       200:
 *         description: Verification code sent (or silently ignored if email not found)
 */

/**
 * @swagger
 * /v1/auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request password reset
 *     description: Send a password reset code to the user's email. Always returns success to prevent user enumeration.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: player@example.com
 *     responses:
 *       200:
 *         description: Reset code sent (always returns success)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "If that email exists, a reset code has been sent" }
 */

/**
 * @swagger
 * /v1/auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Confirm password reset
 *     description: Reset password using the code received via email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code, newPassword]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: player@example.com
 *               code:
 *                 type: string
 *                 example: "123456"
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 *                 example: NewSecurePassword123!
 *     responses:
 *       200:
 *         description: Password reset successfully
 *       400:
 *         description: Invalid or expired code
 */

/**
 * @swagger
 * /v1/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Sign out
 *     description: Revoke refresh token and sign out
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logged out successfully
 */

/**
 * @swagger
 * /v1/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh access token
 *     description: Get a new access token using refresh token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New tokens issued
 *       401:
 *         description: Invalid refresh token
 */

/**
 * @swagger
 * /v1/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current user profile
 *     description: Returns the authenticated user's profile with balances and stats
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/User' }
 *       401:
 *         description: Unauthorized
 */

// ============================================
// User Endpoints (2)
// ============================================

/**
 * @swagger
 * /v1/user/profile:
 *   get:
 *     tags: [User]
 *     summary: Get user profile
 *     description: Returns full user profile with stats, currencies, and settings
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     userId: { type: string }
 *                     email: { type: string }
 *                     displayName: { type: string }
 *                     tier: { type: string, enum: [free, premium, vip] }
 *                     currencies:
 *                       type: object
 *                       properties:
 *                         essence: { type: number, example: 1500 }
 *                         gems: { type: number, example: 100 }
 *                     stats:
 *                       type: object
 *                       properties:
 *                         totalTotems: { type: number }
 *                         totalChallengesCompleted: { type: number }
 *                         loginStreak: { type: number }
 *                     settings:
 *                       type: object
 *                       properties:
 *                         notifications: { type: boolean, example: true }
 *                         darkMode: { type: string, enum: [system, light, dark], example: system }
 *       401:
 *         description: Unauthorized
 */

/**
 * @swagger
 * /v1/user/profile:
 *   put:
 *     tags: [User]
 *     summary: Update user profile
 *     description: Update display name and settings
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName:
 *                 type: string
 *                 example: NewDisplayName
 *               settings:
 *                 type: object
 *                 properties:
 *                   notifications: { type: boolean }
 *                   darkMode: { type: string, enum: [system, light, dark] }
 *     responses:
 *       200:
 *         description: Profile updated
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 */

// ============================================
// Totem Endpoints (11)
// ============================================

/**
 * @swagger
 * /v1/totems:
 *   get:
 *     tags: [Totems]
 *     summary: Get all user's totems
 *     description: Returns all totems owned by the authenticated user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of totems
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     totems:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Totem' }
 */

/**
 * @swagger
 * /v1/totems/{id}:
 *   get:
 *     tags: [Totems]
 *     summary: Get a specific totem
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Totem ID (ttm_*)
 *     responses:
 *       200:
 *         description: Totem details
 *       404:
 *         description: Totem not found
 */

/**
 * @swagger
 * /v1/totems/purchase/info:
 *   get:
 *     tags: [Totems]
 *     summary: Get totem purchase info
 *     description: Returns cost and available species for totem purchase
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Purchase information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     cost: { type: number, example: 500 }
 *                     currency: { type: string, example: essence }
 *                     availableSpecies:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: number }
 *                           name: { type: string }
 */

/**
 * @swagger
 * /v1/totems/purchase:
 *   post:
 *     tags: [Totems]
 *     summary: Purchase a new totem
 *     description: Buy a new totem with Essence (500 Essence). Rarity is determined server-side via weighted random.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [speciesId]
 *             properties:
 *               speciesId:
 *                 type: number
 *                 description: Species to purchase (0-11)
 *                 example: 1
 *     responses:
 *       201:
 *         description: Totem purchased
 *       402:
 *         description: Insufficient Essence
 *       400:
 *         description: Invalid species
 */

/**
 * @swagger
 * /v1/totems/{id}/feed:
 *   post:
 *     tags: [Totems]
 *     summary: Feed a totem
 *     description: "Costs 10 Essence. Grants +10 happiness. 8-hour time windows (3 feeds per day: 00-08, 08-16, 16-24)."
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Totem fed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     action: { type: string, example: feed }
 *                     totemId: { type: string }
 *                     happinessChange: { type: number, example: 10 }
 *                     newBalance: { type: number }
 *                     achievements: { type: array, items: { type: object } }
 *       400:
 *         description: On cooldown or insufficient Essence
 */

/**
 * @swagger
 * /v1/totems/{id}/train:
 *   post:
 *     tags: [Totems]
 *     summary: Train a totem
 *     description: "Costs 20 Essence. Grants +50 XP, -10 happiness. No cooldown."
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Training complete
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     action: { type: string, example: train }
 *                     totemId: { type: string }
 *                     xpGained: { type: number, example: 50 }
 *                     happinessChange: { type: number, example: -10 }
 *                     newBalance: { type: number }
 *                     achievements: { type: array, items: { type: object } }
 */

/**
 * @swagger
 * /v1/totems/{id}/treat:
 *   post:
 *     tags: [Totems]
 *     summary: Treat a totem
 *     description: "Costs 20 Essence. Grants +10 happiness. 4-hour cooldown."
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Totem treated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     action: { type: string, example: treat }
 *                     totemId: { type: string }
 *                     happinessChange: { type: number, example: 10 }
 *                     newBalance: { type: number }
 *                     achievements: { type: array, items: { type: object } }
 *       400:
 *         description: On cooldown or insufficient Essence
 */

/**
 * @swagger
 * /v1/totems/{id}/evolve:
 *   post:
 *     tags: [Totems]
 *     summary: Evolve a totem
 *     description: "Evolve to next stage. Free. Requires sufficient XP (500/1500/3500/7500) and happiness >= 30. Boosts strength, agility, wisdom by +stage, happiness by +10. Stages: Hatchling → Chick → Juvenile → Adult → Wise Elder."
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Evolution successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     action: { type: string, example: evolve }
 *                     totemId: { type: string }
 *                     evolution:
 *                       type: object
 *                       properties:
 *                         previousStage: { type: number }
 *                         previousStageName: { type: string }
 *                         newStage: { type: number }
 *                         newStageName: { type: string }
 *                     statBoosts:
 *                       type: object
 *                       properties:
 *                         strength: { type: number }
 *                         agility: { type: number }
 *                         wisdom: { type: number }
 *                         happiness: { type: number, example: 10 }
 *                     achievements: { type: array, items: { type: object } }
 *       400:
 *         description: Requirements not met or already max stage
 */

/**
 * @swagger
 * /v1/totems/{id}/nickname:
 *   post:
 *     tags: [Totems]
 *     summary: Set totem nickname
 *     description: Set or update a custom nickname for a totem
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nickname]
 *             properties:
 *               nickname:
 *                 type: string
 *                 maxLength: 20
 *                 example: Sparky
 *     responses:
 *       200:
 *         description: Nickname updated
 *       400:
 *         description: Invalid nickname
 */

/**
 * @swagger
 * /v1/totems/{id}/cooldowns:
 *   get:
 *     tags: [Totems]
 *     summary: Get action cooldowns
 *     description: Returns cooldown status for feed, train, and treat actions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cooldown status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     totemId: { type: string }
 *                     cooldowns:
 *                       type: object
 *                       properties:
 *                         feed:
 *                           type: object
 *                           properties:
 *                             onCooldown: { type: boolean }
 *                             readyAt: { type: string, nullable: true }
 *                             remainingMs: { type: number }
 *                         train:
 *                           type: object
 *                           properties:
 *                             onCooldown: { type: boolean }
 *                             readyAt: { type: string, nullable: true }
 *                             remainingMs: { type: number }
 *                         treat:
 *                           type: object
 *                           properties:
 *                             onCooldown: { type: boolean }
 *                             readyAt: { type: string, nullable: true }
 *                             remainingMs: { type: number }
 */

/**
 * @swagger
 * /v1/totems/{id}/evolution:
 *   get:
 *     tags: [Totems]
 *     summary: Get evolution status
 *     description: Returns current stage, whether totem can evolve, and requirements for next stage
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Evolution status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     totemId: { type: string }
 *                     currentStage: { type: number }
 *                     currentStageName: { type: string }
 *                     isMaxStage: { type: boolean }
 *                     canEvolve: { type: boolean }
 *                     requirements:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         xpRequired: { type: number }
 *                         xpCurrent: { type: number }
 *                         happinessRequired: { type: number }
 *                         happinessCurrent: { type: number }
 *                     nextStage: { type: number, nullable: true }
 *                     nextStageName: { type: string, nullable: true }
 */

/**
 * @swagger
 * /v1/totems/{id}/status:
 *   get:
 *     tags: [Totems]
 *     summary: Get totem status summary
 *     description: Returns combined status including stats, cooldowns, and evolution info
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Totem status summary
 */

// ============================================
// Challenge Endpoints (3)
// ============================================

/**
 * @swagger
 * /v1/challenges:
 *   get:
 *     tags: [Challenges]
 *     summary: Get available challenges
 *     description: Returns all challenges with completion status
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of challenges
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     challenges:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Challenge' }
 */

/**
 * @swagger
 * /v1/challenges/status:
 *   get:
 *     tags: [Challenges]
 *     summary: Get challenge progress status
 *     description: Returns aggregated challenge progress for the user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Challenge progress summary
 */

/**
 * @swagger
 * /v1/challenges/{id}/complete:
 *   post:
 *     tags: [Challenges]
 *     summary: Complete a challenge
 *     description: Submit challenge completion with chosen totem
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Challenge ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [totemId]
 *             properties:
 *               totemId:
 *                 type: string
 *                 description: Totem to use for challenge
 *     responses:
 *       200:
 *         description: Challenge completed
 *       400:
 *         description: Totem doesn't meet requirements
 */

// ============================================
// Expedition Endpoints (4)
// ============================================

/**
 * @swagger
 * /v1/expeditions:
 *   get:
 *     tags: [Expeditions]
 *     summary: Get expeditions
 *     description: Returns available expedition types and user's active expeditions
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Expedition data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     available:
 *                       type: array
 *                       items: { type: object }
 *                     active:
 *                       type: array
 *                       items: { type: object }
 */

/**
 * @swagger
 * /v1/expeditions/active:
 *   get:
 *     tags: [Expeditions]
 *     summary: Get active expeditions
 *     description: Returns the user's currently active expeditions with completion status and claimable summary.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active expedition data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     expeditions:
 *                       type: array
 *                       items: { type: object }
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total: { type: number }
 *                         claimable: { type: number }
 */

/**
 * @swagger
 * /v1/expeditions/{id}/start:
 *   post:
 *     tags: [Expeditions]
 *     summary: Start an expedition
 *     description: Send a totem on an expedition. Totem becomes unavailable until expedition completes.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Expedition type ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [totemId]
 *             properties:
 *               totemId: { type: string }
 *     responses:
 *       200:
 *         description: Expedition started
 *       400:
 *         description: Totem unavailable or insufficient Essence
 */

/**
 * @swagger
 * /v1/expeditions/{id}/claim:
 *   post:
 *     tags: [Expeditions]
 *     summary: Claim expedition rewards
 *     description: Claim Essence and XP rewards from a completed expedition
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Expedition instance ID
 *     responses:
 *       200:
 *         description: Rewards claimed
 *       400:
 *         description: Expedition not complete
 */

// ============================================
// Reward Endpoints (9)
// ============================================

/**
 * @swagger
 * /v1/rewards:
 *   get:
 *     tags: [Rewards]
 *     summary: Get reward status
 *     description: Returns daily and weekly streak status, claim availability, and protection info. Alias for /v1/rewards/status.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reward status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     daily:
 *                       type: object
 *                       properties:
 *                         canClaim: { type: boolean }
 *                         streakDays: { type: number }
 *                         bestStreak: { type: number }
 *                         nextClaimTime: { type: string, nullable: true }
 *                         isProtected: { type: boolean }
 *                         protectionExpiry: { type: string, nullable: true }
 *                     weekly:
 *                       type: object
 *                       properties:
 *                         canClaim: { type: boolean }
 *                         weeklyStreak: { type: number }
 *                         bestStreak: { type: number }
 *                         isUnlocked: { type: boolean }
 *                         nextClaimTime: { type: string, nullable: true }
 *                         isProtected: { type: boolean }
 */

/**
 * @swagger
 * /v1/rewards/status:
 *   get:
 *     tags: [Rewards]
 *     summary: Get reward status
 *     description: Returns daily and weekly streak status, claim availability, and protection info
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reward status (same as GET /v1/rewards)
 */

/**
 * @swagger
 * /v1/rewards/daily:
 *   post:
 *     tags: [Rewards]
 *     summary: Claim daily reward
 *     description: Claim daily login reward. Base 10 Essence + streak bonus. Once per day.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reward claimed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     reward:
 *                       type: object
 *                       properties:
 *                         baseAmount: { type: number }
 *                         streakBonus: { type: number }
 *                         totalAmount: { type: number }
 *                     newStreak: { type: number }
 *                     newBalance: { type: number }
 *                     nextClaimTime: { type: string }
 *       400:
 *         description: Already claimed today
 */

/**
 * @swagger
 * /v1/rewards/daily/claim:
 *   post:
 *     tags: [Rewards]
 *     summary: Claim daily reward (alias)
 *     description: Alias for POST /v1/rewards/daily
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reward claimed
 *       400:
 *         description: Already claimed today
 */

/**
 * @swagger
 * /v1/rewards/weekly:
 *   post:
 *     tags: [Rewards]
 *     summary: Claim weekly reward
 *     description: Claim weekly bonus. Requires 7 consecutive daily claims to unlock. Resets weekly.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Weekly reward claimed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     reward:
 *                       type: object
 *                       properties:
 *                         totalAmount: { type: number }
 *                     newStreak: { type: number }
 *                     newBalance: { type: number }
 *                     nextClaimTime: { type: string }
 *       400:
 *         description: Not unlocked or already claimed this week
 */

/**
 * @swagger
 * /v1/rewards/weekly/claim:
 *   post:
 *     tags: [Rewards]
 *     summary: Claim weekly reward (alias)
 *     description: Alias for POST /v1/rewards/weekly
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Weekly reward claimed
 */

/**
 * @swagger
 * /v1/rewards/daily/protection:
 *   post:
 *     tags: [Rewards]
 *     summary: Buy daily streak protection
 *     description: "Purchase protection to prevent losing daily streak if you miss a day. Tier 0: 50 Essence, 1-day protection, requires 7-day streak. Tier 1: 250 Essence, 7-day protection, requires 14-day streak."
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tier:
 *                 type: number
 *                 enum: [0, 1]
 *                 default: 0
 *                 description: "Protection tier (0 = 1 day/50 Essence, 1 = 7 days/250 Essence)"
 *     responses:
 *       200:
 *         description: Protection purchased
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     rewardType: { type: string, example: daily }
 *                     tier: { type: number }
 *                     cost: { type: number }
 *                     durationSeconds: { type: number }
 *                     protectionExpiry: { type: string }
 *                     newBalance: { type: number }
 *       402:
 *         description: Insufficient Essence
 *       403:
 *         description: Streak too low for selected tier
 *       409:
 *         description: Already has active protection
 */

/**
 * @swagger
 * /v1/rewards/weekly/protection:
 *   post:
 *     tags: [Rewards]
 *     summary: Buy weekly streak protection
 *     description: "Purchase protection for weekly streak. Tier 0 only: 500 Essence, 14-day protection, requires 4-week streak."
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tier:
 *                 type: number
 *                 enum: [0]
 *                 default: 0
 *     responses:
 *       200:
 *         description: Protection purchased
 *       402:
 *         description: Insufficient Essence
 *       403:
 *         description: Streak too low
 *       409:
 *         description: Already has active protection
 */

/**
 * @swagger
 * /v1/rewards/tutorial/progress:
 *   get:
 *     tags: [Rewards]
 *     summary: Get tutorial reward progress
 *     description: Returns which tutorial steps have been completed and rewards claimed (6 steps total)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tutorial progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     completedSteps: { type: array, items: { type: number } }
 *                     totalSteps: { type: number, example: 6 }
 *                     nextStep: { type: number }
 *                     totalEssenceEarned: { type: number }
 *                     totalExperienceEarned: { type: number }
 *                     claimedRewards: { type: array, items: { type: object } }
 */

/**
 * @swagger
 * /v1/rewards/tutorial:
 *   post:
 *     tags: [Rewards]
 *     summary: Claim tutorial step reward
 *     description: Claim reward for completing a tutorial step
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [step]
 *             properties:
 *               step:
 *                 type: number
 *                 description: Tutorial step number (1-6)
 *                 example: 1
 *     responses:
 *       200:
 *         description: Tutorial reward claimed
 *       400:
 *         description: Step already claimed or invalid step
 */

// ============================================
// Achievement Endpoints (1)
// ============================================

/**
 * @swagger
 * /v1/achievements:
 *   get:
 *     tags: [Achievements]
 *     summary: Get achievements
 *     description: Returns all achievements with progress and unlock status
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Achievement list with progress
 */

// ============================================
// Shop Endpoints (7)
// ============================================

/**
 * @swagger
 * /v1/shop:
 *   get:
 *     tags: [Shop]
 *     summary: Get shop items
 *     description: Returns available shop items (unbound totems for sale by the shop)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Shop items
 */

/**
 * @swagger
 * /v1/shop/config:
 *   get:
 *     tags: [Shop]
 *     summary: Get shop configuration
 *     description: Returns shop fees, listing limits, and price ranges
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Shop configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     listing:
 *                       type: object
 *                       properties:
 *                         fee: { type: number, example: 100 }
 *                         minPrice: { type: number, example: 50 }
 *                         maxPrice: { type: number, example: 1000000 }
 *                     purchase:
 *                       type: object
 *                       properties:
 *                         feePercent: { type: number, example: 5 }
 */

/**
 * @swagger
 * /v1/shop/listings:
 *   get:
 *     tags: [Shop]
 *     summary: Browse marketplace listings
 *     description: Get user-listed totems available for purchase
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: species
 *         schema: { type: number }
 *         description: Filter by species ID (0-11)
 *       - in: query
 *         name: rarity
 *         schema: { type: number }
 *         description: Filter by rarity (0=Common, 1=Uncommon, 2=Rare, 3=Epic, 4=Legendary, 5=Limited)
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [price_asc, price_desc, newest, oldest]
 *       - in: query
 *         name: limit
 *         schema: { type: number, default: 20 }
 *     responses:
 *       200:
 *         description: List of marketplace listings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     listings:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/ShopListing' }
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         count: { type: number }
 *                         hasMore: { type: boolean }
 */

/**
 * @swagger
 * /v1/shop/my-listings:
 *   get:
 *     tags: [Shop]
 *     summary: Get my marketplace listings
 *     description: Returns all listings created by the authenticated user with summary stats
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User's listings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     listings: { type: array, items: { type: object } }
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total: { type: number }
 *                         active: { type: number }
 *                         sold: { type: number }
 *                         cancelled: { type: number }
 */

/**
 * @swagger
 * /v1/shop/list:
 *   post:
 *     tags: [Shop]
 *     summary: Sell a totem to the shop
 *     description: "Sell your totem to the shop. Price calculated server-side: 300 + (stage x 30) + (rarityId x 20). Essence credited immediately."
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [totemId]
 *             properties:
 *               totemId:
 *                 type: string
 *                 description: ID of totem to sell
 *     responses:
 *       200:
 *         description: Totem sold to shop
 *       400:
 *         description: Invalid totem, on expedition, or already listed
 */

/**
 * @swagger
 * /v1/shop/purchase:
 *   post:
 *     tags: [Shop]
 *     summary: Buy a totem from the shop
 *     description: "Purchase an unbound totem from the marketplace. Price = sell price + 100 fee."
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listingId]
 *             properties:
 *               listingId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Purchase successful
 *       400:
 *         description: Insufficient Essence or listing not found
 */

/**
 * @swagger
 * /v1/shop/cancel:
 *   post:
 *     tags: [Shop]
 *     summary: Cancel a marketplace listing
 *     description: Cancel your active listing and get the totem back
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listingId]
 *             properties:
 *               listingId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Listing cancelled, totem returned
 *       400:
 *         description: Listing not found or not owned by user
 */

// ============================================
// Special Bundle Endpoints (2)
// ============================================

/**
 * @swagger
 * /v1/shop/bundles:
 *   get:
 *     tags: [Shop]
 *     summary: Get special offer bundles
 *     description: Returns available collector bundles and monthly series bundles.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Available bundles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     bundles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           name: { type: string }
 *                           type: { type: string, enum: [collector, monthly_series] }
 *                           gemCost: { type: number }
 *                           contents: { type: object }
 */

/**
 * @swagger
 * /v1/shop/bundles/purchase:
 *   post:
 *     tags: [Shop]
 *     summary: Purchase a special bundle
 *     description: Buy a collector or monthly series bundle with Gems
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bundleId]
 *             properties:
 *               bundleId:
 *                 type: string
 *                 example: collector_fire_bundle
 *     responses:
 *       201:
 *         description: Bundle purchased
 *       402:
 *         description: Insufficient Gems
 *       409:
 *         description: Daily purchase limit reached
 */

// ============================================
// Gem Purchase & Exchange Endpoints (5)
// ============================================

/**
 * @swagger
 * /v1/shop/gems/packages:
 *   get:
 *     tags: [Gems]
 *     summary: Get gem packages
 *     description: Returns available gem packages for purchase.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of gem packages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     packages:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/GemPackage' }
 */

/**
 * @swagger
 * /v1/shop/gems/checkout:
 *   post:
 *     tags: [Gems]
 *     summary: Create gem purchase checkout
 *     description: Creates Stripe checkout session for gem purchase. In dev mode, bypasses Stripe and credits gems directly.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [packageId]
 *             properties:
 *               packageId:
 *                 type: string
 *                 example: pkg_starter
 *     responses:
 *       200:
 *         description: Checkout session created (or gems credited in dev mode)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     sessionUrl: { type: string, description: "Stripe checkout URL (prod only)" }
 *                     devMode: { type: boolean, description: "True if gems were credited directly" }
 */

/**
 * @swagger
 * /v1/shop/gems/fulfill:
 *   post:
 *     tags: [Gems]
 *     summary: Fulfill gem purchase
 *     description: Manually fulfill a gem purchase (admin/webhook use). Credits gems to user account.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sessionId]
 *             properties:
 *               sessionId:
 *                 type: string
 *                 description: Stripe checkout session ID
 *     responses:
 *       200:
 *         description: Gems fulfilled
 */

/**
 * @swagger
 * /v1/shop/exchange/bundles:
 *   get:
 *     tags: [Gems]
 *     summary: Get Gem-to-Essence exchange bundles
 *     description: Returns available exchange options. 1 Gem = 5 Essence base rate with bundle bonuses.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Exchange bundles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     bundles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           gemCost: { type: number }
 *                           essenceAmount: { type: number }
 *                           bonus: { type: number }
 *                           bonusNote: { type: string }
 *                     conversionRate: { type: number, example: 5 }
 */

/**
 * @swagger
 * /v1/shop/exchange:
 *   post:
 *     tags: [Gems]
 *     summary: Exchange Gems for Essence
 *     description: Convert Gems to Essence using a predefined bundle
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bundleId]
 *             properties:
 *               bundleId:
 *                 type: string
 *                 example: exchange_medium
 *     responses:
 *       200:
 *         description: Exchange successful
 *       402:
 *         description: Insufficient Gems
 */

// ============================================
// Subscription Endpoints (7)
// ============================================

/**
 * @swagger
 * /v1/subscription/checkout:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Create subscription checkout
 *     description: Creates Stripe checkout session for subscription. In dev mode, directly activates the tier.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tier]
 *             properties:
 *               tier:
 *                 type: string
 *                 enum: [premium, vip]
 *                 example: premium
 *     responses:
 *       200:
 *         description: Checkout session created or tier activated (dev mode)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     sessionId: { type: string }
 *                     sessionUrl: { type: string }
 *       409:
 *         description: Already subscribed to this tier
 */

/**
 * @swagger
 * /v1/subscription/status:
 *   get:
 *     tags: [Subscriptions]
 *     summary: Get subscription status
 *     description: Returns current tier, subscription status, and billing period info
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tier: { type: string, enum: [free, premium, vip] }
 *                     subscription:
 *                       type: object
 *                       properties:
 *                         status: { type: string, enum: [none, active, canceled] }
 *                         tier: { type: string, nullable: true }
 *                         currentPeriodEnd: { type: string, nullable: true }
 *                         cancelAtPeriodEnd: { type: boolean }
 */

/**
 * @swagger
 * /v1/subscription/cancel:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Cancel subscription
 *     description: Cancel subscription at end of current billing period. Benefits continue until period end.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription scheduled for cancellation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     currentPeriodEnd: { type: string }
 *                     cancelAtPeriodEnd: { type: boolean, example: true }
 *       400:
 *         description: No active subscription
 */

/**
 * @swagger
 * /v1/subscription/reactivate:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Reactivate cancelled subscription
 *     description: Undo a pending cancellation before the billing period ends
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription reactivated
 *       400:
 *         description: No subscription or not scheduled to cancel
 */

/**
 * @swagger
 * /v1/subscription/portal:
 *   get:
 *     tags: [Subscriptions]
 *     summary: Get Stripe billing portal
 *     description: Returns a URL to the Stripe billing portal for managing payment methods
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Billing portal URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     portalUrl: { type: string }
 *       400:
 *         description: No Stripe customer found
 */

/**
 * @swagger
 * /v1/subscription/bonus-status:
 *   get:
 *     tags: [Subscriptions]
 *     summary: Get monthly bonus status
 *     description: "Check if subscriber can claim this month's bonus. Premium: 500 Essence + 100 Gems. VIP: 1500 Essence + 500 Gems."
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bonus status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     eligible: { type: boolean }
 *                     tier: { type: string }
 *                     canClaim: { type: boolean }
 *                     alreadyClaimed: { type: boolean }
 *                     currentMonth: { type: string, example: "2026-02" }
 *                     bonus:
 *                       type: object
 *                       properties:
 *                         essence: { type: number }
 *                         gems: { type: number }
 */

/**
 * @swagger
 * /v1/subscription/claim-bonus:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Claim monthly subscription bonus
 *     description: Claim Essence and Gems monthly bonus. Must be actively subscribed. One claim per month.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bonus claimed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tier: { type: string }
 *                     monthKey: { type: string }
 *                     essence: { type: number }
 *                     gems: { type: number }
 *                     newEssenceBalance: { type: number }
 *                     newGemsBalance: { type: number }
 *       403:
 *         description: Not subscribed
 *       409:
 *         description: Already claimed this month
 */

// ============================================
// IoT Push Notification Endpoints (2)
// ============================================

/**
 * @swagger
 * /v1/iot/config:
 *   get:
 *     tags: [IoT]
 *     summary: Get IoT connection config
 *     description: Returns endpoint, region, and identity pool info for MQTT connection setup
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: IoT configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     endpoint: { type: string, nullable: true }
 *                     region: { type: string, example: us-east-1 }
 *                     identityPoolId: { type: string, nullable: true }
 *                     registered: { type: boolean }
 *                     topic: { type: string, nullable: true, description: "Personal topic (user/{identityId}/commands)" }
 */

/**
 * @swagger
 * /v1/iot/register:
 *   post:
 *     tags: [IoT]
 *     summary: Register for push notifications
 *     description: Register Cognito Identity Pool identityId for IoT Core push notifications. Attaches browser policy in production.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identityId]
 *             properties:
 *               identityId:
 *                 type: string
 *                 description: "Cognito Identity Pool ID (format: region:uuid)"
 *                 example: us-east-1:12345678-1234-1234-1234-123456789012
 *     responses:
 *       200:
 *         description: Registered for push notifications
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     registered: { type: boolean, example: true }
 *                     topic: { type: string }
 *       400:
 *         description: Invalid identityId format
 */

// ============================================
// Loot Box Endpoints (2)
// ============================================

/**
 * @swagger
 * /v1/loot/items:
 *   get:
 *     tags: [Loot]
 *     summary: Get unclaimed loot items
 *     description: Returns all unclaimed loot boxes for the authenticated user (e.g., signup Uncommon Totem Box)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unclaimed loot items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           lootItemId: { type: string }
 *                           boxType: { type: string, example: uncommon_totem_box }
 *                           status: { type: string, enum: [unclaimed, claiming, claimed] }
 *                           grantedAt: { type: string }
 *                     count: { type: number }
 */

/**
 * @swagger
 * /v1/loot/claim:
 *   post:
 *     tags: [Loot]
 *     summary: Claim a loot box
 *     description: "Open a loot box with optional choices. For totem boxes: choose species via options.speciesId, color is random. Uses atomic 3-phase claim security."
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [lootItemId]
 *             properties:
 *               lootItemId:
 *                 type: string
 *                 description: ID of the loot item to claim
 *               options:
 *                 type: object
 *                 properties:
 *                   speciesId:
 *                     type: number
 *                     description: Chosen species for totem box (0-11)
 *     responses:
 *       200:
 *         description: Loot claimed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     totemId: { type: string }
 *                     speciesId: { type: number }
 *                     colorId: { type: number }
 *                     rarity: { type: string }
 *                     rarityId: { type: number }
 *       400:
 *         description: Missing lootItemId
 *       422:
 *         description: Claim failed (already claimed, expired, etc.)
 */

// ============================================
// Webhook Endpoints (1)
// ============================================

/**
 * @swagger
 * /webhooks/stripe:
 *   post:
 *     tags: [Webhooks]
 *     summary: Stripe webhook handler
 *     description: "Receives Stripe webhook events. Handles: checkout.session.completed (gem purchase + subscription), customer.subscription.updated, customer.subscription.deleted. Requires raw body and valid Stripe signature. No auth required (signature verified)."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Webhook processed
 *       400:
 *         description: Invalid signature
 */

// ============================================
// Health Check (1)
// ============================================

/**
 * @swagger
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Health check
 *     description: Returns server health status and timestamp
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: healthy }
 *                 timestamp: { type: string, format: date-time }
 */

module.exports = {};
