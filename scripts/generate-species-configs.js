#!/usr/bin/env node
/**
 * Generate Species Config Files
 *
 * Pulls data from totembound folder and combines with species metadata
 * to create consistent per-species JSON files for CloudFront/S3.
 *
 * Usage: node scripts/generate-species-configs.js
 *
 * Output: src/data/species/{species}.json
 */

const fs = require('fs');
const path = require('path');

// Paths
const TOTEMBOUND_DIR = path.join(__dirname, '../../totembound');
const SPECIES_METADATA = path.join(__dirname, '../../totem-app/src/config/species.json');
const OUTPUT_DIR = path.join(__dirname, '../../totem-app/public/data/species');

// IPFS Gateway for building URLs
const IPFS_GATEWAY = 'https://ipfs.totembound.com/ipfs/';

// Color ID mapping (matches contract/business rules)
const COLOR_IDS = {
  'Brown': 0, 'brown': 0,
  'Gray': 1, 'gray': 1,
  'White': 2, 'white': 2,
  'Tawny': 3, 'tawny': 3,
  'Slate': 4, 'slate': 4,
  'Copper': 5, 'copper': 5,
  'Cream': 6, 'cream': 6,
  'Dappled': 7, 'dappled': 7,
  'Golden': 8, 'golden': 8,
  'DarkPurple': 9, 'purple': 9,
  'Charcoal': 10, 'charcoal': 10,
  'EmeraldGreen': 11, 'emerald': 11,
  'CrimsonRed': 12, 'crimson': 12,
  'DeepSapphire': 13, 'sapphire': 13,
  'EtherealSilver': 14, 'silver': 14,
  'RadiantGold': 15, 'gold': 15,
  'FrostbiteBlue': 16, 'frostbite': 16,
  'RosyPink': 17, 'rosy': 17,
  'VerdantGold': 18, 'verdant': 18,
  'RaindropTeal': 19, 'raindrop': 19,
  'FloralViolet': 20, 'floral': 20,
  'SunsetOrange': 21, 'sunset': 21,
  'EmberRed': 22, 'ember': 22,
  'OceanicAzure': 23, 'oceanic': 23,
  'HarvestGold': 24, 'harvest': 24,
  'PhantomBlack': 25, 'phantom': 25,
  'EmberwoodBrown': 26, 'emberwood': 26,
  'StarlitSilver': 27, 'starlit': 27,
};

// Rarity mapping by color ID
const RARITY_BY_COLOR_ID = {
  0: 'common', 1: 'common', 2: 'common', 3: 'common',
  4: 'uncommon', 5: 'uncommon', 6: 'uncommon', 7: 'uncommon',
  8: 'rare', 9: 'rare', 10: 'rare',
  11: 'epic', 12: 'epic', 13: 'epic',
  14: 'legendary', 15: 'legendary',
  16: 'limited', 17: 'limited', 18: 'limited', 19: 'limited',
  20: 'limited', 21: 'limited', 22: 'limited', 23: 'limited',
  24: 'limited', 25: 'limited', 26: 'limited', 27: 'limited',
};

/**
 * Extract CID from IPFS URL
 */
function extractCid(ipfsUrl) {
  if (!ipfsUrl) return null;
  // Handle ipfs:// format
  if (ipfsUrl.startsWith('ipfs://')) {
    return ipfsUrl.replace('ipfs://', '');
  }
  // Handle gateway URL format
  if (ipfsUrl.includes('/ipfs/')) {
    return ipfsUrl.split('/ipfs/')[1];
  }
  return ipfsUrl;
}

/**
 * Normalize color name to lowercase key
 */
function normalizeColorName(colorName) {
  // Map various color names to consistent lowercase keys
  const mapping = {
    'Brown': 'brown',
    'Gray': 'gray',
    'White': 'white',
    'Tawny': 'tawny',
    'Slate': 'slate',
    'Copper': 'copper',
    'Cream': 'cream',
    'Dappled': 'dappled',
    'Golden': 'golden',
    'DarkPurple': 'purple',
    'Charcoal': 'charcoal',
    'EmeraldGreen': 'emerald',
    'CrimsonRed': 'crimson',
    'DeepSapphire': 'sapphire',
    'EtherealSilver': 'silver',
    'RadiantGold': 'gold',
    'VerdantGold': 'verdant',
    'FrostbiteBlue': 'frostbite',
    'RosyPink': 'rosy',
    'RaindropTeal': 'raindrop',
    'FloralViolet': 'floral',
    'SunsetOrange': 'sunset',
    'EmberRed': 'ember',
    'OceanicAzure': 'oceanic',
    'HarvestGold': 'harvest',
    'PhantomBlack': 'phantom',
    'EmberwoodBrown': 'emberwood',
    'StarlitSilver': 'starlit',
  };
  return mapping[colorName] || colorName.toLowerCase();
}

