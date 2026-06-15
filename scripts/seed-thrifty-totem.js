const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const userId = 'usr_01KSS0FR0NYJ18E1T3KWBDDBYB';
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: 'http://localhost:8000',
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
);
const now = new Date().toISOString();

async function seed(totemId, traits, label) {
  await client.send(new PutCommand({
    TableName: 'TotemBound-Totems',
    Item: {
      pk: `USER#${userId}`,
      sk: `TOTEM#${totemId}`,
      id: totemId,
      userId,
      speciesId: 0,
      colorId: 0,
      rarityId: 0,
      nickname: label,
      stage: 2,
      experience: 1500,
      prestigeLevel: 0,
      stats: {
        strength: 12,
        agility: 12,
        wisdom: 12,
        happiness: 80,
        hunger: 100,
      },
      cooldowns: { feed: null, train: null, treat: null },
      traits,
      createdAt: now,
      updatedAt: now,
    },
  }));
  console.log('seeded', totemId);
}

(async () => {
  await seed('ttm_thrifty01', { innate: 'trt_curious', learned: 'trt_thrifty', awakened: null }, 'Pinch');
  await seed('ttm_plain001', { innate: 'trt_brave', learned: null, awakened: null }, 'Bravo');
})();
