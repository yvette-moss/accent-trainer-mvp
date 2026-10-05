#!/usr/bin/env node
'use strict';

/**
 * Build step (runs on Vercel via `npm run build`, and before `npm run dev`).
 *
 * 1. Validates src/phrases.json — the single source of truth for content —
 *    so a malformed exercise fails the deploy instead of breaking in a browser.
 * 2. Publishes it to public/data/phrases.json for the static frontend.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'phrases.json');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const OUT = path.join(OUT_DIR, 'phrases.json');

// Phrase-only curriculum: isolated single words are not allowed.
const TYPES = new Set(['phrase', 'contrast']);
// Sounds this B1 curriculum targets (IPA, as emitted by Azure en-US).
const FOCUS_SOUNDS = new Set(['θ', 'ð', 's', 'd', 't', 'w', 'v']);
// Word-count bands per section (hyphenated words count once). Sections not
// listed only need the phrase minimum.
const MIN_WORDS = 3;
const WORD_RANGE = { collocation: [3, 5], sentence: [6, 10] };

function countWords(text) {
  return text.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

function fail(msg) {
  console.error(`✗ content validation failed: ${msg}`);
  process.exit(1);
}

const content = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (!Array.isArray(content.exercises) || !content.exercises.length) fail('no exercises');

const sectionIds = new Set((content.sections || []).map((s) => s.id));
const seen = new Set();

content.exercises.forEach((ex, i) => {
  const where = `exercises[${i}] (${ex.id || 'no id'})`;
  if (!ex.id || typeof ex.id !== 'string') fail(`${where}: missing id`);
  if (seen.has(ex.id)) fail(`${where}: duplicate id`);
  seen.add(ex.id);
  if (!sectionIds.has(ex.section)) fail(`${where}: unknown section "${ex.section}"`);
  if (!TYPES.has(ex.type)) fail(`${where}: type must be one of ${[...TYPES].join(', ')}`);
  if (!ex.target_text || ex.target_text.length > 200) fail(`${where}: target_text required (≤200 chars)`);
  const n = countWords(ex.target_text);
  if (n < MIN_WORDS) fail(`${where}: "${ex.target_text}" has ${n} word(s) — every exercise must be a phrase of at least ${MIN_WORDS} words`);
  const range = WORD_RANGE[ex.section];
  if (range && (n < range[0] || n > range[1])) {
    fail(`${where}: ${ex.section} items need ${range[0]}–${range[1]} words, "${ex.target_text}" has ${n}`);
  }
  if (!Array.isArray(ex.focus) || !ex.focus.length) fail(`${where}: focus must list at least one IPA symbol`);
  ex.focus.forEach((f) => {
    if (!FOCUS_SOUNDS.has(f)) fail(`${where}: focus sound /${f}/ is outside this curriculum (${[...FOCUS_SOUNDS].join(' ')})`);
  });
  if (!ex.cue) fail(`${where}: a pedagogical cue is required`);
  // target_words drive the strict target-phoneme gate in public/scoring.js:
  // they must exist in the sentence (hyphenated words count as their parts).
  if (!Array.isArray(ex.target_words) || !ex.target_words.length) {
    fail(`${where}: target_words must list the word(s) whose target sounds are gated`);
  }
  const textWords = new Set(
    ex.target_text.toLowerCase().split(/[\s\-–—]+/).map((w) => w.replace(/[^a-z']/g, '')).filter(Boolean)
  );
  ex.target_words.forEach((w) => {
    if (w !== w.toLowerCase() || !textWords.has(w)) fail(`${where}: target word "${w}" is not a lowercase word of "${ex.target_text}"`);
  });
  if (ex.type === 'contrast' && (!Array.isArray(ex.contrast) || ex.contrast.length !== 2)) {
    fail(`${where}: contrast drills need a 2-item "contrast" pair`);
  }
});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(content));

const bySection = content.exercises.reduce((acc, ex) => ((acc[ex.section] = (acc[ex.section] || 0) + 1), acc), {});
console.log(
  `✓ ${content.exercises.length} exercises → public/data/phrases.json  (` +
    Object.entries(bySection).map(([k, v]) => `${k}: ${v}`).join(', ') +
    ')'
);