/**
 * Load species metadata from totem-app config
 */
function loadSpeciesMetadata() {
  try {
    const data = JSON.parse(fs.readFileSync(SPECIES_METADATA, 'utf8'));
    const metadataById = {};
    for (const species of data.species) {
      metadataById[species.id] = species;
    }
    return metadataById;
  } catch (err) {
    console.error('Failed to load species metadata:', err.message);
    return {};
  }
}

/**
 * Load species config from totembound folder
 */
function loadSpeciesConfig(speciesName) {
  const configPath = path.join(TOTEMBOUND_DIR, speciesName, `${speciesName}-config.json`);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.warn(`No config found for ${speciesName}: ${err.message}`);
    return null;
  }
}

/**
 * Get list of available species from totembound folder
 */
function getAvailableSpecies() {
  const species = [];
  const entries = fs.readdirSync(TOTEMBOUND_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const configPath = path.join(TOTEMBOUND_DIR, entry.name, `${entry.name}-config.json`);
      if (fs.existsSync(configPath)) {
        species.push(entry.name);
      }
    }
  }

  return species.sort();
}

/**
 * Build consistent species config
 */
function buildSpeciesConfig(speciesName, config, metadata) {
  const speciesId = metadata?.id ?? -1;

  // Build colors object
  const colors = {};

  if (config.colors) {
    for (const [colorName, colorData] of Object.entries(config.colors)) {
      const normalizedName = normalizeColorName(colorName);
      const colorId = COLOR_IDS[colorName] ?? COLOR_IDS[normalizedName] ?? -1;
      const rarity = RARITY_BY_COLOR_ID[colorId] || 'common';

      // Extract CIDs from IPFS URLs
      const images = (colorData.stageImages || []).map(extractCid);

      colors[normalizedName] = {
        id: colorId,
        displayName: colorName,
        rarity,
        stageNames: colorData.stageNames || [],
        stageDescriptions: colorData.stageDescriptions || [],
        images, // Just CIDs, gateway added at runtime
      };
    }
  }

  return {
    id: speciesId,
    name: speciesName.charAt(0).toUpperCase() + speciesName.slice(1),
    fullName: metadata?.fullName || config.name || speciesName,
    title: metadata?.title || '',
    description: metadata?.description || '',
    affinity: config.affinity || metadata?.affinity || '',
    domain: config.domain || metadata?.domain || '',
    locationId: metadata?.locationId || null,
    available: metadata?.available ?? true,
    placeholderImage: metadata?.image || `/totems/${speciesName}placecard.png`,
    baseStats: config.baseStats || metadata?.baseStats || { strength: 8, agility: 8, wisdom: 8 },
    stages: metadata?.stages || ['Hatchling', 'Juvenile', 'Adult', 'Elder', 'Wise Elder'],
    colors,
  };
}

/**
 * Main execution
 */
function main() {
  console.log('🔄 Generating species config files...\n');

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Load metadata
  const metadata = loadSpeciesMetadata();
  console.log(`📋 Loaded metadata for ${Object.keys(metadata).length} species`);

  // Get available species from totembound folder
  const speciesList = getAvailableSpecies();
  console.log(`📁 Found ${speciesList.length} species in totembound folder: ${speciesList.join(', ')}\n`);

  const results = {
    success: [],
    skipped: [],
    errors: [],
  };

  // Process each species
  for (const speciesName of speciesList) {
    try {
      const config = loadSpeciesConfig(speciesName);
      if (!config) {
        results.skipped.push(speciesName);
        continue;
      }

      // Find matching metadata by name
      const speciesMeta = Object.values(metadata).find(
        m => m.name.toLowerCase() === speciesName.toLowerCase()
      );

      const speciesConfig = buildSpeciesConfig(speciesName, config, speciesMeta);

      // Write output file
      const outputPath = path.join(OUTPUT_DIR, `${speciesName}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(speciesConfig, null, 2));

      const colorCount = Object.keys(speciesConfig.colors).length;
      console.log(`✅ ${speciesName}: ${colorCount} colors, available: ${speciesConfig.available}`);
      results.success.push(speciesName);

    } catch (err) {
      console.error(`❌ ${speciesName}: ${err.message}`);
      results.errors.push({ species: speciesName, error: err.message });
    }
  }

  // Generate index file
  const indexPath = path.join(OUTPUT_DIR, 'index.json');
  const index = {
    gateway: IPFS_GATEWAY,
    generated: new Date().toISOString(),
    species: results.success.map(name => ({
      name,
      file: `${name}.json`,
    })),
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Summary:');
  console.log(`   ✅ Success: ${results.success.length}`);
  console.log(`   ⏭️  Skipped: ${results.skipped.length}`);
  console.log(`   ❌ Errors: ${results.errors.length}`);
  console.log(`\n📁 Output: ${OUTPUT_DIR}`);
  console.log('='.repeat(50));
}

main();
