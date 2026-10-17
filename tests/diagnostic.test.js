'use strict';

/**
 * Onboarding diagnostic: per-sound profile (public/scoring.js), personalised
 * exercise ranking, and the diagnostic mode of /api/coach. Offline: `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const S = require('../public/scoring.js');
const coach = require('../api/coach.js');
const curriculum = require('../src/phrases.json');

// Fixture paragraph (the original onboarding text): the profile logic is tested
// against a fixed paragraph; the shipped paragraphs are checked in curriculum.test.js.
const DIAG = {
  id: 'DIAG-FIXTURE',
  target_text: 'On Thursday morning, thirty-three people gathered to discuss the weather and their health. Although the cold wind blew through the valley, everyone stayed very positive. It was worthwhile to breathe the fresh air and think about future growth.',
  measured: ['θ', 'ð', 'w', 'v'],
  pass_mark: 80,
  sound_words: {
    'θ': ['thursday', 'thirty', 'three', 'health', 'through', 'worthwhile', 'think', 'growth'],
    'ð': ['the', 'weather', 'their', 'although', 'breathe', 'gathered'],
    'w': ['weather', 'wind', 'everyone', 'was', 'worthwhile'],
    'v': ['valley', 'everyone', 'very', 'positive'],
  },
};

/* ---------- synthetic Azure result for the whole paragraph ---------- */

// Approximate en-US IPA for the words that carry measured sounds; every other
// word gets one neutral vowel. Enough to exercise the extraction logic.
const IPA = {
  thursday: ['θ', 'ɝ', 'z', 'd', 'eɪ'], thirty: ['θ', 'ɝ', 't', 'i'], three: ['θ', 'ɹ', 'i'],
  health: ['h', 'ɛ', 'l', 'θ'], through: ['θ', 'ɹ', 'u'], think: ['θ', 'ɪ', 'ŋ', 'k'], growth: ['ɡ', 'ɹ', 'oʊ', 'θ'],
  worthwhile: ['w', 'ɝ', 'θ', 'w', 'aɪ', 'l'], the: ['ð', 'ə'], weather: ['w', 'ɛ', 'ð', 'ɚ'], their: ['ð', 'ɛ', 'ɹ'],
  although: ['ɔ', 'l', 'ð', 'oʊ'], breathe: ['b', 'ɹ', 'i', 'ð'], gathered: ['ɡ', 'æ', 'ð', 'ɚ', 'd'],
  wind: ['w', 'ɪ', 'n', 'd'], everyone: ['ɛ', 'v', 'ɹ', 'i', 'w', 'ʌ', 'n'], was: ['w', 'ə', 'z'],
  valley: ['v', 'æ', 'l', 'i'], very: ['v', 'ɛ', 'ɹ', 'i'], positive: ['p', 'ɑ', 'z', 'ə', 't', 'ɪ', 'v'],
};

/**
 * @param {object} soundScores  e.g. { θ: 40 } — accuracy for that phoneme everywhere
 * @param {object} [opts] { unnamed: true } drops phoneme names (en-GB style);
 *                        { skip: ['thursday'] } leaves words out of the recording
 */
function paragraphSegment(soundScores, opts = {}) {
  const skip = new Set(opts.skip || []);
  const produced = opts.produced || {};
  const words = [];
  S.tokenizeReference(DIAG.target_text).forEach((tok) => {
    tok.parts.forEach((part) => {
      if (skip.has(part)) return;
      const phs = (IPA[part] || ['ə']).map((ph) => {
        const score = soundScores[ph] !== undefined ? soundScores[ph] : 90;
        const nbest = [{ Phoneme: produced[ph] || ph, Score: score }];
        return { Phoneme: opts.unnamed ? '' : ph, PronunciationAssessment: { AccuracyScore: score, NBestPhonemes: opts.unnamed ? undefined : nbest } };
      });
      const wordScore = Math.round(phs.reduce((s, p) => s + p.PronunciationAssessment.AccuracyScore, 0) / phs.length);
      words.push({ Word: part, PronunciationAssessment: { AccuracyScore: wordScore, ErrorType: 'None' }, Phonemes: phs });
    });
  });
  return {
    RecognitionStatus: 'Success',
    NBest: [{
      PronunciationAssessment: { AccuracyScore: 80, FluencyScore: 85, CompletenessScore: 100, PronScore: 80, ProsodyScore: 78 },
      Words: words,
    }],
  };
}

