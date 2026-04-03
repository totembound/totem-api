/**
 * Promote a user to admin role
 *
 * Usage: node scripts/promote-admin.js <email>
 *
 * Looks up the user by email in DynamoDB Local and sets role to 'admin'.
 * This is the ONLY way to create an admin — no API endpoint exists for this.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
const region = process.env.AWS_REGION || 'us-west-2';
const tableName = process.env.DYNAMODB_USERS_TABLE || 'TotemBound-Users';

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ endpoint, region, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }),
);

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/promote-admin.js <email>');
    process.exit(1);
  }

  // Find user by email
  const scan = await client.send(new ScanCommand({
    TableName: tableName,
    FilterExpression: 'sk = :profile AND email = :email',
    ExpressionAttributeValues: { ':profile': 'PROFILE', ':email': email.toLowerCase() },
  }));

  const user = (scan.Items || [])[0];
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  if (user.role === 'admin') {
    console.log(`User ${email} is already an admin.`);
    process.exit(0);
  }

  // Update role to admin
  await client.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: user.pk, sk: 'PROFILE' },
    UpdateExpression: 'SET #role = :admin, updatedAt = :now',
    ExpressionAttributeNames: { '#role': 'role' },
    ExpressionAttributeValues: { ':admin': 'admin', ':now': new Date().toISOString() },
  }));

  console.log(`Promoted ${email} (${user.id}) to admin.`);
  console.log('Log out and back in to get a new token with the admin role.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
