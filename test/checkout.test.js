// Import the module we're testing
const { handler } = require('../src/checkout/index');

// Mock the getParameter function
jest.mock('../src/common/params', () => ({
    getParameter: jest.fn().mockResolvedValue('sk_test_testkeytestkeytestkeytestkeytestkey')
}));

// Mock the dependencies
jest.mock('../src/common/utils', () => ({
    validateEmail: jest.fn(email => email.includes('@')),
    normalizeAddress: jest.fn(addr => addr.toLowerCase())
}));

jest.mock('../src/common/db', () => ({
    getUserByEmail: jest.fn().mockResolvedValue(null),
    getUserByWallet: jest.fn().mockResolvedValue(null)
}));

// Create a mock for Stripe
const mockStripeInstance = {
    checkout: {
        sessions: {
            create: jest.fn().mockResolvedValue({
                id: 'test_session_id',
                url: 'https://test.stripe.com/checkout/test_session_id'
            })
        }
    }
};

// Mock the Stripe constructor
jest.mock('stripe', () => {
    return jest.fn().mockImplementation(() => mockStripeInstance);
});

// Import the mocked modules for direct access in tests
const utils = require('../src/common/utils');
const db = require('../src/common/db');
const params = require('../src/common/params');

describe('Checkout Lambda Function', () => {
    beforeEach(() => {
        // Reset mocks before each test
        jest.clearAllMocks();
    });

    it('should handle OPTIONS request for CORS', async () => {
        const event = {
            httpMethod: 'OPTIONS',
            body: ''
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(200);
        expect(response.headers['Access-Control-Allow-Origin']).toBeDefined();
        expect(JSON.parse(response.body).message).toBe('CORS preflight response');
    });

    it('should create a checkout session successfully', async () => {
        const event = {
            httpMethod: 'POST',
            body: JSON.stringify({
                email: 'test@example.com',
                walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
            })
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);

        expect(response.statusCode).toBe(200);
        expect(body.sessionId).toBe('test_session_id');
        expect(body.sessionUrl).toBe('https://test.stripe.com/checkout/test_session_id');

        // Check Stripe was called with correct parameters
        expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                payment_method_types: ['card'],
                line_items: [
                    {
                        price: process.env.STRIPE_PRICE_ID,
                        quantity: 1
                    }
                ],
                mode: 'subscription',
                client_reference_id: '0x1234567890abcdef1234567890abcdef12345678',
                customer_email: 'test@example.com',
                metadata: {
                    walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
                }
            })
        );

        // Check if getParameter was called
        expect(params.getParameter).toHaveBeenCalled();
    });

    it('should return 400 for invalid email', async () => {
        const event = {
            httpMethod: 'POST',
            body: JSON.stringify({
                email: 'not-an-email',
                walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
            })
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);

        expect(response.statusCode).toBe(400);
        expect(body.error).toBe('Invalid email');
    });

    it('should return 400 for missing wallet address', async () => {
        const event = {
            httpMethod: 'POST',
            body: JSON.stringify({
                email: 'test@example.com'
            })
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);

        expect(response.statusCode).toBe(400);
        expect(body.error).toBe('Missing wallet address');
    });

    it('should return 400 if user already has premium subscription', async () => {
        // Mock an existing premium user
        db.getUserByEmail.mockResolvedValueOnce({
            userId: 'existing-user-id',
            email: 'test@example.com',
            walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
            tier: 'premium'
        });

        db.getUserByWallet.mockResolvedValueOnce({
            userId: 'existing-user-id',
            email: 'test@example.com',
            walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
            tier: 'premium'
        });

        const event = {
            httpMethod: 'POST',
            body: JSON.stringify({
                email: 'test@example.com',
                walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
            })
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);

        expect(response.statusCode).toBe(400);
        expect(body.error).toBe('Already subscribed');
    });

    it('should return 400 if email and wallet addresses do not match', async () => {
        // Mock conflicting user records
        db.getUserByEmail.mockResolvedValueOnce({
            userId: 'user-1',
            email: 'test@example.com',
            walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            tier: 'free'
        });

        db.getUserByWallet.mockResolvedValueOnce({
            userId: 'user-2',
            email: 'another@example.com',
            walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
            tier: 'free'
        });

        const event = {
            httpMethod: 'POST',
            body: JSON.stringify({
                email: 'test@example.com',
                walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
            })
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);

        expect(response.statusCode).toBe(400);
        expect(body.error).toBe('Email and wallet mismatch');
    });

    it('should handle malformed JSON in request body', async () => {
        const event = {
            httpMethod: 'POST',
            body: '{invalid json'
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);

        expect(response.statusCode).toBe(500);
        expect(body.error).toBe('Internal server error');
    });

    it('should handle Stripe API errors', async () => {
        // Mock a Stripe error
        mockStripeInstance.checkout.sessions.create.mockRejectedValueOnce(
            new Error('Invalid API key provided')
        );

        const event = {
            httpMethod: 'POST',
            body: JSON.stringify({
                email: 'test@example.com',
                walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
            })
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);

        expect(response.statusCode).toBe(500);
        expect(body.error).toBe('Internal server error');
        expect(body.message).toBe('Invalid API key provided');
    });

    it('should normalize email to lowercase', async () => {
        const event = {
            httpMethod: 'POST',
            body: JSON.stringify({
                email: 'Test@Example.COM',
                walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
            })
        };

        await handler(event);

        // The normalized email should be passed to Stripe
        expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                customer_email: 'test@example.com'
            })
        );
    });

    it('should normalize wallet address', async () => {
        const event = {
            httpMethod: 'POST',
            body: JSON.stringify({
                email: 'test@example.com',
                walletAddress: '0x1234567890ABCDEF1234567890abcdef12345678'
            })
        };

        await handler(event);

        expect(utils.normalizeAddress).toHaveBeenCalledWith(
            '0x1234567890ABCDEF1234567890abcdef12345678'
        );
    });
});