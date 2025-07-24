const TurnstileVerification = require('../src/common/turnstile-verification');
const { getClientIP } = require('../src/common/client-utils');

// Mock params module
jest.mock('../src/common/params');
const { getParameter } = require('../src/common/params');

// Mock fetch
global.fetch = jest.fn();

describe('TurnstileVerification', () => {
  let verification;
  
  beforeEach(() => {
    verification = new TurnstileVerification();
    jest.clearAllMocks();
  });

  describe('verifyToken', () => {
    test('should handle missing token', async () => {
      const result = await verification.verifyToken('');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Missing verification token');
    });

    test('should handle null token', async () => {
      const result = await verification.verifyToken(null);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Missing verification token');
    });

    test('should handle successful verification', async () => {
      // Mock successful CloudFlare response
      global.fetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce({
          success: true
        })
      });

      // Mock getParameter response
      getParameter.mockResolvedValueOnce('test-secret-key');

      const result = await verification.verifyToken('valid-token', '192.168.1.1');
      
      expect(result.success).toBe(true);
      expect(result.message).toBe('Verification successful');
      expect(result.errorCodes).toEqual([]);
      expect(getParameter).toHaveBeenCalledWith('/totemboundci/turnstile/secret-key');
    });

    test('should handle failed verification', async () => {
      // Mock failed CloudFlare response
      global.fetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce({
          success: false,
          'error-codes': ['invalid-input-response']
        })
      });

      // Mock getParameter response
      getParameter.mockResolvedValueOnce('test-secret-key');

      const result = await verification.verifyToken('invalid-token');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Verification failed');
      expect(result.errorCodes).toEqual(['invalid-input-response']);
    });

    test('should handle network errors', async () => {
      // Mock network error
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      // Mock getParameter response
      getParameter.mockResolvedValueOnce('test-secret-key');

      const result = await verification.verifyToken('valid-token');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Verification service unavailable');
    });

    test('should handle Parameter Store errors', async () => {
      // Mock getParameter error
      getParameter.mockRejectedValueOnce(new Error('Parameter Store error'));

      const result = await verification.verifyToken('valid-token');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Verification service unavailable');
    });
  });

});

describe('getClientIP', () => {
  test('should extract IP from requestContext', () => {
    const event = { 
      requestContext: { 
        http: { 
          sourceIp: '192.168.1.1' 
        } 
      } 
    };
    expect(getClientIP(event)).toBe('192.168.1.1');
  });

  test('should extract IP from x-forwarded-for header', () => {
    const event = { 
      headers: { 
        'x-forwarded-for': '192.168.1.1, 10.0.0.1' 
      } 
    };
    expect(getClientIP(event)).toBe('192.168.1.1');
  });

  test('should extract IP from x-real-ip header', () => {
    const event = { 
      headers: { 
        'x-real-ip': '192.168.1.1' 
      } 
    };
    expect(getClientIP(event)).toBe('192.168.1.1');
  });

  test('should return null when no IP found', () => {
    const event = { headers: {} };
    expect(getClientIP(event)).toBeNull();
  });

  test('should handle missing event properties', () => {
    const event = {};
    expect(getClientIP(event)).toBeNull();
  });
});