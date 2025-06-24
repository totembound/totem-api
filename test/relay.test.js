const { handler } = require('../src/relay/index');

// Mock ALL dependencies to avoid initialization issues
jest.mock('../src/common/api-key', () => ({
    verifyApiKey: jest.fn()
}));

jest.mock('../src/common/db', () => ({
    checkDailyLimit: jest.fn(),
    incrementUsageAndTransactions: jest.fn(),
    logDetailedTransaction: jest.fn()
}));

jest.mock('../src/common/params', () => ({
    getParameter: jest.fn().mockResolvedValue('mock-value')
}));

// Mock the ABI file
jest.mock('../contracts/TotemTrustedForwarder.abi.json', () => [], { virtual: true });

// Mock ethers completely
jest.mock('ethers', () => ({
    JsonRpcProvider: jest.fn(),
    Wallet: jest.fn(),
    Contract: jest.fn(),
    formatEther: jest.fn().mockReturnValue('1.0'),
    formatUnits: jest.fn().mockReturnValue('2.0'),
    parseEther: jest.fn().mockReturnValue(BigInt('100000000000000000')),
    parseUnits: jest.fn().mockReturnValue(BigInt('50000000000'))
}));

const { verifyApiKey } = require('../src/common/api-key');
const db = require('../src/common/db');

describe('Relay Lambda - Basic Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
          // Set required environment variables
        process.env.FORWARDER_ADDRESS = '0x1234567890123456789012345678901234567890';
        process.env.GAME_ADDRESS = '0x0987654321098765432109876543210987654321';
        process.env.USE_MOCK_DB = 'true';
        process.env.RPC_URL = 'https://polygon-mumbai.g.alchemy.com/v2/test-key';
        process.env.FORWARDER_PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        process.env.MAX_GAS_PRICE = '50';
        process.env.MIN_WALLET_BALANCE = '0.1';
    });

    it('should handle OPTIONS request for CORS', async () => {
        const event = {
            httpMethod: 'OPTIONS',
            headers: {}
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(200);
        expect(response.headers['Access-Control-Allow-Origin']).toBeDefined();
        expect(JSON.parse(response.body).message).toBe('CORS preflight response');
    });

    it('should return quota information for GET /relay/quotas with valid API key', async () => {
        const event = {
            httpMethod: 'GET',
            resource: '/relay/quotas',
            headers: {
                'X-Api-Key': 'valid-api-key'
            }
        };

        const mockUser = {
            userId: 'user-123',
            email: 'test@example.com',
            tier: 'free'
        };

        const mockUsage = {
            dailyLimit: 100,
            currentUsage: 25,
            remaining: 75,
            exceeded: false
        };

        verifyApiKey.mockResolvedValueOnce(mockUser);
        db.checkDailyLimit.mockResolvedValueOnce(mockUsage);

        const response = await handler(event);
        const body = JSON.parse(response.body);

        expect(response.statusCode).toBe(200);
        expect(body.userId).toBe('user-123');
        expect(body.email).toBe('test@example.com');
        expect(body.tier).toBe('free');
        expect(body.quota.dailyLimit).toBe(100);
        expect(body.quota.currentUsage).toBe(25);
        expect(body.quota.remaining).toBe(75);
        expect(body.quota.exceeded).toBe(false);
        expect(body.timestamp).toBeDefined();
    });

    it('should return 401 for GET /relay/quotas without API key', async () => {
        const event = {
            httpMethod: 'GET',
            resource: '/relay/quotas',
            headers: {}
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(401);
        expect(JSON.parse(response.body).error).toBe('API key required for quota information');
    });

    it('should return 401 for invalid API key', async () => {
        const event = {
            httpMethod: 'POST',
            headers: {
                'X-Api-Key': 'invalid-api-key'
            },
            body: JSON.stringify({
                contractType: 'game',
                functionName: 'playGame',
                request: { to: process.env.GAME_ADDRESS },
                signature: '0xsignature'
            })
        };

        verifyApiKey.mockResolvedValueOnce(null);

        const response = await handler(event);

        expect(response.statusCode).toBe(401);
        expect(JSON.parse(response.body).error).toBe('Invalid API key');
    });

    it('should return 429 when daily limit is exceeded', async () => {
        const event = {
            httpMethod: 'POST',
            headers: {
                'X-Api-Key': 'valid-api-key'
            },
            body: JSON.stringify({
                contractType: 'game',
                functionName: 'playGame',
                request: { to: process.env.GAME_ADDRESS },
                signature: '0xsignature'
            })
        };

        const mockUser = {
            userId: 'user-123',
            email: 'test@example.com',
            tier: 'free'
        };

        const mockUsage = {
            dailyLimit: 100,
            currentUsage: 100,
            remaining: 0,
            exceeded: true
        };

        verifyApiKey.mockResolvedValueOnce(mockUser);
        db.checkDailyLimit.mockResolvedValueOnce(mockUsage);

        const response = await handler(event);

        expect(response.statusCode).toBe(429);
        expect(JSON.parse(response.body).error).toBe('Daily request limit exceeded');
    });

    it('should include usage headers in response when user is present', async () => {
        const event = {
            httpMethod: 'GET',
            resource: '/relay/quotas',
            headers: {
                'X-Api-Key': 'valid-api-key'
            }
        };

        const mockUser = {
            userId: 'user-123',
            email: 'test@example.com',
            tier: 'premium'
        };

        const mockUsage = {
            dailyLimit: 1000,
            currentUsage: 250,
            remaining: 750,
            exceeded: false
        };

        verifyApiKey.mockResolvedValueOnce(mockUser);
        db.checkDailyLimit.mockResolvedValueOnce(mockUsage);

        const response = await handler(event);

        expect(response.headers['X-Daily-Requests-Remaining']).toBe('750');
        expect(response.headers['X-Daily-Requests-Limit']).toBe('1000');
        expect(response.headers['X-Daily-Requests-Used']).toBe('250');
        expect(response.headers['X-User-Tier']).toBe('premium');
    });
});