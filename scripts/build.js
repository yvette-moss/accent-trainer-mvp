#!/usr/bin/env node
'use strict';

/**
 * Build step (`npm run build` runs scripts/csv-to-json.js first, then this).
 *
 * Re-validates src/phrases.json with the shared content rules and publishes it
 * to public/data/curriculum.json for the static frontend, so a malformed
 * curriculum fails the deploy instead of breaking in a browser.
 */

const fs = require('fs');
const path = require('path');
const { validateContent } = require('./lib/content-rules');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'phrases.json');
const OUT = path.join(ROOT, 'public', 'data', 'curriculum.json');

const content = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const { errors } = validateContent(content);
if (errors.length) {
  errors.forEach((e) => console.error(`✗ content validation failed: ${e}`));
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(content));
console.log(`✓ validated ${content.exercises.length} exercises → public/data/curriculum.json` + ` + ${(content.diagnostics || []).length} diagnostic paragraphs`);
