#!/usr/bin/env node

/**
 * Generate Test JWT Token
 *
 * Creates a JWT token for local development testing.
 * This mimics what Cognito would return after authentication.
 *
 * Usage:
 *   node scripts/generate-test-token.js
 *   node scripts/generate-test-token.js --user premium
 *   node scripts/generate-test-token.js --email custom@test.com
 */

const jwt = require('jsonwebtoken');

// ============================================
// Test Users
// ============================================

const TEST_USERS = {
  free: {
    sub: 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    email: 'testplayer1@example.com',
    'custom:userId': 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'custom:displayName': 'TestPlayer1',
    'custom:tier': 'free',
    email_verified: true,
  },
  premium: {
    sub: 'usr_b2c3d4e5-f6a7-8901-bcde-f12345678901',
    email: 'premiumplayer@example.com',
    'custom:userId': 'usr_b2c3d4e5-f6a7-8901-bcde-f12345678901',
    'custom:displayName': 'PremiumPlayer',
    'custom:tier': 'premium',
    email_verified: true,
  },
  vip: {
    sub: 'usr_c3d4e5f6-a7b8-9012-cdef-123456789012',
    email: 'vipplayer@example.com',
    'custom:userId': 'usr_c3d4e5f6-a7b8-9012-cdef-123456789012',
    'custom:displayName': 'VIPPlayer',
    'custom:tier': 'vip',
    email_verified: true,
  },
};

// ============================================
// Parse Arguments
// ============================================

const args = process.argv.slice(2);
let userType = 'free';
let customEmail = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--user' && args[i + 1]) {
    userType = args[i + 1];
    i++;
  } else if (args[i] === '--email' && args[i + 1]) {
    customEmail = args[i + 1];
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Usage: node scripts/generate-test-token.js [options]

Options:
  --user <type>    User type: free, premium, vip (default: free)
  --email <email>  Custom email (creates new user)
  --help, -h       Show this help

Examples:
  node scripts/generate-test-token.js
  node scripts/generate-test-token.js --user premium
  node scripts/generate-test-token.js --email custom@test.com
`);
    process.exit(0);
  }
}

// ============================================
// Generate Token
// ============================================

// Secret for local development (not secure, but that's fine for local)
const LOCAL_SECRET = 'totembound-local-development-secret-key-not-for-production';

// Get or create user payload
let payload;

if (customEmail) {
  const { v4: uuidv4 } = require('uuid');
  const userId = `usr_${uuidv4()}`;
  payload = {
    sub: userId,
    email: customEmail,
    'custom:userId': userId,
    'custom:displayName': customEmail.split('@')[0],
    'custom:tier': 'free',
    email_verified: true,
  };
} else if (TEST_USERS[userType]) {
  payload = TEST_USERS[userType];
} else {
  console.error(`Unknown user type: ${userType}`);
  console.error('Available types: free, premium, vip');
  process.exit(1);
}

// Add standard Cognito claims
const now = Math.floor(Date.now() / 1000);
const fullPayload = {
  ...payload,
  iss: 'http://localhost:9229/local_totembound',
  aud: 'totembound-local-client',
  token_use: 'access',
  auth_time: now,
  iat: now,
  exp: now + (60 * 60), // 1 hour
};

// Generate token
const token = jwt.sign(fullPayload, LOCAL_SECRET, { algorithm: 'HS256' });

// ============================================
// Output
// ============================================

console.log('');
console.log('🔑 Generated Test JWT Token');
console.log('============================');
console.log('');
console.log('User:', payload['custom:displayName'], `(${payload['custom:tier']})`);
console.log('Email:', payload.email);
console.log('User ID:', payload['custom:userId']);
console.log('');
console.log('Token (valid for 1 hour):');
console.log('');
console.log(token);
console.log('');
console.log('Usage with curl:');
console.log(`  curl -H "Authorization: Bearer ${token}" http://localhost:3001/api/user/profile`);
console.log('');
console.log('Usage in browser console:');
console.log(`  localStorage.setItem('totembound_token', '${token}')`);
console.log('');
