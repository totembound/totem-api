/**
 * Deployment script for the monolithic API Lambda
 *
 * Uploads the Lambda package to S3 and optionally:
 * - Updates the CloudFormation stack
 * - Updates the Lambda function code directly
 *
 * Usage: node scripts/deploy-api.js [staging|prod]
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  CloudFormationClient,
  DescribeStacksCommand,
  CreateStackCommand,
  UpdateStackCommand
} = require('@aws-sdk/client-cloudformation');
const { LambdaClient, UpdateFunctionCodeCommand } = require('@aws-sdk/client-lambda');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

// Configuration
const FUNCTION_NAME = 'totembound-api';
const PACKAGE_DIR = path.join(__dirname, '..', 'packages');
const CF_TEMPLATE_PATH = path.join(__dirname, '..', 'infrastructure', 'cloudformation', 'api.yml');

// Environment config
const ENV_CONFIG = {
  staging: {
    prefix: 'totemboundci',
    s3Bucket: 'totemboundci-releases',
    region: 'us-west-2',
    stackName: 'totemboundci-api-stack',
  },
  prod: {
    prefix: 'totembound',
    s3Bucket: 'totembound-releases',
    region: 'us-east-1',
    stackName: 'totembound-api-stack',
  }
};

// Get environment from command line args
const environment = process.argv[2];
if (!environment || !ENV_CONFIG[environment]) {
  console.error(chalk.red('Error: Valid environment required'));
  console.log(chalk.cyan('Usage: node scripts/deploy-api.js [staging|prod]'));
  process.exit(1);
}

const config = ENV_CONFIG[environment];
const packageJson = require('../package.json');
const VERSION = process.env.VERSION || packageJson.version;

// AWS clients
const s3Client = new S3Client({ region: config.region });
const cfClient = new CloudFormationClient({ region: config.region });
const lambdaClient = new LambdaClient({ region: config.region });

console.log(chalk.blue(`Environment: ${environment}`));
console.log(chalk.blue(`S3 bucket: ${config.s3Bucket}`));
console.log(chalk.blue(`Region: ${config.region}`));
console.log(chalk.blue(`Version: ${VERSION}`));

/**
 * Upload a file to S3
 */
async function uploadToS3(filePath, key) {
  console.log(chalk.cyan(`  Uploading ${path.basename(filePath)} → s3://${config.s3Bucket}/${key}`));

  const fileContent = fs.readFileSync(filePath);
  await s3Client.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    Body: fileContent
  }));
  console.log(chalk.green(`  ✓ Uploaded`));
}

/**
 * Upload Lambda package to S3
 */
async function uploadPackage() {
  console.log(chalk.bold(`\n📤 Uploading Lambda package to S3...\n`));

  const zipFileName = `${FUNCTION_NAME}-${VERSION}.zip`;
  const zipFilePath = path.join(PACKAGE_DIR, zipFileName);

  if (!fs.existsSync(zipFilePath)) {
    console.error(chalk.red(`Error: Package not found: ${zipFilePath}`));
    console.log(chalk.cyan(`Run 'npm run build && npm run package' first.`));
    return false;
  }

  try {
    // Upload versioned zip
    await uploadToS3(zipFilePath, `totem-api/${zipFileName}`);

    // Upload as "latest"
    await uploadToS3(zipFilePath, `totem-api/${FUNCTION_NAME}-latest.zip`);

    return true;
  } catch (error) {
    console.error(chalk.red(`  ✗ Failed: ${error.message}`));
    return false;
  }
}

/**
 * Upload CloudFormation template to S3
 */
async function uploadTemplate() {
  console.log(chalk.bold(`\n📤 Uploading CloudFormation template...\n`));

  if (!fs.existsSync(CF_TEMPLATE_PATH)) {
    console.log(chalk.yellow(`  ⚠ Template not found at ${CF_TEMPLATE_PATH}`));
    return false;
  }

  try {
    await uploadToS3(CF_TEMPLATE_PATH, `totem-api/cloudformation/api-${VERSION}.yml`);
    await uploadToS3(CF_TEMPLATE_PATH, `totem-api/cloudformation/api-latest.yml`);
    return true;
  } catch (error) {
    console.error(chalk.red(`  ✗ Failed: ${error.message}`));
    return false;
  }
}

