/**
 * Manual stats-snapshot runner (local / dev / test).
 *
 * Computes and persists a stats snapshot to AdminStatsHistory — the same code
 * path the EventBridge Lambda and the local node-cron use (the handler is the
 * single source of truth).
 *
 * Usage:
 *   node scripts/run-snapshot.js                      # hourly
 *   node scripts/run-snapshot.js --granularity=daily
 *   node scripts/run-snapshot.js --all                # hourly + daily + weekly
 *
 * Talks to DynamoDB Local by default (IS_LOCAL). To run against another target,
 * set IS_LOCAL=false plus the appropriate AWS_REGION / credentials.
 */

process.env.IS_LOCAL = process.env.IS_LOCAL || 'true';

const { runSnapshot, GRANULARITIES } = require('../src/functions/admin/stats-snapshot');

function parseArgs() {
  const args = process.argv.slice(2);
  let granularity = 'HOURLY';
  let all = false;
  for (const a of args) {
    if (a === '--all') all = true;
    else if (a.startsWith('--granularity=')) granularity = a.split('=')[1];
  }
  return { granularity, all };
}

async function main() {
  const { granularity, all } = parseArgs();
  const grans = all ? GRANULARITIES : [granularity];

  console.log('📸 Running stats snapshot(s):', grans.join(', '));
  for (const g of grans) {
    const result = await runSnapshot({ granularity: g });
    console.log(`  ${result.granularity}: ${result.written ? '✓ written' : '· already existed'} (bucket ${result.bucket})`);
  }
  console.log('✅ Done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Snapshot failed:', err.message);
    process.exit(1);
  });
