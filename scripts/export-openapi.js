#!/usr/bin/env node
/**
 * Export OpenAPI Spec to JSON
 *
 * Generates a static openapi.json from the swagger-jsdoc configuration.
 * Used by CI/CD to bundle API docs with the frontend build.
 *
 * Usage: node scripts/export-openapi.js [output-path]
 *   Default output: ./openapi.json
 */

const path = require('path');
const fs = require('fs');

// swagger-jsdoc resolves relative paths from cwd, so ensure we're in totem-api root
process.chdir(path.resolve(__dirname, '..'));

const { swaggerSpec } = require('../src/config/swagger');

const outputPath = process.argv[2] || path.join(__dirname, '..', 'openapi.json');
fs.writeFileSync(outputPath, JSON.stringify(swaggerSpec, null, 2));

console.log(`OpenAPI spec exported to ${outputPath}`);
