/**
 * Deployment script for Lambda functions
 * Uploads packages to S3 and optionally updates CloudFormation stack
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
const LAMBDA_FUNCTIONS = ['relay', 'signup', 'premium', 'checkout'];
const PACKAGE_DIR = path.join(__dirname, '..', 'packages');
const CF_TEMPLATE_PATH = path.join(__dirname, '..', 'infrastructure', 'cloudformation', 'main.yml');

// Get environment from command line args
const environment = process.argv[2];
if (!environment) {
  console.error(chalk.red('Error: Environment is required'));
  console.log(chalk.cyan('Usage: node scripts/deploy.js [environment]'));
  console.log(chalk.cyan('Available environments: dev, staging, prod'));
  process.exit(1);
}

// Validate environment
const validEnvironments = ['dev', 'staging', 'prod'];
if (!validEnvironments.includes(environment)) {
  console.error(chalk.red(`Error: Invalid environment: ${environment}`));
  console.log(chalk.cyan(`Available environments: ${validEnvironments.join(', ')}`));
  process.exit(1);
}

// Get version
const packageJson = require('../package.json');
const VERSION = process.env.VERSION || packageJson.version;

// AWS clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const cfClient = new CloudFormationClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

// S3 bucket for deployment artifacts
const S3_BUCKET = process.env.S3_BUCKET || 'totem-releases';

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
  } catch (error) {
    console.error(chalk.red(`  ✗ Failed to upload to S3: ${error.message}`));
    return false;
  }
}

/**
 * Deploy Lambda packages to S3
 */
async function deployPackagesToS3() {
  console.log(chalk.bold(`\n📤 Uploading Lambda packages to S3...\n`));

  const uploadPromises = LAMBDA_FUNCTIONS.map(async functionName => {
    const zipFileName = `${functionName}-lambda-${VERSION}.zip`;
    const zipFilePath = path.join(PACKAGE_DIR, zipFileName);

    if (!fs.existsSync(zipFilePath)) {
      console.log(chalk.yellow(`Warning: Package not found for ${functionName}`));
      return false;
    }

    const s3Key = `${environment}/lambda/${zipFileName}`;
    const result = await uploadToS3(zipFilePath, s3Key);

    if (result) {
      // Also upload as "latest" version
      const latestKey = `${environment}/lambda/${functionName}-lambda-latest.zip`;
      await uploadToS3(zipFilePath, latestKey);
    }

    return result;
  });

  const uploadResults = await Promise.all(uploadPromises);

  if (uploadResults.every(Boolean)) {
    console.log(chalk.bold.green('\n✅ All packages uploaded successfully!\n'));
    return true;
  } else {
    console.log(chalk.bold.red('\n❌ Failed to upload some packages. Check the logs above.\n'));
    return false;
  }
}

/**
 * Upload CloudFormation template to S3
 */
async function uploadCloudFormationTemplate() {
  console.log(chalk.bold(`\n📤 Uploading CloudFormation template to S3...\n`));

  if (!fs.existsSync(CF_TEMPLATE_PATH)) {
    console.log(chalk.yellow(`Warning: CloudFormation template not found at ${CF_TEMPLATE_PATH}`));
    return false;
  }

  const templateKey = `${environment}/cloudformation/main-${VERSION}.yml`;
  const result = await uploadToS3(CF_TEMPLATE_PATH, templateKey);

  if (result) {
    // Also upload as "latest" version
    const latestKey = `${environment}/cloudformation/main-latest.yml`;
    await uploadToS3(CF_TEMPLATE_PATH, latestKey);
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
  } catch (error) {
    if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
      return false;
    }
    throw error;
  }
}

/**
 * Create or update CloudFormation stack
 */
