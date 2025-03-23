/**
 * Package script for Lambda functions
 * Creates ZIP files for each Lambda function for deployment
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');

// Configuration
const LAMBDA_FUNCTIONS = ['relay', 'signup', 'premium', 'checkout', 'subscription'];
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PACKAGE_DIR = path.join(__dirname, '..', 'packages');

// Ensure package directory exists
if (!fs.existsSync(PACKAGE_DIR)) {
  fs.mkdirSync(PACKAGE_DIR, { recursive: true });
}

// Get version
const packageJson = require('../package.json');
const VERSION = process.env.VERSION || packageJson.version;

/**
 * Install production dependencies for a function
 */
function installDependencies(functionName) {
  const functionDir = path.join(DIST_DIR, functionName);
  
  console.log(chalk.cyan(`Installing dependencies for ${functionName}...`));
  
  try {
    // Run npm install with production flag
    execSync('npm install --omit=dev', {
      cwd: functionDir,
      stdio: 'inherit'
    });
    
    console.log(chalk.green(`  ✓ Installed dependencies for ${functionName}`));
    return true;
  }
  catch (error) {
    console.error(chalk.red(`  ✗ Failed to install dependencies for ${functionName}`));
    console.error(error.message);
    return false;
  }
}

/**
 * Package a Lambda function into a ZIP file
 */
function packageFunction(functionName) {
  console.log(chalk.cyan(`Packaging ${functionName} function...`));
  
  const functionDir = path.join(DIST_DIR, functionName);
  const zipFilePath = path.join(PACKAGE_DIR, `${functionName}-lambda-${VERSION}.zip`);
  
  // Ensure function directory exists
  if (!fs.existsSync(functionDir)) {
    console.log(chalk.yellow(`Warning: ${functionName} directory not found in dist`));
    return false;
  }

  try {
    // Create ZIP file
    if (process.platform === 'win32') {
      // Windows approach
      const zipCommand = `powershell Compress-Archive -Path "${functionDir}\\*" -DestinationPath "${zipFilePath}" -Force`;
      execSync(zipCommand);
    } else {
      // Unix approach
      const zipCommand = `cd "${functionDir}" && zip -r "${zipFilePath}" ./*`;
      execSync(zipCommand);
    }
    
    console.log(chalk.green(`  ✓ Created ${path.basename(zipFilePath)}`));
    return true;
  }
  catch (error) {
    console.error(chalk.red(`  ✗ Failed to create ZIP for ${functionName}`));
    console.error(error.message);
    return false;
  }
}

// First, check if dist directory exists
if (!fs.existsSync(DIST_DIR)) {
  console.log(chalk.red(`Error: Dist directory not found. Run 'npm run build' first.`));
  process.exit(1);
}

// Install dependencies and package all Lambda functions
console.log(chalk.bold(`\n📦 Packaging Lambda functions (v${VERSION})...\n`));

const installResults = LAMBDA_FUNCTIONS.map(installDependencies);
if (!installResults.every(Boolean)) {
  console.log(chalk.red('\n❌ Failed to install dependencies for some functions.'));
  process.exit(1);
}

console.log(chalk.bold('\n🚀 Creating ZIP packages...\n'));
const packageResults = LAMBDA_FUNCTIONS.map(packageFunction);

if (packageResults.every(Boolean)) {
  console.log(chalk.bold.green('\n✅ All functions packaged successfully!\n'));
  
  // List created packages
  console.log(chalk.cyan('Created packages:'));
  fs.readdirSync(PACKAGE_DIR).forEach(file => {
    if (file.endsWith('.zip')) {
      const filePath = path.join(PACKAGE_DIR, file);
      const stats = fs.statSync(filePath);
      const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`  - ${file} (${fileSizeInMB} MB)`);
    }
  });
  
  console.log(chalk.cyan(`\nPackages are ready for deployment in: ${PACKAGE_DIR}\n`));
}
else {
  console.log(chalk.bold.red('\n❌ Failed to package some functions. Check the logs above.\n'));
  process.exit(1);
}
