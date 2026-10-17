#!/usr/bin/env node
'use strict';

/**
 * content/curriculum.csv  ──►  src/phrases.json            (used by tests + evals)
 *                          └─► public/data/curriculum.json (loaded by the app)
 *
 * The CSV is the single source of truth: edit it in Excel / Numbers / Google
 * Sheets, then run `node scripts/csv-to-json.js` (also part of `npm run build`
 * and `npm run dev`). Columns:
 *
 *   id, topic_id, topic_title, target_sound, text, type, focus_words, pedagogical_cue
 *
 *   target_sound  IPA sound(s) checked in this exercise, "|"-separated, e.g. "θ|s"
 *   type          phrase | contrast
 *   focus_words   lowercase words of the text whose target sounds are checked,
 *                 "|"-separated; for contrast drills the first two are the pair
 *
 * Comma- or semicolon-separated files (European Excel) and a UTF-8 BOM are fine.
 * Diagnostic paragraphs live in content/diagnostics.json (one is picked at
 * random for each learner). Each lists target_sounds and, per sound, the
 * target_words that carry it. Sounds may be written learner-style ("/r/",
 * "/iː/") — they are converted to Azure's en-US IPA ("ɹ", "i").
 */

const fs = require('fs');
const path = require('path');
const { validateContent } = require('./lib/content-rules');
const { topicSounds } = require('../public/curriculum.js');

const ROOT = path.join(__dirname, '..');
const CSV = path.join(ROOT, 'content', 'curriculum.csv');
const DIAGNOSTICS = path.join(ROOT, 'content', 'diagnostics.json');
const OUT_SRC = path.join(ROOT, 'src', 'phrases.json');
const OUT_PUBLIC = path.join(ROOT, 'public', 'data', 'curriculum.json');

const COLUMNS = ['id', 'topic_id', 'topic_title', 'target_sound', 'text', 'type', 'focus_words', 'pedagogical_cue'];

/** RFC 4180 CSV → array of string arrays. Handles quotes, "" escapes, CRLF, BOM, ; or , delimiters. */
function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const list = (v) => String(v || '').split(/[|;,]/).map((s) => s.trim()).filter(Boolean);
// Learner-friendly spellings → Azure en-US IPA (what the scoring compares against).
const SOUND_ALIASES = { 'r': 'ɹ', 'iː': 'i', 'i:': 'i', 'ʧ': 'tʃ', 'ʤ': 'dʒ', 'e': 'ɛ' };
const toAzure = (s) => {
  const k = String(s).trim().replace(/^\/|\/$/g, '').normalize('NFC');
  return SOUND_ALIASES[k] || k;
};
const sounds = (v) => list(v).map(toAzure);

/** content/diagnostics.json entries → the shape the app and scoring use. */
function normalizeDiagnostics(raw) {
  return (raw || []).map((d) => {
    const soundWords = {};
    Object.entries(d.target_words || {}).forEach(([k, words]) => {
      soundWords[toAzure(k)] = (words || []).map((w) => String(w).toLowerCase().replace(/[’‘]/g, "'"));
    });
    return {
      id: d.id,
      title: d.title || '',
      theme: d.theme || '',
      target_text: String(d.text || '').replace(/[’‘]/g, "'"),
      cue: d.cue || 'Read at your natural pace, as if telling a friend. Don’t slow down for the hard sounds — we want to hear how you normally speak.',
      measured: (d.target_sounds || []).map(toAzure),
      pass_mark: d.pass_mark || 80,
      sound_words: soundWords,
    };
  });
}

/** Parsed CSV rows → the app's content JSON (topics + exercises + diagnostics). */
function rowsToContent(rows, diagnostics) {
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`curriculum.csv is missing column(s): ${missing.join(', ')}`);
  const col = (r, name) => (r[header.indexOf(name)] || '').trim();

  const topics = [];
  const topicById = {};
  const exercises = rows.slice(1).map((r) => {
    const topicId = col(r, 'topic_id');
    if (topicId && !topicById[topicId]) {
      topicById[topicId] = { id: topicId, title: col(r, 'topic_title'), sounds: [], exercise_ids: [] };
      topics.push(topicById[topicId]);
    }
    const words = list(col(r, 'focus_words')).map((w) => w.toLowerCase());
    const type = col(r, 'type').toLowerCase();
    const ex = {
      id: col(r, 'id'),
      topic_id: topicId,
      section: topicId, // the practice card's badge shows the topic
      type,
      target_text: col(r, 'text'),
      focus: sounds(col(r, 'target_sound')),
      target_words: words,
      cue: col(r, 'pedagogical_cue'),
    };
    if (type === 'contrast' && words.length >= 2) ex.contrast = words.slice(0, 2);
    if (topicById[topicId]) topicById[topicId].exercise_ids.push(ex.id);
    return ex;
  });

  topics.forEach((t) => { t.sounds = topicSounds(exercises.filter((ex) => ex.topic_id === t.id)); });

  return {
    version: '3.0.0',
    locale: 'en-US',
    level: 'B1',
    source: 'Generated from content/curriculum.csv by scripts/csv-to-json.js — edit the CSV, not this file.',
    topics,
    // kept for the practice card's section badge
    sections: topics.map((t) => ({ id: t.id, label: t.title, description: t.title })),
    exercises,
    diagnostics: normalizeDiagnostics(diagnostics),
  };
}

function main() {
  const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
  const diagnostics = fs.existsSync(DIAGNOSTICS) ? JSON.parse(fs.readFileSync(DIAGNOSTICS, 'utf8')) : [];
  const content = rowsToContent(rows, diagnostics);
  const { errors, warnings } = validateContent(content);
  warnings.forEach((w) => console.warn(`! ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`✗ ${e}`));
    console.error(`✗ content/curriculum.csv: ${errors.length} problem(s) — nothing was written`);
    process.exit(1);
  }
  const json = JSON.stringify(content, null, 2) + '\n';
  fs.writeFileSync(OUT_SRC, json);
  fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
  fs.writeFileSync(OUT_PUBLIC, JSON.stringify(content));
  console.log(
    `✓ ${content.exercises.length} exercises in ${content.topics.length} topics → src/phrases.json + public/data/curriculum.json  (` +
      content.topics.map((t) => `${t.id}: ${t.exercise_ids.length}`).join(', ') + `) + ${content.diagnostics.length} diagnostic paragraphs`
  );
}

if (require.main === module) main();

module.exports = { parseCsv, rowsToContent, normalizeDiagnostics, toAzure, COLUMNS };
