/**
 * app.js — client orchestration.
 *
 *   phrases.json ─► exercise card ─► mic + Azure Speech SDK (ephemeral token)
 *                                       │  raw JSON segments
 *                                       ▼
 *                              AccentScoring.analyzeAttempt()   (public/scoring.js, pure)
 *                                       │
 *              stars · word chips · bars ┤
 *                                       └─► /api/coach (only when coaching is needed)
 *
 * Secrets never reach this file: the browser only ever holds a 10-minute Azure
 * token from /api/speech-token, and Groq is called exclusively from /api/coach.
 */
(function () {
  'use strict';

  var S = window.AccentScoring;
  var C = window.AccentCurriculum;

  /* -------------------------------------------------------------- */
  /* Config                                                          */
  /* -------------------------------------------------------------- */
  var CONFIG = {
    contentUrl: '/data/curriculum.json',
    tokenUrl: '/api/speech-token',
    coachUrl: '/api/coach',
    tokenRefreshMarginMs: 60 * 1000,
    maxRecordMs: { word: 7000, phrase: 20000, contrast: 20000, diagnostic: 60000 },
    finalizeTimeoutMs: 2500,
    sdkWaitMs: 8000,
  };

  /**
   * Target-accent benchmarks. Azure documents IPA phoneme names, spoken-phoneme
   * NBest lists and prosody scoring for en-US only, so those options are sent
   * per locale. IPA is still requested for en-GB as the standard alphabet; if
   * Azure rejects any of these options for en-GB, the app falls back to the
   * documented en-GB set (safeMode) and asks the learner to record again.
   */
  var ACCENTS = {
    'en-US': { label: 'General American', short: 'GenAm', ipa: true, nbestPhonemes: true, prosody: true },
    // Measured against the live service (Oct 2026): en-GB returns prosody, but its
    // phonemes come back with empty names and it scores other native accents
    // almost perfectly — see README "Target accents".
    'en-GB': { label: 'British (RP)', short: 'RP', ipa: true, nbestPhonemes: false, prosody: true },
  };
  var ACCENT_STORAGE_KEY = 'accentCoach.accent';
  var FLAGS = { 'en-US': '🇺🇸', 'en-GB': '🇬🇧' };

  // Onboarding diagnostic result: { completed, weakPhonemes, summaryText, … }.
  // Its presence means the diagnostic is done; "Retake Diagnostic" removes it.
  var DIAG_STORAGE_KEY = 'accent_diagnostic_completed';
  var TOPIC_STORAGE_KEY = 'accentCoach.topics'; // the learner's chosen session topics (convenience only)
  var LAST_DIAG_KEY = 'accentCoach.lastDiagnostic'; // so a retake gets a different paragraph

  /** Azure writes long /iː/ as "i"; show learners the familiar symbol. */
  var IPA_DISPLAY = { 'i': 'iː' };
  function ipa(s) { return '/' + (IPA_DISPLAY[s] || s) + '/'; }
  // A diagnostic attempt must cover most of the paragraph to be meaningful.
  var DIAG_MIN_COMPLETENESS = 60;

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (_) { /* ignore */ }
  }

  /** The saved diagnostic result, or null (never stored, cleared, or unreadable). */
  function loadDiagnostic() {
    var raw = storageGet(DIAG_STORAGE_KEY);
    if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      if (d && d.completed) {
        d.weakPhonemes = Array.isArray(d.weakPhonemes) ? d.weakPhonemes : [];
        return d;
      }
    } catch (_) { /* legacy "true" or corrupt value */ }
    return { completed: true, weakPhonemes: [], summaryText: '' };
  }

  function loadAccent() {
    try {
      var saved = window.localStorage.getItem(ACCENT_STORAGE_KEY);
      if (saved && ACCENTS[saved]) return saved;
    } catch (_) { /* storage unavailable */ }
    return 'en-US';
  }

  /* -------------------------------------------------------------- */
  /* State                                                           */
  /* -------------------------------------------------------------- */
  var state = {
    content: null,
    exercises: [], // the current session's randomized queue
    library: [], // every exercise, curriculum order
    view: 'plan', // diagnostic | plan (topics) | practice | summary
    diagnosticEx: null, // the diagnostic paragraph, shaped like an exercise
    diagnosticSrc: null, // the content/diagnostics.json paragraph chosen for this learner
    diagnostic: null, // saved diagnostic result (see loadDiagnostic)
    rankedTopics: [], // AccentCurriculum.rankTopics() for the saved diagnostic
    activeTopics: [], // topic ids the next session draws from
    session: null, // { topicIds, queue, attemptsFrom, startedAt }
    lastQueue: [], // exercise ids of the previous set, so "Next Set" moves on
    practised: {}, // exercise_id → true for everything recorded since the page loaded
    diagSeq: 0,
    sections: {},
    index: 0,
    attempts: [], // session history (in-memory only)
    exportedCount: 0,
    token: null, // { token, region, expiresAt }
    phase: 'idle', // idle | connecting | recording | analyzing
    rec: null, // active recording context
    lastAnalysis: null,
    coachSeq: 0,
    micChecked: false,
    locale: loadAccent(), // 'en-US' | 'en-GB'
    gbSafeMode: false, // en-GB: drop options Azure may not support after a rejection
    lastRecording: null, // { exercise, wav } — kept so an accent switch can re-score it
  };

  /* -------------------------------------------------------------- */
  /* DOM helpers                                                     */
  /* -------------------------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function show(id, on) { $(id).hidden = !on; }

  var NOTICE_STYLES = {
    error: 'mt-4 rounded-xl border px-4 py-3 text-sm border-rose-200 bg-rose-50 text-rose-800',
    warn: 'mt-4 rounded-xl border px-4 py-3 text-sm border-amber-200 bg-amber-50 text-amber-900',
    info: 'mt-4 rounded-xl border px-4 py-3 text-sm border-sky-200 bg-sky-50 text-sky-900',
  };
  function notice(kind, message) {
    var n = $('notice');
    if (!message) { n.hidden = true; n.textContent = ''; return; }
    n.className = NOTICE_STYLES[kind] || NOTICE_STYLES.info;
    n.textContent = message;
    n.hidden = false;
  }

  /* -------------------------------------------------------------- */
  /* Boot                                                            */
  /* -------------------------------------------------------------- */
  async function init() {
    bindEvents();

    if (!S || !C) {
      notice('error', 'The scoring module failed to load. Please refresh the page.');
      return;
    }

    try {
      var resp = await fetch(CONFIG.contentUrl, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      state.content = await resp.json();
      state.library = state.content.exercises || [];
      state.exercises = state.library.slice();
      (state.content.sections || []).forEach(function (s) { state.sections[s.id] = s; });
      if (!state.exercises.length) throw new Error('empty');
      pickDiagnostic();
    } catch (e) {
      notice('error', 'Could not load the exercise library. Please refresh the page.');
      $('progressText').textContent = 'Exercises unavailable';
      $('recordBtn').disabled = true;
      return;
    }

    state.diagnostic = loadDiagnostic();
    if (!state.diagnosticEx || state.diagnostic) { applyPlan(); showPlan(); }
    else showDiagnostic();

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notice('error', 'Microphone access needs a secure (https) page in a modern browser such as Chrome, Edge or Safari.');
      $('recordBtn').disabled = true;
      return;
    }

    // Warm the token in the background so the first recording starts instantly
    // and a misconfigured deployment is reported before the learner records.
    getToken().catch(handleTokenError);
  }

  function waitForSdk() {
    if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function poll() {
        if (window.SpeechSDK) return resolve(window.SpeechSDK);
        if (Date.now() - start > CONFIG.sdkWaitMs) return reject(new Error('sdk_unavailable'));
        setTimeout(poll, 100);
      })();
    });
  }

  /* -------------------------------------------------------------- */
  /* Token handling                                                  */
  /* -------------------------------------------------------------- */
  async function getToken() {
    var t = state.token;
    if (t && t.expiresAt - Date.now() > CONFIG.tokenRefreshMarginMs) return t;

    var resp = await fetch(CONFIG.tokenUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    var body = {};
    try { body = await resp.json(); } catch (_) { /* ignore */ }
    if (!resp.ok) {
      var err = new Error(body.error || 'token_http_' + resp.status);
      err.status = resp.status;
      throw err;
    }
    state.token = {
      token: body.token,
      region: body.region,
      expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 540) * 1000,
    };
    return state.token;
  }

  function handleTokenError(err) {
    if (err && err.status === 503) {
      notice('warn', 'Pronunciation scoring is not configured on this deployment yet (missing Azure Speech key). The site owner needs to add AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.');
    } else if (err && err.status === 429) {
      notice('warn', 'Lots of practice happening right now — please wait a minute and try again.');
    } else {
      notice('warn', 'Could not reach the scoring service. Check your connection and try again.');
    }
  }

  /* -------------------------------------------------------------- */
  /* Exercise rendering & navigation                                 */
  /* -------------------------------------------------------------- */
  function current() {
    return state.view === 'diagnostic' ? state.diagnosticEx : state.exercises[state.index];
  }

  /* -------------------------------------------------------------- */
  /* Views: diagnostic → plan → practice                             */
  /* -------------------------------------------------------------- */
  var TARGET_TEXT_CLASS = {
    practice: 'mt-4 font-display text-3xl sm:text-4xl leading-snug text-slate-900 break-words',
    diagnostic: 'mt-4 font-display text-xl sm:text-2xl leading-relaxed text-slate-900 break-words',
  };

  function setView(view) {
    state.view = view;
    var practising = view === 'practice';
    show('diagnosticIntro', view === 'diagnostic');
    show('diagnosticStatus', false);
    show('planView', view === 'plan');
    show('summaryView', view === 'summary');
    show('progressSection', practising);
    show('exerciseCard', practising || view === 'diagnostic');
    show('skipWrap', practising || view === 'diagnostic');
    if (!practising) {
      show('resultPanel', false);
      show('coachTip', false);
      show('actions', false);
      show('skipBtn', true);
    }
    $('targetText').className = TARGET_TEXT_CLASS[view === 'diagnostic' ? 'diagnostic' : 'practice'];
    $('skipBtn').textContent = view === 'diagnostic' ? 'Skip the diagnostic for now' : 'Skip this one';
    updateNav();
  }

  /** Header buttons: Topics + Finish Session while practising, Retake once a result exists. */
  function updateNav() {
    var hasDiag = !!state.diagnosticEx;
    show('planBtn', state.view === 'practice');
    show('retakeBtn', hasDiag && state.view !== 'diagnostic');
    show('finishBtn', state.view === 'practice');
  }

  /**
   * One of the content's diagnostic paragraphs at random (never the one taken
   * last time, when there is a choice). Each measures only a few sounds.
   */
  function pickDiagnostic() {
    var list = (state.content && state.content.diagnostics) || [];
    // avoid the paragraph the learner last completed (falls back to the one on screen)
    var last = storageGet(LAST_DIAG_KEY) || (state.diagnosticSrc && state.diagnosticSrc.id);
    state.diagnosticSrc = null;
    state.diagnosticEx = null;
    if (!list.length) return;
    var pool = list.length > 1 ? list.filter(function (d) { return d.id !== last; }) : list;
    var d = pool[Math.floor(Math.random() * pool.length)];
    state.diagnosticSrc = d;
    state.diagnosticEx = {
      id: d.id, type: 'diagnostic', section: 'diagnostic', target_text: d.target_text,
      focus: d.measured || [], target_words: [], cue: d.cue, title: d.title,
    };
  }

  var SOUND_EXAMPLE = {
    'θ': 'think', 'ð': 'the', 'w': 'wind', 'v': 'valley', 's': 'see', 'z': 'zoo', 'i': 'feel', 'ɪ': 'fill',
    'ʃ': 'share', 'tʃ': 'change', 'dʒ': 'bridge', 'ɹ': 'really', 'l': 'clear', 'p': 'plan', 't': 'track', 'k': 'quick', 'æ': 'bad', 'ɛ': 'bed',
  };

  /** "Read … We'll check your /θ/ (think), /ð/ (the) and /w/ (wind) …" for the chosen paragraph. */
  function renderDiagnosticIntro(src) {
    var box = $('diagIntroText');
    box.textContent = '';
    box.appendChild(document.createTextNode('Read the paragraph below aloud once. This one checks your '));
    var sounds = src.measured || [];
    sounds.forEach(function (s, i) {
      if (i) box.appendChild(document.createTextNode(i === sounds.length - 1 ? ' and ' : ', '));
      box.appendChild(el('span', 'ipa font-semibold', ipa(s)));
      var example = (src.sound_words && src.sound_words[s] && src.sound_words[s][0]) || SOUND_EXAMPLE[s];
      if (example) {
        box.appendChild(document.createTextNode(' ('));
        box.appendChild(el('em', '', example));
        box.appendChild(document.createTextNode(')'));
      }
    });
    box.appendChild(document.createTextNode('; we’ll rank the practice topics around your weakest sounds. Retake it any time for a different paragraph.'));
    $('diagTitle').textContent = 'Pronunciation Diagnostic' + (src.title ? ': ' + src.title : '');
  }

  function showDiagnostic() {
    if (!state.diagnosticEx) pickDiagnostic();
    if (!state.diagnosticEx) { applyPlan(); showPlan(); return; }
    renderDiagnosticIntro(state.diagnosticSrc);
    stopModelAudio();
    state.diagSeq++;
    state.coachSeq++;
    setView('diagnostic');
    var ex = state.diagnosticEx;
    var chips = $('focusChips');
    chips.textContent = '';
    chips.appendChild(el('span', 'text-xs font-semibold uppercase tracking-wide px-2 py-1 rounded-md bg-brand-100 text-brand-800', 'Diagnostic'));
    ex.focus.forEach(function (f) {
      chips.appendChild(el('span', 'ipa text-sm px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 ring-1 ring-slate-200', ipa(f)));
    });
    $('targetText').textContent = ex.target_text;
    $('cueText').textContent = ex.cue || '';
    state.lastAnalysis = null;
    state.lastRecording = null;
    setPhase('idle', 'Tap the mic and read the whole paragraph aloud.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function retakeDiagnostic() {
    if (state.phase !== 'idle') return;
    storageRemove(DIAG_STORAGE_KEY);
    state.diagnostic = null;
    state.rankedTopics = [];
    pickDiagnostic(); // a different paragraph from the last one
    showDiagnostic();
  }

  function skipDiagnostic() {
    saveDiagnostic({ completed: true, skipped: true, weakPhonemes: [], summaryText: '' });
    applyPlan(true);
    showPlan();
  }

  function saveDiagnostic(result) {
    state.diagnostic = result;
    if (!storageSet(DIAG_STORAGE_KEY, JSON.stringify(result))) {
      notice('info', 'Your browser isn’t letting this page save data, so your plan will reset when you close the tab.');
    }
  }

  /* -------------------------------------------------------------- */
  /* Topics: ranked by the diagnostic, selectable for a session      */
  /* -------------------------------------------------------------- */
  /** Rank topics for the saved diagnostic and choose the session's active topics. */
  function applyPlan(resetSelection) {
    state.rankedTopics = C.rankTopics((state.content && state.content.topics) || [], state.diagnostic);
    var known = {};
    state.rankedTopics.forEach(function (r) { known[r.topic.id] = true; });
    var saved = null;
    if (resetSelection) storageRemove(TOPIC_STORAGE_KEY);
    else {
      try { saved = JSON.parse(storageGet(TOPIC_STORAGE_KEY) || 'null'); } catch (_) { saved = null; }
    }
    var ids = Array.isArray(saved) ? saved.filter(function (id) { return known[id]; }) : [];
    state.activeTopics = ids.length ? ids : C.defaultTopicSelection(state.rankedTopics);
  }

  function topicById(id) {
    return ((state.content && state.content.topics) || []).filter(function (t) { return t.id === id; })[0] || null;
  }

  function isPriorityTopic(id) {
    return state.rankedTopics.some(function (r) { return r.topic.id === id && r.priority; });
  }

  function toggleTopic(id) {
    var i = state.activeTopics.indexOf(id);
    if (i >= 0) state.activeTopics.splice(i, 1);
    else state.activeTopics.push(id);
    var order = state.rankedTopics.map(function (r) { return r.topic.id; });
    state.activeTopics.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    storageSet(TOPIC_STORAGE_KEY, JSON.stringify(state.activeTopics));
    renderTopics();
  }

  var SOUND_LABELS = {
    'θ': 'voiceless “th” · think', 'ð': 'voiced “th” · the', 'w': 'w · wind', 'v': 'v · valley', 's': 's · stay',
    'z': 'buzzing z · rises', 'i': 'long ee · feel', 'ɪ': 'short i · fill', 'ʃ': 'sh · share', 'tʃ': 'ch · change',
    'dʒ': 'j · bridge', 'ɹ': 'English r · really', 'l': 'l · clear', 'p': 'aspirated p · plan', 't': 'aspirated t · track',
    'k': 'aspirated k · quick', 'æ': 'open a · bad', 'ɛ': 'e · bed',
  };

  function showPlan() {
    stopModelAudio();
    setView('plan');
    setPhase('idle');
    var d = state.diagnostic || { weakPhonemes: [] };
    var skipped = !!d.skipped;
    $('planKicker').textContent = skipped ? 'Diagnostic skipped' : 'Step 2 of 2 · Your results';

    var report = $('planReport');
    report.textContent = '';
    if (skipped) {
      report.appendChild(el('p', '', 'Take the one-minute diagnostic to find your weakest sounds. Your Recommended Focus list will then put the drills for them first.'));
    } else if (d.parts && d.parts.strength) {
      [['Top strength', d.parts.strength, 'text-emerald-700'],
        ['Main area to improve', d.parts.improve, 'text-rose-700'],
        ['Recommendation', d.parts.recommendation, 'text-brand-700']].forEach(function (row) {
        var pEl = el('p', '');
        pEl.appendChild(el('span', 'block text-[11px] font-semibold uppercase tracking-wide ' + row[2], row[0]));
        pEl.appendChild(document.createTextNode(row[1]));
        report.appendChild(pEl);
      });
    } else {
      report.appendChild(el('p', '', d.summaryText || 'Your diagnostic is complete.'));
    }
    var src = d.source === 'groq' ? 'Report written by your AI coach'
      : d.source === 'fallback' ? 'Report from the built-in coaching library'
        : d.source === 'offline' ? 'Report generated offline (coach unavailable)' : '';
    if (d.completedAt && !skipped) src += (src ? ' · ' : '') + 'taken ' + new Date(d.completedAt).toLocaleDateString();
    $('planSource').textContent = src;
    show('takeDiagnosticBtn', skipped);

    var sounds = $('planSounds');
    sounds.textContent = '';
    var scores = d.scores || [];
    show('planSoundsWrap', !skipped && scores.length > 0);
    $('planLevelNote').textContent = d.level === 'word'
      ? '— checked word by word (British benchmark), so it’s more forgiving'
      : '';
    var RATINGS = {
      clear: { label: 'Clear', pill: 'bg-emerald-100 text-emerald-800', fill: 'bg-emerald-500', steps: 3 },
      nearly: { label: 'Nearly there', pill: 'bg-amber-100 text-amber-900', fill: 'bg-amber-400', steps: 2 },
      focus: { label: 'Focus', pill: 'bg-rose-100 text-rose-700', fill: 'bg-rose-500', steps: 1 },
    };
    scores.forEach(function (x) {
      // Older saved results have no rating: derive one from the focus list.
      var key = x.rating || (x.score === null || x.score === undefined ? null
        : d.weakPhonemes.indexOf(x.phoneme) !== -1 ? 'focus' : x.score >= 80 ? 'clear' : 'nearly');
      var r = RATINGS[key];
      var row = el('div', '');
      var head = el('div', 'flex items-center justify-between gap-2 text-sm');
      var name = el('span', 'flex items-center gap-2 min-w-0');
      name.appendChild(el('span', 'ipa text-lg font-semibold text-slate-800 w-8', ipa(x.phoneme)));
      name.appendChild(el('span', 'text-xs text-slate-500 truncate', SOUND_LABELS[x.phoneme] || ''));
      head.appendChild(name);
      head.appendChild(el('span', 'text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded ' + (r ? r.pill : 'bg-slate-100 text-slate-500'), r ? r.label : 'Not heard'));
      row.appendChild(head);
      var meter = el('div', 'mt-1.5 grid grid-cols-3 gap-1');
      for (var i = 0; i < 3; i++) meter.appendChild(el('span', 'h-1.5 rounded-full ' + (r && i < r.steps ? r.fill : 'bg-slate-100')));
      row.appendChild(meter);
      if (r && key !== 'clear' && x.weakest_word) {
        row.appendChild(el('p', 'mt-1 text-[11px] text-slate-400', 'Hardest in “' + x.weakest_word + '”'));
      }
      sounds.appendChild(row);
    });

    renderTopics();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  var RATING_TEXT = { focus: 'Diagnostic: needs focus', nearly: 'Diagnostic: nearly there', clear: 'Diagnostic: clear' };

  /** "Your Priority Focus Topics": one card per topic, ranked by need; tap to toggle. */
  function renderTopics() {
    var grid = $('topicGrid');
    grid.textContent = '';
    var anyPriority = state.rankedTopics.some(function (r) { return r.priority; });
    var d = state.diagnostic;
    $('topicsHint').textContent = anyPriority
      ? 'Ranked by your diagnostic. Tap a topic to add it to your session or remove it.'
      : d && !d.skipped ? 'No topic stood out in your diagnostic, so pick any you like.'
        : 'Pick the topics you want to practise.';

    state.rankedTopics.forEach(function (r) {
      var t = r.topic;
      var active = state.activeTopics.indexOf(t.id) !== -1;
      var card = el('button', 'text-left rounded-2xl bg-white p-4 transition '
        + (active ? 'ring-2 ring-brand-600 shadow-sm' : 'ring-1 ring-slate-200 hover:ring-slate-300'));
      card.type = 'button';
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
      card.setAttribute('aria-label', t.title + (r.priority ? ', high priority' : '') + (active ? ', in this session' : ', not in this session'));

      var top = el('div', 'flex items-start justify-between gap-2');
      var head = el('div', 'min-w-0');
      head.appendChild(el('p', 'font-semibold text-slate-900', t.title));
      var snd = el('p', 'mt-1 flex flex-wrap gap-1');
      (t.sounds || []).forEach(function (s) { snd.appendChild(el('span', 'ipa text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600', ipa(s))); });
      head.appendChild(snd);
      top.appendChild(head);
      top.appendChild(el('span', 'mt-0.5 w-5 h-5 shrink-0 rounded-md grid place-items-center text-xs font-bold '
        + (active ? 'bg-brand-700 text-white' : 'ring-1 ring-slate-300 text-transparent'), '✓'));
      card.appendChild(top);

      var meta = el('div', 'mt-3 flex flex-wrap items-center gap-1.5');
      if (r.priority) meta.appendChild(el('span', 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700', '🎯 High Priority'));
      else if (r.rating) meta.appendChild(el('span', 'text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600', RATING_TEXT[r.rating]));
      var ids = t.exercise_ids || [];
      var done = ids.filter(function (id) { return state.practised[id]; }).length;
      meta.appendChild(el('span', 'text-[11px] text-slate-500', ids.length + ' phrases' + (done ? ' · ' + done + ' practised' : '')));
      card.appendChild(meta);
      var sample = state.library.filter(function (ex) { return ex.topic_id === t.id; })[0];
      if (sample) card.appendChild(el('p', 'mt-2 font-display text-[15px] text-slate-500 truncate', '“' + sample.target_text + '”'));

      card.addEventListener('click', function () { toggleTopic(t.id); });
      grid.appendChild(card);
    });

    var n = state.activeTopics.length;
    var pool = state.library.filter(function (ex) { return state.activeTopics.indexOf(ex.topic_id) !== -1; }).length;
    $('startSessionBtn').disabled = !n;
    $('sessionHint').textContent = n
      ? Math.min(C.SESSION.size, pool) + ' random drills from ' + state.activeTopics.map(function (id) { return topicById(id).title; }).join(', ') + '.'
      : 'Choose at least one topic.';
  }

  /** A fresh randomized queue (5–8 drills) drawn only from the active topics. */
  function startSession() {
    if (state.phase !== 'idle' || !state.activeTopics.length) return;
    var queue = C.buildQueue(state.library, state.activeTopics, { practised: state.practised, previous: state.lastQueue });
    if (!queue.length) return;
    state.lastQueue = queue.map(function (ex) { return ex.id; });
    state.session = { topicIds: state.activeTopics.slice(), queue: queue, attemptsFrom: state.attempts.length, startedAt: Date.now() };
    state.exercises = queue;
    state.index = 0;
    setView('practice');
    renderExercise();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function finishSession() {
    if (state.phase !== 'idle') return;
    stopModelAudio();
    state.coachSeq++;
    setView('summary');
    setPhase('idle');
    renderSessionSummary();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Session Summary: per topic, curriculum coverage and a qualitative star average. */
  function renderSessionSummary() {
    var sess = state.session || { topicIds: state.activeTopics.slice(), queue: [], attemptsFrom: state.attempts.length };
    var sessionAttempts = state.attempts.slice(sess.attemptsFrom);
    var report = C.sessionReport({
      content: state.content, sessionAttempts: sessionAttempts, practised: state.practised, topicIds: sess.topicIds,
    });
    var drills = {};
    sessionAttempts.forEach(function (a) { drills[a.exercise_id] = true; });
    var nDrills = Object.keys(drills).length;
    $('summarySubtitle').textContent = sessionAttempts.length
      ? 'You practised ' + nDrills + ' of ' + sess.queue.length + ' drills (' + sessionAttempts.length + ' recording' + (sessionAttempts.length === 1 ? '' : 's') + ').'
      : 'No recordings in this session yet. Practise a few drills to see your progress.';

    var box = $('summaryTopics');
    box.textContent = '';
    report.forEach(function (r) {
      var t = r.topic;
      var card = el('div', 'rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-5');
      var head = el('div', 'flex flex-wrap items-center gap-2');
      head.appendChild(el('p', 'font-semibold text-slate-900 mr-1', t.title));
      (t.sounds || []).forEach(function (s) { head.appendChild(el('span', 'ipa text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600', ipa(s))); });
      if (isPriorityTopic(t.id)) head.appendChild(el('span', 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700', '🎯 High Priority'));
      card.appendChild(head);

      var grid = el('div', 'mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4');
      var cov = el('div', '');
      cov.appendChild(el('p', 'text-[11px] font-semibold uppercase tracking-wide text-slate-400', 'Curriculum coverage'));
      cov.appendChild(el('p', 'mt-1 text-sm text-slate-700', r.coverage.done + ' of ' + r.coverage.total + ' exercises completed — ' + r.coverage.percent + '%'));
      var track = el('div', 'mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden');
      var fill = el('div', 'h-full rounded-full bg-brand-600');
      fill.style.width = r.coverage.percent + '%';
      track.appendChild(fill);
      cov.appendChild(track);
      grid.appendChild(cov);

      var perf = el('div', '');
      perf.appendChild(el('p', 'text-[11px] font-semibold uppercase tracking-wide text-slate-400', 'Session performance'));
      var line = el('p', 'mt-1 text-sm text-slate-700');
      line.appendChild(document.createTextNode('Average Rating: '));
      var tone = r.averageStars === null ? 'text-slate-300' : r.averageStars >= 2.5 ? 'text-emerald-500' : r.averageStars >= 1.5 ? 'text-amber-500' : 'text-rose-500';
      line.appendChild(el('span', 'text-lg tracking-wider ' + tone, r.averageLabel));
      perf.appendChild(line);
      perf.appendChild(el('p', 'text-[11px] text-slate-400', r.attempts
        ? r.exercisesAttempted + ' drill' + (r.exercisesAttempted === 1 ? '' : 's') + ' · ' + r.attempts + ' attempt' + (r.attempts === 1 ? '' : 's') + ' this session'
        : 'Not practised in this session'));
      grid.appendChild(perf);
      card.appendChild(grid);
      box.appendChild(card);
    });
    $('downloadCsvBtn').disabled = !state.attempts.length;
    $('practiceAgainBtn').disabled = !state.activeTopics.length;
  }

  function renderExercise() {
    var ex = current();
    var total = state.exercises.length;
    $('progressText').textContent = 'Drill ' + (state.index + 1) + ' of ' + total + ' · Practice session';
    var pct = Math.round((state.index / total) * 100);
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', String(pct));

    var section = state.sections[ex.section];
    $('sectionBadge').textContent = section ? section.label : ex.type;

    var chips = $('focusChips');
    chips.textContent = '';
    ex.focus.forEach(function (f) {
      chips.appendChild(el('span', 'ipa text-sm px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 ring-1 ring-slate-200', ipa(f)));
    });
    if (ex.position) chips.appendChild(el('span', 'text-xs text-slate-500', ex.position + ' position'));
    if (ex.contrast) chips.appendChild(el('span', 'text-xs text-slate-500', ex.contrast[0] + ' ↔ ' + ex.contrast[1]));
    if (isPriorityTopic(ex.topic_id)) chips.appendChild(el('span', 'text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose-100 text-rose-700', '🎯 Priority'));

    $('targetText').textContent = ex.target_text;
    $('cueText').textContent = ex.cue || '';

    show('resultPanel', false);
    show('coachTip', false);
    show('actions', false);
    show('skipBtn', true);
    $('nextBtn').textContent = state.index === total - 1 ? 'Finish Session' : 'Next Phrase →';
    setPhase('idle');
    state.lastAnalysis = null;
    state.lastRecording = null;
    state.coachSeq++; // invalidate any in-flight coach request
    cmp.seq++; // and any compare-player loading
    stopCompare();
  }

  function goNext() {
    if (state.index >= state.exercises.length - 1) { finishSession(); return; }
    state.index++;
    renderExercise();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function retry() {
    stopCompare();
    show('resultPanel', false);
    show('coachTip', false);
    show('actions', false);
    show('skipBtn', true);
    setPhase('idle');
    state.coachSeq++;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* -------------------------------------------------------------- */
  /* Recording state machine                                         */
  /* -------------------------------------------------------------- */
  function setPhase(phase, message) {
    state.phase = phase;
    var btn = $('recordBtn');
    var recording = phase === 'recording';
    var busy = phase === 'connecting' || phase === 'analyzing';

    btn.disabled = busy;
    btn.setAttribute('aria-pressed', recording ? 'true' : 'false');
    btn.classList.toggle('bg-rose-600', recording);
    btn.classList.toggle('hover:bg-rose-700', recording);
    btn.classList.toggle('bg-brand-700', !recording);
    btn.classList.toggle('hover:bg-brand-800', !recording);
    $('micIcon').hidden = recording || busy;
    $('stopIcon').hidden = !recording;
    $('spinIcon').hidden = !busy;
    $('recordRing').hidden = !recording;
    $('recordLabel').textContent = recording ? 'Stop recording' : 'Start recording';

    var defaults = {
      idle: 'Tap the mic, read the text aloud, then tap stop.',
      connecting: 'Connecting to the scoring service…',
      recording: 'Listening… tap stop when you finish.',
      analyzing: 'Scoring your pronunciation…',
    };
    $('recordStatus').textContent = message || defaults[phase];
    $('finishBtn').disabled = recording || busy;
    $('accentSelect').disabled = recording || busy;
    $('skipBtn').disabled = recording || busy;
    $('nextBtn').disabled = recording || busy;
    $('retryBtn').disabled = recording || busy;
    $('planBtn').disabled = recording || busy;
    $('retakeBtn').disabled = recording || busy;
  }

  async function ensureMicPermission() {
    if (state.micChecked) return;
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(function (t) { t.stop(); });
    state.micChecked = true;
  }

  async function onRecordClick() {
    if (state.phase === 'recording') return stopRecording('user');
    if (state.phase !== 'idle') return;
    stopModelAudio();
    show('resultPanel', false);
    show('coachTip', false);
    show('actions', false);
    setPhase('connecting');

    try {
      await ensureMicPermission();
    } catch (e) {
      setPhase('idle', 'Microphone blocked.');
      notice('error', 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.');
      return;
    }

    var SDK, tok;
    try {
      SDK = await waitForSdk();
    } catch (e) {
      setPhase('idle', 'Speech engine unavailable.');
      notice('error', 'The Azure Speech SDK could not be loaded (a blocker or network filter may be stopping cdn.jsdelivr.net).');
      return;
    }
    try {
      tok = await getToken();
    } catch (e) {
      setPhase('idle', 'Scoring service unavailable.');
      handleTokenError(e);
      return;
    }
    notice(null);

    var capture = startPcmCapture();
    try {
      startRecognizer(SDK, tok, current(), capture);
    } catch (e) {
      capture.stop();
      console.error(e);
      setPhase('idle', 'Could not start recording.');
      notice('error', 'Could not start the recorder. Please refresh and try again.');
    }
  }

  /** One recognizer + pronunciation-assessment config for a given benchmark locale. */
  function createAssessmentRecognizer(SDK, tok, ex, locale, audioConfig) {
    var speechConfig = SDK.SpeechConfig.fromAuthorizationToken(tok.token, tok.region);
    var caps = ACCENTS[locale];
    speechConfig.speechRecognitionLanguage = locale; // en-US (GenAm) or en-GB (RP) benchmark
    var recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);

    // Phoneme granularity + miscue detection. The JS SDK has no separate
    // "enableMispronunciation" switch: word-level Mispronunciation labels are
    // always returned, and the 4th argument (enableMiscue) adds Omission and
    // Insertion detection against the reference text. Every exercise is a
    // phrase, so it is always on.
    var pa = new SDK.PronunciationAssessmentConfig(
      ex.target_text,
      SDK.PronunciationAssessmentGradingSystem.HundredMark,
      SDK.PronunciationAssessmentGranularity.Phoneme,
      true
    );
    var safe = locale === 'en-GB' && state.gbSafeMode;
    if (caps.ipa && !safe) pa.phonemeAlphabet = 'IPA';
    if (caps.nbestPhonemes) pa.nbestPhonemeCount = 5;
    pa.enableProsodyAssessment = !!caps.prosody;
    pa.applyTo(recognizer);
    return recognizer;
  }

  function startRecognizer(SDK, tok, ex, capture) {
    var locale = state.locale;
    var recognizer = createAssessmentRecognizer(SDK, tok, ex, locale, SDK.AudioConfig.fromDefaultMicrophoneInput());

    var refParts = S.tokenizeReference(ex.target_text).reduce(function (n, t) { return n + t.parts.length; }, 0);

    var rec = {
      recognizer: recognizer,
      exercise: ex,
      locale: locale,
      capture: capture,
      segments: [],
      error: null,
      stopped: false,
      startedAt: Date.now(),
      timers: [],
      sessionStopped: null,
    };
    rec.sessionStopped = new Promise(function (resolve) { rec.resolveSession = resolve; });
    state.rec = rec;

    recognizer.recognized = function (_s, e) {
      if (e.result.reason !== SDK.ResultReason.RecognizedSpeech) return;
      var raw = e.result.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult);
      try { rec.segments.push(JSON.parse(raw)); } catch (_) { return; }
      // Auto-stop once every reference word has been heard.
      var heard = rec.segments.reduce(function (n, seg) {
        var nb = seg.NBest && seg.NBest[0];
        return n + ((nb && nb.Words) || []).filter(function (w) {
          return !(w.PronunciationAssessment && w.PronunciationAssessment.ErrorType === 'Omission');
        }).length;
      }, 0);
      if (heard >= refParts) stopRecording('complete');
    };
    recognizer.canceled = function (_s, e) {
      if (e.reason === SDK.CancellationReason.Error) {
        rec.error = e.errorDetails || 'canceled';
        console.error('[speech] canceled:', e.errorCode, e.errorDetails);
        if (e.errorCode === SDK.CancellationErrorCode.AuthenticationFailure) state.token = null;
      }
      stopRecording('canceled');
    };
    recognizer.sessionStopped = function () { rec.resolveSession(); };

    recognizer.startContinuousRecognitionAsync(
      function () {
        if (rec.stopped) return;
        setPhase('recording');
        rec.timers.push(setInterval(function () {
          var secs = Math.floor((Date.now() - rec.startedAt) / 1000);
          if (state.phase === 'recording') $('recordStatus').textContent = 'Listening… 0:' + String(secs).padStart(2, '0') + ' — tap stop when you finish.';
        }, 250));
        rec.timers.push(setTimeout(function () { stopRecording('timeout'); }, CONFIG.maxRecordMs[ex.type] || 15000));
      },
      function (err) {
        rec.error = String(err);
        stopRecording('start_failed');
      }
    );
  }

  function stopRecording(reason) {
    var rec = state.rec;
    if (!rec || rec.stopped) return;
    rec.stopped = true;
    rec.timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
    setPhase('analyzing');

    var done = false;
    function finish() {
      if (done) return;
      done = true;
      try { rec.recognizer.close(); } catch (_) { /* ignore */ }
      state.rec = null;
      if (rec.capture) {
        rec.wavPromise = rec.capture.stop();
        rec.wavPromise.then(function (wav) {
          state.lastRecording = wav && rec.segments.length ? { exercise: rec.exercise, wav: wav } : null;
        });
      }
      finalizeAttempt(rec, reason);
    }

    try {
      rec.recognizer.stopContinuousRecognitionAsync(
        function () {
          // Wait for the final `recognized` event to flush (sessionStopped), bounded.
          Promise.race([
            rec.sessionStopped,
            new Promise(function (r) { setTimeout(r, CONFIG.finalizeTimeoutMs); }),
          ]).then(finish);
        },
        function () { finish(); }
      );
    } catch (_) {
      finish();
    }
  }

  /* -------------------------------------------------------------- */
  /* Analysis → UI                                                   */
  /* -------------------------------------------------------------- */
  function finalizeAttempt(rec, reason) {
    var ex = rec.exercise;
    if (ex !== current()) { setPhase('idle'); return; } // user navigated away

    if (rec.error && !rec.segments.length && rec.locale === 'en-GB' && !state.gbSafeMode
        && !/auth|401|403|token/i.test(rec.error)) {
      // Azure may reject IPA for en-GB (documented for en-US only): retry without it.
      state.gbSafeMode = true;
      setPhase('idle', 'Adjusted British scoring settings — tap the mic and say it again.');
      notice('info', 'Azure didn\u2019t accept the IPA phoneme setting for British English, so this session now uses the British defaults. Target sounds are checked at word level.');
      return;
    }
    if (rec.error && !rec.segments.length) {
      setPhase('idle', 'Something went wrong — please try again.');
      notice('warn', /auth|401|403|token/i.test(rec.error)
        ? 'The scoring session expired. Tap the mic to try again.'
        : 'The scoring service had a hiccup. Please try again.');
      return;
    }

    var analysis = S.analyzeAttempt(rec.segments, ex.target_text, {
      focus: ex.focus,
      targetWords: ex.target_words,
    });
    analysis.locale = rec.locale;
    if (!analysis.recognized) {
      setPhase('idle', reason === 'timeout'
        ? "We didn't hear anything — check your mic and try again."
        : "We didn't catch that — try speaking a little louder.");
      return;
    }

    if (ex.type === 'diagnostic') { finalizeDiagnostic(analysis); return; }

    analysis.status = S.feedbackStatus(analysis);
    state.lastAnalysis = analysis;
    logAttempt(ex, analysis);
    renderResult(analysis);
    renderCompare(ex, analysis, rec.wavPromise || null);
    setPhase('idle', 'Tap the mic to record again.');
    show('actions', true);
    show('skipBtn', false);

    if (analysis.needsCoaching || analysis.status.key !== 'spot_on') requestCoach(ex, analysis);
    else show('coachTip', false);

    setTimeout(function () { $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  }

  /* -------------------------------------------------------------- */
  /* Result: qualitative status, highlighted phrase, one cue         */
  /* (no numbers are shown — thresholds live in scoring.js)         */
  /* -------------------------------------------------------------- */
  var STATUS_STYLES = {
    green: { badge: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500' },
    amber: { badge: 'bg-amber-100 text-amber-900', dot: 'bg-amber-500' },
    red: { badge: 'bg-rose-100 text-rose-800', dot: 'bg-rose-500' },
  };

  // How a sound is spelled for a learner ("th", not /θ/) in plain-language lines.
  var SOUND_SPELLING = {
    'θ': 'th', 'ð': 'th', 's': 's', 'z': 'z', 't': 't', 'd': 'd', 'f': 'f', 'v': 'v', 'w': 'w',
    'b': 'b', 'p': 'p', 'h': 'h', 'ʃ': 'sh', 'ʒ': 'zh', 'ɹ': 'r', 'l': 'l', 'n': 'n', 'm': 'm', 'k': 'k', 'ɡ': 'g',
    'tʃ': 'ch', 'dʒ': 'j', 'i': 'ee', 'ɪ': 'i', 'æ': 'a', 'ɛ': 'e', 'ŋ': 'ng',
  };
  function spell(ph) { return SOUND_SPELLING[ph] || (ph ? '/' + ph + '/' : 'sound'); }
  function quoteWord(w) { return '“' + w + '”'; }

  /** One plain-language line under the badge describing what happened. */
  function statusLine(st) {
    if (st.key === 'spot_on') return st.total ? 'Every target sound landed cleanly. Keep that placement.' : 'Clear and natural. Keep it up.';
    var m = st.misses[0];
    if (!m) return 'A few sounds drifted. Listen to the model and try again.';
    var line;
    if (m.reason === 'omitted') line = quoteWord(m.word) + ' was skipped. Say every word, even the small ones.';
    else if (m.reason === 'replaced') line = quoteWord(m.word) + ' came out as a different word' + (m.heardAs ? ' (' + quoteWord(m.heardAs) + ')' : '') + '.';
    else if (m.reason === 'heard_as') line = 'The ' + quoteWord(spell(m.phoneme)) + ' in ' + quoteWord(m.word) + ' sounded closer to ' + quoteWord(spell(m.produced)) + '.';
    else if (m.reason === 'slipped') line = 'Only the ' + (m.phoneme ? quoteWord(spell(m.phoneme)) + ' in ' : '') + quoteWord(m.word) + ' needs a little more polish.';
    else line = 'The ' + (m.phoneme ? quoteWord(spell(m.phoneme)) + ' in ' : 'target sound in ') + quoteWord(m.word) + ' didn’t come through clearly yet.';
    var more = st.misses.length - 1;
    if (more === 1) line += ' One more spot needs attention too.';
    else if (more > 1) line += ' A few more spots need attention too.';
    return line;
  }

  function renderResult(a) {
    show('resultPanel', true);
    var st = a.status || S.feedbackStatus(a);
    a.status = st;
    var style = STATUS_STYLES[st.tone] || STATUS_STYLES.amber;
    var badge = $('statusBadge');
    badge.className = 'inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold ' + style.badge;
    badge.textContent = '';
    badge.appendChild(el('span', 'w-2 h-2 rounded-full ' + style.dot));
    badge.appendChild(document.createTextNode(st.label));
    $('statusLine').textContent = statusLine(st);
    $('resultPanel').setAttribute('aria-label', st.label + '. ' + statusLine(st));
    $('benchmarkBadge').textContent = (a.rescored ? 're-scored as ' : 'scored as ') + (FLAGS[a.locale] || '') + ' '
      + (ACCENTS[a.locale] ? ACCENTS[a.locale].short : a.locale);
    renderPhrase(a, st);
  }

  /** The phrase with target words marked: green underline = clean, amber = slipped, coral = failed/substituted. */
  function renderPhrase(a, st) {
    var box = $('feedbackPhrase');
    box.textContent = '';
    var missByWord = {};
    st.misses.forEach(function (m) {
      if (m.wordIndex < 0) return;
      var prev = missByWord[m.wordIndex];
      if (!prev || (!prev.hard && m.hard) || m.reason === 'heard_as') missByWord[m.wordIndex] = m;
    });
    a.words.forEach(function (w, i) {
      if (i) box.appendChild(document.createTextNode(' '));
      if (!w.isTarget) { box.appendChild(document.createTextNode(w.display)); return; }
      var m = missByWord[i];
      var span = el('span', m
        ? (m.reason === 'slipped'
          ? 'rounded-md px-1 -mx-0.5 bg-amber-100 text-amber-950 ring-1 ring-amber-300'
          : 'rounded-md px-1 -mx-0.5 bg-rose-100 text-rose-950 ring-1 ring-rose-300')
        : 'underline decoration-emerald-400 decoration-2 underline-offset-[6px]', w.display);
      span.title = m ? 'Work on this word — see Hear the Difference below' : 'Target sound landed cleanly';
      box.appendChild(span);
    });
  }

  function lowerFirst(t) { return t ? t.charAt(0).toLowerCase() + t.slice(1) : t; }

  /* -------------------------------------------------------------- */
  /* Hear & Compare: model vs learner energy envelopes               */
  /* -------------------------------------------------------------- */
  /*
   * Model track: the Azure neural voice for the whole phrase, with its word
   * boundaries (from the synthesizer) so the same word can be highlighted.
   * Learner track: the 16 kHz WAV captured alongside the SDK. The SDK and the
   * capture open the mic separately, so the two clocks differ slightly: the
   * offset is estimated by matching the first speech onset in the WAV to the
   * first word's Azure Offset, and word slices are padded a little.
   */
  var WORD_PAD_SEC = 0.15;
  var cmp = { seq: 0, ctx: null, model: null, learner: null, delta: 0, modelRegions: [], learnerRegions: [], env: {}, src: null, raf: 0, playing: null, analysis: null };

  function playbackCtx() {
    if (!cmp.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      cmp.ctx = new AC();
    }
    if (cmp.ctx.state === 'suspended' && cmp.ctx.resume) cmp.ctx.resume().catch(function () {});
    return cmp.ctx;
  }

  function decodeAudio(arrayBuffer) {
    var ctx = playbackCtx();
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(arrayBuffer, resolve, reject); // callback form for older Safari
      if (p && p.catch) p.catch(reject);
    });
  }

  function compareNote(msg) {
    $('compareNote').textContent = msg || '';
    show('compareNote', !!msg);
  }

  /** Normalised RMS envelope with `bars` buckets (cached per canvas width). */
  function envelope(key, buffer, bars) {
    var c = cmp.env[key];
    if (c && c.buffer === buffer && c.bars === bars) return c.data;
    var data = buffer.getChannelData(0), n = data.length, per = Math.max(1, Math.floor(n / bars)), out = [], max = 0;
    for (var i = 0; i < bars; i++) {
      var st = i * per, en = Math.min(n, st + per), sum = 0;
      for (var j = st; j < en; j += 2) sum += data[j] * data[j];
      var v = Math.sqrt(sum / Math.max(1, (en - st) / 2));
      out.push(v);
      if (v > max) max = v;
    }
    out = out.map(function (v) { return max ? Math.pow(v / max, 0.7) : 0; });
    cmp.env[key] = { buffer: buffer, bars: bars, data: out };
    return out;
  }

  function drawTrack(canvasId, buffer, regions, color, headSec) {
    var c = $(canvasId);
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth || 300, h = c.clientHeight || 48;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!buffer) {
      g.fillStyle = '#e2e8f0';
      g.fillRect(0, h / 2 - 1, w, 2);
      return;
    }
    var dur = buffer.duration || 1;
    g.fillStyle = 'rgba(244, 63, 94, 0.18)';
    (regions || []).forEach(function (r) {
      var x0 = Math.max(0, (r.start / dur) * w), x1 = Math.min(w, (r.end / dur) * w);
      g.fillRect(x0, 0, Math.max(3, x1 - x0), h);
    });
    var step = 3, bars = Math.max(10, Math.floor(w / step));
    var env = envelope(canvasId, buffer, bars);
    g.fillStyle = color;
    for (var i = 0; i < env.length; i++) {
      var bh = Math.max(1.5, env[i] * (h - 4));
      g.fillRect(i * step, (h - bh) / 2, 2, bh);
    }
    if (headSec !== undefined && headSec !== null) {
      g.fillStyle = '#0f172a';
      g.fillRect(Math.min(w - 1.5, (headSec / dur) * w), 0, 1.5, h);
    }
  }

  function redrawTrack(which, headSec) {
    if (which === 'model') drawTrack('modelWave', cmp.model, cmp.modelRegions, '#0f766e', headSec);
    else drawTrack('learnerWave', cmp.learner, cmp.learnerRegions, '#475569', headSec);
  }

  function stopCompare() {
    var was = cmp.playing;
    if (cmp.src) {
      try { cmp.src.onended = null; cmp.src.stop(); } catch (_) { /* already stopped */ }
      cmp.src = null;
    }
    if (cmp.raf) cancelAnimationFrame(cmp.raf);
    cmp.playing = null;
    if (was) redrawTrack(was);
  }

  /** Plays [start, start+dur] of a track with a moving playhead. */
  function playTrack(which, start, dur) {
    var buffer = cmp[which];
    if (!buffer || state.phase === 'recording') return;
    stopModelAudio(); // also stops any compare playback
    var ctx = playbackCtx();
    start = Math.max(0, Math.min(start || 0, buffer.duration));
    dur = Math.max(0.05, Math.min(buffer.duration - start, dur || buffer.duration));
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    var t0 = ctx.currentTime;
    src.start(0, start, dur);
    cmp.src = src;
    cmp.playing = which;
    src.onended = function () {
      if (cmp.src !== src) return;
      cmp.src = null;
      cmp.playing = null;
      cancelAnimationFrame(cmp.raf);
      redrawTrack(which);
    };
    (function tick() {
      if (cmp.src !== src) return;
      redrawTrack(which, start + (ctx.currentTime - t0));
      cmp.raf = requestAnimationFrame(tick);
    })();
  }

  /** Learner-WAV time minus Azure time, from the first speech onset (seconds). */
  function alignDelta(buffer, words) {
    var first = null;
    (words || []).forEach(function (w) { if (w.start !== null && (first === null || w.start < first)) first = w.start; });
    if (first === null) return 0;
    var data = buffer.getChannelData(0), rate = buffer.sampleRate, frame = Math.round(rate * 0.01);
    var rms = [], max = 0;
    for (var i = 0; i + frame <= data.length; i += frame) {
      var s = 0;
      for (var j = i; j < i + frame; j++) s += data[j] * data[j];
      var v = Math.sqrt(s / frame);
      rms.push(v);
      if (v > max) max = v;
    }
    if (!max) return 0;
    var onset = -1;
    for (var k = 2; k < rms.length; k++) {
      // three consecutive frames above 15% of the peak = speech, not a click
      if (rms[k] > max * 0.15 && rms[k - 1] > max * 0.15 && rms[k - 2] > max * 0.15) { onset = k - 2; break; }
    }
    if (onset < 0) return 0;
    var delta = onset * 0.01 - first;
    return Math.max(-1, Math.min(3, delta));
  }

  /** Unique word indexes that need work, in phrase order. */
  function missedIndexes(a) {
    var seen = {}, out = [];
    ((a.status && a.status.misses) || []).forEach(function (m) {
      if (m.wordIndex >= 0 && !seen[m.wordIndex]) { seen[m.wordIndex] = true; out.push(m.wordIndex); }
    });
    return out.sort(function (x, y) { return x - y; });
  }

  function learnerRegions(a) {
    return missedIndexes(a).map(function (i) { return a.words[i]; })
      .filter(function (w) { return w.start !== null; })
      .map(function (w) { return { start: w.start + cmp.delta - WORD_PAD_SEC / 2, end: w.end + cmp.delta + WORD_PAD_SEC / 2 }; });
  }

  /** Model-track regions for the missed words, matched to the synthesizer's word boundaries. */
  function modelRegions(a, boundaries) {
    if (!boundaries || !boundaries.length) return [];
    var regions = [];
    missedIndexes(a).forEach(function (i) {
      var w = a.words[i];
      var parts = w.display.split(/[-–—]/).map(S.normalizeWord).filter(Boolean);
      var joined = parts.join('');
      var occurrence = a.words.slice(0, i).filter(function (o) { return S.normalizeWord(o.display) === S.normalizeWord(w.display); }).length;
      var matches = boundaries.filter(function (b) {
        var n = S.normalizeWord(b.text);
        return n === joined || parts.indexOf(n) !== -1;
      });
      var per = Math.max(1, Math.round(matches.length / Math.max(1, occurrence + 1 + a.words.slice(i + 1).filter(function (o) { return S.normalizeWord(o.display) === S.normalizeWord(w.display); }).length)));
      var mine = matches.slice(occurrence * per, occurrence * per + per);
      if (!mine.length) return;
      regions.push({ start: mine[0].start, end: mine[mine.length - 1].end });
    });
    return regions;
  }

  function renderCompare(ex, a, wavPromise) {
    var seq = ++cmp.seq;
    stopCompare();
    cmp.model = null;
    cmp.learner = null;
    cmp.delta = 0;
    cmp.modelRegions = [];
    cmp.learnerRegions = [];
    cmp.env = {};
    cmp.analysis = a;
    var locale = a.locale || state.locale;
    $('modelVoiceName').textContent = NEURAL_VOICES[locale] ? '· ' + NEURAL_VOICES[locale].label : '';
    $('playModelBtn').disabled = true;
    $('playLearnerBtn').disabled = true;
    compareNote(null);
    redrawTrack('model');
    redrawTrack('learner');
    renderDiffWords(a);

    Promise.resolve(wavPromise).then(function (wav) {
      if (seq !== cmp.seq) return;
      if (!wav) { compareNote('Your recording isn’t available for playback in this browser.'); return; }
      return decodeAudio(wav.slice(0)).then(function (buf) {
        if (seq !== cmp.seq) return;
        cmp.learner = buf;
        cmp.delta = alignDelta(buf, a.words);
        cmp.learnerRegions = learnerRegions(a);
        $('playLearnerBtn').disabled = false;
        redrawTrack('learner');
        renderDiffWords(a);
      });
    }).catch(function () {
      if (seq === cmp.seq) compareNote('Couldn’t load your recording for playback.');
    });

    synthesizeNeural(ex.target_text, locale).then(function (tts) {
      return decodeAudio(tts.data.slice(0)).then(function (buf) {
        if (seq !== cmp.seq) return;
        cmp.model = buf;
        cmp.modelRegions = modelRegions(a, tts.boundaries);
        $('playModelBtn').disabled = false;
        redrawTrack('model');
      });
    }).catch(function () {
      if (seq === cmp.seq) compareNote('The model waveform needs the Azure voice. “Hear Target Sound” still works with your browser’s voice.');
    });
  }

  /** "Hear the Difference": one row per word that needs work. */
  function renderDiffWords(a) {
    var box = $('diffWords');
    box.textContent = '';
    var idxs = missedIndexes(a);
    if (!idxs.length) return;
    box.appendChild(el('p', 'text-xs font-semibold uppercase tracking-wide text-slate-400', 'Hear the Difference'));
    idxs.forEach(function (i) {
      var w = a.words[i];
      var word = w.display.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
      var m = a.status.misses.filter(function (x) { return x.wordIndex === i; })[0] || {};
      var row = el('div', 'flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 ring-1 ring-slate-200 px-3 py-2.5');
      var label = el('div', 'min-w-0 flex-1');
      label.appendChild(el('span', 'font-display text-lg text-slate-900 mr-2', word));
      var what = m.reason === 'heard_as' ? 'sounded like ' + quoteWord(spell(m.produced))
        : m.reason === 'omitted' ? 'skipped'
          : m.reason === 'replaced' ? 'heard as another word'
            : m.reason === 'slipped' ? 'a little soft' : 'not clear yet';
      label.appendChild(el('span', 'text-xs text-slate-500', (m.phoneme ? quoteWord(spell(m.phoneme)) + ' ' : '') + what));
      row.appendChild(label);

      var hearTarget = el('button', 'text-xs font-medium px-2.5 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-800', '▶ Hear Target Sound');
      hearTarget.type = 'button';
      hearTarget.addEventListener('click', function () { speak(word); });
      row.appendChild(hearTarget);

      var hearMine = el('button', 'text-xs font-medium px-2.5 py-1.5 rounded-lg bg-white ring-1 ring-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed', '▶ Hear Your Attempt');
      hearMine.type = 'button';
      var playable = cmp.learner && w.start !== null;
      hearMine.disabled = !playable;
      hearMine.title = w.start === null ? 'This word wasn’t heard in your recording' : cmp.learner ? '' : 'Loading your recording…';
      hearMine.addEventListener('click', function () {
        playTrack('learner', w.start + cmp.delta - WORD_PAD_SEC, (w.end - w.start) + 2 * WORD_PAD_SEC);
      });
      row.appendChild(hearMine);
      box.appendChild(row);
    });
  }

  /* -------------------------------------------------------------- */
  /* Diagnostic evaluation → report → plan                           */
  /* -------------------------------------------------------------- */
  async function finalizeDiagnostic(analysis) {
    var diag = state.diagnosticSrc;
    var profile = S.diagnosticProfile(analysis, diag);
    var measured = profile.scores.filter(function (x) { return x.score !== null; });
    if ((typeof analysis.completeness === 'number' && analysis.completeness < DIAG_MIN_COMPLETENESS) || !measured.length) {
      setPhase('idle', 'We only heard part of the paragraph. Tap the mic and read all of it, start to finish.');
      return;
    }

    var seq = ++state.diagSeq;
    setPhase('analyzing', 'Writing your diagnostic report…');
    show('diagnosticStatus', true);
    setTimeout(function () { $('diagnosticStatus').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50);

    var payload = {
      mode: 'diagnostic',
      accent: analysis.locale,
      overall_score: analysis.overall,
      phoneme_scores: measured.map(function (x) {
        return { phoneme: x.phoneme, score: x.score, samples: x.samples, passes: x.passes, best_word: x.best_word, weakest_word: x.weakest_word };
      }),
      weak_phonemes: profile.weakPhonemes,
    };

    var report;
    try {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 15000);
      var resp = await fetch(CONFIG.coachUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('coach_http_' + resp.status);
      report = await resp.json();
      if (!report || !report.report) throw new Error('coach_empty');
    } catch (e) {
      report = offlineDiagnosticReport(profile);
    }
    if (seq !== state.diagSeq || state.view !== 'diagnostic') return; // retaken or skipped meanwhile

    saveDiagnostic({
      completed: true,
      weakPhonemes: profile.weakPhonemes,
      summaryText: report.report,
      parts: { strength: report.strength, improve: report.improve, recommendation: report.recommendation },
      scores: profile.scores,
      level: profile.level,
      passMark: profile.passMark,
      overall: analysis.overall,
      locale: analysis.locale,
      source: report.source,
      model: report.model || null,
      completedAt: new Date().toISOString(),
      diagnosticId: diag.id,
      diagnosticTitle: diag.title || '',
    });
    storageSet(LAST_DIAG_KEY, diag.id);
    applyPlan(true);
    setPhase('idle');
    showPlan();
  }

  /** Last resort when /api/coach can't be reached: a plain report from the numbers. */
  function offlineDiagnosticReport(profile) {
    var weak = profile.weakPhonemes;
    var s = profile.strongest;
    var strength = s && s.rating === 'clear' && weak.indexOf(s.phoneme) === -1
      ? 'Your /' + s.phoneme + '/ is already clear' + (s.best_word ? ', for example in “' + s.best_word + '”' : '') + '.'
      : 'You read the whole paragraph through, which gives us a solid baseline.';
    var lowest = profile.scores.filter(function (x) { return x.score !== null; })
      .sort(function (a, b) { return a.score - b.score; })[0];
    var focus = weak[0] || (lowest && lowest.phoneme);
    var improve = 'Your main area to improve is /' + focus + '/: follow the placement cue shown on each drill.';
    var recommendation = weak.length
      ? 'Start with your Recommended Focus drills for ' + weak.map(function (p) { return '/' + p + '/'; }).join(' and ') + ', five minutes a day.'
      : 'Browse the full library at your own pace to keep every sound sharp.';
    return {
      strength: strength, improve: improve, recommendation: recommendation,
      report: [strength, improve, recommendation].join(' '), source: 'offline',
    };
  }

  /* -------------------------------------------------------------- */
  /* Coach                                                           */
  /* -------------------------------------------------------------- */
  async function requestCoach(ex, a) {
    var seq = ++state.coachSeq;
    show('coachTip', true);
    show('coachLoading', true);
    show('coachText', false);
    show('coachSource', false);

    var wt = a.weakestTarget;
    var payload = {
      target_text: ex.target_text,
      overall_score: a.overall,
      accent: a.locale,
      focus: ex.focus,
      mispronounced_words: a.mispronouncedWords,
      phoneme_errors: a.phonemeErrors,
      weakest_target: wt ? { word: wt.word, phoneme: wt.phoneme, accuracy: wt.score } : null,
    };

    var tip;
    try {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 12000);
      var resp = await fetch(CONFIG.coachUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('coach_http_' + resp.status);
      tip = await resp.json();
      if (!tip || !tip.tip) throw new Error('coach_empty');
    } catch (e) {
      tip = { sound: (wt && wt.phoneme) || ex.focus[0] || '', tip: ex.cue, source: 'offline' };
    }
    if (seq !== state.coachSeq) return; // stale response
    renderCoach(tip, a);
  }

  /** One physical placement instruction, directly under the rating. */
  function renderCoach(tip, a) {
    $('coachSound').textContent = tip.sound ? '/' + String(tip.sound).replace(/^\/|\/$/g, '') + '/' : '';
    var text = tip.tip || '';
    // Library/offline tips are generic: anchor them to the word that slipped.
    var miss = a && a.status && a.status.misses[0];
    if (tip.source !== 'groq' && miss && miss.word && text.toLowerCase().indexOf(miss.word.toLowerCase()) === -1) {
      text = 'On ' + quoteWord(miss.word) + ': ' + lowerFirst(text);
    }
    $('coachTipText').textContent = text;
    var src = tip.source === 'groq'
      ? 'Personalised by your AI coach'
      : ({ fallback: 'Coaching library tip', offline: 'Exercise cue (coach offline)' })[tip.source] || '';
    $('coachSource').textContent = src;
    show('coachLoading', false);
    show('coachText', true);
    show('coachSource', !!src);
  }

  var MODEL_NAMES = {
    'openai/gpt-oss-120b': 'GPT-OSS 120B',
    'openai/gpt-oss-20b': 'GPT-OSS 20B',
  };

  /* -------------------------------------------------------------- */
  /* Text-to-speech (browser voice, free)                            */
  /* -------------------------------------------------------------- */
  /*
   * Voices load asynchronously: on first page load getVoices() is often [],
   * Chrome then fires `voiceschanged` (sometimes several times), and Safari may
   * never fire it at all. So the voice is never cached at start-up: it is
   * resolved from a fresh getVoices() list every time Listen is pressed, for
   * the accent currently selected in the dropdown.
   */
  var voiceCache = [];
  var voicesWaiters = [];

  function refreshVoices() {
    if (!window.speechSynthesis) return [];
    var list = window.speechSynthesis.getVoices() || [];
    if (list.length) {
      voiceCache = list;
      voicesWaiters.splice(0).forEach(function (fn) { fn(list); });
    }
    return voiceCache;
  }

  /** Resolves with the populated voice list (event, or polling for Safari), max ~2.5 s. */
  function whenVoicesReady() {
    var now = refreshVoices();
    if (now.length) return Promise.resolve(now);
    return new Promise(function (resolve) {
      var settled = false;
      function finish(list) { if (!settled) { settled = true; resolve(list || voiceCache); } }
      voicesWaiters.push(finish);
      var tries = 0;
      (function poll() {
        if (settled) return;
        if (refreshVoices().length || ++tries > 25) return finish(voiceCache);
        setTimeout(poll, 100);
      })();
    });
  }

  function normLang(lang) {
    return String(lang || '').replace('_', '-').toLowerCase();
  }

  // macOS ships joke/effect and "Eloquence" voices tagged en-US/en-GB; never use them as a model voice.
  var NOVELTY_VOICES = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
  var PREFERRED_VOICES = {
    'en-US': /samantha|google us english|microsoft (aria|jenny|guy)|ava|allison|natural|neural|premium|enhanced/i,
    'en-GB': /daniel|serena|kate|oliver|arthur|george|google uk english|microsoft (libby|sonia|ryan|george|hazel)|natural|neural|premium|enhanced/i,
  };
  var BRITISH_NAME = /\b(uk|united kingdom|british|england|daniel|oliver|arthur|george|kate|serena|libby|sonia|ryan|hazel)\b/i;

  /**
   * Best system voice for a target locale:
   *   1. exact locale (en-GB / en_GB), best-ranked by name;
   *   2. locale prefix (e.g. "en-GB-oxendict");
   *   3. British voices whose lang tag is missing or generic, matched by name.
   * Returns null when nothing matches — the caller then falls back to lang only.
   */
  function getSelectedVoice(targetLocale, voices) {
    voices = voices || voiceCache;
    if (!voices || !voices.length) return null;
    var want = normLang(targetLocale);
    function rank(v) {
      var score = 0;
      if (PREFERRED_VOICES[targetLocale] && PREFERRED_VOICES[targetLocale].test(v.name)) score += 100;
      if (NOVELTY_VOICES.test(v.name)) score -= 1000;
      if (v.localService) score += 5;
      if (v.default) score += 3;
      return score;
    }
    function best(list) {
      return list.slice().sort(function (x, y) { return rank(y) - rank(x); })[0] || null;
    }
    var exact = voices.filter(function (v) { return normLang(v.lang) === want; });
    var matched = best(exact.filter(function (v) { return !NOVELTY_VOICES.test(v.name); })) || best(exact);
    if (!matched) matched = best(voices.filter(function (v) { return normLang(v.lang).indexOf(want) === 0; }));
    if (!matched && want === 'en-gb') {
      matched = best(voices.filter(function (v) {
        var l = normLang(v.lang);
        return (!l || l === 'en' || l.indexOf('en') === 0) && BRITISH_NAME.test(v.name) && !NOVELTY_VOICES.test(v.name);
      }));
    }
    return matched || null;
  }

  /** The accent to use right now: the dropdown is the source of truth. */
  function selectedLocale() {
    var sel = $('accentSelect');
    var v = sel && sel.value;
    return ACCENTS[v] ? v : state.locale;
  }

  function isBritishVoice(v) {
    return !!v && (normLang(v.lang) === 'en-gb' || (normLang(v.lang).indexOf('en-gb') === 0) || BRITISH_NAME.test(v.name));
  }

  function updateVoiceHint() {
    var hint = $('voiceHint');
    if (!hint) return;
    var locale = selectedLocale();
    // Primary voice is Azure neural; the browser voice is only the offline fallback.
    var v = window.speechSynthesis ? getSelectedVoice(locale, refreshVoices()) : null;
    var ok = !!v && (locale === 'en-GB' ? isBritishVoice(v) : normLang(v.lang) === 'en-us');
    hint.textContent = 'Model voice: ' + NEURAL_VOICES[locale].label + ' (' + locale + ', Azure neural)'
      + (ok ? ' · offline fallback: ' + v.name : '');
  }

  /** Kept for callers: refresh the hint for the current accent. */
  function pickVoice() { updateVoiceHint(); }

  function setAccent(locale) {
    if (!ACCENTS[locale]) return;
    if (state.phase !== 'idle') { $('accentSelect').value = state.locale; return; }
    if (locale === state.locale) return;
    state.locale = locale;
    $('accentSelect').value = locale;
    try { window.localStorage.setItem(ACCENT_STORAGE_KEY, locale); } catch (_) { /* ignore */ }
    pickVoice();
    onBenchmarkChanged();
  }

  /**
   * A visible result belongs to the benchmark it was scored with. When the accent
   * changes, re-score the same recording against the new benchmark; if there is
   * no recording to re-use, clear the stale result instead of leaving it on screen.
   */
  function onBenchmarkChanged() {
    var resultShown = !$('resultPanel').hidden && state.lastAnalysis;
    if (!resultShown) return;
    if (state.lastAnalysis.locale === state.locale) return;
    var lr = state.lastRecording;
    if (lr && lr.wav && lr.exercise === current()) {
      rescoreLastRecording();
      return;
    }
    state.lastAnalysis = null;
    state.coachSeq++;
    show('resultPanel', false);
    show('coachTip', false);
    show('actions', false);
    show('skipBtn', true);
    setPhase('idle', 'Accent changed to ' + ACCENTS[state.locale].label + ' — record again to be scored against it.');
  }

  async function rescoreLastRecording() {
    var ex = current();
    var lr = state.lastRecording;
    var locale = state.locale;
    setPhase('analyzing', 'Re-scoring your last recording as ' + ACCENTS[locale].label + '…');
    var SDK, tok;
    try {
      SDK = await waitForSdk();
      tok = await getToken();
    } catch (e) {
      setPhase('idle', 'Could not re-score — record again.');
      return;
    }
    var segments = [];
    var recognizer;
    try {
      recognizer = createAssessmentRecognizer(SDK, tok, ex, locale,
        SDK.AudioConfig.fromWavFileInput(new File([lr.wav], 'attempt.wav', { type: 'audio/wav' })));
    } catch (e) {
      console.error(e);
      setPhase('idle', 'Could not re-score — record again.');
      return;
    }
    await new Promise(function (resolve) {
      var finished = false;
      function done() { if (finished) return; finished = true; resolve(); }
      recognizer.recognized = function (_s, e) {
        if (e.result.reason !== SDK.ResultReason.RecognizedSpeech) return;
        try { segments.push(JSON.parse(e.result.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult))); } catch (_) { /* skip */ }
      };
      recognizer.canceled = function (_s, e) {
        if (e.reason === SDK.CancellationReason.Error) console.error('[speech] re-score canceled:', e.errorCode, e.errorDetails);
        done();
      };
      recognizer.sessionStopped = done;
      recognizer.startContinuousRecognitionAsync(function () {}, done);
      setTimeout(done, 20000);
    });
    try { recognizer.stopContinuousRecognitionAsync(function () { recognizer.close(); }, function () { recognizer.close(); }); } catch (_) { /* ignore */ }

    // The learner may have moved on or switched again while this ran: leave
    // whatever is on screen now alone.
    if (ex !== current() || locale !== state.locale || state.phase !== 'analyzing' || state.rec) return;
    var analysis = S.analyzeAttempt(segments, ex.target_text, { focus: ex.focus, targetWords: ex.target_words });
    if (!analysis.recognized) { setPhase('idle', 'Could not re-score that recording — record again.'); return; }
    analysis.locale = locale;
    analysis.rescored = true;
    analysis.status = S.feedbackStatus(analysis);
    state.lastAnalysis = analysis;
    renderResult(analysis);
    renderCompare(ex, analysis, lr.wav);
    if (analysis.needsCoaching || analysis.status.key !== 'spot_on') requestCoach(ex, analysis); else show('coachTip', false);
    setPhase('idle', 'Re-scored the same recording as ' + ACCENTS[locale].label + '. Tap the mic to record again.');
  }

  /* -------------------------------------------------------------- */
  /* Raw audio capture (kept so a recording can be re-scored)        */
  /* -------------------------------------------------------------- */
  var CAPTURE_RATE = 16000;
  var CAPTURE_MAX_SECONDS = 60; // the diagnostic paragraph takes ~20–40 s

  /** Records the mic in parallel with the SDK and returns a 16 kHz mono WAV on stop(). */
  function startPcmCapture() {
    var chunks = [];
    var total = 0;
    var stream, ctx, source, node, inputRate;
    var ready = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }).then(function (s) {
      stream = s;
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      inputRate = ctx.sampleRate;
      source = ctx.createMediaStreamSource(s);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = function (e) {
        if (total > inputRate * CAPTURE_MAX_SECONDS) return;
        var data = new Float32Array(e.inputBuffer.getChannelData(0));
        chunks.push(data);
        total += data.length;
      };
      source.connect(node);
      node.connect(ctx.destination); // outputs silence; needed for onaudioprocess to fire
    });
    var stopped = null;
    return {
      stop: function () {
        if (stopped) return stopped;
        stopped = ready.then(function () {
          try { source.disconnect(); node.disconnect(); } catch (_) { /* ignore */ }
          stream.getTracks().forEach(function (t) { t.stop(); });
          try { ctx.close(); } catch (_) { /* ignore */ }
          return total ? encodeWav(chunks, total, inputRate) : null;
        }).catch(function () { return null; });
        return stopped;
      },
    };
  }

  function encodeWav(chunks, total, inputRate) {
    var flat = new Float32Array(total);
    var off = 0;
    chunks.forEach(function (c) { flat.set(c, off); off += c.length; });
    // Downsample by averaging to 16 kHz (the rate Azure Speech expects).
    var ratio = inputRate / CAPTURE_RATE;
    var outLen = Math.floor(total / ratio);
    var pcm = new Int16Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var start = Math.floor(i * ratio), end = Math.min(total, Math.floor((i + 1) * ratio));
      var sum = 0;
      for (var j = start; j < end; j++) sum += flat[j];
      var v = end > start ? sum / (end - start) : 0;
      v = Math.max(-1, Math.min(1, v));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    var buf = new ArrayBuffer(44 + pcm.length * 2);
    var dv = new DataView(buf);
    function str(o, t) { for (var k = 0; k < t.length; k++) dv.setUint8(o + k, t.charCodeAt(k)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, CAPTURE_RATE, true); dv.setUint32(28, CAPTURE_RATE * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }
  /*
   * Model audio.
   *
   * Primary: Azure neural text-to-speech with an explicit accent voice
   * (en-US-JennyNeural / en-GB-SoniaNeural), using the same 10-minute token as
   * scoring. The accent is fixed by the voice name, so it can't silently fall
   * back to an American system voice, and it sounds the same on every device.
   * Fallback (offline, token error, autoplay blocked): the browser's own voice,
   * resolved at click time for the selected accent.
   */
  var NEURAL_VOICES = {
    'en-US': { name: 'en-US-JennyNeural', label: 'Jenny' },
    'en-GB': { name: 'en-GB-SoniaNeural', label: 'Sonia' },
  };
  var ttsCache = {}; // "locale|text" -> { url, data (MP3 ArrayBuffer), boundaries [{ text, start, end }] }
  var ttsAudio = null;
  var ttsSeq = 0;

  function escapeXml(t) {
    return String(t).replace(/[<>&'"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c];
    });
  }

  function synthesizeNeural(text, locale) {
    var key = locale + '|' + text;
    if (ttsCache[key]) return Promise.resolve(ttsCache[key]);
    return Promise.all([waitForSdk(), getToken()]).then(function (r) {
      var SDK = r[0], tok = r[1];
      var voiceName = NEURAL_VOICES[locale].name;
      var cfg = SDK.SpeechConfig.fromAuthorizationToken(tok.token, tok.region);
      cfg.speechSynthesisVoiceName = voiceName;
      cfg.speechSynthesisOutputFormat = SDK.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
      var synth = new SDK.SpeechSynthesizer(cfg, null); // null → return audio, don't auto-play
      var boundaries = [];
      synth.wordBoundary = function (_s, e) {
        // audioOffset/duration are in 100-ns ticks; keep spoken words only (no punctuation).
        if (!e || !/[A-Za-z]/.test(e.text || '')) return;
        var start = Number(e.audioOffset) / 1e7;
        var dur = Number(e.duration) / 1e7;
        if (!isFinite(start)) return;
        boundaries.push({ text: e.text, start: start, end: isFinite(dur) && dur > 0 && dur < 5 ? start + dur : start + 0.35 });
      };
      var ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + locale + "'>"
        + "<voice name='" + voiceName + "'><prosody rate='-8%'>" + escapeXml(text) + '</prosody></voice></speak>';
      return new Promise(function (resolve, reject) {
        synth.speakSsmlAsync(ssml, function (result) {
          synth.close();
          if (result && result.audioData && result.audioData.byteLength) {
            var url = URL.createObjectURL(new Blob([result.audioData], { type: 'audio/mpeg' }));
            ttsCache[key] = { url: url, data: result.audioData, boundaries: boundaries };
            resolve(ttsCache[key]);
          } else {
            reject(new Error((result && result.errorDetails) || 'tts_failed'));
          }
        }, function (err) { synth.close(); reject(new Error(String(err))); });
      });
    });
  }

  function stopModelAudio() {
    stopCompare();
    ttsSeq++;
    if (ttsAudio) { try { ttsAudio.pause(); } catch (_) { /* ignore */ } }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (_) { /* ignore */ } }
  }

  function speak(text) {
    if (!text) return;
    if (state.phase === 'recording') return; // never talk over the mic
    var locale = selectedLocale();
    stopModelAudio();
    var seq = ttsSeq;
    if (!ttsAudio) ttsAudio = new Audio();
    var audio = ttsAudio;
    synthesizeNeural(text, locale).then(function (tts) {
      if (seq !== ttsSeq) return; // a newer Listen click won
      audio.src = tts.url;
      state.lastVoice = { engine: 'azure', name: NEURAL_VOICES[locale].name, locale: locale };
      if (window.console && console.info) console.info('[tts] ' + locale + ' → Azure ' + NEURAL_VOICES[locale].name);
      return audio.play();
    }).catch(function (err) {
      if (seq !== ttsSeq) return;
      console.warn('[tts] Azure voice unavailable, using browser voice:', err && err.message);
      speakWithBrowser(text, locale);
    });
  }

  /** Fallback: browser voice for the selected accent, resolved at click time. */
  function speakWithBrowser(text, locale) {
    if (!window.speechSynthesis) return;
    var synth = window.speechSynthesis;
    var voices = refreshVoices();
    if (voices.length) utter(getSelectedVoice(locale, voices));
    else whenVoicesReady().then(function (list) { utter(getSelectedVoice(locale, list)); });

    function utter(v) {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 0.88;
      if (v) {
        u.voice = v;
        u.lang = v.lang ? String(v.lang).replace('_', '-') : locale;
      } else {
        u.lang = locale;
      }
      if (window.console && console.info) console.info('[tts] ' + locale + ' → browser', v ? v.name + ' (' + v.lang + ')' : 'no matching voice, lang only');
      state.lastVoice = { engine: 'browser', name: v ? v.name : null, lang: v ? v.lang : locale, locale: locale };
      // Chrome can drop or mis-voice an utterance queued in the same tick as cancel().
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(function () { synth.speak(u); }, 80);
      } else {
        synth.speak(u);
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* Session history, summary & CSV                                  */
  /* -------------------------------------------------------------- */
  function logAttempt(ex, a) {
    state.attempts.push({
      timestamp: new Date().toISOString(),
      exercise_id: ex.id,
      target_text: ex.target_text,
      overall_score: a.overall,
      star_rating: a.stars,
      fluency_score: a.fluency,
      prosody_score: a.prosody,
      mispronounced_words: a.mispronouncedWords,
      phoneme_errors: a.phonemeErrors,
      target_phoneme_score: a.targetScore,
      accent: a.locale,
      status: a.status ? a.status.key : null,
    });
    state.practised[ex.id] = true;
  }

  function downloadCsv() {
    if (!state.attempts.length) return;
    // BOM so Excel opens UTF-8 (IPA symbols) correctly.
    var blob = new Blob(['﻿' + S.toCsv(state.attempts)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    a.href = url;
    a.download = 'accent-coach-session-' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    state.exportedCount = state.attempts.length;
  }

  /* -------------------------------------------------------------- */
  /* Events                                                          */
  /* -------------------------------------------------------------- */
  function bindEvents() {
    $('recordBtn').addEventListener('click', onRecordClick);
    $('accentSelect').value = state.locale;
    $('accentSelect').addEventListener('change', function (e) { setAccent(e.target.value); });
    $('listenBtn').addEventListener('click', function () { var ex = current(); if (ex) speak(ex.target_text); });
    $('nextBtn').addEventListener('click', goNext);
    $('retryBtn').addEventListener('click', retry);
    $('skipBtn').addEventListener('click', function () {
      if (state.phase !== 'idle') return;
      if (state.view === 'diagnostic') skipDiagnostic(); else goNext();
    });
    $('retakeBtn').addEventListener('click', retakeDiagnostic);
    $('takeDiagnosticBtn').addEventListener('click', retakeDiagnostic);
    $('planBtn').addEventListener('click', function () { if (state.phase === 'idle') showPlan(); });
    $('startSessionBtn').addEventListener('click', startSession);
    $('practiceAgainBtn').addEventListener('click', startSession);
    $('backToTopicsBtn').addEventListener('click', showPlan);
    $('playModelBtn').addEventListener('click', function () { playTrack('model'); });
    $('playLearnerBtn').addEventListener('click', function () { playTrack('learner'); });
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (!$('resultPanel').hidden) { redrawTrack('model'); redrawTrack('learner'); } }, 150);
    });
    $('finishBtn').addEventListener('click', finishSession);
    $('downloadCsvBtn').addEventListener('click', downloadCsv);

    if (window.speechSynthesis) {
      var onVoices = function () { refreshVoices(); updateVoiceHint(); };
      if (window.speechSynthesis.addEventListener) window.speechSynthesis.addEventListener('voiceschanged', onVoices);
      else window.speechSynthesis.onvoiceschanged = onVoices;
      whenVoicesReady().then(onVoices); // Safari may never fire voiceschanged
      updateVoiceHint();
    }

    window.addEventListener('beforeunload', function (e) {
      if (state.attempts.length > state.exportedCount) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
