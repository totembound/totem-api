/**
 * Swagger/OpenAPI Configuration
 *
 * Auto-generates API documentation from JSDoc comments.
 * Access at: http://localhost:3001/api-docs
 */

const swaggerJsdoc = require('swagger-jsdoc');

const IS_LOCAL = process.env.IS_LOCAL === 'true';
const ENV = process.env.ENVIRONMENT || process.env.NODE_ENV || 'development';

const apiVersion = require('../../package.json').version;

const servers = IS_LOCAL
  ? [{ url: 'http://localhost:3001', description: 'Local development server' }]
  : ENV === 'production'
    ? [{ url: 'https://api.totembound.com', description: 'Production server' }]
    : [{ url: 'https://api.totembound-test.net', description: 'Staging server' }];

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'TotemBound API',
      version: apiVersion,
      description: 'REST API for TotemBound game - manage totems, rewards, challenges, and shop',
      contact: {
        name: 'TotemBound Team',
      },
    },
    servers,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT token from /auth/login response',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'INVALID_REQUEST' },
                message: { type: 'string', example: 'Invalid request parameters' },
              },
            },
          },
        },
        User: {
          type: 'object',
          properties: {
            userId: { type: 'string', example: 'user_abc123' },
            email: { type: 'string', example: 'player@example.com' },
            displayName: { type: 'string', example: 'TotemMaster' },
            tier: { type: 'string', enum: ['free', 'premium', 'vip'], example: 'free' },
            currencies: {
              type: 'object',
              properties: {
                essence: { type: 'number', example: 1500 },
                gems: { type: 'number', example: 100 },
              },
            },
            stats: {
              type: 'object',
              properties: {
                totalTotems: { type: 'number', example: 5 },
                loginStreak: { type: 'number', example: 7 },
              },
            },
          },
        },
        Totem: {
          type: 'object',
          properties: {
            totemId: { type: 'string', example: 'totem_xyz789' },
            name: { type: 'string', example: 'Tawny Pup' },
            speciesId: { type: 'number', example: 1 },
            colorId: { type: 'number', example: 2 },
            rarityId: { type: 'number', example: 0 },
            stage: { type: 'number', example: 0, description: 'Stage 0-4 (displayed as 1-5)' },
            experience: { type: 'number', example: 250 },
            happiness: { type: 'number', example: 75 },
            stats: {
              type: 'object',
              properties: {
                strength: { type: 'number', example: 10 },
                agility: { type: 'number', example: 8 },
                wisdom: { type: 'number', example: 12 },
              },
            },
          },
        },
        StreakStatus: {
          type: 'object',
          properties: {
            streakDays: { type: 'number', example: 7 },
            canClaimToday: { type: 'boolean', example: true },
            bestStreak: { type: 'number', example: 14 },
            nextClaimTime: { type: 'string', format: 'date-time' },
          },
        },
        ShopListing: {
          type: 'object',
          properties: {
            listingId: { type: 'string' },
            totemId: { type: 'string' },
            askingPrice: { type: 'number', example: 300 },
            sellPrice: { type: 'number', example: 300 },
            totem: { $ref: '#/components/schemas/Totem' },
            listedAt: { type: 'string', format: 'date-time' },
          },
        },
        GemPackage: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'pkg_starter' },
            name: { type: 'string', example: 'Starter Pack' },
            price: { type: 'number', example: 499, description: 'Price in cents' },
            priceFormatted: { type: 'string', example: '$4.99' },
            gems: { type: 'number', example: 500 },
            bonus: { type: 'number', example: 0 },
          },
        },
        Challenge: {
          type: 'object',
          properties: {
            challengeId: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string', enum: ['rites', 'strength', 'agility', 'wisdom'] },
            difficulty: { type: 'number', example: 1 },
            requirements: {
              type: 'object',
              properties: {
                stage: { type: 'number' },
                strength: { type: 'number' },
                agility: { type: 'number' },
                wisdom: { type: 'number' },
              },
            },
          },
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Authentication and account management' },
      { name: 'User', description: 'User profile and settings' },
      { name: 'Totems', description: 'Totem CRUD, actions (feed/train/treat/evolve), cooldowns, and evolution' },
      { name: 'Rewards', description: 'Daily/weekly rewards, streaks, protection, and tutorial rewards' },
      { name: 'Shop', description: 'Marketplace listings, buy/sell totems, special bundles' },
      { name: 'Gems', description: 'Gem packages, Stripe checkout, and Gem-to-Essence exchange' },
      { name: 'Subscriptions', description: 'Premium/VIP subscription management and monthly bonuses' },
      { name: 'Challenges', description: 'Challenge system and completion' },
      { name: 'Expeditions', description: 'Send totems on expeditions and claim rewards' },
      { name: 'Achievements', description: 'Achievement tracking and progress' },
      { name: 'IoT', description: 'Real-time push notification setup (MQTT over IoT Core)' },
      { name: 'Loot', description: 'Loot box inventory and claiming' },
      { name: 'Webhooks', description: 'Stripe webhook handlers' },
      { name: 'System', description: 'Health check and system status' },
    ],
  },
  apis: [
    './src/routes/api-docs.js',  // Main API documentation
    './src/app.js',              // Shared Express app (routes live here now)
    './src/local-server.js',     // Local-only routes
    './src/functions/**/*.js',
    './src/routes/**/*.js',
  ],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = { swaggerSpec, options };
