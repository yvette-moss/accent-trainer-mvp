'use strict';

/**
 * Unit tests for the serverless handlers. Network is mocked via global.fetch,
 * so these run offline in CI with no keys: `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const speechToken = require('../api/speech-token.js');
const coach = require('../api/coach.js');

/* ---------- helpers ---------- */

function mockReq({ method = 'GET', headers = {}, body } = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(raw);
  req.method = method;
  req.headers = { host: 'coach.example.com', ...headers };
  req.socket = { remoteAddress: `10.0.0.${Math.floor(Math.random() * 250)}` };
  return req;
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(chunk) { this.body = chunk || ''; this.ended = true; },
  };
  return res;
}

async function call(handler, reqOpts) {
  const res = mockRes();
  await handler(mockReq(reqOpts), res);
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null, raw: res.body };
}

function withEnv(vars, fn) {
  return async () => {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    const realFetch = global.fetch;
    try { await fn(); } finally {
      global.fetch = realFetch;
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
}

const SECRET = 'sk-test-SECRET-should-never-leak';

/* ---------- /api/speech-token ---------- */

test('speech-token: 503 when Azure is not configured', withEnv({ AZURE_SPEECH_KEY: undefined, AZURE_SPEECH_REGION: undefined }, async () => {
  speechToken._resetCache();
  const r = await call(speechToken);
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'not_configured');
}));

test('speech-token: issues token, never returns the key, caches between calls', withEnv({ AZURE_SPEECH_KEY: SECRET, AZURE_SPEECH_REGION: 'westeurope' }, async () => {
  speechToken._resetCache();
  let calls = 0;
  global.fetch = async (url, opts) => {
    calls++;
    assert.equal(url, 'https://westeurope.api.cognitive.microsoft.com/sts/v1.0/issueToken');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['Ocp-Apim-Subscription-Key'], SECRET);
    return new Response('eyJ.fake.token', { status: 200 });
  };
  const a = await call(speechToken);
  const b = await call(speechToken);
  assert.equal(a.status, 200);
  assert.deepEqual(Object.keys(a.json).sort(), ['expires_in', 'region', 'token']);
  assert.equal(a.json.token, 'eyJ.fake.token');
  assert.equal(a.json.region, 'westeurope');
  assert.ok(a.json.expires_in > 500 && a.json.expires_in <= 600);
  assert.equal(b.json.token, 'eyJ.fake.token');
  assert.equal(calls, 1, 'second request should be served from cache');
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.ok(!a.raw.includes(SECRET));
}));

test('speech-token: rejected key maps to 503 without leaking upstream detail', withEnv({ AZURE_SPEECH_KEY: SECRET, AZURE_SPEECH_REGION: 'eastus' }, async () => {
  speechToken._resetCache();
  global.fetch = async () => new Response('Access denied due to invalid subscription key ' + SECRET, { status: 401 });
  const r = await call(speechToken);
  assert.equal(r.status, 503);
  assert.ok(!r.raw.includes(SECRET));
  assert.ok(!r.raw.includes('Access denied'));
}));

