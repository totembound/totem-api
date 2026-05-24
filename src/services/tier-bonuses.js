/**
 * Tier Bonuses
 *
 * Subscription tier multipliers applied to recurring rewards (daily/weekly).
 * The multiplier scales the base reward before the streak bonus is applied.
 *
 *   free    → 1x  (no bonus shown)
 *   premium → 2x  (+100%)
 *   vip     → 3x  (+200%)
 */

const TIER_MULTIPLIERS = {
  free: 1,
  premium: 2,
  vip: 3,
};

function getTierMultiplier(tier) {
  return TIER_MULTIPLIERS[tier] ?? 1;
}

function getTierBonusPercent(tier) {
  return (getTierMultiplier(tier) - 1) * 100;
}

module.exports = {
  TIER_MULTIPLIERS,
  getTierMultiplier,
  getTierBonusPercent,
};
