const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

/**
 * CloudFlare Turnstile Server-Side Verification Service
 * Handles verification of Turnstile tokens using CloudFlare's Siteverify API
 */
class TurnstileVerification {
  constructor() {
    this.ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    this.siteverifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    this.secretKey = null;
  }

  /**
   * Retrieve Turnstile secret key from AWS Parameter Store
   * @returns {Promise<string>} - Secret key
   */
  async getSecretKey() {
    if (this.secretKey) return this.secretKey;

    try {
      const command = new GetParameterCommand({
        Name: process.env.TURNSTILE_SECRET_KEY_NAME || '/totemboundci/turnstile/secret-key',
        WithDecryption: true
      });
      const response = await this.ssmClient.send(command);
      this.secretKey = response.Parameter.Value;
      return this.secretKey;
    }
    catch (error) {
      console.error('Failed to retrieve Turnstile secret key:', error);
      throw new Error('Turnstile configuration error');
    }
  }

  /**
   * Verify Turnstile token with CloudFlare
   * @param {string} token - Turnstile token from client
   * @param {string} clientIP - Client IP address (optional)
   * @returns {Promise<object>} - Verification result
   */
  async verifyToken(token, clientIP = null) {
    if (!token) {
      return { success: false, message: 'Missing verification token' };
    }

    try {
      const secretKey = await this.getSecretKey();
      
      const formData = new URLSearchParams({
        secret: secretKey,
        response: token,
        ...(clientIP && { remoteip: clientIP })
      });

      const response = await fetch(this.siteverifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData
      });

      const result = await response.json();
      
      return {
        success: result.success,
        message: result.success ? 'Verification successful' : 'Verification failed',
        errorCodes: result['error-codes'] || []
      };
    }
    catch (error) {
      console.error('Turnstile verification error:', error);
      // Re-throw configuration errors, return service unavailable for others
      if (error.message === 'Turnstile configuration error') {
        throw error;
      }
      return { success: false, message: 'Verification service unavailable' };
    }
  }
}

module.exports = TurnstileVerification;