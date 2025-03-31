// Import the module we're testing
const { handler } = require('../src/subscription/index');

// Mock the dependencies
jest.mock('../src/common/db', () => ({
    getUserByApiKey: jest.fn()
}));

jest.mock('../src/common/params', () => ({
    getParameter: jest.fn().mockResolvedValue('sk_test_testkeytestkeytestkeytestkeytestkey')
}));

// Create a mock for Stripe
const mockStripeInstance = {
    subscriptions: {
        list: jest.fn().mockResolvedValue({
            data: [
                {
                    id: 'sub_test123',
                    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days from now
                    status: 'active'
                }
            ]
        }),
        update: jest.fn().mockResolvedValue({
            id: 'sub_test123',
            cancel_at_period_end: true
        })
    }
};

// Mock the Stripe constructor
jest.mock('stripe', () => {
    return jest.fn().mockImplementation(() => mockStripeInstance);
});

// Import the mocked modules for direct access in tests
const db = require('../src/common/db');
const params = require('../src/common/params');

describe('Subscription Management API', () => {
    beforeEach(() => {
        // Reset mocks before each test
        jest.clearAllMocks();
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

    it('should return 403 if API key is missing', async () => {
        const event = {
            httpMethod: 'GET',
            headers: {} // No API key
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body).error).toBe('Forbidden');
    });

    it('should return 405 for unsupported HTTP methods', async () => {
        const event = {
            httpMethod: 'PUT', // Unsupported method
            headers: {
                'x-api-key': 'test-api-key'
            }
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(405);
        expect(JSON.parse(response.body).error).toBe('Method not allowed');
    });

    describe('GET /subscription', () => {
        it('should return 404 if user not found with API key', async () => {
            const event = {
                httpMethod: 'GET',
                headers: {
                    'x-api-key': 'invalid-api-key'
                }
            };

            // Mock user not found
            db.getUserByApiKey.mockResolvedValueOnce(null);

            const response = await handler(event);

            expect(response.statusCode).toBe(404);
            expect(JSON.parse(response.body).error).toBe('No subscription found');
        });

        it('should return 404 if user is not active', async () => {
            const event = {
                httpMethod: 'GET',
                headers: {
                    'x-api-key': 'inactive-api-key'
                }
            };

            // Mock inactive user
            db.getUserByApiKey.mockResolvedValueOnce({
                userId: 'user-123',
                isActive: false
            });

            const response = await handler(event);

            expect(response.statusCode).toBe(404);
            expect(JSON.parse(response.body).error).toBe('No subscription found');
        });

        it('should return subscription details for premium user with Stripe subscription', async () => {
            const event = {
                httpMethod: 'GET',
                headers: {
                    'x-api-key': 'premium-api-key'
                }
            };

            // Mock premium user with Stripe customer ID
            db.getUserByApiKey.mockResolvedValueOnce({
                userId: 'user-123',
                isActive: true,
                tier: 'premium',
                createdAt: '2023-01-01T00:00:00.000Z',
                stripeCustomerId: 'cus_test123'
            });

            const response = await handler(event);
            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.tier).toBe('premium');
            expect(body.memberSince).toBe('2023-01-01T00:00:00.000Z');
            expect(body.renewalDate).toBeDefined();

            // Check if Stripe subscription list was called
            expect(mockStripeInstance.subscriptions.list).toHaveBeenCalledWith({
                customer: 'cus_test123',
                status: 'active',
                limit: 1
            });
        });

        it('should return subscription details without renewal date for free user', async () => {
            const event = {
                httpMethod: 'GET',
                headers: {
                    'x-api-key': 'free-api-key'
                }
            };

            // Mock free user without Stripe customer ID
            db.getUserByApiKey.mockResolvedValueOnce({
                userId: 'user-456',
                isActive: true,
                tier: 'free',
                createdAt: '2023-02-01T00:00:00.000Z'
                // No stripeCustomerId
            });

            const response = await handler(event);
            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.tier).toBe('free');
            expect(body.memberSince).toBe('2023-02-01T00:00:00.000Z');
            expect(body.renewalDate).toBeNull();

            // Stripe subscriptions.list should not be called
            expect(mockStripeInstance.subscriptions.list).not.toHaveBeenCalled();
        });

        it('should handle errors when fetching subscription data', async () => {
            const event = {
                httpMethod: 'GET',
                headers: {
                    'x-api-key': 'error-api-key'
                }
            };

            // Mock user found but Stripe error
            db.getUserByApiKey.mockResolvedValueOnce({
                userId: 'user-789',
                isActive: true,
                tier: 'premium',
                stripeCustomerId: 'cus_error'
            });

            // Mock Stripe error
            mockStripeInstance.subscriptions.list.mockRejectedValueOnce(
                new Error('Stripe API error')
            );

            const response = await handler(event);

            expect(response.statusCode).toBe(500);
            expect(JSON.parse(response.body).error).toBe('Internal server error');
        });
    });

    describe('DELETE /subscription', () => {
        it('should return 401 if user not found with API key', async () => {
            const event = {
                httpMethod: 'DELETE',
                headers: {
                    'x-api-key': 'invalid-api-key'
                }
            };

            // Mock user not found
            db.getUserByApiKey.mockResolvedValueOnce(null);

            const response = await handler(event);

            expect(response.statusCode).toBe(401);
            expect(JSON.parse(response.body).error).toBe('Unauthorized');
        });

        it('should return 401 if user is not active', async () => {
            const event = {
                httpMethod: 'DELETE',
                headers: {
                    'x-api-key': 'inactive-api-key'
                }
            };

            // Mock inactive user
            db.getUserByApiKey.mockResolvedValueOnce({
                userId: 'user-123',
                isActive: false
            });

            const response = await handler(event);

            expect(response.statusCode).toBe(401);
            expect(JSON.parse(response.body).error).toBe('Unauthorized');
        });

        it('should successfully cancel subscription for premium user', async () => {
            const event = {
                httpMethod: 'DELETE',
                headers: {
                    'x-api-key': 'premium-api-key'
                }
            };
        
            // Mock premium user
            db.getUserByApiKey.mockResolvedValueOnce({
                userId: 'user-123',
                isActive: true,
                tier: 'premium',
                stripeCustomerId: 'cus_test123'
            });
        
            const response = await handler(event);
        
            expect(response.statusCode).toBe(200);
            // Updated assertion to match the new implementation
            expect(JSON.parse(response.body).message).toBe('Subscription will be canceled at the end of the billing period');
            // Add assertions for the new fields
            expect(JSON.parse(response.body).currentPeriodEnd).toBeDefined();
            expect(JSON.parse(response.body).canceled).toBe(true);
        });

        it('should handle errors during subscription cancellation', async () => {
            const event = {
                httpMethod: 'DELETE',
                headers: {
                    'x-api-key': 'error-api-key'
                }
            };

            // Mock database error
            db.getUserByApiKey.mockRejectedValueOnce(
                new Error('Database connection error')
            );

            const response = await handler(event);

            expect(response.statusCode).toBe(500);
            expect(JSON.parse(response.body).error).toBe('Internal server error');
            expect(JSON.parse(response.body).message).toBe('Database connection error');
        });
    });
});
