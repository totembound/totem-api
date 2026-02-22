# TotemBound Infrastructure

AWS infrastructure for the TotemBound game backend. Four CloudFormation stacks provision everything needed to run the API: database tables, authentication, the Lambda function with API Gateway, and real-time push notifications via IoT Core.

All stacks use environment mappings so the same templates work for both staging (`totemboundci-*`, us-west-2) and production (`totembound-*`, us-east-1). Stacks export outputs that downstream stacks import, so deploy order matters.

Templates are versioned and stored in S3 before each deploy. Parameter files in this directory hold environment-specific values (Stripe price IDs, SSM paths, email config) that get passed to CloudFormation at deploy time.

## CloudFormation Stacks

Deploy in order (cross-stack references):

| # | Stack | Template | What it creates |
|---|-------|----------|-----------------|
| 1 | **core** | `cloudformation/core.yml` | 9 DynamoDB tables + IAM Lambda execution role |
| 2 | **cognito** | `cloudformation/cognito.yml` | Cognito User Pool + App Client (24h token validity) |
| 3 | **api** | `cloudformation/api.yml` | Lambda (nodejs20.x) + REST API Gateway + Cognito Authorizer |
| 4 | **iot** | `cloudformation/iot.yml` | Cognito Identity Pool + IoT policies (real-time MQTT/WebSocket push) |

## Stack Names

| Stack | Staging | Production |
|-------|---------|------------|
| core | `totemboundci-core-stack` | `totembound-core-stack` |
| cognito | `totemboundci-cognito-stack` | `totembound-cognito-stack` |
| api | `totemboundci-api-stack` | `totembound-api-stack` |
| iot | `totemboundci-iot-stack` | `totembound-iot-stack` |

## Parameter Files

| File | Stack | Environment |
|------|-------|-------------|
| `params-core-staging.json` | core | staging |
| `params-cognito-staging.json` | cognito | staging |
| `params-api-staging.json` | api | staging (Stripe price IDs, SSM paths) |

Prod parameter files (`params-*-prod.json`) to be added before production deploy.

The IoT stack doesn't use a parameter file — its parameters (CognitoUserPoolId, CognitoUserPoolClientId, LambdaExecutionRoleArn) are fetched dynamically from the core and cognito stack outputs at deploy time.

## Deploy from CLI

```bash
# Using Node.js scripts (interactive)
node scripts/deploy-core.js
node scripts/deploy-cognito.js
node scripts/deploy-api.js

# Using AWS CLI directly
aws cloudformation update-stack \
  --stack-name totemboundci-core-stack \
  --template-body file://cloudformation/core.yml \
  --parameters ParameterKey=Environment,ParameterValue=staging \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-west-2
```

## CI/CD

Infrastructure deploys are automated via GitHub Actions in `totem-devops`:
- `ci-infra-deploy.yml` — staging (us-west-2)
- `prod-infra-deploy.yml` — production (us-east-1)

Both workflows accept a stack choice (core, cognito, api, iot, or all) and deploy sequentially when `all` is selected. Templates are versioned in S3 at `s3://{bucket}/totem-api/cloudformation/{stack}-{version}.yml`.
