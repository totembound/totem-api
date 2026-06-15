/**
 * Sanctum Handler Validation Tests
 *
 * Tests param validation in the thin handler layer (functions/sanctum/).
 * Service-level logic is tested in sanctum.test.js.
 */

const { seatTotem } = require('../src/functions/sanctum/seat');
const { unseatTotem } = require('../src/functions/sanctum/unseat');
const { startCouncilMission } = require('../src/functions/sanctum/mission-start');
const { claimCouncilMission } = require('../src/functions/sanctum/mission-claim');
const { cancelCouncilMission } = require('../src/functions/sanctum/mission-cancel');

// Mock the service — we only test handler validation here
jest.mock('../src/services/sanctum-service', () => ({
  seatTotem: jest.fn(),
  unseatTotem: jest.fn(),
  startCouncilMission: jest.fn(),
  claimCouncilMission: jest.fn(),
  cancelCouncilMission: jest.fn(),
}));

const user = { userId: 'usr_test123' };

describe('Sanctum Handler Validation', () => {
  describe('seatTotem', () => {
    it('should reject missing totemId', async () => {
      const result = await seatTotem(user, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should reject null body', async () => {
      const result = await seatTotem(user, null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should reject invalid totemId format', async () => {
      const result = await seatTotem(user, { totemId: 'bad_id' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should reject invalid seatIndex (negative)', async () => {
      const result = await seatTotem(user, { totemId: 'ttm_abc', seatIndex: -1 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_PARAM');
    });

    it('should reject invalid seatIndex (> 2)', async () => {
      const result = await seatTotem(user, { totemId: 'ttm_abc', seatIndex: 3 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_PARAM');
    });

    it('should reject non-integer seatIndex', async () => {
      const result = await seatTotem(user, { totemId: 'ttm_abc', seatIndex: 1.5 });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_PARAM');
    });

    it('should pass valid params to service', async () => {
      const sanctumService = require('../src/services/sanctum-service');
      sanctumService.seatTotem.mockResolvedValue({ success: true });

      const result = await seatTotem(user, { totemId: 'ttm_abc', seatIndex: 1 });
      expect(result.success).toBe(true);
      expect(sanctumService.seatTotem).toHaveBeenCalledWith('usr_test123', 'ttm_abc', 1);
    });

    it('should allow omitted seatIndex', async () => {
      const sanctumService = require('../src/services/sanctum-service');
      sanctumService.seatTotem.mockResolvedValue({ success: true });

      const result = await seatTotem(user, { totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(sanctumService.seatTotem).toHaveBeenCalledWith('usr_test123', 'ttm_abc', undefined);
    });
  });

  describe('unseatTotem', () => {
    it('should reject missing totemId', async () => {
      const result = await unseatTotem(user, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should reject invalid totemId format', async () => {
      const result = await unseatTotem(user, { totemId: 'totem_123' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_ID');
    });

    it('should pass valid params to service', async () => {
      const sanctumService = require('../src/services/sanctum-service');
      sanctumService.unseatTotem.mockResolvedValue({ success: true });

      const result = await unseatTotem(user, { totemId: 'ttm_xyz' });
      expect(result.success).toBe(true);
      expect(sanctumService.unseatTotem).toHaveBeenCalledWith('usr_test123', 'ttm_xyz');
    });
  });

  describe('startCouncilMission', () => {
    it('should reject missing totemId', async () => {
      const result = await startCouncilMission(user, { missionType: 'cm_decree-of-wisdom' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
      expect(result.error.message).toMatch(/totemId/);
    });

    it('should reject missing missionType', async () => {
      const result = await startCouncilMission(user, { totemId: 'ttm_abc' });
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
      expect(result.error.message).toMatch(/missionType/);
    });

    it('should reject empty body', async () => {
      const result = await startCouncilMission(user, null);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should pass valid params to service', async () => {
      const sanctumService = require('../src/services/sanctum-service');
      sanctumService.startCouncilMission.mockResolvedValue({ success: true });

      const result = await startCouncilMission(user, { totemId: 'ttm_abc', missionType: 'cm_decree-of-wisdom' });
      expect(result.success).toBe(true);
      expect(sanctumService.startCouncilMission).toHaveBeenCalledWith('usr_test123', 'ttm_abc', 'cm_decree-of-wisdom');
    });
  });

  describe('claimCouncilMission', () => {
    it('should reject missing totemId', async () => {
      const result = await claimCouncilMission(user, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should pass valid params to service', async () => {
      const sanctumService = require('../src/services/sanctum-service');
      sanctumService.claimCouncilMission.mockResolvedValue({ success: true });

      const result = await claimCouncilMission(user, { totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(sanctumService.claimCouncilMission).toHaveBeenCalledWith('usr_test123', 'ttm_abc');
    });
  });

  describe('cancelCouncilMission', () => {
    it('should reject missing totemId', async () => {
      const result = await cancelCouncilMission(user, {});
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('MISSING_PARAM');
    });

    it('should pass valid params to service', async () => {
      const sanctumService = require('../src/services/sanctum-service');
      sanctumService.cancelCouncilMission.mockResolvedValue({ success: true });

      const result = await cancelCouncilMission(user, { totemId: 'ttm_abc' });
      expect(result.success).toBe(true);
      expect(sanctumService.cancelCouncilMission).toHaveBeenCalledWith('usr_test123', 'ttm_abc');
    });
  });
});
