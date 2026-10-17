'use strict';

/**
 * Number-free coaching feedback: the three status badges, discrete target-sound
 * passes, word timings for "Hear Your Attempt", and the no-digits tip contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../public/scoring.js');
const coach = require('../api/coach.js');
const golden = require('../evals/golden_dataset.json');
const curriculum = require('../src/phrases.json');
const byId = Object.fromEntries(curriculum.exercises.map((e) => [e.id, e]));

/** "Think outside the box." with a chosen /θ/ score, NBest top guess and fluency. */
function thinkAttempt({ th = 90, heard = 'θ', fluency = 88, skip = false } = {}) {
  const ph = (p, sc, guess) => ({ Phoneme: p, PronunciationAssessment: { AccuracyScore: sc, NBestPhonemes: [{ Phoneme: guess || p, Score: sc }] } });
  const word = (w, phs, off) => ({
    Word: w, Offset: off, Duration: 4000000,
    PronunciationAssessment: { AccuracyScore: Math.round(phs.reduce((a, p) => a + p.PronunciationAssessment.AccuracyScore, 0) / phs.length), ErrorType: 'None' },
    Phonemes: phs,
  });
  const words = [
    word('think', [ph('θ', th, heard), ph('ɪ', 92), ph('ŋ', 90), ph('k', 94)], 5000000),
    word('outside', [ph('aʊ', 90), ph('t', 92), ph('s', 91), ph('aɪ', 90), ph('d', 88)], 9500000),
    word('the', [ph('ð', 90), ph('ə', 92)], 14000000),
    word('box', [ph('b', 93), ph('ɑ', 90), ph('k', 92), ph('s', 91)], 16500000),
  ].filter((w) => !(skip && w.Word === 'think'));
  return S.analyzeAttempt([{
    RecognitionStatus: 'Success',
    NBest: [{ PronunciationAssessment: { AccuracyScore: 90, FluencyScore: fluency, CompletenessScore: 100, PronScore: 90, ProsodyScore: 85 }, Words: words }],
  }], 'Think outside the box.', { focus: ['θ', 'ð'], targetWords: ['think'] });
}

test('status: every target sound ≥ 80 with no substitution → Spot On', () => {
  const st = S.feedbackStatus(thinkAttempt({ th: 84 }));
  assert.equal(st.key, 'spot_on');
  assert.equal(st.label, 'Spot On! Crisp & Natural');
  assert.equal(st.passes, 1);
  assert.equal(st.total, 1);
  assert.deepEqual(st.missedWords, {});
});

test('status: one target sound just under the pass mark, fluent → Almost There', () => {
  const st = S.feedbackStatus(thinkAttempt({ th: 74 }));
  assert.equal(st.key, 'almost');
  assert.equal(st.label, 'Almost There — Just Minor Polish');
  assert.equal(st.misses[0].reason, 'slipped');
  assert.deepEqual(st.missedWords, { 0: true }, 'word index of "Think"');
});

test('status: the same slip without fluency → Needs Work', () => {
  assert.equal(S.feedbackStatus(thinkAttempt({ th: 74, fluency: 50 })).key, 'needs_work');
});

test('status: a high score that Azure heard as another sound is a substitution → Needs Work', () => {
  const st = S.feedbackStatus(thinkAttempt({ th: 86, heard: 's' }));
  assert.equal(st.key, 'needs_work');
  assert.equal(st.label, 'Needs Work on Target Sound');
  assert.equal(st.misses[0].reason, 'heard_as');
  assert.equal(st.misses[0].produced, 's');
});

test('status: a skipped target word → Needs Work (omission)', () => {
  const st = S.feedbackStatus(thinkAttempt({ skip: true }));
  assert.equal(st.key, 'needs_work');
  assert.equal(st.misses[0].reason, 'omitted');
});

test('status: golden cases map to the expected badges', () => {
  const want = { 'GD-01': 'spot_on', 'GD-02': 'needs_work', 'GD-03': 'needs_work', 'GD-04': 'almost', 'GD-05': 'needs_work', 'GD-06': 'spot_on' };
  golden.cases.forEach((tc) => {
    const ex = byId[tc.exercise_id];
    const a = S.analyzeAttempt(tc.azure_segments, tc.reference_text, { focus: ex.focus, targetWords: ex.target_words });
    assert.equal(S.feedbackStatus(a).key, want[tc.id], tc.id);
  });
});

test('timing: each word carries start/end seconds from Azure Offset/Duration', () => {
  const a = thinkAttempt();
  assert.equal(a.words[0].start, 0.5);
  assert.equal(a.words[0].end, 0.9);
  assert.equal(a.words[3].start, 1.65);
  const skipped = thinkAttempt({ skip: true });
  assert.equal(skipped.words[0].start, null, 'a skipped word has no audio to replay');
});

test('coach: tips containing numbers are rejected (no numbers reach the learner)', () => {
  assert.equal(coach._internals.validateTip({ sound: 'θ', tip: 'Your score was 42, so put your tongue out.' }), null);
  assert.ok(coach._internals.validateTip({ sound: 'θ', tip: "Your tongue stayed behind your teeth on 'think' — slip the tip between your teeth." }));
  const prompt = coach._internals.systemPrompt('en-US');
  assert.match(prompt, /naming the word from the attempt/);
  assert.match(prompt, /numbers/);
});
