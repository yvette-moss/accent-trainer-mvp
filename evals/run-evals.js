#!/usr/bin/env node
'use strict';

/**
 * Golden-dataset evals.
 *
 *   npm run eval            → offline: scoring pipeline (stars, target-sound gate,
 *                             chips, drifts) + deterministic coach fallback
 *   npm run eval -- --live  → also POSTs each coaching case to a running /api/coach
 *                             (BASE_URL, default http://localhost:3000) and checks the
 *                             LLM output contract: { sound, tip }, tip = 1–2 sentences
 *                             of physical placement, no drills / word pairs / quotes.
 *
 * Offline evals import the exact files that ship (public/scoring.js, api/coach.js),
 * and each case's focus sounds + target words come from src/phrases.json, so a
 * passing run means the deployed behaviour matches the golden expectations.
 */

const path = require('path');
const S = require('../public/scoring.js');
const coach = require('../api/coach.js')._internals;
const dataset = require('./golden_dataset.json');
const curriculum = require('../src/phrases.json');
const exercisesById = Object.fromEntries(curriculum.exercises.map((e) => [e.id, e]));

const LIVE = process.argv.includes('--live');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function check(failures, label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}: expected ${e}, got ${a}`);
}

/** Same payload public/app.js sends to /api/coach. */
function buildCoachPayload(tc, exercise, r) {
  const wt = r.weakestTarget;
  return {
    target_text: tc.reference_text,
    overall_score: r.overall,
    accent: tc.accent || 'en-US',
    focus: exercise ? exercise.focus : [],
    mispronounced_words: r.mispronouncedWords,
    phoneme_errors: r.phonemeErrors,
    weakest_target: wt ? { word: wt.word, phoneme: wt.phoneme, accuracy: wt.score } : null,
  };
}

function runOffline(tc) {
  const failures = [];
  const ex = tc.expected;

  // Golden cases must describe real exercises, so the evals can't drift from the curriculum.
  const exercise = exercisesById[tc.exercise_id];
  if (!exercise) failures.push(`exercise_id ${tc.exercise_id} is not in src/phrases.json`);
  else if (exercise.target_text !== tc.reference_text) {
    failures.push(`reference_text differs from ${tc.exercise_id}: "${exercise.target_text}"`);
  }

  const r = S.analyzeAttempt(tc.azure_segments, tc.reference_text, {
    focus: exercise ? exercise.focus : [],
    targetWords: exercise ? exercise.target_words : [],
  });
  if (!r.recognized) return { failures: failures.concat('analysis returned recognized=false'), r, exercise };

  check(failures, 'overall', r.overall, ex.overall);
  check(failures, 'stars', r.stars, ex.stars);
  if ('capped' in ex) check(failures, 'capped', r.capped, ex.capped);
  check(failures, 'needs_coaching', r.needsCoaching, ex.needs_coaching);
  for (const k of ['accuracy', 'fluency', 'prosody', 'completeness']) {
    if (k in ex) check(failures, k, r[k], ex[k]);
  }
  if ('target_score' in ex) check(failures, 'target_score', r.targetScore, ex.target_score);
  if ('target_level' in ex) check(failures, 'target_level', r.targetLevel, ex.target_level);
  if ('target_failures' in ex) {
    check(
      failures,
      'target_failures',
      r.targetFailures.map((t) => ({ word: t.word, phoneme: t.phoneme, reason: t.reason })),
      ex.target_failures
    );
  }
  for (const [word, band] of Object.entries(ex.word_bands || {})) {
    const w = r.words.find((x) => x.display === word);
    if (!w) failures.push(`word_bands: chip "${word}" not rendered (chips: ${r.words.map((x) => x.display).join(' | ')})`);
    else check(failures, `band("${word}")`, w.band, band);
  }
  check(failures, 'omitted', r.words.filter((w) => w.errorType === 'Omission').map((w) => S.normalizeWord(w.display)), ex.omitted);
  check(failures, 'insertions', r.insertions.map(S.normalizeWord), ex.insertions);
  check(
    failures,
    'phoneme_drifts',
    r.phonemeErrors.map((p) => {
      const o = { word: p.word, expected: p.expected, produced: p.produced };
      if (p.target) o.target = true;
      return o;
    }),
    ex.phoneme_drifts
  );

  if (ex.needs_coaching) {
    const payload = coach.validatePayload(buildCoachPayload(tc, exercise, r));
    if (payload.error) failures.push(`coach payload rejected: ${payload.error}`);
    else {
      const tip = coach.fallbackTip(payload.value);
      if (!tip.tip) failures.push('fallback tip is empty');
      const wantSound = ex.fallback_sound || ex.coach_sound;
      if (wantSound) check(failures, 'fallback sound', tip.sound, wantSound);
      if ('contrast_pair' in tip || 'micro_drill' in tip) failures.push('fallback tip still carries drill/pair fields');
    }
  }
  return { failures, r, exercise };
}

function sentenceCount(text) {
  return (String(text).match(/[^.!?]+[.!?]+/g) || [text]).filter((x) => x.trim()).length;
}

async function runLive(tc, exercise, r) {
  const failures = [];
  const resp = await fetch(`${BASE_URL}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildCoachPayload(tc, exercise, r)),
  });
  if (!resp.ok) return { failures: [`HTTP ${resp.status}`], tip: null };
  const tip = await resp.json();

  if (typeof tip.tip !== 'string' || !tip.tip.trim()) failures.push('missing tip');
  else {
    const n = sentenceCount(tip.tip);
    if (n > 2) failures.push(`tip has ${n} sentences (want 1–2)`);
    if (tip.tip.length > 240) failures.push(`tip is ${tip.tip.length} chars (max 240)`);
    if (/\bvs\.?\b/i.test(tip.tip)) failures.push(`tip contains a word pair: "${tip.tip}"`);
    if (/["“”][^"“”]*\s[^"“”]*\s[^"“”]*["“”]/.test(tip.tip)) failures.push(`tip quotes a practice phrase: "${tip.tip}"`);
  }
  for (const k of ['encouragement', 'contrast_pair', 'micro_drill', 'physical_cue']) {
    if (k in tip) failures.push(`unexpected legacy field "${k}"`);
  }
  if (tc.expected.coach_sound && String(tip.sound).replace(/\//g, '') !== tc.expected.coach_sound) {
    failures.push(`coached /${tip.sound}/, expected /${tc.expected.coach_sound}/`);
  }
  if (tip.source !== 'groq') {
    failures.push(`source=${tip.source} — every Groq model failed; see the dev-server log for "[coach] attempt failed" lines (model + Groq error code)`);
  }
  return { failures, tip };
}

(async function main() {
  console.log(c.bold(`\n${dataset.name} — ${dataset.cases.length} cases${LIVE ? ' (+ live coach)' : ''}\n`));
  let failed = 0;

  for (const tc of dataset.cases) {
    const { failures, r, exercise } = runOffline(tc);
    let liveTip = null;
    if (LIVE && tc.expected.needs_coaching && r && r.recognized) {
      try {
        const live = await runLive(tc, exercise, r);
        live.failures.forEach((f) => failures.push(`[live] ${f}`));
        liveTip = live.tip;
      } catch (e) {
        failures.push(`[live] ${e.message} — is the dev server running at ${BASE_URL}?`);
      }
    }

    const summary = r && r.recognized
      ? `${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)} ${String(r.overall).padStart(3)} · target ${r.targetScore === null ? '–' : String(r.targetScore).padStart(2)}`
      : '—';
    if (failures.length) {
      failed++;
      console.log(`${c.red('✗')} ${tc.id}  ${summary}  ${tc.title}`);
      failures.forEach((f) => console.log(c.red(`      ${f}`)));
    } else {
      console.log(`${c.green('✓')} ${tc.id}  ${summary}  ${tc.title}`);
    }
    // Printed AFTER the case line so it is never mistaken for the next case's output.
    if (liveTip) console.log(c.dim(`      coach [${liveTip.model || liveTip.source}] /${liveTip.sound}/: ${liveTip.tip}`));
  }

  const passed = dataset.cases.length - failed;
  console.log(`\n${failed ? c.red(`${failed} failed`) : c.green('all passed')} · ${passed}/${dataset.cases.length}\n`);
  process.exitCode = failed ? 1 : 0;
})();

module.exports = { runOffline, buildCoachPayload, datasetPath: path.join(__dirname, 'golden_dataset.json') };
