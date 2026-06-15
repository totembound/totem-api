/**
 * Shared Stripe constants.
 *
 * Pin the API version so webhook payload shapes are deterministic across `stripe`
 * SDK upgrades. This matters because newer Stripe versions (the 2025 "basil" line)
 * relocated fields our webhook handlers read — e.g. `invoice.subscription` and the
 * invoice line item's `.price` moved under `invoice.parent` / `line.pricing`. Pinning
 * keeps the shapes the handlers expect. Bump this deliberately and re-test the
 * subscription + refund webhook paths when you do.
 */
const STRIPE_API_VERSION = '2024-06-20';

module.exports = { STRIPE_API_VERSION };
