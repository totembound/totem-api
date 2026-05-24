/**
 * Package script for Lambda deployment
 *
 * Creates a ZIP file of the monolithic Lambda function for deployment.
 * Run `npm run build` first to populate the dist/ directory.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const chalk = require('chalk');

const FUNCTION_NAME = 'totembound-api';
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PACKAGE_DIR = path.join(__dirname, '..', 'packages');

if (!fs.existsSync(PACKAGE_DIR)) {
  fs.mkdirSync(PACKAGE_DIR, { recursive: true });
}

const packageJson = require('../package.json');
const VERSION = process.env.VERSION || packageJson.version;

function installDependencies() {
  const functionDir = path.join(DIST_DIR, FUNCTION_NAME);

  console.log(chalk.cyan(`Installing production dependencies...`));

  try {
    execSync('npm install --omit=dev', {
      cwd: functionDir,
      stdio: 'inherit'
    });
    console.log(chalk.green(`  ✓ Installed dependencies`));
    return true;
  }
  catch (error) {
    console.error(chalk.red(`  ✗ Failed to install dependencies`));
    console.error(error.message);
    return false;
  }
}

function packageFunction() {
  console.log(chalk.cyan(`Packaging ${FUNCTION_NAME}...`));

  const functionDir = path.join(DIST_DIR, FUNCTION_NAME);
  const zipFilePath = path.join(PACKAGE_DIR, `${FUNCTION_NAME}-${VERSION}.zip`);

  if (!fs.existsSync(functionDir)) {
    console.log(chalk.red(`Error: ${functionDir} not found. Run 'npm run build' first.`));
    return false;
  }

  try {
    // Remove old zip if exists
    if (fs.existsSync(zipFilePath)) {
      fs.unlinkSync(zipFilePath);
    }

    if (process.platform === 'win32') {
      execFileSync('powershell', [
        '-Command',
        'Compress-Archive',
        '-Path', `${functionDir}\\*`,
        '-DestinationPath', zipFilePath,
        '-Force',
      ]);
    }
    else {
      execFileSync('zip', ['-r', zipFilePath, '.'], { cwd: functionDir });
    }

    const stats = fs.statSync(zipFilePath);
    const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(chalk.green(`  ✓ Created ${path.basename(zipFilePath)} (${fileSizeInMB} MB)`));
    return true;
  }
  catch (error) {
    console.error(chalk.red(`  ✗ Failed to create ZIP`));
    console.error(error.message);
    return false;
  }
}

// Check dist exists
if (!fs.existsSync(path.join(DIST_DIR, FUNCTION_NAME))) {
  console.log(chalk.red(`Error: Dist directory not found. Run 'npm run build' first.`));
  process.exit(1);
}

console.log(chalk.bold(`\n📦 Packaging Lambda function (v${VERSION})...\n`));

if (!installDependencies()) {
  console.log(chalk.red('\n❌ Failed to install dependencies.'));
  process.exit(1);
}

console.log(chalk.bold('\n🚀 Creating ZIP package...\n'));

if (packageFunction()) {
  console.log(chalk.bold.green('\n✅ Package ready for deployment!\n'));
  console.log(chalk.cyan(`Package: ${PACKAGE_DIR}/${FUNCTION_NAME}-${VERSION}.zip`));
  console.log(chalk.cyan(`Lambda handler: lambda.handler\n`));
}
else {
  console.log(chalk.bold.red('\n❌ Packaging failed.\n'));
  process.exit(1);
}
