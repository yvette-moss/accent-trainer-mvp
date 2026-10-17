'use strict';

/**
 * Content rules shared by scripts/csv-to-json.js and scripts/build.js, so a
 * malformed curriculum fails the build instead of breaking in a browser.
 * Returns a list of problems (empty = valid); warnings don't fail the build.
 */

// Phrase-only curriculum: isolated single words are not allowed.
const TYPES = new Set(['phrase', 'contrast']);
// Sounds this curriculum targets — IPA exactly as Azure en-US emits it
// (long /iː/ is "i", English /r/ is "ɹ"; see the SSML phonetic sets docs).
const FOCUS_SOUNDS = new Set(['θ', 'ð', 's', 'z', 'd', 't', 'p', 'k', 'w', 'v', 'i', 'ɪ', 'ʃ', 'tʃ', 'dʒ', 'ɹ', 'l', 'æ', 'ɛ']);
const MIN_WORDS_PER_SOUND = 3;
const WORDS = { min: 3, max: 8 };
const PER_TOPIC = { min: 10, max: 15 };

function countWords(text) {
  return text.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

function wordsOf(text) {
  return new Set(text.toLowerCase().split(/[\s\-–—]+/).map((w) => w.replace(/[^a-z']/g, '')).filter(Boolean));
}

function validateContent(content) {
  const errors = [];
  const warnings = [];
  const fail = (m) => errors.push(m);
  if (!Array.isArray(content.exercises) || !content.exercises.length) fail('no exercises');
  if (!Array.isArray(content.topics) || !content.topics.length) fail('no topics');
  if (errors.length) return { errors, warnings };

  const topicIds = new Set(content.topics.map((t) => t.id));
  const seen = new Set();
  content.exercises.forEach((ex, i) => {
    const where = `${ex.id || `row ${i + 1}`}`;
    if (!ex.id || typeof ex.id !== 'string') fail(`${where}: missing id`);
    if (seen.has(ex.id)) fail(`${where}: duplicate id`);
    seen.add(ex.id);
    if (!topicIds.has(ex.topic_id)) fail(`${where}: unknown topic "${ex.topic_id}"`);
    if (!TYPES.has(ex.type)) fail(`${where}: type must be one of ${[...TYPES].join(', ')} (got "${ex.type}")`);
    if (!ex.target_text || ex.target_text.length > 200) { fail(`${where}: text required (≤200 chars)`); return; }
    const n = countWords(ex.target_text);
    if (n < WORDS.min || n > WORDS.max) fail(`${where}: "${ex.target_text}" has ${n} words — every exercise must be a natural ${WORDS.min}–${WORDS.max} word phrase`);
    if (!Array.isArray(ex.focus) || !ex.focus.length) fail(`${where}: target_sound must list at least one IPA symbol`);
    (ex.focus || []).forEach((f) => {
      if (!FOCUS_SOUNDS.has(f)) fail(`${where}: target sound /${f}/ is outside this curriculum (${[...FOCUS_SOUNDS].join(' ')})`);
    });
    if (!ex.cue) fail(`${where}: a pedagogical_cue is required`);
    // target_words drive the strict target-phoneme gate in public/scoring.js.
    if (!Array.isArray(ex.target_words) || !ex.target_words.length) fail(`${where}: focus_words must list the word(s) whose target sounds are checked`);
    const words = wordsOf(ex.target_text);
    (ex.target_words || []).forEach((w) => {
      if (w !== w.toLowerCase() || !words.has(w)) fail(`${where}: focus word "${w}" is not a lowercase word of "${ex.target_text}"`);
    });
    if (ex.type === 'contrast' && (!Array.isArray(ex.contrast) || ex.contrast.length !== 2)) {
      fail(`${where}: contrast drills need at least two focus_words (the first two form the pair)`);
    }
  });

  content.topics.forEach((t) => {
    const n = content.exercises.filter((ex) => ex.topic_id === t.id).length;
    if (!t.title) fail(`topic ${t.id}: topic_title is required`);
    if (n < PER_TOPIC.min || n > PER_TOPIC.max) warnings.push(`topic ${t.id} has ${n} exercises (aim for ${PER_TOPIC.min}–${PER_TOPIC.max})`);
    if (!t.sounds || !t.sounds.length) fail(`topic ${t.id}: no sound is shared by at least half of its exercises`);
  });

  // Diagnostic paragraphs: every measured sound must be practised by a topic,
  // so a weak sound always maps to drills (strict alignment with the curriculum).
  const topicSoundSet = new Set();
  content.topics.forEach((t) => (t.sounds || []).forEach((x) => topicSoundSet.add(x)));
  const diags = content.diagnostics || [];
  if (!diags.length) warnings.push('no diagnostic paragraphs — learners go straight to the topics');
  const diagIds = new Set();
  diags.forEach((diag, i) => {
    const where = `diagnostic ${diag.id || `#${i + 1}`}`;
    if (!diag.id || seen.has(diag.id) || diagIds.has(diag.id)) fail(`${where}: needs an id no exercise or other paragraph uses`);
    diagIds.add(diag.id);
    if (!diag.target_text || diag.target_text.length > 500) fail(`${where}: text required (≤500 chars)`);
    if (!Array.isArray(diag.measured) || !diag.measured.length) fail(`${where}: target_sounds must list at least one sound`);
    const words = wordsOf(diag.target_text || '');
    const soundWords = diag.sound_words || {};
    (diag.measured || []).forEach((f) => {
      if (!FOCUS_SOUNDS.has(f)) fail(`${where}: sound /${f}/ is outside this curriculum`);
      else if (!topicSoundSet.has(f)) fail(`${where}: /${f}/ is not practised by any topic in content/curriculum.csv — add a topic for it or remove it from target_sounds`);
      const list = soundWords[f] || [];
      if (list.length < MIN_WORDS_PER_SOUND) fail(`${where}: /${f}/ needs at least ${MIN_WORDS_PER_SOUND} target words in the paragraph (has ${list.length})`);
    });
    Object.entries(soundWords).forEach(([f, list]) => {
      if (!(diag.measured || []).includes(f)) fail(`${where}: target_words lists /${f}/, which is not in target_sounds`);
      list.forEach((w) => { if (!words.has(w)) fail(`${where}: /${f}/ word "${w}" is not a lowercase word of the paragraph`); });
    });
  });
  return { errors, warnings };
}

module.exports = { validateContent, countWords, FOCUS_SOUNDS, TYPES, WORDS, PER_TOPIC, MIN_WORDS_PER_SOUND };
