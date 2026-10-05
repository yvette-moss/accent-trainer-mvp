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

  /* -------------------------------------------------------------- */
  /* Config                                                          */
  /* -------------------------------------------------------------- */
  var CONFIG = {
    contentUrl: '/data/phrases.json',
    tokenUrl: '/api/speech-token',
    coachUrl: '/api/coach',
    tokenRefreshMarginMs: 60 * 1000,
    maxRecordMs: { word: 7000, phrase: 20000, contrast: 20000 },
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
    exercises: [],
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

    if (!S) {
      notice('error', 'The scoring module failed to load. Please refresh the page.');
      return;
    }

    try {
      var resp = await fetch(CONFIG.contentUrl, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      state.content = await resp.json();
      state.exercises = state.content.exercises || [];
      (state.content.sections || []).forEach(function (s) { state.sections[s.id] = s; });
      if (!state.exercises.length) throw new Error('empty');
    } catch (e) {
      notice('error', 'Could not load the exercise library. Please refresh the page.');
      $('progressText').textContent = 'Exercises unavailable';
      $('recordBtn').disabled = true;
      return;
    }

    renderExercise();

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
  function current() { return state.exercises[state.index]; }

  function renderExercise() {
    var ex = current();
    var total = state.exercises.length;
    $('progressText').textContent = 'Exercise ' + (state.index + 1) + ' of ' + total;
    var pct = Math.round((state.index / total) * 100);
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', String(pct));

    var section = state.sections[ex.section];
    $('sectionBadge').textContent = section ? section.label : ex.type;

    var chips = $('focusChips');
    chips.textContent = '';
    ex.focus.forEach(function (f) {
      chips.appendChild(el('span', 'ipa text-sm px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 ring-1 ring-slate-200', '/' + f + '/'));
    });
    if (ex.position) chips.appendChild(el('span', 'text-xs text-slate-500', ex.position + ' position'));
    if (ex.contrast) chips.appendChild(el('span', 'text-xs text-slate-500', ex.contrast[0] + ' ↔ ' + ex.contrast[1]));

    $('targetText').textContent = ex.target_text;
    $('cueText').textContent = ex.cue || '';

    show('resultPanel', false);
    show('coachTip', false);
    show('actions', false);
    show('skipBtn', true);
    $('nextBtn').textContent = state.index === total - 1 ? 'Finish & Export' : 'Next Phrase →';
    setPhase('idle');
    state.lastAnalysis = null;
    state.lastRecording = null;
    state.coachSeq++; // invalidate any in-flight coach request
  }

  function goNext() {
    if (state.index >= state.exercises.length - 1) { openSummary(); return; }
    state.index++;
    renderExercise();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function retry() {
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
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) { /* ignore */ }
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
        rec.capture.stop().then(function (wav) {
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

    state.lastAnalysis = analysis;
    logAttempt(ex, analysis);
    renderResult(analysis);
    setPhase('idle', 'Tap the mic to record again.');
    show('actions', true);
    show('skipBtn', false);

    if (analysis.needsCoaching) requestCoach(ex, analysis);
    else show('coachTip', false);

    setTimeout(function () { $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  }

  var CHIP_STYLES = {
    green: 'ring-1 bg-emerald-50 text-emerald-800 ring-emerald-200',
    amber: 'ring-1 bg-amber-50 text-amber-800 ring-amber-300 hover:-translate-y-0.5 cursor-pointer',
    red: 'ring-1 bg-rose-50 text-rose-800 ring-rose-300 hover:-translate-y-0.5 cursor-pointer',
    target: 'bg-rose-100 text-rose-900 ring-2 ring-rose-500 hover:-translate-y-0.5 cursor-pointer',
  };

  function renderResult(a) {
    show('resultPanel', true);
    var stars = '';
    for (var i = 1; i <= 3; i++) stars += i <= a.stars ? '★' : '☆';
    var starRow = $('starRow');
    starRow.textContent = stars;
    starRow.className = 'text-3xl tracking-wider ' + ({ green: 'text-emerald-500', amber: 'text-amber-500', red: 'text-rose-500' })[a.tone];
    $('starLabel').textContent = a.label;
    $('starLabel').className = 'mt-1 font-semibold ' + ({ green: 'text-emerald-700', amber: 'text-amber-700', red: 'text-rose-700' })[a.tone];
    $('overallScore').textContent = a.overall;
    $('resultPanel').setAttribute('aria-label', a.stars + ' of 3 stars, score ' + a.overall + '. ' + a.label);
    $('benchmarkBadge').textContent = 'scored as ' + (FLAGS[a.locale] || '') + ' ' + (ACCENTS[a.locale] ? ACCENTS[a.locale].short : a.locale);
    renderCapReason(a);
    renderTargetStrip(a);

    var wrap = $('wordChips');
    wrap.textContent = '';
    $('chipDetail').hidden = true;
    a.words.forEach(function (w) {
      var interactive = w.band !== 'green' || w.errorType !== 'None' || w.targetFailed;
      var style = w.targetFailed ? CHIP_STYLES.target : CHIP_STYLES[w.band];
      var chip = el(interactive ? 'button' : 'span',
        'chip relative px-3 py-1.5 rounded-lg text-base font-medium ' + style);
      chip.textContent = w.display;
      if (w.targetFailed) {
        chip.appendChild(el('span', 'absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full bg-rose-600 ring-2 ring-white', ''));
      }
      chip.title = (w.targetFailed ? 'Target sound failed · ' : '')
        + (w.errorType === 'None' ? 'Score ' + w.score : w.errorType + ' · score ' + w.score);
      if (interactive) {
        chip.type = 'button';
        chip.setAttribute('aria-pressed', 'false');
        chip.setAttribute('aria-label', w.display + ', score ' + w.score + '. Show details.');
        chip.addEventListener('click', function () { toggleChipDetail(chip, w); });
      }
      wrap.appendChild(chip);
    });
    a.insertions.forEach(function (iw) {
      var extra = el('span', 'px-3 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-400 text-base line-through', iw);
      extra.title = 'Extra word — not in the target text';
      wrap.appendChild(extra);
    });

    setBar('fluency', a.fluency);
    setBar('prosody', a.prosody, ACCENTS[a.locale] && !ACCENTS[a.locale].prosody ? 'n/a for en-GB' : null);
  }

  function phonemeName(t) {
    return t.phoneme ? '/' + t.phoneme + '/' : 'word';
  }

  /** One line under the label explaining WHY the rating was capped at ★☆☆. */
  function renderCapReason(a) {
    var box = $('capReason');
    var f = a.targetFailures && a.targetFailures[0];
    if (!a.capped || !f) { box.hidden = true; box.textContent = ''; return; }
    var why;
    if (f.reason === 'omitted') why = '"' + f.word + '" was skipped';
    else if (f.reason === 'replaced') why = '"' + f.word + '" was heard as "' + f.heardAs + '"';
    else if (f.reason === 'heard_as') why = phonemeName(f) + ' in "' + f.word + '" was heard as /' + f.produced + '/ (' + f.score + ')';
    else why = phonemeName(f) + ' in "' + f.word + '" scored ' + f.score;
    var more = a.targetFailures.length > 1 ? ' (+' + (a.targetFailures.length - 1) + ' more)' : '';
    box.textContent = 'Capped at ★☆☆: ' + why + more + '. Target sounds must reach ' + S.THRESHOLDS.targetFail + '.';
    box.hidden = false;
  }

  /** Every target-sound check for this exercise, pass/fail at a glance. */
  function renderTargetStrip(a) {
    var strip = $('targetStrip');
    strip.textContent = '';
    $('targetLevelNote').textContent = a.targetLevel === 'word'
      ? (a.locale === 'en-GB'
        ? '— word level: Azure\u2019s British model doesn\u2019t score individual sounds and is lenient'
        : '— checked at word level (Azure returned no phoneme names)')
      : a.targetScore === null ? '' : '— weakest ' + a.targetScore + ' · ★★★ needs ' + S.THRESHOLDS.threeStarTarget;
    (a.targets || []).forEach(function (t) {
      var tone = t.failed ? 'bg-rose-50 text-rose-800 ring-rose-300'
        : t.score < S.THRESHOLDS.threeStarTarget ? 'bg-amber-50 text-amber-800 ring-amber-300'
          : 'bg-emerald-50 text-emerald-800 ring-emerald-200';
      var item = el('span', 'inline-flex items-center gap-1.5 px-2 py-1 rounded-md ring-1 ' + tone);
      item.appendChild(el('span', 'font-medium', t.word));
      item.appendChild(el('span', 'ipa', phonemeName(t)));
      var verdict = t.reason === 'omitted' ? 'skipped'
        : t.reason === 'replaced' ? 'replaced'
          : t.reason === 'heard_as' ? '→ /' + t.produced + '/ ' + t.score
            : String(t.score);
      item.appendChild(el('span', 'tabular-nums text-xs opacity-80', verdict));
      strip.appendChild(item);
    });
    if (!(a.targets || []).length) strip.appendChild(el('span', 'text-xs text-slate-400', 'No target-sound data for this attempt.'));
  }

  function setBar(name, value, naLabel) {
    var has = value !== null && value !== undefined;
    $(name + 'Val').textContent = has ? value : (naLabel || 'n/a');
    $(name + 'Bar').style.width = (has ? value : 0) + '%';
  }

  function toggleChipDetail(chip, w) {
    var box = $('chipDetail');
    var wasOpen = chip.getAttribute('aria-pressed') === 'true';
    Array.prototype.forEach.call($('wordChips').querySelectorAll('button.chip'), function (b) { b.setAttribute('aria-pressed', 'false'); });
    if (wasOpen) { box.hidden = true; return; }
    chip.setAttribute('aria-pressed', 'true');
    box.textContent = '';

    var head = el('div', 'flex items-center justify-between gap-3');
    head.appendChild(el('p', 'font-semibold text-slate-800', w.display.replace(/^[^\w']+|[^\w']+$/g, '')));
    var speakBtn = el('button', 'text-xs px-2 py-1 rounded-md bg-white ring-1 ring-slate-200 hover:bg-slate-100', '▶ Hear it');
    speakBtn.type = 'button';
    speakBtn.addEventListener('click', function () { speak(w.display.replace(/[^\w'\- ]/g, '')); });
    head.appendChild(speakBtn);
    box.appendChild(head);

    if (w.targetFailed && !w.drifts.length && w.errorType !== 'Omission' && w.errorType !== 'Substitution') {
      box.appendChild(el('p', 'mt-2 text-rose-700', 'The target sound in this word scored below ' + S.THRESHOLDS.targetFail + '.'));
    }
    if (w.errorType === 'Omission') {
      box.appendChild(el('p', 'mt-2 text-rose-700', 'This word was skipped. Say every word, even the small ones.'));
    } else if (w.errorType === 'Substitution') {
      box.appendChild(el('p', 'mt-2 text-rose-700', 'Heard as "' + w.heardAs + '" — a different word. Slow down and aim for the target sounds below.'));
    }

    if (w.phonemes.length) {
      var row = el('div', 'mt-3 flex flex-wrap gap-1.5');
      w.phonemes.forEach(function (p) {
        var band = S.bandFor(p.score);
        var cls = { green: 'bg-emerald-100 text-emerald-900', amber: 'bg-amber-100 text-amber-900', red: 'bg-rose-100 text-rose-900' }[band];
        var cell = el('span', 'ipa inline-flex flex-col items-center min-w-[2.25rem] px-1.5 py-1 rounded-md ' + cls
          + (p.isTarget ? ' ring-2 ' + (p.targetFailed ? 'ring-rose-500' : 'ring-emerald-500') : ''));
        if (p.isTarget) cell.title = 'Target sound';
        cell.appendChild(el('span', 'text-base leading-none', p.phoneme || '·'));
        cell.appendChild(el('span', 'text-[10px] opacity-70 mt-0.5 tabular-nums', String(p.score)));
        row.appendChild(cell);
      });
      box.appendChild(row);
    }

    if (w.drifts.length) {
      var list = el('ul', 'mt-3 space-y-1');
      w.drifts.forEach(function (d) {
        var li = el('li', 'text-slate-700');
        if (d.isTarget) li.appendChild(el('span', 'mr-1 text-[10px] font-semibold uppercase tracking-wide text-rose-600', 'target'));
        li.appendChild(document.createTextNode('Expected '));
        li.appendChild(el('span', 'ipa font-semibold text-emerald-700', '/' + d.phoneme + '/'));
        li.appendChild(document.createTextNode(d.produced ? ' → heard ' : ' → '));
        li.appendChild(el('span', 'ipa font-semibold text-rose-700', d.produced ? '/' + d.produced + '/' : 'distorted'));
        li.appendChild(el('span', 'text-xs text-slate-400', '  (' + d.score + '/100)'));
        list.appendChild(li);
      });
      box.appendChild(list);
    } else if (w.errorType === 'None' || w.errorType === 'Mispronunciation') {
      box.appendChild(el('p', 'mt-2 text-slate-600', 'No single sound stood out — try saying it a little slower and clearer.'));
    }
    box.hidden = false;
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
    renderCoach(tip);
  }

  /** One physical placement instruction, directly under the rating. */
  function renderCoach(tip) {
    $('coachSound').textContent = tip.sound ? '/' + String(tip.sound).replace(/^\/|\/$/g, '') + '/' : '';
    $('coachTipText').textContent = tip.tip || '';
    var src = tip.source === 'groq'
      ? 'Personalised by ' + (tip.model ? MODEL_NAMES[tip.model] || tip.model : 'AI') + ' on Groq'
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
  var voice = null;
  var voiceMatchesAccent = false;
  var PREFERRED_VOICES = {
    'en-US': /natural|neural|premium|enhanced|samantha|google us/i,
    'en-GB': /natural|neural|premium|enhanced|daniel|serena|kate|google uk/i,
  };
  function sameLocale(v, locale) {
    return String(v.lang || '').replace('_', '-').toLowerCase() === locale.toLowerCase();
  }
  /** Pick a system voice for the active target accent (en-US or en-GB). */
  function pickVoice() {
    if (!window.speechSynthesis) return;
    var locale = state.locale;
    var voices = window.speechSynthesis.getVoices() || [];
    var exact = voices.filter(function (v) { return sameLocale(v, locale); });
    voice = exact.find(function (v) { return PREFERRED_VOICES[locale].test(v.name); })
      || exact[0]
      || voices.find(function (v) { return /^en/i.test(v.lang); })
      || null;
    voiceMatchesAccent = !!voice && sameLocale(voice, locale);
    var hint = $('voiceHint');
    if (hint) {
      hint.textContent = !voices.length ? "Model audio uses your browser's voice."
        : voiceMatchesAccent ? 'Model voice: ' + voice.name + ' (' + locale + ')'
          : 'No ' + ACCENTS[locale].label + ' voice installed — using ' + (voice ? voice.name : 'the default voice') + '.';
    }
  }

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
    state.lastAnalysis = analysis;
    renderResult(analysis);
    if (analysis.needsCoaching) requestCoach(ex, analysis); else show('coachTip', false);
    setPhase('idle', 'Re-scored the same recording as ' + ACCENTS[locale].label + '. Tap the mic to record again.');
  }

  /* -------------------------------------------------------------- */
  /* Raw audio capture (kept so a recording can be re-scored)        */
  /* -------------------------------------------------------------- */
  var CAPTURE_RATE = 16000;
  var CAPTURE_MAX_SECONDS = 30;

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
  function speak(text) {
    if (!window.speechSynthesis || !text) return;
    if (state.phase === 'recording') return; // never talk over the mic
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = state.locale;
    u.rate = 0.88;
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
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
    });
  }

  function openSummary() {
    var attempts = state.attempts;
    var unique = {};
    attempts.forEach(function (a) { unique[a.exercise_id] = true; });
    var completed = Object.keys(unique).length;
    var avg = attempts.length
      ? attempts.reduce(function (s, a) { return s + a.star_rating; }, 0) / attempts.length
      : null;

    $('sumCompleted').textContent = completed;
    $('sumAttempts').textContent = attempts.length;
    $('sumStars').textContent = avg === null ? '–' : avg.toFixed(1) + '★';
    $('summarySubtitle').textContent = attempts.length
      ? completed + ' of ' + state.exercises.length + ' exercises practised this session.'
      : 'No attempts yet — record a phrase to start tracking progress.';

    var list = $('sumTrouble');
    list.textContent = '';
    var trouble = S.topTroubleSounds(attempts, 2);
    if (!trouble.length) {
      list.appendChild(el('li', 'text-slate-500', attempts.length ? 'No recurring sound drifts — excellent work.' : '—'));
    } else {
      trouble.forEach(function (t) {
        var li = el('li', 'flex items-center gap-3 rounded-lg bg-rose-50 px-3 py-2');
        li.appendChild(el('span', 'ipa text-xl font-semibold text-rose-700 w-10 text-center', '/' + t.phoneme + '/'));
        var txt = el('span', 'text-slate-700');
        txt.appendChild(el('span', 'font-medium', t.count + ' drift' + (t.count === 1 ? '' : 's')));
        txt.appendChild(document.createTextNode(' · ' + t.words.slice(0, 4).join(', ')));
        li.appendChild(txt);
        list.appendChild(li);
      });
    }

    $('downloadCsvBtn').disabled = !attempts.length;
    var dlg = $('summaryDialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeSummary() {
    var dlg = $('summaryDialog');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
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

  function restart() {
    if (state.attempts.length > state.exportedCount &&
        !window.confirm('Start over? Attempts you have not exported will be cleared.')) return;
    state.attempts = [];
    state.exportedCount = 0;
    state.index = 0;
    closeSummary();
    renderExercise();
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
    $('skipBtn').addEventListener('click', function () { if (state.phase === 'idle') goNext(); });
    $('finishBtn').addEventListener('click', openSummary);
    $('downloadCsvBtn').addEventListener('click', downloadCsv);
    $('closeSummaryBtn').addEventListener('click', closeSummary);
    $('restartBtn').addEventListener('click', restart);

    if (window.speechSynthesis) {
      pickVoice();
      window.speechSynthesis.onvoiceschanged = pickVoice;
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
