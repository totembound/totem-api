const { handler } = require('../src/premium/index');

// Mock the dependencies
jest.mock('../src/common/api-key', () => ({
    createUserWithApiKey: jest.fn().mockResolvedValue({
        userId: 'test-user-id',
        email: 'test@example.com',
        walletAddress: '0x1234567890abcdef',
        apiKey: 'premium_test_api_key',
        tier: 'premium'
    }),
    updateUserApiKey: jest.fn().mockResolvedValue({
        userId: 'test-user-id',
        email: 'test@example.com',
        walletAddress: '0x1234567890abcdef',
        apiKey: 'premium_test_api_key',
        tier: 'premium'
    })
}));

jest.mock('../src/common/email', () => ({
    sendPremiumEmail: jest.fn().mockResolvedValue({ MessageId: 'test-message-id' }),
    sendDowngradeEmail: jest.fn().mockResolvedValue({ MessageId: 'test-message-id' })
}));

jest.mock('../src/common/db', () => ({
    getUserByEmail: jest.fn().mockResolvedValue(null),
    getUserByStripeCustomerId: jest.fn().mockResolvedValue(null),
    updateUser: jest.fn().mockResolvedValue({})
}));

jest.mock('../src/common/params', () => ({
    getParameter: jest.fn()
        .mockImplementation((paramName) => {
            if (paramName === process.env.STRIPE_SECRET_KEY_PARAM) {
                return Promise.resolve('sk_test_testkeytestkeytestkeytestkeytestkey');
            }
            if (paramName === process.env.STRIPE_WEBHOOK_SECRET_PARAM) {
                return Promise.resolve('whsec_testkeytestkeytestkeytestkeytestkey');
            }
            return Promise.resolve('');
        })
}));

// Create a mock for Stripe
const mockStripeInstance = {
    webhooks: {
        constructEvent: jest.fn()
    }
};

// Mock the Stripe constructor
jest.mock('stripe', () => {
    return jest.fn().mockImplementation(() => mockStripeInstance);
});

// Mock AWS APIGateway
global.apigateway = {
    updateApiKey: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({})
    })
};

// Import the mocked modules for direct access in tests
const apiKey = require('../src/common/api-key');
const email = require('../src/common/email');
const db = require('../src/common/db');
const params = require('../src/common/params');

