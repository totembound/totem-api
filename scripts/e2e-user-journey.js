/**
 * Full user-lifecycle e2e — fires every transactional email for ONE user by driving the
 * REAL container webhook handlers + auth API. Webhook events are self-signed with the
 * local STRIPE_WEBHOOK_SECRET and POSTed to /webhooks/stripe — the exact code path Stripe
 * uses (this is how `stripe trigger` works internally), but with our real metadata + the
 * user's stripeCustomerId so handlers resolve the user and actually send.
 *
 * Prereq: user journey@example.com exists (create via the UI signup first).
 * Run:    node scripts/e2e-user-journey.js
 * View:   http://localhost:8025  (filter to journey@example.com)
 */

require('dotenv').config({ path: __dirname + '//../.env.local' });
const http = require('http');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const EMAIL = 'journey@example.com';
const CUSTOMER = 'cus_journey_e2e';
const SECRET = process.env.STRIPE_SECRET_KEY;
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET;
const PREMIUM_PRICE = process.env.STRIPE_PRICE_PREMIUM;
const stripe = require('stripe')(SECRET);

const db = DynamoDBDocumentClient.from(new DynamoDBClient({
  endpoint: 'http://localhost:8000', region: 'us-west-2',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
}));

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: 'localhost', port: 3001, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// Sign a synthetic Stripe event and POST it to the real webhook endpoint.
async function fireWebhook(label, type, object) {
  const event = { id: `evt_journey_${label}`, object: 'event', api_version: '2024-06-20',
    created: nowSec(), type, data: { object } };
  const payload = JSON.stringify(event);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  const res = await post('/webhooks/stripe', payload, { 'Stripe-Signature': sig });
  console.log(`  → ${type.padEnd(34)} HTTP ${res.status}  ${res.body.slice(0, 80)}`);
  await sleep(400);
}

async function findUserId() {
  const r = await db.send(new ScanCommand({ TableName: 'TotemBound-Users',
    FilterExpression: 'email = :e', ExpressionAttributeValues: { ':e': EMAIL } }));
  const u = (r.Items || [])[0];
  if (!u) throw new Error(`User ${EMAIL} not found — sign up via the UI first.`);
  return u.id;
}

(async () => {
  if (!SECRET || !WHSEC) { console.error('Missing STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET in .env.local'); process.exit(1); }
  const userId = await findUserId();
  console.log(`Journey user: ${userId} (${EMAIL})\n`);

  // Make the user a premium subscriber tied to our test customer so the webhook
  // handlers resolve them via getUserByStripeCustomerId.
  await db.send(new UpdateCommand({ TableName: 'TotemBound-Users',
    Key: { pk: `USER#${userId}`, sk: 'PROFILE' },
    UpdateExpression: 'SET tier = :t, stripeCustomerId = :c, subscription = :s',
    ExpressionAttributeValues: { ':t': 'premium', ':c': CUSTOMER,
      ':s': { status: 'active', tier: 'premium', subscriptionId: 'sub_journey', cancelAtPeriodEnd: false } } }));
  console.log(`Mapped ${EMAIL} → ${CUSTOMER} (premium)\n`);

  console.log('Firing lifecycle webhooks:');
  // 1. Subscription confirmed (checkout.session.completed, mode=subscription)
  await fireWebhook('sub_confirm', 'checkout.session.completed', {
    id: 'cs_journey_sub', mode: 'subscription', client_reference_id: userId,
    metadata: { userId, tier: 'premium' }, subscription: 'sub_journey', customer: CUSTOMER,
    customer_email: EMAIL });

  // 2. Renewal receipt (invoice.payment_succeeded, subscription_cycle)
  await fireWebhook('renewal', 'invoice.payment_succeeded', {
    id: 'in_journey_renewal', customer: CUSTOMER, billing_reason: 'subscription_cycle',
    amount_paid: 999, currency: 'usd',
    lines: { data: [{ period: { end: nowSec() + 30 * 86400 }, price: { id: PREMIUM_PRICE } }] } });

  // 3. Payment failed / dunning (invoice.payment_failed)
  await fireWebhook('dunning', 'invoice.payment_failed', {
    id: 'in_journey_failed', customer: CUSTOMER, billing_reason: 'subscription_cycle',
    next_payment_attempt: nowSec() + 3 * 86400 });

  // 4. Gem purchase receipt (checkout.session.completed, mode=payment) — adds 500 gems
  await fireWebhook('gem', 'checkout.session.completed', {
    id: 'cs_journey_gem', mode: 'payment', client_reference_id: userId,
    metadata: { userId, packageId: 'pkg_starter', gems: '500' } });

  // 5. Refund issued (charge.refunded) — claws back the 500 gems just granted
  await fireWebhook('refund', 'charge.refunded', {
    id: 'ch_journey', amount: 499, amount_refunded: 499, currency: 'usd',
    metadata: { userId, packageId: 'pkg_starter' } });

  // 6. Password changed — via the real auth API (forgot → reset, local code 123456)
  console.log('\nPassword reset via API:');
  const fp = await post('/v1/auth/forgot-password', { email: EMAIL });
  console.log(`  → forgot-password           HTTP ${fp.status}`);
  await sleep(300);
  const rp = await post('/v1/auth/reset-password', { email: EMAIL, code: '123456', newPassword: 'NewJourneyPass123' });
  console.log(`  → reset-password            HTTP ${rp.status}  ${rp.body.slice(0, 80)}`);
  await sleep(400);

  // 7. Subscription expired (customer.subscription.deleted) — LAST (downgrades to free)
  console.log('\nFinal lifecycle webhook:');
  await fireWebhook('expired', 'customer.subscription.deleted', { customer: CUSTOMER });

  // Report
  await sleep(600);
  const inbox = await new Promise((resolve) => {
    http.get('http://localhost:8025/api/v2/messages', (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); });
  });
  const mine = inbox.items.filter((m) => (m.Content.Headers.To || []).some((t) => t.includes(EMAIL)));
  console.log(`\nMailHog — ${mine.length} emails for ${EMAIL}:`);
  for (const m of mine.reverse()) console.log(`  • ${(m.Content.Headers.Subject || ['?'])[0]}`);
  console.log('\nOpen http://localhost:8025 to read them.');
})().catch((e) => { console.error(e); process.exit(1); });
