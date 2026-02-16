/**
 * SSM Loader & IoT Handler Tests
 */

// =============================================================================
// SSM LOADER TESTS
// =============================================================================

describe('SSM Loader', () => {
  let getSecret;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules to get fresh ssm-loader
    jest.resetModules();
    process.env = { ...originalEnv };

    // Mock @aws-sdk/client-ssm
    jest.mock('@aws-sdk/client-ssm', () => {
      const mockSend = jest.fn();
      return {
        SSMClient: jest.fn(() => ({ send: mockSend })),
        GetParameterCommand: jest.fn((params) => params),
        __mockSend: mockSend,
      };
    });

    getSecret = require('../src/common/ssm-loader').getSecret;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return direct env var when set', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_real_key_here';
    const result = await getSecret('STRIPE_SECRET_KEY');
    expect(result).toBe('sk_live_real_key_here');
  });

  it('should skip placeholder env vars', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_your_key_here';
    process.env.STRIPE_SECRET_KEY_PARAM = '/test/stripe/key';
    const { __mockSend } = require('@aws-sdk/client-ssm');
    __mockSend.mockResolvedValue({ Parameter: { Value: 'sk_live_real' } });

    const result = await getSecret('STRIPE_SECRET_KEY');
    expect(result).toBe('sk_live_real');
  });

  it('should return null when no env var and no param name', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY_PARAM;
    const result = await getSecret('STRIPE_SECRET_KEY');
    expect(result).toBeNull();
  });

  it('should load from SSM when param name is set', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY_PARAM = '/test/stripe/key';
    const { __mockSend } = require('@aws-sdk/client-ssm');
    __mockSend.mockResolvedValue({ Parameter: { Value: 'sk_live_from_ssm' } });

    const result = await getSecret('STRIPE_SECRET_KEY');
    expect(result).toBe('sk_live_from_ssm');
    // Should also cache in process.env
    expect(process.env.STRIPE_SECRET_KEY).toBe('sk_live_from_ssm');
  });

  it('should handle SSM error gracefully', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY_PARAM = '/test/stripe/key';
    const { __mockSend } = require('@aws-sdk/client-ssm');
    __mockSend.mockRejectedValue(new Error('SSM not available'));

    const result = await getSecret('STRIPE_SECRET_KEY');
    expect(result).toBeNull();
  });

  it('should return placeholder when SSM returns empty', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_your_placeholder';
    process.env.STRIPE_SECRET_KEY_PARAM = '/test/stripe/key';
    const { __mockSend } = require('@aws-sdk/client-ssm');
    __mockSend.mockResolvedValue({ Parameter: { Value: null } });

    const result = await getSecret('STRIPE_SECRET_KEY');
    // Falls back to the placeholder
    expect(result).toBe('sk_test_your_placeholder');
  });
});

// =============================================================================
// IOT HANDLER TESTS
// =============================================================================

describe('IoT Handlers', () => {
  beforeEach(() => {
    jest.resetModules();

    jest.mock('../src/common/db-client', () => ({
      getUser: jest.fn(),
      updateUser: jest.fn().mockResolvedValue({}),
    }));
  });

  const testUser = { userId: 'usr_test123' };

  describe('registerIoT', () => {
    it('should register an identity successfully', async () => {
      process.env.IS_LOCAL = 'true';
      const { registerIoT } = require('../src/functions/iot');

      const result = await registerIoT(testUser, {
        identityId: 'us-east-1:12345678-1234-1234-1234-123456789abc',
      });
      expect(result.success).toBe(true);
      expect(result.data.registered).toBe(true);
      expect(result.data.topic).toContain('user/');
    });

    it('should require identityId', async () => {
      const { registerIoT } = require('../src/functions/iot');
      const result = await registerIoT(testUser, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('should reject non-string identityId', async () => {
      const { registerIoT } = require('../src/functions/iot');
      const result = await registerIoT(testUser, { identityId: 12345 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('should reject invalid identityId format', async () => {
      const { registerIoT } = require('../src/functions/iot');
      const result = await registerIoT(testUser, { identityId: 'bad-format' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('should save identityId to user record', async () => {
      process.env.IS_LOCAL = 'true';
      const dbClient = require('../src/common/db-client');
      const { registerIoT } = require('../src/functions/iot');

      await registerIoT(testUser, {
        identityId: 'us-east-1:12345678-1234-1234-1234-123456789abc',
      });
      expect(dbClient.updateUser).toHaveBeenCalledWith(
        testUser.userId,
        { iotIdentityId: 'us-east-1:12345678-1234-1234-1234-123456789abc' }
      );
    });
  });

  describe('getIoTConfig', () => {
    it('should return IoT config', async () => {
      const dbClient = require('../src/common/db-client');
      dbClient.getUser.mockResolvedValue({ iotIdentityId: 'us-east-1:abc-123' });
      const { getIoTConfig } = require('../src/functions/iot');

      const result = await getIoTConfig(testUser);
      expect(result.success).toBe(true);
      expect(result.data.registered).toBe(true);
      expect(result.data.topic).toContain('user/');
    });

    it('should return registered=false when no identity', async () => {
      const dbClient = require('../src/common/db-client');
      dbClient.getUser.mockResolvedValue({});
      const { getIoTConfig } = require('../src/functions/iot');

      const result = await getIoTConfig(testUser);
      expect(result.data.registered).toBe(false);
      expect(result.data.topic).toBeNull();
    });

    it('should handle getUser failure gracefully', async () => {
      const dbClient = require('../src/common/db-client');
      dbClient.getUser.mockRejectedValue(new Error('fail'));
      const { getIoTConfig } = require('../src/functions/iot');

      const result = await getIoTConfig(testUser);
      expect(result.success).toBe(true);
      expect(result.data.registered).toBe(false);
    });
  });
});
