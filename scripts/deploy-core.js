/**
 * Deployment script for Core Infrastructure
 * Creates/updates the core CloudFormation stack
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  CloudFormationClient,
  DescribeStacksCommand,
  CreateStackCommand,
  UpdateStackCommand
} = require('@aws-sdk/client-cloudformation');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

// Get environment from command line args
const environment = process.argv[2];
if (!environment) {
  console.error(chalk.red('Error: Environment is required'));
  console.log(chalk.cyan('Usage: node scripts/deploy-core.js [environment]'));
  console.log(chalk.cyan('Available environments: staging, prod'));
  process.exit(1);
}

// Validate environment
const validEnvironments = ['staging', 'prod'];
if (!validEnvironments.includes(environment)) {
  console.error(chalk.red(`Error: Invalid environment: ${environment}`));
  console.log(chalk.cyan(`Available environments: ${validEnvironments.join(', ')}`));
  process.exit(1);
}

// Configuration
const CORE_TEMPLATE_PATH = path.join(__dirname, '..', 'infrastructure', 'cloudformation', 'core.yml');
const prefix = environment === 'prod' ? 'totembound' : 'totemboundci';

// Get version
const packageJson = require('../package.json');
const VERSION = process.env.VERSION || packageJson.version;

// Set bucket name and region based on environment
const S3_BUCKET = environment === 'prod' ? 'totembound-releases' : 'totemboundci-releases';
const AWS_REGION = environment === 'prod' ? 'us-east-1' : 'us-west-2';
console.log(chalk.blue(`Using S3 bucket: ${S3_BUCKET}`));
console.log(chalk.blue(`Using AWS region: ${AWS_REGION}`));

// AWS clients
const s3Client = new S3Client({ region: AWS_REGION });
const cfClient = new CloudFormationClient({ region: AWS_REGION });

/**
 * Upload a file to S3
 */
async function uploadToS3(filePath, key) {
  console.log(chalk.cyan(`Uploading ${path.basename(filePath)} to S3...`));

  try {
    const fileContent = fs.readFileSync(filePath);

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: fileContent
    });

    await s3Client.send(command);
    console.log(chalk.green(`  ✓ Uploaded to s3://${S3_BUCKET}/${key}`));
    return true;
  }
  catch (error) {
    console.error(chalk.red(`  ✗ Failed to upload to S3: ${error.message}`));
    return false;
  }
}

/**
 * Upload CloudFormation template to S3
 */
async function uploadCoreTemplate() {
  console.log(chalk.bold(`\n📤 Uploading Core Infrastructure template to S3...\n`));

  if (!fs.existsSync(CORE_TEMPLATE_PATH)) {
    console.log(chalk.yellow(`Warning: Core template not found at ${CORE_TEMPLATE_PATH}`));
    return false;
  }

  const templateKey = `totem-api/cloudformation/core-${VERSION}.yml`;
  const result = await uploadToS3(CORE_TEMPLATE_PATH, templateKey);

  if (result) {
    // Also upload as "latest" version
    const latestKey = `totem-api/cloudformation/core-latest.yml`;
    await uploadToS3(CORE_TEMPLATE_PATH, latestKey);
  }

  return result;
}

/**
 * Check if CloudFormation stack exists
 */
async function stackExists(stackName) {
  try {
    const command = new DescribeStacksCommand({ StackName: stackName });
    await cfClient.send(command);
    return true;
  }
  catch (error) {
    if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
      return false;
    }
    throw error;
  }
}

/**
 * Create or update the core CloudFormation stack
 */
async function deployCoreStack() {
  console.log(chalk.bold(`\n🚀 Deploying Core Infrastructure CloudFormation stack...\n`));
  const stackName = `${prefix}-core-stack`;

  // Get S3 path for the template
  const templateKey = `totem-api/cloudformation/core-${VERSION}.yml`;
  const templateUrl = `https://${S3_BUCKET}.s3.amazonaws.com/${templateKey}`;

  console.log(chalk.cyan(`Using template: core-${VERSION}.yml`));
  console.log(chalk.cyan(`Stack name: ${stackName}`));

  const exists = await stackExists(stackName);

  // Read environment-specific parameters
  let parameters = [];
  const paramFilePath = path.join(
    __dirname,
    '..',
    'infrastructure',
    `params-core-${environment}.json`
  );

  if (fs.existsSync(paramFilePath)) {
    try {
      const paramConfig = JSON.parse(fs.readFileSync(paramFilePath, 'utf8'));
      parameters = Object.entries(paramConfig).map(([key, value]) => ({
        ParameterKey: key,
        ParameterValue: value
      }));
      console.log(chalk.green(`  ✓ Loaded parameters from ${paramFilePath}`));
    }
    catch (error) {
      console.error(chalk.red(`  ✗ Failed to load parameters: ${error.message}`));
      return false;
    }
  }
  else {
    console.log(chalk.yellow(`  ⚠ No parameter file found at ${paramFilePath}, using defaults`));
    // For core infrastructure, only environment is required
    parameters = [
      {
        ParameterKey: 'Environment',
        ParameterValue: environment
      }
    ];
  }

  try {
    if (exists) {
      // Update existing stack
      console.log(chalk.cyan(`Updating stack ${stackName}...`));

      const command = new UpdateStackCommand({
        StackName: stackName,
        TemplateURL: templateUrl,
        Parameters: parameters,
        Capabilities: ['CAPABILITY_NAMED_IAM']
      });

      await cfClient.send(command);
      console.log(chalk.green(`  ✓ Stack update initiated. Check AWS Console for progress.`));
    }
    else {
      // Create new stack
      console.log(chalk.cyan(`Creating stack ${stackName}...`));

      const command = new CreateStackCommand({
        StackName: stackName,
        TemplateURL: templateUrl,
        Parameters: parameters,
        Capabilities: ['CAPABILITY_NAMED_IAM']
      });

      await cfClient.send(command);
      console.log(chalk.green(`  ✓ Stack creation initiated. Check AWS Console for progress.`));
    }

    return true;
  }
  catch (error) {
    console.error(chalk.red(`  ✗ Failed to deploy stack: ${error.message}`));
    return false;
  }
}

/**
 * Prompt user for yes/no input
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
 * Run the deployment
 */
async function deploy() {
  console.log(
    chalk.bold.cyan(
      `\n🚀 Starting Core Infrastructure deployment to ${environment.toUpperCase()} environment (v${VERSION})...\n`
    )
  );

  // Upload CloudFormation template to S3
  const templateUploaded = await uploadCoreTemplate();
  if (!templateUploaded) {
    console.error(chalk.red('Failed to upload core template. Deployment aborted.'));
    process.exit(1);
  }

  // Ask for confirmation before deploying infrastructure
  const createOrUpdateStack = await promptYesNo(
    `Do you want to ${(await stackExists(`${environment === 'prod' ? 'totembound' : 'totemboundci'}-core-stack`)) ? 'update' : 'create'} the Core Infrastructure stack?`
  );

  if (createOrUpdateStack) {
    // Deploy or update CloudFormation stack
    const stackDeployed = await deployCoreStack();
    if (!stackDeployed) {
      console.error(chalk.red('Failed to deploy Core Infrastructure stack. Deployment aborted.'));
      process.exit(1);
    }
  }
  else {
    console.log(chalk.yellow('Skipping Core Infrastructure stack deployment.'));
  }

  console.log(chalk.bold.green('\n✅ Core Infrastructure deployment completed successfully!\n'));
}

// Run deployment
deploy().catch(error => {
  console.error(chalk.red(`\n❌ Deployment failed: ${error.message}\n`));
  process.exit(1);
});
