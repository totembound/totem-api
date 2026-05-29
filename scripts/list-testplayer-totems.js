const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: 'http://localhost:8000',
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
);

(async () => {
  // Find TestPlayer1
  const users = await client.send(new ScanCommand({
    TableName: 'TotemBound-Users',
    FilterExpression: 'displayName = :n',
    ExpressionAttributeValues: { ':n': 'TestPlayer1' },
  }));
  for (const u of users.Items || []) {
    console.log('user', u.id, u.email);
    const totems = await client.send(new ScanCommand({
      TableName: 'TotemBound-Totems',
      FilterExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': u.id },
    }));
    for (const t of totems.Items || []) {
      console.log('  totem', t.id, 'stage', t.stage, 'traits', JSON.stringify(t.traits));
    }
  }
})();
