# TotemBound API

Serverless REST API for **TotemBound** - a creature-raising game where players collect, train, and evolve mystical animal spirits.

Built with Express on AWS Lambda, this API powers all game mechanics including totem lifecycle management, a dual-currency economy, challenge mini-games, team expeditions, and a player marketplace.

## Architecture

```
                        ┌─────────────────────┐
                        │   CloudFront CDN     │
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │  API Gateway (REST)  │
                        │  + Cognito Authorizer│
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │  Lambda Function     │
                        │  Express + serverless│
                        │  -http               │
                        └──────────┬──────────┘
                                   │
          ┌────────────┬───────────┼───────────┬────────────┐
          │            │           │           │            │
    ┌─────▼─────┐ ┌────▼────┐ ┌───▼───┐ ┌────▼────┐ ┌─────▼─────┐
    │ DynamoDB  │ │ Cognito │ │  SES  │ │  SSM    │ │ IoT Core  │
    │ 9 tables  │ │ Auth    │ │ Email │ │ Secrets │ │ Push      │
    └───────────┘ └─────────┘ └───────┘ └─────────┘ └───────────┘
```

The API uses a **single Lambda function** with Express routed via API Gateway `{proxy+}`. This keeps cold starts fast while supporting 58+ endpoints.

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Compute | AWS Lambda + Express | All API routes in one function |
| Gateway | API Gateway (REST) | Routing, CORS, throttling, WAF |
| Auth | Cognito User Pool | Email/password, JWT access + refresh tokens |
| Database | DynamoDB | 9 tables for all game state |
| Push | IoT Core | Real-time notifications via MQTT WebSocket |
| Payments | Stripe | Gem purchases and subscriptions |
| Email | AWS SES | Transactional emails |
| Secrets | SSM Parameter Store | API keys, Stripe secrets |

### Dual-Mode Design

```
Local:   Express app.js  →  local-server.js  (.listen + Swagger UI)
AWS:     Express app.js  →  lambda.js         (serverless-http → API Gateway)
```

`app.js` is the shared core - same routes, middleware, and auth logic in both environments. Only the wrapper changes.

## Game Mechanics

### Species & Totems

12 species across 3 domains (Earth, Water, Air) with unique stat distributions:

| Species | Domain | STR | AGI | WIS | Affinity |
|---------|--------|-----|-----|-----|----------|
| Wolf | Earth | 11 | 8 | 5 | Strength |
| Bear | Earth | 12 | 5 | 7 | Strength |
| Deer | Earth | 5 | 11 | 8 | Agility |
| Snake | Earth | 7 | 6 | 11 | Wisdom |
| Goose | Water | 8 | 6 | 10 | Wisdom |
| Otter | Water | 8 | 10 | 6 | Agility |
| Beaver | Water | 10 | 5 | 9 | Strength |
| Turtle | Water | 10 | 8 | 6 | Strength |
| Falcon | Air | 5 | 12 | 7 | Agility |
| Owl | Air | 5 | 7 | 12 | Wisdom |
| Raven | Air | 5 | 8 | 11 | Wisdom |
| Woodpecker | Air | 7 | 11 | 6 | Agility |

### Rarity System

Rarity is determined **server-side** via weighted random - cannot be manipulated by the client.

| Rarity | Drop Rate | Stat Bonus | Colors |
|--------|-----------|------------|--------|
| Common | 75% | +0 | Brown, Gray, White, Tawny |
| Uncommon | 15% | +0 | Slate, Copper, Cream, Dappled |
| Rare | 7% | +1 | Golden, DarkPurple, Charcoal |
| Epic | 2.5% | +2 | EmeraldGreen, CrimsonRed, DeepSapphire |
| Legendary | 0.5% | +4 | EtherealSilver, RadiantGold |
| Limited | Event only | +2 | Seasonal exclusives |

### Actions & Progression

| Action | Cost | Happiness | XP | Cooldown | Notes |
|--------|------|-----------|-----|----------|-------|
| Feed | 10 Essence | +10 | 0 | 8hr windows | Max 3/day (one per window) |
| Train | 20 Essence | -10 | +50 | None | Requires 20+ happiness |
| Treat | 20 Essence | +10 | 0 | 4 hours | No happiness requirement |
| Evolve | Free | 0 | 0 | None | Requires 30+ happiness |

### Evolution Stages