test('speech-token: blocks foreign origins, allows own host and ALLOWED_ORIGINS', withEnv({ AZURE_SPEECH_KEY: SECRET, AZURE_SPEECH_REGION: 'eastus', ALLOWED_ORIGINS: 'https://preview.example.org' }, async () => {
  speechToken._resetCache();
  global.fetch = async () => new Response('tok', { status: 200 });
  assert.equal((await call(speechToken, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(speechToken, { headers: { origin: 'https://coach.example.com' } })).status, 200);
  assert.equal((await call(speechToken, { headers: { origin: 'https://preview.example.org' } })).status, 200);
}));

test('speech-token: rejects non-GET', async () => {
  const r = await call(speechToken, { method: 'POST' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET');
});

/* ---------- /api/coach ---------- */

const PAYLOAD = {
  target_text: 'I think the kitchen sink is clean.',
  overall_score: 64,
  accent: 'en-US',
  focus: ['θ', 's'],
  mispronounced_words: [{ word: 'think', accuracy: 41, error_type: 'Mispronunciation' }],
  phoneme_errors: [{ word: 'think', expected: 'θ', produced: 's', accuracy: 22, target: true }],
  weakest_target: { word: 'think', phoneme: 'θ', accuracy: 22 },
};

function groqReply(obj) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
}

const LEGACY_FIELDS = ['encouragement', 'physical_cue', 'contrast_pair', 'micro_drill'];

test('coach: 400 when target_text is missing', async () => {
  const r = await call(coach, { method: 'POST', body: { overall_score: 50 } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'target_text_required');
});

test('coach: 400 on invalid JSON, 413 on oversized body', async () => {
  assert.equal((await call(coach, { method: 'POST', body: '{nope' })).status, 400);
  const big = { ...PAYLOAD, target_text: 'x'.repeat(20000) };
  assert.equal((await call(coach, { method: 'POST', body: big })).status, 413);
});

test('coach: deterministic θ placement tip when GROQ_API_KEY is absent — no drill, no pair', withEnv({ GROQ_API_KEY: undefined }, async () => {
  global.fetch = async () => { throw new Error('should not be called'); };
  const r = await call(coach, { method: 'POST', body: PAYLOAD });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'fallback');
  assert.equal(r.json.sound, 'θ');
  assert.match(r.json.tip, /tongue/i);
  assert.deepEqual(Object.keys(r.json).sort(), ['sound', 'source', 'tip']);
}));

test('coach: fallback coaches the failed TARGET sound before louder non-target drifts', () => {
  const { value } = coach._internals.validatePayload({
    ...PAYLOAD,
    phoneme_errors: [
      { word: 'kitchen', expected: 'tʃ', produced: 'ʃ', accuracy: 30 },
      { word: 'kitchen', expected: 'tʃ', produced: 'ʃ', accuracy: 35 },
      { word: 'think', expected: 'θ', produced: 's', accuracy: 50, target: true },
    ],
  });
  assert.equal(coach._internals.fallbackTip(value).sound, 'θ');
  const noErrors = coach._internals.validatePayload({ ...PAYLOAD, phoneme_errors: [], weakest_target: { word: 'wide', phoneme: 'w', accuracy: 72 } });
  assert.equal(coach._internals.fallbackTip(noErrors.value).sound, 'w', 'weakest target is used when nothing failed');
});

test('coach: prompt asks for one placement tip in the selected accent, never drills or pairs', () => {
  const us = coach._internals.systemPrompt('en-US');
  const gb = coach._internals.systemPrompt('en-GB');
  assert.match(us, /General American/);
  assert.match(gb, /Received Pronunciation/);
  for (const p of [us, gb]) {
    assert.match(p, /"sound"/);
    assert.match(p, /"tip"/);
    assert.match(p, /one or two short sentences/i);
    assert.match(p, /Do NOT include practice phrases, tongue twisters, example words, word pairs/);
    assert.doesNotMatch(p, /micro_drill|contrast_pair|encouragement/);
  }
  assert.equal(coach._internals.validatePayload({ ...PAYLOAD, accent: 'fr-FR' }).value.accent, 'en-US', 'unknown accents fall back to en-US');
});

test('coach: returns validated Groq JSON and sends the key only to Groq', withEnv({ GROQ_API_KEY: SECRET, GROQ_MODEL: undefined }, async () => {
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(opts.headers.Authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.reasoning_effort, 'low');
    assert.ok(body.max_completion_tokens >= 1024, 'budget must cover reasoning + answer');
    assert.equal(body.max_tokens, undefined);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.ok(body.messages[1].content.includes('"expected":"θ"'));
    assert.ok(body.messages[1].content.includes('"weakest_target"'));
    assert.match(body.messages[0].content, /General American/);
    return groqReply({ sound: '/θ/', tip: 'Let your tongue tip rest lightly between your teeth and blow air — no voice.', extra_field: 'dropped' });
  };
  const r = await call(coach, { method: 'POST', body: PAYLOAD });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'groq');
  assert.equal(r.json.sound, 'θ', 'slashes are stripped');
  assert.equal(r.json.tip, 'Let your tongue tip rest lightly between your teeth and blow air — no voice.');
  assert.equal(r.json.extra_field, undefined);
  assert.ok(!r.raw.includes(SECRET));
}));

