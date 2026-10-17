'use strict';

/**
 * Topic-based curriculum: CSV → JSON pipeline, topic ranking from the
 * diagnostic, randomized session queues and the session report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const C = require('../public/curriculum.js');
const { parseCsv, rowsToContent, toAzure } = require('../scripts/csv-to-json.js');
const { validateContent, countWords } = require('../scripts/lib/content-rules.js');
const content = require('../src/phrases.json');
const golden = require('../evals/golden_dataset.json');

const ROOT = path.join(__dirname, '..');

/* ---------- CSV parsing ---------- */

test('csv: quotes, escaped quotes, commas inside fields, CRLF and a BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,plain,"multi\nline"\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'plain', 'multi\nline']]);
});

test('csv: semicolon-separated files (European Excel) are detected', () => {
  assert.deepEqual(parseCsv('a;b;c\n1;"x; y";3\n'), [['a', 'b', 'c'], ['1', 'x; y', '3']]);
});

test('csv: a missing column is reported', () => {
  assert.throws(() => rowsToContent([['id', 'topic_id', 'text']]), /missing column/);
});

/* ---------- generated curriculum ---------- */

test('curriculum: src/phrases.json and public/data/curriculum.json are in sync with content/curriculum.csv', () => {
  const fresh = rowsToContent(parseCsv(fs.readFileSync(path.join(ROOT, 'content/curriculum.csv'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(ROOT, 'content/diagnostics.json'), 'utf8')));
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), content, 'run `npm run content` after editing the CSV');
  const published = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/curriculum.json'), 'utf8'));
  assert.deepEqual(published, content);
});

test('curriculum: ten topics with 10–15 natural 3–8 word phrases each, all valid', () => {
  const { errors, warnings } = validateContent(content);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(content.topics.map((t) => t.id),
    ['th_unvoiced', 'th_voiced', 'th_vs_s', 'w_vs_v', 's_vs_z', 'i_vs_ih', 'postalveolar', 'r_vs_l', 'stops', 'ae_vs_e']);
  assert.deepEqual(content.topics.map((t) => t.sounds),
    [['θ'], ['ð'], ['θ', 's'], ['w', 'v'], ['s', 'z'], ['i', 'ɪ'], ['ʃ', 'tʃ', 'dʒ'], ['ɹ', 'l'], ['p', 't', 'k'], ['æ', 'ɛ']]);
  content.topics.forEach((t) => {
    assert.ok(t.exercise_ids.length >= 10 && t.exercise_ids.length <= 15, `${t.id}: ${t.exercise_ids.length}`);
  });
  content.exercises.forEach((ex) => {
    const n = countWords(ex.target_text);
    assert.ok(n >= 3 && n <= 8, `${ex.id}: ${n} words`);
    if (ex.type === 'contrast') assert.equal(ex.contrast.length, 2);
  });
});

test('curriculum: every golden-eval exercise keeps its id and text, so the evals still target real content', () => {
  const byId = Object.fromEntries(content.exercises.map((e) => [e.id, e]));
  golden.cases.forEach((tc) => {
    assert.ok(byId[tc.exercise_id], tc.exercise_id);
    assert.equal(byId[tc.exercise_id].target_text, tc.reference_text);
  });
});

test('curriculum: validation rejects single words, unknown sounds and focus words missing from the text', () => {
  const bad = JSON.parse(JSON.stringify(content));
  bad.exercises[0].target_text = 'Think.';
  bad.exercises[1].focus = ['ʒ'];
  bad.exercises[2].target_words = ['banana'];
  const { errors } = validateContent(bad);
  assert.equal(errors.length, 3);
});

/* ---------- diagnostics ---------- */

test('diagnostics: learner-style symbols become Azure en-US IPA', () => {
  assert.equal(toAzure('/r/'), 'ɹ');
  assert.equal(toAzure('/iː/'), 'i');
  assert.equal(toAzure('/θ/'), 'θ');
  const d = content.diagnostics.find((x) => x.id === 'diag_03');
  assert.deepEqual(d.measured, ['θ', 'ð', 'ɹ', 'p']);
  assert.ok(d.sound_words['ɹ'].includes('project'));
});

test('diagnostics: every measured sound must be practised by a topic (strict alignment)', () => {
  const bad = JSON.parse(JSON.stringify(content));
  bad.diagnostics[0].measured.push('ŋ');
  bad.diagnostics[0].sound_words['ŋ'] = ['morning', 'during', 'thinking'];
  assert.match(validateContent(bad).errors.join('\n'), /outside this curriculum/);

  const noTopic = JSON.parse(JSON.stringify(content));
  noTopic.topics = noTopic.topics.filter((t) => t.id !== 'ae_vs_e');
  noTopic.exercises = noTopic.exercises.filter((e) => e.topic_id !== 'ae_vs_e');
  noTopic.diagnostics[0].measured.push('æ');
  noTopic.diagnostics[0].sound_words['æ'] = ['planned', 'and', 'thirty'];
  assert.match(validateContent(noTopic).errors.join('\n'), /\/æ\/ is not practised by any topic/);
});

