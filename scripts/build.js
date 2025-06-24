/**
 * Build script for Lambda functions
 * Creates optimized packages for each Lambda function
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

// Configuration
const LAMBDA_FUNCTIONS = ['relay', 'signup', 'premium', 'checkout', 'subscription'];
const SOURCE_DIR = path.join(__dirname, '..', 'src');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const COMMON_DIR = path.join(SOURCE_DIR, 'common');
const CONTRACTS_DIR = path.join(SOURCE_DIR, 'contracts');

// Files to skip during copy
const SKIP_FILES = ['.env', '.env.local', '.env.development', '.env.production'];

// Ensure dist directory exists
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR);
}

/**
 * Remove directory recursively (if it exists)
 */
function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy directory recursively
 */
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip .env files
    if (!entry.isDirectory() && SKIP_FILES.includes(entry.name)) {
      console.log(chalk.yellow(`  ↷ Skipping ${entry.name}`));
      continue;
    }
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Build a Lambda function
 */
function buildFunction(functionName) {
  console.log(chalk.cyan(`Building ${functionName} function...`));

  const functionSrc = path.join(SOURCE_DIR, functionName);
  const functionDist = path.join(DIST_DIR, functionName);
  const functionSrcDist = path.join(functionDist, functionName);

  // Ensure function directory exists
  if (!fs.existsSync(functionSrc)) {
    console.log(chalk.yellow(`Warning: ${functionName} directory not found in src`));
    return false;
  }

  // Create function dist directory
  if (!fs.existsSync(functionDist)) {
    fs.mkdirSync(functionDist, { recursive: true });
  }

  // Copy function source files
   removeDir(functionSrcDist);
  fs.mkdirSync(functionSrcDist, { recursive: true });
  copyDir(functionSrc, functionSrcDist);
  console.log(chalk.green(`  ✓ Copied ${functionName} source files`));
  
  // Copy common directory at the same level as in source
  const commonDist = path.join(functionDist, 'common');
  removeDir(commonDist); // Remove existing common directory
  fs.mkdirSync(commonDist, { recursive: true });
  copyDir(COMMON_DIR, commonDist);
  console.log(chalk.green(`  ✓ Copied common utilities (refreshed)`));
  
  // Copy contract ABIs if this is the relay function
  if (functionName === 'relay') {
    const contractsDist = path.join(functionDist, 'contracts');
    removeDir(contractsDist); // Remove existing contracts directory
    fs.mkdirSync(contractsDist, { recursive: true });
    copyDir(CONTRACTS_DIR, contractsDist);
    console.log(chalk.green(`  ✓ Copied contract ABIs (refreshed)`));
  }

  // Create a package.json for the function if it doesn't exist
  const packageJsonPath = path.join(functionDist, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    const packageJson = {
      name: `totem-api-${functionName}`,
      version: require('../package.json').version,
      private: true,
      main: 'index.js',
      dependencies: {}
    };

    // Add function-specific dependencies
    const rootPackageJson = require('../package.json');
    for (const dep in rootPackageJson.dependencies) {
      packageJson.dependencies[dep] = rootPackageJson.dependencies[dep];
    }

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    console.log(chalk.green(`  ✓ Created package.json`));
  }

  // Create a .env file with placeholder values if in development
  if (process.env.NODE_ENV !== 'production') {
    const envPath = path.join(functionDist, '.env.sample');
    if (!fs.existsSync(envPath)) {
      const envContent = `# Sample environment variables for ${functionName} function
# Replace with appropriate values for your environment
AWS_REGION=us-east-1
CORS_ORIGIN=*

# Common settings
USERS_TABLE=totembound-users-dev
TRANSACTIONS_TABLE=totembound-transactions-dev

# API Gateway settings
FREE_TIER_USAGE_PLAN_ID=abcdef123
PREMIUM_TIER_USAGE_PLAN_ID=abcdef456

# Function-specific settings
${
  functionName === 'relay'
    ? `
RPC_URL=https://polygon-mumbai.g.alchemy.com/v2/your-api-key
FORWARDER_PRIVATE_KEY=your-private-key
FORWARDER_ADDRESS=0x1234...
GAME_ADDRESS=0x1234...
NFT_ADDRESS=0x1234...
TOKEN_ADDRESS=0x1234...
REWARDS_ADDRESS=0x1234...
MAX_GAS_PRICE=50
MIN_WALLET_BALANCE=0.1`
    : ''
}
${
  functionName === 'checkout' || functionName === 'premium'
    ? `
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
STRIPE_SUCCESS_URL=https://totembound-test.net/account/success
STRIPE_CANCEL_URL=https://totembound-test.net/account/premium`
    : ''
}
${
  functionName === 'signup'
    ? `
EMAIL_FROM=no-reply@totembound.com
PAYMENT_URL=https://api.totembound.com/dev/checkout`
    : ''
}
`;
      fs.writeFileSync(envPath, envContent);
      console.log(chalk.green(`  ✓ Created .env.sample file`));
    }
  }

  console.log(chalk.green(`✅ Successfully built ${functionName} function`));
  return true;
}

// Build all Lambda functions
console.log(chalk.bold('\n📦 Building Lambda functions...\n'));
const results = LAMBDA_FUNCTIONS.map(buildFunction);

if (results.every(Boolean)) {
  console.log(chalk.bold.green('\n✅ All functions built successfully!\n'));
} else {
  console.log(chalk.bold.yellow('\n⚠️ Some functions could not be built. Check the logs above.\n'));
  process.exit(1);
}
