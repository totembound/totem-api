// Import the module we're testing
const { handler } = require('../src/signup/index');

// Mock the dependencies
jest.mock('../src/common/api-key', () => ({
  createUserWithApiKey: jest.fn().mockResolvedValue({
    userId: 'test-user-id',
    email: 'test@example.com',
    walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    apiKey: 'test-api-key',
    tier: 'free'
  })
}));

jest.mock('../src/common/email', () => ({
  sendWelcomeEmail: jest.fn().mockResolvedValue({ MessageId: 'test-message-id' })
}));

jest.mock('../src/common/utils', () => ({
  validateEmail: jest.fn(email => email.includes('@')),
  normalizeAddress: jest.fn(addr => addr.toLowerCase()),
  formatResponse: jest.fn((statusCode, body, corsOrigin) => ({
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin || '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
      'Access-Control-Allow-Methods': 'POST,OPTIONS'
    },
    body: JSON.stringify(body)
  })),
  validateParams: jest.fn((params, required) => {
    for (const param of required) {
      if (!params[param]) {
        return {
          error: `Missing parameter: ${param}`,
          statusCode: 400
        };
      }
    }
    return null;
  })
}));

jest.mock('../src/common/db', () => ({
  getUserByEmail: jest.fn().mockResolvedValue(null),
  getUserByWallet: jest.fn().mockResolvedValue(null)
}));

jest.mock('../src/common/turnstile-verification', () => {
  return jest.fn().mockImplementation(() => ({
    verifyToken: jest.fn().mockResolvedValue({ success: true, message: 'Verification successful' })
  }));
});

jest.mock('../src/common/client-utils', () => ({
  getClientIP: jest.fn().mockReturnValue('192.168.1.1')
}));

// Import the mocked modules for direct access in tests
const apiKey = require('../src/common/api-key');
const email = require('../src/common/email');
const utils = require('../src/common/utils');
const db = require('../src/common/db');
const TurnstileVerification = require('../src/common/turnstile-verification');
const clientUtils = require('../src/common/client-utils');

describe('Signup Lambda Function', () => {
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

  it('should create a free tier API key successfully', async () => {
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'test@example.com',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        tier: 'free',
        turnstileToken: 'valid-token'
      })
    };

    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.message).toBe('API key created successfully');
    expect(body.apiKey).toBe('test-api-key');

    expect(apiKey.createUserWithApiKey).toHaveBeenCalledWith(
      'test@example.com',
      '0x1234567890abcdef1234567890abcdef12345678',
      'free',
      '192.168.1.1'
    );

    expect(email.sendWelcomeEmail).toHaveBeenCalledWith('test@example.com', 'test-api-key');
  });


  it('should return 400 for invalid email', async () => {
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'not-an-email',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        tier: 'free',
        turnstileToken: 'valid-token'
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
        email: 'test@example.com',
        tier: 'free',
        turnstileToken: 'valid-token'
      })
    };

    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(400);
    expect(body.error).toBe('Missing parameter: walletAddress');
  });

  it('should handle existing users gracefully', async () => {
    // Mock an existing user response
    db.getUserByEmail.mockResolvedValueOnce({
      userId: 'existing-user-id',
      email: 'test@example.com',
      walletAddress: '0xdifferentaddress'
    });

    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'test@example.com',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        tier: 'free',
        turnstileToken: 'valid-token'
      })
    };

    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(409);
    expect(body.error).toBe('Account already exists');
    expect(body.keyExists).toBe(true);
  });

  it('should handle internal errors gracefully', async () => {
    // Mock an error in the API key creation
    apiKey.createUserWithApiKey.mockRejectedValueOnce(new Error('Database connection failed'));

    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'test@example.com',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        tier: 'free',
        turnstileToken: 'valid-token'
      })
    };

    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(body.message).toBe('Database connection failed');
  });

  it('should handle malformed JSON in request body', async () => {
    const event = {
      httpMethod: 'POST',
      body: '{invalid json'
    };

    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('should normalize email to lowercase', async () => {
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'Test@Example.COM',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        tier: 'free',
        turnstileToken: 'valid-token'
      })
    };

    await handler(event);

    // The normalized email should be passed to the createUserWithApiKey function
    expect(apiKey.createUserWithApiKey).toHaveBeenCalledWith(
      'test@example.com', // Should be lowercase
      expect.any(String),
      'free',
      '192.168.1.1'
    );
  });

  it('should normalize wallet address', async () => {
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'test@example.com',
        walletAddress: '0x1234567890ABCDEF1234567890abcdef12345678',
        tier: 'free',
        turnstileToken: 'valid-token'
      })
    };

    await handler(event);

    expect(utils.normalizeAddress).toHaveBeenCalledWith(
      '0x1234567890ABCDEF1234567890abcdef12345678'
    );
  });

  it('should return 400 for missing turnstile token on free tier', async () => {
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'test@example.com',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        tier: 'free'
      })
    };

    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(400);
    expect(body.error).toBe('Missing verification');
    expect(body.field).toBe('turnstile');
  });
});