test('diagnostics: each measured sound needs at least three of its words in the paragraph', () => {
  const thin = JSON.parse(JSON.stringify(content));
  thin.diagnostics[0].sound_words['θ'] = ['thursday'];
  assert.match(validateContent(thin).errors.join('\n'), /needs at least 3 target words/);
  const missing = JSON.parse(JSON.stringify(content));
  missing.diagnostics[0].sound_words['θ'].push('banana');
  assert.match(validateContent(missing).errors.join('\n'), /"banana" is not a lowercase word/);
});

/* ---------- topic ranking ---------- */

const diag = (weak, ratings) => ({
  completed: true,
  weakPhonemes: weak,
  scores: Object.entries(ratings || {}).map(([phoneme, rating]) => ({ phoneme, rating })),
});

test('topics: diagnostic weak sounds mark topics High Priority, weakest sound first', () => {
  const ranked = C.rankTopics(content.topics, diag(['w', 'θ'], { 'θ': 'focus', 'w': 'focus', 'ð': 'nearly', 'v': 'clear' }));
  assert.deepEqual(ranked.slice(0, 4).map((r) => [r.topic.id, r.priority]), [
    ['w_vs_v', true], ['th_unvoiced', true], ['th_vs_s', true], ['th_voiced', false],
  ]);
  assert.ok(ranked.slice(3).every((r) => !r.priority));
  assert.deepEqual(C.defaultTopicSelection(ranked), ['w_vs_v', 'th_unvoiced', 'th_vs_s']);
});

test('topics: with no weak sounds nothing is flagged, "nearly there" topics lead, all are selected', () => {
  const ranked = C.rankTopics(content.topics, diag([], { 'θ': 'clear', 'ð': 'nearly', 'w': 'clear', 'v': 'clear' }));
  assert.ok(ranked.every((r) => !r.priority));
  assert.equal(ranked[0].topic.id, 'th_voiced');
  assert.equal(C.defaultTopicSelection(ranked).length, content.topics.length);
  assert.deepEqual(C.rankTopics(content.topics, null).map((r) => r.topic.id), content.topics.map((t) => t.id));
});

/* ---------- session queue ---------- */

test('queue: 5–8 randomized drills drawn strictly from the active topics', () => {
  const q = C.buildQueue(content.exercises, ['th_unvoiced', 'w_vs_v'], { rng: C.seededRandom(1) });
  assert.equal(q.length, C.SESSION.size);
  assert.ok(q.every((ex) => ex.topic_id === 'th_unvoiced' || ex.topic_id === 'w_vs_v'));
  assert.equal(new Set(q.map((ex) => ex.id)).size, q.length, 'no duplicates');
  assert.deepEqual(q.map((ex) => ex.topic_id).slice(0, 4), ['th_unvoiced', 'w_vs_v', 'th_unvoiced', 'w_vs_v'], 'topics take turns');
  assert.equal(C.buildQueue(content.exercises, ['th_voiced'], { size: 99 }).length, 8, 'clamped to 8');
  assert.equal(C.buildQueue(content.exercises, ['th_voiced'], { size: 1 }).length, 5, 'clamped to 5');
  const a = C.buildQueue(content.exercises, ['th_voiced'], { rng: C.seededRandom(7) }).map((e) => e.id);
  const b = C.buildQueue(content.exercises, ['th_voiced'], { rng: C.seededRandom(7) }).map((e) => e.id);
  const c = C.buildQueue(content.exercises, ['th_voiced'], { rng: C.seededRandom(8) }).map((e) => e.id);
  assert.deepEqual(a, b, 'same seed, same queue');
  assert.notDeepEqual(a, c, 'different seed, different order');
});

test('queue: "Next Set" prefers drills not practised yet, then ones not in the previous set', () => {
  const first = C.buildQueue(content.exercises, ['w_vs_v'], { rng: C.seededRandom(3) });
  const practised = Object.fromEntries(first.map((ex) => [ex.id, true]));
  const next = C.buildQueue(content.exercises, ['w_vs_v'], { rng: C.seededRandom(4), practised, previous: first.map((e) => e.id) });
  assert.ok(next.every((ex) => !practised[ex.id]), 'all six are new (12 in the topic)');
  assert.deepEqual(C.buildQueue(content.exercises, [], {}), []);
});

/* ---------- session report ---------- */

test('report: coverage per topic and a qualitative star average', () => {
  const ids = content.topics.find((t) => t.id === 'th_unvoiced').exercise_ids;
  const attempts = [
    { exercise_id: ids[0], star_rating: 1 },
    { exercise_id: ids[0], star_rating: 3 },
    { exercise_id: ids[1], star_rating: 2 },
  ];
  const practised = { [ids[0]]: true, [ids[1]]: true, [ids[2]]: true }; // one more from an earlier set
  const [unvoiced, wv] = C.sessionReport({ content, sessionAttempts: attempts, practised, topicIds: ['th_unvoiced', 'w_vs_v'] });
  assert.equal(unvoiced.topic.id, 'th_unvoiced');
  assert.deepEqual(unvoiced.coverage, { done: 3, total: 14, percent: 21 });
  assert.equal(unvoiced.exercisesAttempted, 2);
  assert.equal(unvoiced.attempts, 3);
  assert.deepEqual(unvoiced.stars, [1, 3, 2]);
  assert.equal(unvoiced.averageLabel, '★★☆');
  assert.equal(wv.attempts, 0);
  assert.equal(wv.averageLabel, '–');
  assert.equal(C.starString(2.6), '★★★');
  assert.equal(C.starString(1.2), '★☆☆');
});