function analyze(segment) {
  return S.analyzeAttempt([segment], DIAG.target_text, { focus: DIAG.measured, targetWords: [] });
}

/* ---------- content ---------- */

test('diagnostic: the shipped paragraphs each measure a few sounds, all practised by a topic', () => {
  const topicSounds = new Set(curriculum.topics.flatMap((t) => t.sounds));
  assert.equal(curriculum.diagnostics.length, 11);
  curriculum.diagnostics.forEach((d) => {
    assert.ok(d.measured.length >= 1 && d.measured.length <= 4, d.id);
    d.measured.forEach((ph) => assert.ok(topicSounds.has(ph), `${d.id}: /${ph}/ has no topic`));
    assert.equal(d.pass_mark, 80);
  });
});

test('diagnostic: averages every occurrence of each target phoneme and flags the 1–2 weakest below 70', () => {
  const a = analyze(paragraphSegment({ 'θ': 40, 'w': 62, 'ð': 85, 'v': 92 }, { produced: { 'θ': 's' } }));
  assert.ok(a.recognized);
  const p = S.diagnosticProfile(a, DIAG);
  const by = Object.fromEntries(p.scores.map((x) => [x.phoneme, x]));
  assert.equal(by['θ'].score, 40);
  assert.equal(by['θ'].samples, 8, 'thursday, thirty, three, health, through, worthwhile, think, growth');
  assert.equal(by['w'].samples, 6, 'weather, wind, everyone, was, worthwhile ×2');
  assert.equal(by['w'].score, 62);
  assert.equal(by['ð'].score, 85);
  assert.equal(by['v'].score, 92);
  assert.deepEqual(p.weakPhonemes, ['θ', 'w'], 'weakest first');
  assert.equal(p.strongest.phoneme, 'v');
  assert.equal(p.level, 'phoneme');
  assert.deepEqual(p.scores.map((x) => x.phoneme), ['θ', 'ð', 'w', 'v'], 'reported in measured order');
});

test('diagnostic: at most two weak sounds, none when every occurrence passes (≥ 80, no substitution)', () => {
  const many = S.diagnosticProfile(analyze(paragraphSegment({ 'θ': 50, 'ð': 55, 'w': 60, 'v': 65 })), DIAG);
  assert.deepEqual(many.weakPhonemes, ['θ', 'ð']);
  const none = S.diagnosticProfile(analyze(paragraphSegment({ 'θ': 80, 'ð': 88, 'w': 85, 'v': 90 })), DIAG);
  assert.deepEqual(none.weakPhonemes, [], '80 is a pass');
  assert.ok(none.scores.every((x) => x.rating === 'clear'));
  const seventy = S.diagnosticProfile(analyze(paragraphSegment({ 'θ': 79 })), DIAG);
  assert.deepEqual(seventy.weakPhonemes, ['θ'], '79 is a miss — a high average no longer hides it');
});

test('diagnostic: a high-scoring sound that Azure heard as a different sound counts as a miss', () => {
  const p = S.diagnosticProfile(analyze(paragraphSegment({ 'θ': 88 }, { produced: { 'θ': 't' } })), DIAG);
  const th = p.scores.find((x) => x.phoneme === 'θ');
  assert.equal(th.passes, 0);
  assert.equal(th.rating, 'focus');
  assert.deepEqual(p.weakPhonemes, ['θ']);
  assert.equal(th.substitutions, 8);
  const both = S.diagnosticProfile(analyze(paragraphSegment({ 'θ': 88, 'w': 74 }, { produced: { 'θ': 't' } })), DIAG);
  assert.deepEqual(both.weakPhonemes, ['θ', 'w'], 'a substituted sound outranks a slightly soft one');
});