async function deployCloudFormationStack() {
  console.log(chalk.bold(`\n🚀 Deploying CloudFormation stack...\n`));

  const stackName = `totembound-api-${environment}`;
  const exists = await stackExists(stackName);

  // Get CloudFormation template URL from S3
  const templateUrl = `https://${S3_BUCKET}.s3.amazonaws.com/${environment}/cloudformation/main-${VERSION}.yml`;

  // Read environment-specific parameters
  let parameters = [];
  const paramFilePath = path.join(__dirname, '..', `cloudformation-params-${environment}.json`);

  if (fs.existsSync(paramFilePath)) {
    try {
      const paramConfig = JSON.parse(fs.readFileSync(paramFilePath, 'utf8'));
      parameters = Object.entries(paramConfig).map(([key, value]) => ({
        ParameterKey: key,
        ParameterValue: value
      }));
      console.log(chalk.green(`  ✓ Loaded parameters from ${paramFilePath}`));
    } catch (error) {
      console.error(chalk.red(`  ✗ Failed to load parameters: ${error.message}`));
      return false;
    }
  } else {
    console.log(chalk.yellow(`  ⚠ No parameter file found at ${paramFilePath}, using defaults`));
    // Add default parameters
    parameters = [
      {
        ParameterKey: 'Environment',
        ParameterValue: environment
      },
      {
        ParameterKey: 'CorsOrigin',
        ParameterValue:
          environment === 'prod'
            ? 'https://app.totembound.com'
            : `https://${environment}.totembound.com`
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
        Capabilities: ['CAPABILITY_IAM']
      });

      await cfClient.send(command);
      console.log(chalk.green(`  ✓ Stack update initiated. Check AWS Console for progress.`));
    } else {
      // Create new stack
      console.log(chalk.cyan(`Creating stack ${stackName}...`));

      const command = new CreateStackCommand({
        StackName: stackName,
        TemplateURL: templateUrl,
        Parameters: parameters,
        Capabilities: ['CAPABILITY_IAM']
      });

      await cfClient.send(command);
      console.log(chalk.green(`  ✓ Stack creation initiated. Check AWS Console for progress.`));
    }

    return true;
  } catch (error) {
    console.error(chalk.red(`  ✗ Failed to deploy stack: ${error.message}`));
    return false;
  }
}

/**
 * Update Lambda function code
 */
async function updateLambdaFunctions() {
  console.log(chalk.bold(`\n🔄 Updating Lambda functions...\n`));

  // Get Lambda function names from environment variables or use convention
  const functionNames = LAMBDA_FUNCTIONS.map(
    func =>
      process.env[`${func.toUpperCase()}_FUNCTION_NAME`] || `totembound-${func}-${environment}`
  );

  const updatePromises = LAMBDA_FUNCTIONS.map(async (functionName, index) => {
    const lambdaName = functionNames[index];
    console.log(chalk.cyan(`Updating ${lambdaName}...`));

    try {
      const command = new UpdateFunctionCodeCommand({
        FunctionName: lambdaName,
        S3Bucket: S3_BUCKET,
        S3Key: `${environment}/lambda/${functionName}-lambda-${VERSION}.zip`
      });

      await lambdaClient.send(command);
      console.log(chalk.green(`  ✓ Updated ${lambdaName}`));
      return true;
    } catch (error) {
      console.error(chalk.red(`  ✗ Failed to update ${lambdaName}: ${error.message}`));
      return false;
    }
  });

  const updateResults = await Promise.all(updatePromises);

  if (updateResults.every(Boolean)) {
    console.log(chalk.bold.green('\n✅ All Lambda functions updated successfully!\n'));
    return true;
  } else {
    console.log(
      chalk.bold.yellow('\n⚠️ Some Lambda functions could not be updated. Check the logs above.\n')
    );
    return false;
  }
}

/**
 * Run the full deployment
 */
async function deploy() {
  console.log(
    chalk.bold.cyan(
      `\n🚀 Starting deployment to ${environment.toUpperCase()} environment (v${VERSION})...\n`
    )
  );

  // First, upload packages to S3
  const packagesUploaded = await deployPackagesToS3();
  if (!packagesUploaded) {
    console.error(chalk.red('Failed to upload packages. Deployment aborted.'));
    process.exit(1);
  }

  // Upload CloudFormation template
  const templateUploaded = await uploadCloudFormationTemplate();
  if (!templateUploaded) {
    console.error(chalk.red('Failed to upload CloudFormation template. Deployment aborted.'));
    process.exit(1);
  }

  // Ask for confirmation before updating infrastructure
  const createOrUpdateStack = await promptYesNo(
    `Do you want to ${(await stackExists(`totembound-api-${environment}`)) ? 'update' : 'create'} the CloudFormation stack?`
  );

  if (createOrUpdateStack) {
    // Deploy or update CloudFormation stack
    const stackDeployed = await deployCloudFormationStack();
    if (!stackDeployed) {
      console.error(chalk.red('Failed to deploy CloudFormation stack. Deployment aborted.'));
      process.exit(1);
    }
  } else {
    console.log(chalk.yellow('Skipping CloudFormation stack deployment.'));
  }

  // Ask for confirmation before updating Lambda functions
  const updateLambdas = await promptYesNo('Do you want to update the Lambda functions directly?');

  if (updateLambdas) {
    // Update Lambda functions
    const lambdasUpdated = await updateLambdaFunctions();
    if (!lambdasUpdated) {
      console.error(chalk.red('Failed to update some Lambda functions.'));
      process.exit(1);
    }
  } else {
    console.log(chalk.yellow('Skipping Lambda function updates.'));
  }

  console.log(chalk.bold.green('\n✅ Deployment completed successfully!\n'));
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

// Run deployment
deploy().catch(error => {
  console.error(chalk.red(`\n❌ Deployment failed: ${error.message}\n`));
  process.exit(1);
});