test('coach: over-long tips are trimmed to two sentences and 240 characters', withEnv({ GROQ_API_KEY: SECRET }, async () => {
  global.fetch = async () => groqReply({
    sound: 'θ',
    tip: 'Put your tongue between your teeth. Blow air gently. Now try "three thin thieves" five times. Great job!',
  });
  const r = await call(coach, { method: 'POST', body: PAYLOAD });
  assert.equal(r.json.tip, 'Put your tongue between your teeth. Blow air gently.');
  const long = coach._internals.validateTip({ sound: 'θ', tip: 'a'.repeat(400) });
  assert.ok(long.tip.length <= 240);
}));

test('coach: malformed or failing Groq responses degrade to fallback', withEnv({ GROQ_API_KEY: SECRET }, async () => {
  global.fetch = async () => groqReply({ micro_drill: 'Three thin thieves' });
  const bad = await call(coach, { method: 'POST', body: PAYLOAD });
  assert.equal(bad.json.source, 'fallback');
  for (const k of LEGACY_FIELDS) assert.equal(bad.json[k], undefined);

  global.fetch = async () => new Response('rate limited', { status: 429 });
  assert.equal((await call(coach, { method: 'POST', body: PAYLOAD })).json.source, 'fallback');

  global.fetch = async () => { throw new Error('ECONNRESET'); };
  const r = await call(coach, { method: 'POST', body: PAYLOAD });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'fallback');
}));

test('coach: clamps and sanitises hostile input', () => {
  const { value } = coach._internals.validatePayload({
    target_text: 'hello\u0000\u001b[31m world',
    overall_score: 9000,
    mispronounced_words: Array.from({ length: 50 }, () => ({ word: 'w', accuracy: -5 })),
    phoneme_errors: [{ word: 'x', expected: '', produced: 's' }],
    weakest_target: { word: '', phoneme: 'θ' },
  });
  assert.equal(value.target_text, 'hello [31m world');
  assert.equal(value.overall_score, 100);
  assert.equal(value.mispronounced_words.length, 20);
  assert.equal(value.mispronounced_words[0].accuracy, 0);
  assert.equal(value.phoneme_errors.length, 0, 'phoneme errors without an expected phoneme are dropped');
  assert.equal(value.weakest_target, null, 'weakest_target without a word is dropped');
});

test('coach: retries with GROQ_FALLBACK_MODEL when the primary model is retired', withEnv({ GROQ_API_KEY: SECRET, GROQ_MODEL: undefined, GROQ_FALLBACK_MODEL: undefined }, async () => {
  const models = [];
  global.fetch = async (_url, opts) => {
    const { model } = JSON.parse(opts.body);
    models.push(model);
    if (model === 'openai/gpt-oss-120b') {
      return new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 404 });
    }
    return groqReply({ sound: 'θ', tip: 'Tongue tip between the teeth, then blow.' });
  };
  const r = await call(coach, { method: 'POST', body: PAYLOAD });
  assert.deepEqual(models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert.equal(r.json.source, 'groq');
  assert.equal(r.json.model, 'openai/gpt-oss-20b');
}));

test('coach: does not retry another model on rate limits', withEnv({ GROQ_API_KEY: SECRET }, async () => {
  let n = 0;
  global.fetch = async () => { n++; return new Response('slow down', { status: 429 }); };
  const r = await call(coach, { method: 'POST', body: PAYLOAD });
  assert.equal(n, 1);
  assert.equal(r.json.source, 'fallback');
}));

test('coach: truncated JSON (json_validate_failed) also falls through to the second model', withEnv({ GROQ_API_KEY: SECRET, GROQ_MODEL: undefined, GROQ_FALLBACK_MODEL: undefined }, async () => {
  const models = [];
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    global.fetch = async (_url, opts) => {
      const { model } = JSON.parse(opts.body);
      models.push(model);
      if (model === 'openai/gpt-oss-120b') {
        return new Response(JSON.stringify({ error: { code: 'json_validate_failed', failed_generation: '{"tip": "Ton' } }), { status: 400 });
      }
      return groqReply({ sound: 'θ', tip: 'Tongue tip between the teeth, then blow.' });
    };
    const r = await call(coach, { method: 'POST', body: PAYLOAD });
    assert.deepEqual(models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    assert.equal(r.json.model, 'openai/gpt-oss-20b');
    assert.ok(warnings.some((w) => w.includes('groq_400:json_validate_failed (openai/gpt-oss-120b)')), 'first failure is logged with its Groq code');
  } finally {
    console.warn = realWarn;
  }
}));