/**
 * Check if CloudFormation stack exists
 */
async function stackExists(stackName) {
  try {
    await cfClient.send(new DescribeStacksCommand({ StackName: stackName }));
    return true;
  } catch (error) {
    if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
      return false;
    }
    throw error;
  }
}

/**
 * Deploy CloudFormation stack
 */
async function deployStack() {
  console.log(chalk.bold(`\n🚀 Deploying CloudFormation stack...\n`));

  const templateUrl = `https://${config.s3Bucket}.s3.amazonaws.com/totem-api/cloudformation/api-${VERSION}.yml`;

  // Load environment parameters
  let parameters = [
    { ParameterKey: 'Environment', ParameterValue: environment },
    { ParameterKey: 'AppVersion', ParameterValue: VERSION },
  ];

  const paramFilePath = path.join(__dirname, '..', 'infrastructure', `params-api-${environment}.json`);
  if (fs.existsSync(paramFilePath)) {
    const paramConfig = JSON.parse(fs.readFileSync(paramFilePath, 'utf8'));
    for (const [key, value] of Object.entries(paramConfig)) {
      // Don't override Environment or AppVersion
      if (key !== 'Environment' && key !== 'AppVersion') {
        parameters.push({ ParameterKey: key, ParameterValue: value });
      }
    }
    console.log(chalk.green(`  ✓ Loaded parameters from ${paramFilePath}`));
  }

  const exists = await stackExists(config.stackName);

  try {
    const command = exists
      ? new UpdateStackCommand({
          StackName: config.stackName,
          TemplateURL: templateUrl,
          Parameters: parameters,
          Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
        })
      : new CreateStackCommand({
          StackName: config.stackName,
          TemplateURL: templateUrl,
          Parameters: parameters,
          Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
        });

    await cfClient.send(command);
    console.log(chalk.green(`  ✓ Stack ${exists ? 'update' : 'creation'} initiated.`));
    return true;
  } catch (error) {
    console.error(chalk.red(`  ✗ Failed: ${error.message}`));
    return false;
  }
}

/**
 * Update Lambda function code directly (faster than CloudFormation)
 */
async function updateLambdaCode() {
  console.log(chalk.bold(`\n🔄 Updating Lambda function code...\n`));

  const lambdaName = `${config.prefix}-api`;
  console.log(chalk.cyan(`  Updating ${lambdaName}...`));

  try {
    await lambdaClient.send(new UpdateFunctionCodeCommand({
      FunctionName: lambdaName,
      S3Bucket: config.s3Bucket,
      S3Key: `totem-api/${FUNCTION_NAME}-${VERSION}.zip`
    }));
    console.log(chalk.green(`  ✓ Updated ${lambdaName}`));
    return true;
  } catch (error) {
    console.error(chalk.red(`  ✗ Failed: ${error.message}`));
    return false;
  }
}

/**
 * Prompt user for yes/no
 */
function promptYesNo(question) {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    readline.question(`${chalk.cyan(question)} (y/n) `, answer => {
      readline.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Main deployment flow
 */
async function deploy() {
  console.log(chalk.bold.cyan(
    `\n🚀 Deploying API to ${environment.toUpperCase()} (v${VERSION})...\n`
  ));

  // Upload package to S3
  if (!(await uploadPackage())) {
    process.exit(1);
  }

  // Upload CloudFormation template
  if (!(await uploadTemplate())) {
    console.log(chalk.yellow('Skipping template upload (continuing with Lambda update).'));
  }

  // CloudFormation stack update
  if (await promptYesNo('Deploy/update CloudFormation stack?')) {
    await deployStack();
  } else {
    console.log(chalk.yellow('Skipping CloudFormation update.'));
  }

  // Direct Lambda code update
  if (await promptYesNo('Update Lambda function code directly?')) {
    await updateLambdaCode();
  } else {
    console.log(chalk.yellow('Skipping Lambda code update.'));
  }

  console.log(chalk.bold.green('\n✅ Deployment completed!\n'));
}

deploy().catch(error => {
  console.error(chalk.red(`\n❌ Deployment failed: ${error.message}\n`));
  process.exit(1);
});