describe('Premium Webhook Lambda Function', () => {
    beforeEach(() => {
        // Reset mocks before each test
        jest.clearAllMocks();
    });

    it('should validate Stripe signature and return 400 if invalid', async () => {
        // Mock Stripe signature verification failure
        mockStripeInstance.webhooks.constructEvent.mockImplementationOnce(() => {
            throw new Error('Invalid signature');
        });

        const event = {
            headers: {
                'Stripe-Signature': 'invalid_signature'
            },
            body: JSON.stringify({
                type: 'checkout.session.completed',
                data: { object: {} }
            })
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).error).toBe('Invalid signature');
        expect(mockStripeInstance.webhooks.constructEvent).toHaveBeenCalledTimes(1);
    });

    it('should handle checkout.session.completed event for new user', async () => {
        // Mock a valid Stripe event
        const checkoutSession = {
            type: 'checkout.session.completed',
            data: {
                object: {
                    customer_email: 'test@example.com',
                    metadata: { walletAddress: '0x1234567890abcdef' },
                    customer: 'cus_test123'
                }
            }
        };

        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(checkoutSession);

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify(checkoutSession)
        };

        // Ensure getUserByEmail returns null (new user)
        db.getUserByEmail.mockResolvedValueOnce(null);

        const response = await handler(event);

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).received).toBe(true);

        // Check if createUserWithApiKey was called with correct parameters
        expect(apiKey.createUserWithApiKey).toHaveBeenCalledWith(
            'test@example.com',
            '0x1234567890abcdef',
            'premium'
        );

        // Check if updateUser was called to add Stripe customer ID
        expect(db.updateUser).toHaveBeenCalledWith(
            'test-user-id',
            { stripeCustomerId: 'cus_test123' }
        );

        // Check if welcome email was sent
        expect(email.sendPremiumEmail).toHaveBeenCalledWith(
            'test@example.com',
            'premium_test_api_key',
            false // isUpgrade flag
        );
    });

    it('should handle checkout.session.completed event for existing user', async () => {
        // Mock a valid Stripe event
        const checkoutSession = {
            type: 'checkout.session.completed',
            data: {
                object: {
                    customer_email: 'existing@example.com',
                    metadata: { walletAddress: '0x1234567890abcdef' },
                    customer: 'cus_existing123'
                }
            }
        };

        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(checkoutSession);

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify(checkoutSession)
        };

        // Mock an existing free tier user
        db.getUserByEmail.mockResolvedValueOnce({
            userId: 'existing-user-id',
            email: 'existing@example.com',
            walletAddress: '0x1234567890abcdef',
            tier: 'free'
        });

        const response = await handler(event);

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).received).toBe(true);

        // Check if updateUserApiKey was called
        expect(apiKey.updateUserApiKey).toHaveBeenCalledWith(
            'existing-user-id',
            'premium'
        );

        // Check if updateUser was called to add Stripe customer ID
        expect(db.updateUser).toHaveBeenCalledWith(
            'existing-user-id',
            { stripeCustomerId: 'cus_existing123' }
        );

        // Check if upgrade email was sent
        expect(email.sendPremiumEmail).toHaveBeenCalledWith(
            'existing@example.com',
            'premium_test_api_key',
            true // isUpgrade flag
        );
    });

    it('should skip updating if user is already premium', async () => {
        // Mock a valid Stripe event
        const checkoutSession = {
            type: 'checkout.session.completed',
            data: {
                object: {
                    customer_email: 'premium@example.com',
                    metadata: { walletAddress: '0x1234567890abcdef' },
                    customer: 'cus_premium123'
                }
            }
        };

        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(checkoutSession);

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify(checkoutSession)
        };

        // Mock an existing premium tier user
        db.getUserByEmail.mockResolvedValueOnce({
            userId: 'premium-user-id',
            email: 'premium@example.com',
            walletAddress: '0x1234567890abcdef',
            tier: 'premium'
        });

        const response = await handler(event);

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).message).toBe('User already has premium access');

        // These functions should not be called
        expect(apiKey.updateUserApiKey).not.toHaveBeenCalled();
        expect(email.sendPremiumEmail).not.toHaveBeenCalled();
    });

    it('should handle subscription.deleted event', async () => {
        // Mock a valid Stripe event
        const subscriptionDeleted = {
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    customer: 'cus_canceled123'
                }
            }
        };

        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(subscriptionDeleted);

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify(subscriptionDeleted)
        };

        // Mock finding a user by Stripe customer ID
        db.getUserByStripeCustomerId.mockResolvedValueOnce({
            userId: 'canceled-user-id',
            email: 'canceled@example.com',
            walletAddress: '0x1234567890abcdef',
            tier: 'premium',
            apiKeyId: 'api-key-id-123'
        });

        const response = await handler(event);

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).received).toBe(true);

        // Check if API key was disabled
        expect(global.apigateway.updateApiKey).toHaveBeenCalledWith({
            apiKey: 'api-key-id-123',
            patchOperations: [
                {
                    op: 'replace',
                    path: '/enabled',
                    value: 'false'
                }
            ]
        });

        // Check if user was downgraded to free tier
        expect(apiKey.updateUserApiKey).toHaveBeenCalledWith(
            'canceled-user-id',
            'free'
        );

        // Check if downgrade email was sent
        expect(email.sendDowngradeEmail).toHaveBeenCalledWith(
            'canceled@example.com',
            'premium_test_api_key' // This is the mocked return value from updateUserApiKey
        );
    });

    it('should return 404 if user not found for subscription.deleted event', async () => {
        // Mock a valid Stripe event
        const subscriptionDeleted = {
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    customer: 'cus_nonexistent'
                }
            }
        };

        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(subscriptionDeleted);

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify(subscriptionDeleted)
        };

        // User not found
        db.getUserByStripeCustomerId.mockResolvedValueOnce(null);

        const response = await handler(event);

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body).error).toBe('User not found');
    });

    it('should return 400 if checkout session is missing required data', async () => {
        // Mock a valid Stripe event with missing data
        const incompleteSession = {
            type: 'checkout.session.completed',
            data: {
                object: {
                    // Missing customer_email and walletAddress
                    customer: 'cus_incomplete'
                }
            }
        };

        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(incompleteSession);

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify(incompleteSession)
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).error).toBe('Missing customer data');
    });

    it('should handle unrecognized event types', async () => {
        // Mock a valid but unhandled Stripe event
        const unhandledEvent = {
            type: 'payment_intent.succeeded',
            data: {
                object: {}
            }
        };

        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(unhandledEvent);

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify(unhandledEvent)
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).received).toBe(true);
    });

    it('should handle errors in subscription creation', async () => {
        // Mock a valid Stripe event
        const checkoutSession = {
            type: 'checkout.session.completed',
            data: {
                object: {
                    customer_email: 'error@example.com',
                    metadata: { walletAddress: '0x1234567890abcdef' },
                    customer: 'cus_error'
                }
            }
        };

        mockStripeInstance.webhooks.constructEvent.mockReturnValueOnce(checkoutSession);

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify(checkoutSession)
        };

        // Mock error during user creation
        apiKey.createUserWithApiKey.mockRejectedValueOnce(new Error('Database connection error'));

        const response = await handler(event);

        expect(response.statusCode).toBe(500);
        expect(JSON.parse(response.body).error).toBe('Failed to create premium user');
    });

    it('should handle generic errors', async () => {
        // Force an error in the handler
        params.getParameter.mockRejectedValueOnce(new Error('Parameter store error'));

        const event = {
            headers: {
                'Stripe-Signature': 'valid_signature'
            },
            body: JSON.stringify({})
        };

        const response = await handler(event);

        expect(response.statusCode).toBe(500);
        expect(JSON.parse(response.body).error).toBe('Internal server error');
        expect(JSON.parse(response.body).message).toBe('Parameter store error');
    });
});