const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:8000',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
});

async function main() {
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'TotemBound-Users'
  }));

  console.log('Users found:', result.Items?.length || 0);
  result.Items?.forEach(item => {
    if (item.sk?.S === 'PROFILE') {
      const email = item.email?.S || 'N/A';
      const displayName = item.displayName?.S || 'N/A';
      const id = item.id?.S || item.pk?.S?.replace('USER#', '');
      const gems = item.currencies?.M?.gems?.N || '0';
      const essence = item.currencies?.M?.essence?.N || '0';
      console.log(`ID: ${id}`);
      console.log(`  Email: ${email}`);
      console.log(`  DisplayName: ${displayName}`);
      console.log(`  Gems: ${gems}, Essence: ${essence}`);
      console.log('');
    }
  });
}

main().catch(console.error);