test('diagnostic: unnamed phonemes (en-GB) fall back to word scores for the words that carry each sound', () => {
  const a = analyze(paragraphSegment({ 'θ': 20 }, { unnamed: true }));
  const p = S.diagnosticProfile(a, DIAG);
  const th = p.scores.find((x) => x.phoneme === 'θ');
  assert.equal(p.level, 'word');
  assert.equal(th.level, 'word');
  assert.equal(th.samples, 7, 'one sample per θ-carrying word ("thirty-three" is one word)');
  const thWords = a.words.filter((w) => DIAG.sound_words['θ'].some((sw) => w.display.toLowerCase().includes(sw)));
  const expected = Math.round(thWords.reduce((s, w) => s + w.score, 0) / thWords.length);
  assert.equal(th.score, expected, 'mean of the word scores');
  assert.ok(p.scores.every((x) => x.phoneme === 'θ' || x.score > th.score), 'θ is still the lowest sound');
  // Word scores blend every sound in the word, so word level is lenient: a /θ/ at
  // 20 inside "think" leaves the word in the 70s (see README → diagnostic).
  assert.ok(th.score >= 60);
});

test('diagnostic: skipped words are not samples, but are counted', () => {
  const p = S.diagnosticProfile(analyze(paragraphSegment({}, { skip: ['valley', 'very'] })), DIAG);
  const v = p.scores.find((x) => x.phoneme === 'v');
  assert.equal(p.omitted, 2);
  assert.equal(v.samples, 2, 'everyone + positive still carry /v/');
  assert.equal(v.score, 90);
});

/* ---------- ranking ---------- */

test('diagnostic: drills that target the weakest sounds come first, the rest keep curriculum order', () => {
  const scores = { 'θ': 40, 'ð': 85, 'w': 62, 'v': 92 };
  const ranked = S.rankExercises(curriculum.exercises, ['θ', 'w'], scores);
  assert.equal(ranked.length, curriculum.exercises.length, 'nothing is dropped');
  const firstNon = ranked.findIndex((r) => !r.recommended);
  assert.ok(firstNon > 0);
  assert.ok(ranked.slice(0, firstNon).every((r) => r.exercise.focus.some((f) => f === 'θ' || f === 'w')));
  assert.ok(ranked.slice(firstNon).every((r) => !r.exercise.focus.some((f) => f === 'θ' || f === 'w')));
  assert.equal(ranked[0].weakHits, 2, 'drills covering both weak sounds lead');
  const rest = ranked.slice(firstNon).map((r) => r.exercise.id);
  const order = curriculum.exercises.map((e) => e.id).filter((id) => rest.includes(id));
  assert.deepEqual(rest, order);
});

test('diagnostic: with no weak sounds the ranking is the curriculum order', () => {
  const ranked = S.rankExercises(curriculum.exercises, [], { 'θ': 90 });
  assert.deepEqual(ranked.map((r) => r.exercise.id), curriculum.exercises.map((e) => e.id));
  assert.ok(ranked.every((r) => !r.recommended));
});

/* ---------- /api/coach diagnostic mode ---------- */

function mockReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { host: 'coach.example.com' };
  req.socket = { remoteAddress: `10.1.0.${Math.floor(Math.random() * 250)}` };
  return req;
}
async function post(body) {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(c) { this.body = c || ''; } };
  await coach(mockReq(body), res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, raw: res.body };
}
function withKey(key, fn) {
  return async () => {
    const saved = process.env.GROQ_API_KEY;
    const realFetch = global.fetch;
    if (key === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = key;
    try { await fn(); } finally {
      global.fetch = realFetch;
      if (saved === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved;
    }
  };
}
function groqReply(obj) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
}

const DIAG_PAYLOAD = {
  mode: 'diagnostic',
  accent: 'en-US',
  overall_score: 78,
  phoneme_scores: [
    { phoneme: 'θ', score: 40, samples: 8, passes: 1, best_word: 'think', weakest_word: 'growth' },
    { phoneme: 'ð', score: 85, samples: 8, passes: 7, best_word: 'weather', weakest_word: 'the' },
    { phoneme: 'w', score: 62, samples: 6, passes: 3, best_word: 'wind', weakest_word: 'worthwhile' },
    { phoneme: 'v', score: 92, samples: 4, passes: 4, best_word: 'very', weakest_word: 'positive' },
  ],
  weak_phonemes: ['θ', 'w'],
};

test('coach diagnostic: deterministic 3-sentence report without GROQ_API_KEY', withKey(undefined, async () => {
  global.fetch = async () => { throw new Error('should not be called'); };
  const r = await post(DIAG_PAYLOAD);
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'fallback');
  assert.deepEqual(r.json.weak_phonemes, ['θ', 'w']);
  assert.match(r.json.strength, /\/v\//, 'top strength is the best sound');
  assert.match(r.json.improve, /θ/);
  assert.match(r.json.improve, /tongue/i, 'articulatory cue');
  assert.match(r.json.recommendation, /Recommended Focus/);
  assert.equal(r.json.report, [r.json.strength, r.json.improve, r.json.recommendation].join(' '));
  assert.doesNotMatch(r.json.report, /\b(40|62|85|92)\b/, 'no raw scores');
}));

test('coach diagnostic: Groq report is validated, one sentence per part, extra keys dropped', withKey('sk-diag-SECRET', async () => {
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /"strength"/);
    assert.match(body.messages[0].content, /"improve"/);
    assert.match(body.messages[0].content, /"recommendation"/);
    assert.match(body.messages[0].content, /articulatory cue/);
    assert.ok(body.messages[1].content.includes('"weak_phonemes":["θ","w"]'));
    return groqReply({
      strength: 'Your /v/ is crisp and confident, especially in "very". Great!',
      improve: 'Focus on /θ/: let your tongue tip rest between your teeth and blow air with no voice',
      recommendation: 'Do the Recommended Focus drills for five minutes a day.',
      score: 99,
    });
  };
  const r = await post(DIAG_PAYLOAD);
  assert.equal(r.json.source, 'groq');
  assert.equal(r.json.strength, 'Your /v/ is crisp and confident, especially in "very".');
  assert.equal(r.json.improve, 'Focus on /θ/: let your tongue tip rest between your teeth and blow air with no voice.');
  assert.equal(r.json.score, undefined);
  assert.equal(r.json.report.split(/(?<=[.!?])\s+/).length, 3);
  assert.ok(!r.raw.includes('sk-diag-SECRET'));
}));

test('coach diagnostic: incomplete or failing Groq output degrades to the fallback report', withKey('sk-diag', async () => {
  global.fetch = async () => groqReply({ strength: 'Nice.', improve: '' });
  assert.equal((await post(DIAG_PAYLOAD)).json.source, 'fallback');
  global.fetch = async () => new Response('slow down', { status: 429 });
  const r = await post(DIAG_PAYLOAD);
  assert.equal(r.json.source, 'fallback');
  assert.ok(r.json.report.length > 40);
}));

test('coach diagnostic: validates input — unknown sounds dropped, weak sounds must be measured, 400 without scores', async () => {
  const { value } = coach._internals.validateDiagnosticPayload({
    ...DIAG_PAYLOAD,
    phoneme_scores: [...DIAG_PAYLOAD.phoneme_scores, { phoneme: 'ʒ', score: 10 }, { phoneme: 'θ', score: 1 }],
    weak_phonemes: ['ʒ', 'θ', 'w', 'v'],
  });
  assert.deepEqual(value.phoneme_scores.map((p) => p.phoneme), ['θ', 'ð', 'w', 'v']);
  assert.equal(value.phoneme_scores[0].score, 40, 'first entry per sound wins');
  assert.deepEqual(value.weak_phonemes, ['θ', 'w']);
  const r = await post({ mode: 'diagnostic', phoneme_scores: [] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'phoneme_scores_required');
});
