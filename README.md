# TotemBound API

This repository contains the serverless backend for TotemBound's gasless transaction relay and user management system.

## Architecture

TotemBound's API is built on AWS serverless technologies:

- **API Gateway** - Handles all API requests with rate limiting and authentication
- **Lambda Functions** - Process requests for transaction relay and user management
- **DynamoDB** - Stores user data, API keys, and transaction records
- **CloudFormation** - Infrastructure as code for easy deployment
- **S3** - Stores deployment artifacts

The system consists of several components:

1. **Transaction Relay** - Processes gasless transactions via MetaTransactions pattern
2. **API Key Management** - Handles creation and validation of API keys for users
3. **Premium Subscription** - Manages subscription tiers via Stripe integration

## API Endpoints

| Endpoint | Method | Description | Auth Required |
|----------|--------|-------------|--------------|
| `/health` | GET | Health check | None |
| `/relay` | POST | Forward blockchain transactions | API Key |
| `/signup` | POST | Register for a free API key | None |
| `/create-checkout` | POST | Create Stripe checkout for premium | None |
| `/webhook` | POST | Stripe webhook for subscription events | Stripe-Signature |

## Setup for Development

### Prerequisites

- Node.js v18+
- AWS CLI configured with appropriate permissions
- S3 bucket for deployment artifacts (`totembound-releases`)

### Installation

```bash
# Clone the repository
git clone https://github.com/totembound/totem-api.git
cd totem-api

# Install dependencies
npm install
```

### Local Development

```bash
# Run locally for development
npm run dev

# Run tests
npm test
```

### Environment Variables

Create a `.env.{environment}` file for each environment (staging, prod):

```
# Blockchain Configuration
RPC_URL=https://polygon-mumbai.g.alchemy.com/v2/your-api-key
FORWARDER_PRIVATE_KEY=your-private-key
FORWARDER_ADDRESS=0x1234...
GAME_ADDRESS=0x1234...
NFT_ADDRESS=0x1234...
TOKEN_ADDRESS=0x1234...
REWARDS_ADDRESS=0x1234...

# API Configuration
CORS_ORIGIN=https://app.totembound.com
MAX_GAS_PRICE=50
MIN_WALLET_BALANCE=0.1

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...

# Email Configuration
EMAIL_FROM=no-reply@totembound.com
```

## Deployment

Deployments are managed via GitHub Actions workflows. Each environment (staging, prod) has its own deployment workflow.

### Manual Deployment

```bash
# Build and package Lambda functions
npm run build
npm run package
```
