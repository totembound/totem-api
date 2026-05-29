const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: 'http://localhost:8000',
    region: 'us-west-2',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
);
const userId = 'usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const now = new Date().toISOString();

async function seed(totemId, traits, label, stage = 2, exp = 1500) {
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
      stage,
      experience: exp,
      prestigeLevel: 0,
      stats: { strength: 12, agility: 12, wisdom: 12, happiness: 80, hunger: 100 },
      cooldowns: { feed: null, train: null, treat: null },
      traits,
      createdAt: now,
      updatedAt: now,
    },
  }));
  console.log('seeded', totemId, label);
}

(async () => {
  await seed('ttm_thrifty_ui', { innate: 'trt_curious', learned: 'trt_thrifty', awakened: null }, 'Pinch');
  await seed('ttm_quicklearner_ui', { innate: 'trt_gentle', learned: 'trt_quick_learner', awakened: null }, 'Studious');
  await seed('ttm_mentor_ui', { innate: 'trt_clever', learned: 'trt_quick_learner', awakened: 'trt_mentor' }, 'Mentora', 4, 8000);
})();