| Stage | XP Required | Example Names |
|-------|-------------|---------------|
| 0 - Hatchling | 0 | Pup, Kit, Cub, Hatchling |
| 1 - Juvenile | 500 | Howler, Splash, Fledgling |
| 2 - Adolescent | 1,500 | Stalker, Glide, Hunter |
| 3 - Adult | 3,500 | Alpha, Guardian, Raptor |
| 4 - Wise Elder | 7,500 | All species converge |

After Wise Elder, every additional 2,500 XP earns a prestige level.

### Economy

| Currency | Type | Earn Method |
|----------|------|-------------|
| Essence | Soft (free) | Signup (2,000), daily/weekly rewards, selling totems |
| Gems | Premium | Purchase via Stripe, exchange to Essence (1 Gem = 5 Essence) |

**Shop pricing formula:**
```
sellPrice    = 300 + (stage * 30) + (rarityId * 20)
purchasePrice = sellPrice + 100  (shop fee)
```

## API Endpoints

### Authentication (no auth required)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/v1/auth/signup` | Create account (email + password) → 2,000 Essence + random starter totem |
| POST | `/v1/auth/login` | Login → access token + refresh token |
| POST | `/v1/auth/refresh` | Refresh expired access token |
| POST | `/v1/auth/logout` | Revoke refresh token |

### Totems (JWT required)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/totems` | List all owned totems |
| POST | `/v1/totems` | Purchase new totem (500 Essence, random species + rarity) |
| GET | `/v1/totems/:id` | Get totem details (stats, stage, happiness, XP) |
| POST | `/v1/totems/:id/feed` | Feed totem (+10 happiness, 10 Essence) |
| POST | `/v1/totems/:id/train` | Train totem (+50 XP, -10 happiness, 20 Essence) |
| POST | `/v1/totems/:id/treat` | Treat totem (+10 happiness, 20 Essence) |
| POST | `/v1/totems/:id/evolve` | Evolve to next stage (free, 30+ happiness) |
| GET | `/v1/totems/:id/cooldowns` | Check action cooldowns |
| GET | `/v1/totems/:id/status` | Detailed status with time windows |

### Rewards

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/rewards/status` | Check daily/weekly availability + streak info |
| POST | `/v1/rewards/daily` | Claim daily reward (streak bonuses) |
| POST | `/v1/rewards/weekly` | Claim weekly reward |
| POST | `/v1/rewards/tutorial` | Claim tutorial step reward (6 steps) |

### Challenges

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/challenges` | List 10 available challenges |
| POST | `/v1/challenges/:id/complete` | Submit challenge score |

### Expeditions

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/expeditions` | List expeditions + active status |
| POST | `/v1/expeditions/start` | Start expedition (3 totems, time-gated) |
| POST | `/v1/expeditions/claim` | Claim completed expedition rewards |

### Shop & Marketplace

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/shop/listings` | Browse shop inventory (filters, sorting) |
| POST | `/v1/shop/sell` | Sell totem to shop (server-calculated price) |
| POST | `/v1/shop/purchase` | Buy totem from shop (price + 100 fee) |
| GET | `/v1/shop/gems/packages` | List gem packages (5 tiers) |
| POST | `/v1/shop/gems/purchase` | Purchase gems (Stripe checkout) |
| POST | `/v1/shop/exchange` | Exchange gems for Essence (1:5 ratio) |
| GET | `/v1/shop/bundles` | List special bundles (collector/monthly) |
| POST | `/v1/shop/bundles/:id/purchase` | Purchase bundle |

### Achievements & Profile

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/achievements` | List achievements + progress |
| POST | `/v1/achievements/check` | Trigger achievement check |
| GET | `/v1/user/profile` | Get user profile |
| PUT | `/v1/user/profile` | Update display name, preferences |

### Push Notifications

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/v1/iot/config` | Get IoT endpoint for MQTT connection |
| POST | `/v1/iot/register` | Register device for push notifications |

Full interactive API docs at **http://localhost:3001/api-docs** (Swagger UI).

## Database Schema

9 DynamoDB tables store all game state:

| Table | Partition Key | Sort Key | Purpose |
|-------|--------------|----------|---------|
| Users | userId | - | Profile, balances, streaks, preferences |
| Totems | totemId | - | Species, stats, stage, XP, happiness, owner |
| Shop | listingId | - | Active marketplace listings |
| Transactions | transactionId | - | Currency transaction audit log |
| ChallengeProgress | uniqueKey | - | Per-user challenge scores and attempts |
| ExpeditionState | uniqueKey | - | Active/completed expedition tracking |
| RewardState | uniqueKey | - | Daily/weekly reward state + streaks |
| AchievementProgress | uniqueKey | - | Milestone progress per achievement |
| RewardsClaims | uniqueKey | - | Individual claim records |

