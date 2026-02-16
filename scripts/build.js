/**
 * Build script for Lambda deployment
 *
 * Packages the monolithic Express app (app.js + lambda.js) with all
 * dependencies for a single Lambda function behind API Gateway {proxy+}.
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const SOURCE_DIR = path.join(__dirname, '..', 'src');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const FUNCTION_NAME = 'totembound-api';

// Directories to include in the Lambda package
const INCLUDE_DIRS = [
  'auth',
  'common',
  'config',
  'data',
  'db',
  'functions',
  'routes',
  'services',
  'types',
];

// Top-level source files to include
const INCLUDE_FILES = [
  'app.js',
  'lambda.js',
];

// Files to skip during copy
const SKIP_FILES = ['.env', '.env.local', '.env.development', '.env.production'];

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

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

function buildMonolith() {
  console.log(chalk.cyan(`Building ${FUNCTION_NAME} (monolithic Lambda)...`));

  const functionDist = path.join(DIST_DIR, FUNCTION_NAME);

  // Clean previous build
  removeDir(functionDist);
  fs.mkdirSync(functionDist, { recursive: true });

  // Copy top-level source files (app.js, lambda.js)
  for (const file of INCLUDE_FILES) {
    const srcPath = path.join(SOURCE_DIR, file);
    const destPath = path.join(functionDist, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(chalk.green(`  ✓ Copied ${file}`));
    } else {
      console.log(chalk.yellow(`  ⚠ Not found: ${file}`));
    }
  }

  // Copy included directories
  for (const dir of INCLUDE_DIRS) {
    const srcPath = path.join(SOURCE_DIR, dir);
    const destPath = path.join(functionDist, dir);
    if (fs.existsSync(srcPath)) {
      copyDir(srcPath, destPath);
      console.log(chalk.green(`  ✓ Copied ${dir}/`));
    } else {
      console.log(chalk.yellow(`  ⚠ Not found: ${dir}/`));
    }
  }

  // Create package.json for the Lambda
  const rootPackageJson = require('../package.json');
  const lambdaPackageJson = {
    name: FUNCTION_NAME,
    version: rootPackageJson.version,
    private: true,
    main: 'lambda.js',
    dependencies: {},
  };

  // Include production dependencies only
  for (const dep in rootPackageJson.dependencies) {
    // Skip packages only needed locally
    if (['swagger-jsdoc', 'swagger-ui-express'].includes(dep)) continue;
    lambdaPackageJson.dependencies[dep] = rootPackageJson.dependencies[dep];
  }

  const packageJsonPath = path.join(functionDist, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify(lambdaPackageJson, null, 2));
  console.log(chalk.green(`  ✓ Created package.json (main: lambda.js)`));

  console.log(chalk.green(`\n✅ Successfully built ${FUNCTION_NAME}`));
  return true;
}

// Run build
console.log(chalk.bold('\n📦 Building Lambda function...\n'));

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR);
}

const success = buildMonolith();

if (success) {
  console.log(chalk.bold.green('\n✅ Build complete!\n'));
} else {
  console.log(chalk.bold.red('\n❌ Build failed.\n'));
  process.exit(1);
}
