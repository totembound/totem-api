#!/bin/bash

# TotemBound LocalStack Initialization
# This runs automatically when LocalStack starts

set -e

echo "🚀 Initializing LocalStack services..."

# ============================================
# S3 Buckets
# ============================================
echo "Creating S3 buckets..."
awslocal s3 mb s3://totembound-assets-local 2>/dev/null || true
awslocal s3 mb s3://totembound-uploads-local 2>/dev/null || true

# ============================================
# SSM Parameters (config/secrets for local dev)
# ============================================
echo "Creating SSM parameters..."

# Database config
awslocal ssm put-parameter \
  --name "/totembound/local/dynamodb/endpoint" \
  --value "http://dynamodb-local:8000" \
  --type String \
  --overwrite

# Cognito config
awslocal ssm put-parameter \
  --name "/totembound/local/cognito/user-pool-id" \
  --value "local_totembound" \
  --type String \
  --overwrite

awslocal ssm put-parameter \
  --name "/totembound/local/cognito/client-id" \
  --value "totembound-local-client" \
  --type String \
  --overwrite

# Stripe (test keys - replace with your test keys)
awslocal ssm put-parameter \
  --name "/totembound/local/stripe/secret-key" \
  --value "sk_test_your_test_key_here" \
  --type SecureString \
  --overwrite

awslocal ssm put-parameter \
  --name "/totembound/local/stripe/webhook-secret" \
  --value "whsec_test_webhook_secret" \
  --type SecureString \
  --overwrite

# ============================================
# SES (Email) - Verify sender identity
# ============================================
echo "Setting up SES..."
awslocal ses verify-email-identity --email-address noreply@totembound.local 2>/dev/null || true

echo ""
echo "✅ LocalStack initialized!"
echo ""
echo "Services available:"
echo "  S3:  http://localhost:4566"
echo "  SSM: http://localhost:4566"
echo "  SES: http://localhost:4566"