## Local Development

### Prerequisites

- Node.js 18+
- Docker & Docker Compose

### Quick Start

```bash
# 1. Start infrastructure (DynamoDB, Cognito, MailHog)
cd docker && docker compose up -d && cd ..

# 2. Install dependencies
npm install

# 3. Create 9 DynamoDB tables
node scripts/init-tables.js

# 4. Start API server with Swagger
IS_LOCAL=true node src/local-server.js
```

### Local Services

| Service | Port | URL |
|---------|------|-----|
| API Server | 3001 | http://localhost:3001 |
| Swagger UI | 3001 | http://localhost:3001/api-docs |
| DynamoDB Local | 8000 | http://localhost:8000 |
| DynamoDB Admin | 8001 | http://localhost:8001 |
| Cognito Local | 9229 | http://localhost:9229 |
| MailHog UI | 8025 | http://localhost:8025 |

### Development Mode

```bash
npm run dev:local    # Auto-restart on file changes (nodemon)
```

### Testing a Flow

```bash
# Sign up
curl -X POST http://localhost:3001/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123!"}'

# Login (save the token)
TOKEN=$(curl -s -X POST http://localhost:3001/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123!"}' | jq -r '.data.accessToken')

# List your totems
curl http://localhost:3001/v1/totems -H "Authorization: Bearer $TOKEN"

# Feed your first totem
curl -X POST http://localhost:3001/v1/totems/YOUR_TOTEM_ID/feed \
  -H "Authorization: Bearer $TOKEN"
```

## Build & Deploy

```bash
npm run build      # Build monolithic Lambda package → dist/totembound-api/
npm run package    # Create deployment zip
npm test           # Run Jest test suite
npm run lint       # ESLint check
```

### CloudFormation Stacks

Deploy in order (each stack exports values the next one imports):

| Stack | File | Resources |
|-------|------|-----------|
| 1. Core | `infrastructure/cloudformation/core.yml` | 9 DynamoDB tables, IAM Lambda role |
| 2. Cognito | `infrastructure/cloudformation/cognito.yml` | User Pool, App Client (24h token validity) |
| 3. API | `infrastructure/cloudformation/api.yml` | Lambda, REST API Gateway, Cognito Authorizer |
| 4. IoT | `infrastructure/cloudformation/iot.yml` | Cognito Identity Pool, IoT policies (real-time MQTT/WebSocket push) |

### CI/CD

GitHub Actions workflows in `totem-devops/.github/workflows/`:

| Workflow | Trigger | Action |
|----------|---------|--------|
| `ci-api-build.yml` | Manual | Build + package Lambda zip → S3 |
| `ci-api-deploy.yml` | Manual | Deploy Lambda code from S3 (staging) |
| `prod-api-build.yml` | Manual | Build + package Lambda zip → S3 |
| `prod-api-deploy.yml` | Manual | Deploy Lambda code from S3 (production) |
| `ci-infra-deploy.yml` | Manual | Deploy CF stacks: core, cognito, api, iot (staging) |
| `prod-infra-deploy.yml` | Manual | Deploy CF stacks: core, cognito, api, iot (production) |

## Project Structure

```
src/
├── app.js                  # Shared Express app (routes, middleware, auth)
├── lambda.js               # Lambda handler (serverless-http wrapper)
├── local-server.js         # Local dev server (Swagger UI + .listen)
├── auth/                   # Cognito auth (dual-mode: local sim + AWS SDK)
├── functions/
│   ├── game-actions/       # Feed, Train, Treat, Evolve handlers
│   ├── totems/             # Totem CRUD + purchase
│   ├── shop/               # Marketplace, gems, bundles
│   ├── rewards/            # Daily/weekly claim logic
│   ├── challenges/         # Challenge completion + scoring
│   ├── expeditions/        # Expedition start/claim
│   ├── achievements/       # Achievement tracking
│   ├── user/               # Profile management
│   └── iot/                # Push notification registration
├── services/               # Business logic layer
├── common/                 # db-client, cognito-client, email, validation
├── config/                 # Gem packages, shop config
├── data/                   # totem-config.json (server-side game rules)
└── routes/                 # Route definitions + Swagger JSDoc
```

## License

MIT
