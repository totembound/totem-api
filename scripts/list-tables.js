const { DynamoDBClient, ListTablesCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:8000',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
});

async function main() {
  const result = await dynamodb.send(new ListTablesCommand({}));
  console.log('Tables:', result.TableNames);
}

main().catch(console.error);
