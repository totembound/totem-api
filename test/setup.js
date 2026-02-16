// test/setup.js
const dotenv = require('dotenv');
const path = require('path');
const sinon = require('sinon');

// Load environment variables for testing
dotenv.config({ path: path.join(__dirname, '..', '.env.test') });

// Mock environment variables
process.env.AWS_REGION = 'us-east-1';
process.env.USERS_TABLE = 'totembound-users-test';
process.env.TRANSACTIONS_TABLE = 'totembound-transactions-test';
process.env.FREE_TIER_USAGE_PLAN_ID = 'free_tier_test';
process.env.PREMIUM_TIER_USAGE_PLAN_ID = 'premium_tier_test';
process.env.EMAIL_FROM = 'no-reply@test.totembound.com';
process.env.CORS_ORIGIN = '*';
process.env.RPC_URL = 'https://polygon-mumbai.g.alchemy.com/v2/test-key';
process.env.FORWARDER_ADDRESS = '0x1234567890123456789012345678901234567890';
process.env.GAME_ADDRESS = '0x0987654321098765432109876543210987654321';
process.env.NFT_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
process.env.TOKEN_ADDRESS = '0xfedcbafedcbafedcbafedcbafedcbafedcbafed';
process.env.REWARDS_ADDRESS = '0x1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b';
process.env.MAX_GAS_PRICE = '50';
process.env.MIN_WALLET_BALANCE = '0.1';
process.env.STRIPE_SECRET_KEY = 'sk_test_testkeytestkeytestkeytestkeytestkey';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testkeytestkeytestkeytestkeytestkey';
process.env.STRIPE_PRICE_ID = 'price_test12345';
process.env.PAYMENT_URL = 'https://test.totembound.com/checkout';
process.env.APP_URL = 'https://test.totembound.com';

// Mock AWS SDK v3 clients
// DynamoDB
const mockDynamoSend = sinon.stub();
jest.mock('@aws-sdk/lib-dynamodb', () => {
    return {
        DynamoDBDocumentClient: {
            from: () => ({
                send: mockDynamoSend
            })
        },
        GetCommand: jest.fn(),
        PutCommand: jest.fn(),
        UpdateCommand: jest.fn(),
        ScanCommand: jest.fn()
    };
});

// Setup default responses for DynamoDB operations
mockDynamoSend.callsFake((command) => {
    if (command.constructor.name === 'ScanCommand') {
        return Promise.resolve({ Items: [] });
    }
    if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: null });
    }
    if (command.constructor.name === 'PutCommand') {
        return Promise.resolve({});
    }
    if (command.constructor.name === 'UpdateCommand') {
        return Promise.resolve({ Attributes: {} });
    }
    return Promise.resolve({});
});

// API Gateway
const mockApiGatewaySend = sinon.stub();
jest.mock('@aws-sdk/client-api-gateway', () => {
    return {
        APIGatewayClient: jest.fn().mockImplementation(() => ({
            send: mockApiGatewaySend
        })),
        CreateApiKeyCommand: jest.fn(),
        CreateUsagePlanKeyCommand: jest.fn(),
        UpdateApiKeyCommand: jest.fn(),
        GetUsagePlansCommand: jest.fn(),
        GetUsagePlanKeysCommand: jest.fn(),
        GetUsageCommand: jest.fn()
    };
});

// Setup default responses for API Gateway operations
mockApiGatewaySend.callsFake((command) => {
    if (command.constructor.name === 'CreateApiKeyCommand') {
        return Promise.resolve({ id: 'test-key-id', value: 'test-api-key-value' });
    }
    if (command.constructor.name === 'CreateUsagePlanKeyCommand') {
        return Promise.resolve({});
    }
    if (command.constructor.name === 'GetUsagePlansCommand') {
        return Promise.resolve({ items: [] });
    }
    return Promise.resolve({});
});

// SES
const mockSesSend = sinon.stub();
jest.mock('@aws-sdk/client-ses', () => {
    return {
        SESClient: jest.fn().mockImplementation(() => ({
            send: mockSesSend
        })),
        SendEmailCommand: jest.fn()
    };
});

// Setup default responses for SES operations
mockSesSend.callsFake(() => {
    return Promise.resolve({ MessageId: 'test-message-id' });
});

// Mock fs for loading email templates
jest.mock('fs', () => {
    const originalModule = jest.requireActual('fs');
    return {
        ...originalModule,
        readFileSync: jest.fn().mockImplementation((path) => {
            if (path.includes('welcome.html')) {
                return '<h1>Welcome to TotemBound!</h1><p>Your API key: {{apiKey}}</p>';
            }
            if (path.includes('premium-welcome.html')) {
                return '<h1>Welcome to TotemBound Premium!</h1><p>Your API key: {{apiKey}}</p>';
            }
            if (path.includes('premium-upgrade.html')) {
                return '<h1>Your account has been upgraded to Premium!</h1><p>Your API key: {{apiKey}}</p>';
            }
            if (path.includes('downgrade.html')) {
                return '<h1>Your Premium subscription has ended</h1><p>Your new API key: {{apiKey}}</p>';
            }
            throw new Error(`File not found: ${path}`);
        })
    };
});

// Mock stripe
jest.mock('stripe', () => {
    return jest.fn().mockImplementation(() => ({
        checkout: {
            sessions: {
                create: jest.fn().mockResolvedValue({
                    id: 'test_session_id',
                    url: 'https://test.stripe.com/checkout/test_session_id'
                })
            }
        },
        webhooks: {
            constructEvent: jest.fn().mockReturnValue({
                type: 'checkout.session.completed',
                data: {
                    object: {
                        customer_email: 'test@example.com',
                        metadata: { walletAddress: '0x1234567890abcdef' },
                        customer: 'cus_test123'
                    }
                }
            })
        }
    }));
});

// Mock console methods to reduce noise in tests
// Comment this out if you want to see console output during tests
global.console = {
    ...console,
    log: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

// Global Jest timeout
jest.setTimeout(10000);