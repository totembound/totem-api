/**
 * Gem Purchase Packages Configuration
 *
 * Loads package definitions from shop-config.json (single source of truth)
 * Adds Stripe price IDs from environment variables
 *
 * Conversion Rate: 1 Gem = 5 Essence
 */

const shopConfig = require('../data/shop-config.json');

// Load gem packages from JSON and add Stripe price IDs
const GEM_PACKAGES = shopConfig.gemPackages.map(pkg => ({
  ...pkg,
  stripePriceId: process.env[`STRIPE_PRICE_${pkg.id.replace('pkg_', '').toUpperCase()}`] || null,
}));

// Load collector bundles from JSON and add Stripe price IDs
const COLLECTOR_BUNDLES = shopConfig.monthlySeriesBundles.map(bundle => ({
  ...bundle,
  stripePriceId: process.env[`STRIPE_PRICE_${bundle.id.replace('bundle_', '').toUpperCase()}`] || null,
}));

// Conversion rate from JSON
const GEM_TO_STARLIGHT_RATIO = shopConfig.conversionRate.gemToEssence;

// Totem pricing from JSON
const TOTEM_PRICING = shopConfig.totemPricing;

// Limited totem series from JSON
const LIMITED_SERIES = shopConfig.limitedTotemSeries;

/**
 * Get package by ID (searches both gem packages and collector bundles)
 */
function getPackageById(packageId) {
  return GEM_PACKAGES.find(p => p.id === packageId)
    || COLLECTOR_BUNDLES.find(b => b.id === packageId)
    || null;
}

/**
 * Get all enabled packages formatted for frontend display
 */
function getPackagesForDisplay() {
  const enabledGems = GEM_PACKAGES.filter(p => p.enabled);
  const enabledBundles = COLLECTOR_BUNDLES.filter(b => b.enabled);

  return [...enabledGems, ...enabledBundles].map(pkg => ({
    id: pkg.id,
    name: pkg.name,
    description: pkg.description || null,
    price: pkg.price,
    priceFormatted: pkg.priceFormatted,
    gems: pkg.gems,
    bonus: pkg.bonus,
    bonusFormatted: pkg.bonus > 0 ? `+${pkg.bonus}%` : null,
    category: pkg.category,
    limitedTotems: pkg.limitedTotems || 0,
    exclusiveTitle: pkg.exclusiveTitle || null,
    exclusiveBadge: pkg.exclusiveBadge || false,
  }));
}

/**
 * Get all packages (including disabled, for admin)
 */
function getAllPackages() {
  return [...GEM_PACKAGES, ...COLLECTOR_BUNDLES];
}

/**
 * Get current limited totem series (if any)
 */
function getCurrentLimitedSeries() {
  const series = LIMITED_SERIES.series || [];
  return series.find(s => s.available) || null;
}

module.exports = {
  GEM_PACKAGES,
  COLLECTOR_BUNDLES,
  GEM_TO_STARLIGHT_RATIO,
  TOTEM_PRICING,
  LIMITED_SERIES,
  getPackageById,
  getPackagesForDisplay,
  getAllPackages,
  getCurrentLimitedSeries,
};
