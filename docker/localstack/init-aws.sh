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
# Note: --cli-input-json avoids AWS CLI misinterpreting URLs as remote param files
awslocal ssm put-parameter --cli-input-json '{"Name":"/totembound/local/dynamodb/endpoint","Value":"http://dynamodb-local:8000","Type":"String","Overwrite":true}'

# Cognito config
awslocal ssm put-parameter --cli-input-json '{"Name":"/totembound/local/cognito/user-pool-id","Value":"local_totembound","Type":"String","Overwrite":true}'

awslocal ssm put-parameter --cli-input-json '{"Name":"/totembound/local/cognito/client-id","Value":"totembound-local-client","Type":"String","Overwrite":true}'

# Stripe (test keys - replace with your test keys)
awslocal ssm put-parameter --cli-input-json '{"Name":"/totembound/local/stripe/secret-key","Value":"sk_test_your_test_key_here","Type":"SecureString","Overwrite":true}'

awslocal ssm put-parameter --cli-input-json '{"Name":"/totembound/local/stripe/webhook-secret","Value":"whsec_test_webhook_secret","Type":"SecureString","Overwrite":true}'

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
