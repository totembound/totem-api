/**
 * Subscription tiers — single source of truth for monthly bonus amounts.
 *
 * Used by:
 *  - functions/subscriptions.js  (claim / status of the monthly bonus, confirmed email)
 *  - common/email.js             (subscription-confirmed + renewal-receipt emails)
 *
 * Keep this as the ONLY place these numbers live. Previously the amounts were
 * duplicated across the claim logic and two email senders, which risked drift
 * (e.g. bumping the VIP bonus but having the receipt email still show the old value).
 */

const SUBSCRIPTION_BONUS = {
  premium: { essence: 500, gems: 100 },
  vip: { essence: 1500, gems: 500 },
};

/**
 * Monthly bonus for a tier. Unknown/missing tiers fall back to premium so an email
 * never renders a blank bonus; callers that must reject unknown tiers should check
 * `SUBSCRIPTION_BONUS[tier]` directly (the claim path does).
 */
function getTierBonus(tier) {
  return SUBSCRIPTION_BONUS[tier] || SUBSCRIPTION_BONUS.premium;
}

module.exports = { SUBSCRIPTION_BONUS, getTierBonus };
