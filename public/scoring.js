/**
 * scoring.js — pure analysis layer (no DOM, no network, no SDK).
 *
 * Input:  the raw JSON segments returned by Azure Pronunciation Assessment
 *         (one per `recognized` event) + the reference text.
 * Output: a single, UI-ready attempt analysis — star rating, colour-banded word
 *         chips, expected→produced phoneme drifts and a "needs coaching" flag.
 *
 * Because it is pure and UMD-wrapped, the exact same code runs in the browser
 * (window.AccentScoring) and in Node for the golden-dataset evals
 * (require('../public/scoring.js')). The evals therefore test what ships.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AccentScoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* -------------------------------------------------------------- */
  /* Thresholds                                                      */
  /* -------------------------------------------------------------- */

  /**
   * Strict, target-aware star rules. Azure's overall PronScore rewards
   * intelligibility, so a sentence can score 78 while every /θ/ comes out as /s/.
   * The exercise's TARGET sounds therefore gate the rating:
   *
   *   ★★★  overall ≥ 85 AND weakest target sound ≥ 80
   *   ★★☆  overall 65–84 (or ≥ 85 with a weakest target sound of 65–79)
   *   ★☆☆  overall < 65 OR any target-sound failure
   *
   * A target-sound failure is a target phoneme scoring < 65, a target phoneme
   * Azure heard as a different phoneme (substitution), or a target word that
   * was skipped (omission) or replaced by another word.
   */
  var THRESHOLDS = {
    threeStarOverall: 85,
    threeStarTarget: 80,
    twoStarOverall: 65,
    targetFail: 65,
    // Coaching status (the only result a learner sees): a target sound "passes"
    // at 80+ with no substitution/omission; "fluent" gates the middle status.
    targetPass: 80,
    fluent: 70,
  };
  var LABELS = {
    3: { label: 'Mastered! Clear & natural.', tone: 'green' },
    2: { label: 'Good effort! Minor accent drift.', tone: 'amber' },
    1: { label: 'Needs practice! Focus on tongue placement.', tone: 'red' },
  };
  var WORD_GREEN = 80;
  var WORD_AMBER = 60;
  /** Any phoneme scoring below this is reported as a drift (targets use THRESHOLDS.targetFail). */
  var PHONEME_DRIFT_THRESHOLD = 60;

  /**
   * Scores are rounded to an integer BEFORE banding so the number a learner sees
   * always agrees with the stars they get (84.5 → "85", never "85" + ★★☆ for that reason).
   */
  function roundScore(n) {
    if (n === null || n === undefined || n === '') return null;
    var x = Number(n);
    if (!isFinite(x)) return null;
    return Math.max(0, Math.min(100, Math.round(x)));
  }

  /**
   * @param {number} overall      sentence-level score
   * @param {number|null} targetScore  weakest target-sound score (null = no target data)
   * @param {number} targetFailures    count of target-sound failures
   */
  function starsFor(overall, targetScore, targetFailures) {
    var s = roundScore(overall);
    if (s === null) s = 0;
    var t = targetScore === null || targetScore === undefined ? null : roundScore(targetScore);
    var stars;
    if ((targetFailures || 0) > 0 || s < THRESHOLDS.twoStarOverall) stars = 1;
    else if (s >= THRESHOLDS.threeStarOverall && (t === null || t >= THRESHOLDS.threeStarTarget)) stars = 3;
    else stars = 2;
    return {
      score: s,
      stars: stars,
      label: LABELS[stars].label,
      tone: LABELS[stars].tone,
      capped: stars === 1 && (targetFailures || 0) > 0 && s >= THRESHOLDS.twoStarOverall,
    };
  }

  function bandFor(score) {
    var s = roundScore(score);
    if (s === null) return 'red';
    if (s >= WORD_GREEN) return 'green';
    if (s >= WORD_AMBER) return 'amber';
    return 'red';
  }

  /* -------------------------------------------------------------- */
  /* Reference tokenisation & alignment                              */
  /* -------------------------------------------------------------- */

  function normalizeWord(w) {
    return String(w || '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[^a-z0-9']/g, '');
  }

  /** Strip surrounding punctuation for display/export: "things." → "things". */
  function cleanWord(display) {
    return String(display || '').replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
  }

  /**
   * "I thought about thirty-three things." →
   *   [{display:'I', parts:['i']}, …, {display:'thirty-three', parts:['thirty','three']}, {display:'things.', …}]
   * Azure splits hyphenated words, so each display token may own several parts.
   */
  function tokenizeReference(text) {
    return String(text || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(function (display) {
        var parts = display.split(/[-–—]/).map(normalizeWord).filter(Boolean);
        return { display: display, parts: parts };
      })
      .filter(function (t) { return t.parts.length > 0; });
  }

  /** Longest-common-subsequence alignment of reference parts vs spoken words. */
  function lcsAlign(ref, spoken) {
    var n = ref.length, m = spoken.length, i, j;
    var dp = [];
    for (i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = ref[i] === spoken[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var pairs = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (ref[i] === spoken[j]) { pairs.push([i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  var FILLERS = { um: 1, uh: 1, er: 1, erm: 1, ah: 1, hmm: 1, mm: 1, uhm: 1 };
  var SUBSTITUTION_SIMILARITY = 0.4;

  function levenshtein(x, y) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= y.length; j++) prev[j] = j;
    for (i = 1; i <= x.length; i++) {
      cur = [i];
      for (j = 1; j <= y.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[y.length];
  }

  /** 1 = identical, 0 = nothing in common. "think"/"sink" → 0.6, "throbbing"/"um" → 0. */
  function similarity(x, y) {
    var len = Math.max(x.length, y.length);
    return len ? 1 - levenshtein(x, y) / len : 1;
  }

  /* -------------------------------------------------------------- */
  /* Azure JSON helpers                                              */
  /* -------------------------------------------------------------- */

  function bestOf(segment) {
    return segment && segment.NBest && segment.NBest[0] ? segment.NBest[0] : null;
  }

  function pa(obj) {
    return (obj && obj.PronunciationAssessment) || {};
  }

  function phonemeDetails(azWord) {
    return (azWord.Phonemes || []).map(function (p) {
      // Azure names phonemes only for some locales (IPA names: en-US). Unnamed
      // phonemes still carry an accuracy score but cannot be matched to a target.
      var expected = typeof p.Phoneme === 'string' && p.Phoneme ? p.Phoneme : null;
      var score = roundScore(pa(p).AccuracyScore);
      var cands = (pa(p).NBestPhonemes || []).slice().sort(function (a, b) { return b.Score - a.Score; });
      var produced = null;
      if (expected && cands.length && cands[0].Phoneme && cands[0].Phoneme !== expected) produced = cands[0].Phoneme;
      return { phoneme: expected, score: score, produced: produced };
    });
  }

  /* -------------------------------------------------------------- */
  /* Main analysis                                                   */
  /* -------------------------------------------------------------- */

  /**
   * @param {object[]} segments   raw Azure JSON results (SpeechServiceResponse_JsonResult)
   * @param {string}   referenceText
   * @param {object}   [options]
   * @param {string[]} [options.focus]        target sounds (IPA), e.g. ['θ', 'ð']
   * @param {string[]} [options.targetWords]  words whose target sounds gate the rating
   * @returns {object} analysis (see README → "Scoring model")
   */
  function analyzeAttempt(segments, referenceText, options) {
    options = options || {};
    var focusSet = {};
    (options.focus || []).forEach(function (f) { focusSet[f] = true; });
    var targetSet = {};
    (options.targetWords || []).forEach(function (t) { targetSet[normalizeWord(t)] = true; });
    var refTokens = tokenizeReference(referenceText);
    var best = (segments || []).map(bestOf).filter(Boolean);

    // Spoken words across all segments. Azure's own Omission entries are dropped:
    // omissions are recomputed against the full reference below, which also makes
    // multi-segment (continuous) recognition correct.
    var spoken = [];
    best.forEach(function (nb) {
      (nb.Words || []).forEach(function (w) {
        var et = pa(w).ErrorType || 'None';
        if (et === 'Omission') return;
        spoken.push({ raw: w, norm: normalizeWord(w.Word), errorType: et });
      });
    });

    if (!spoken.length) {
      return { recognized: false };
    }

    // Flatten reference parts.
    var refParts = [];
    refTokens.forEach(function (tok, ti) {
      tok.parts.forEach(function (p) { refParts.push({ norm: p, token: ti }); });
    });

    var pairs = lcsAlign(refParts.map(function (r) { return r.norm; }), spoken.map(function (s) { return s.norm; }));
    var refMatch = new Array(refParts.length).fill(-1);
    var spokenUsed = new Array(spoken.length).fill(false);
    pairs.forEach(function (p) { refMatch[p[0]] = p[1]; spokenUsed[p[1]] = true; });

    // Pair unmatched reference parts with unmatched spoken words that sit between
    // the same anchors → substitution ("think" heard as "sink"). Only plausible
    // look-alikes are paired; fillers ("um") and unrelated words stay insertions.
    var substitutions = {};
    var anchors = [[-1, -1]].concat(pairs, [[refParts.length, spoken.length]]);
    for (var a = 0; a < anchors.length - 1; a++) {
      var r = anchors[a][0] + 1, r1 = anchors[a + 1][0];
      var s = anchors[a][1] + 1, s1 = anchors[a + 1][1];
      while (r < r1 && s < s1) {
        if (FILLERS[spoken[s].norm]) { s++; continue; }
        if (similarity(refParts[r].norm, spoken[s].norm) >= SUBSTITUTION_SIMILARITY) {
          substitutions[r] = s;
          spokenUsed[s] = true;
          r++; s++;
        } else {
          r++;
        }
      }
    }

    // Build per-display-token results.
    var words = refTokens.map(function (tok) {
      return {
        display: tok.display, parts: [], score: null, errorType: 'None', heardAs: null, phonemes: [],
        isTarget: false, targetFailed: false,
        start: null, end: null, // seconds from the start of the audio (Azure Offset/Duration)
      };
    });

    // Target-sound checks: one entry per target phoneme (or per target word when
    // Azure returned no phoneme names, or the word was skipped/replaced).
    var targets = [];
    function addTarget(w, part, t) {
      t.word = cleanWord(w.display);
      t.wordIndex = words.indexOf(w);
      t.part = part;
      t.failed = !!t.reason || t.score === null || t.score < THRESHOLDS.targetFail;
      if (!t.reason && t.failed) t.reason = 'low_score';
      w.isTarget = true;
      if (t.failed) w.targetFailed = true;
      targets.push(t);
    }

    function addTiming(w, raw) {
      var off = Number(raw && raw.Offset), dur = Number(raw && raw.Duration);
      if (!isFinite(off) || !isFinite(dur) || dur <= 0) return;
      var a = off / 1e7, b = (off + dur) / 1e7;
      w.start = w.start === null ? a : Math.min(w.start, a);
      w.end = w.end === null ? b : Math.max(w.end, b);
    }

    refParts.forEach(function (rp, idx) {
      var w = words[rp.token];
      var si = refMatch[idx];
      if (si >= 0) addTiming(w, spoken[si].raw);
      else if (substitutions[idx] !== undefined) addTiming(w, spoken[substitutions[idx]].raw);
      var isTarget = !!targetSet[rp.norm];
      if (si >= 0) {
        var raw = spoken[si].raw;
        var sc = roundScore(pa(raw).AccuracyScore);
        w.parts.push({ score: sc === null ? 0 : sc, errorType: spoken[si].errorType });
        var phs = phonemeDetails(raw).map(function (p) { p.part = rp.norm; return p; });
        w.phonemes = w.phonemes.concat(phs);
        if (isTarget) {
          var focusPhs = phs.filter(function (p) { return p.phoneme && focusSet[p.phoneme]; });
          if (focusPhs.length) {
            focusPhs.forEach(function (p) {
              p.isTarget = true;
              var t = { level: 'phoneme', phoneme: p.phoneme, score: p.score, produced: p.produced };
              if (p.produced) t.reason = 'heard_as';
              addTarget(w, rp.norm, t);
              p.targetFailed = t.failed;
            });
          } else {
            // No named target phoneme (locale without phoneme names): gate on the word.
            addTarget(w, rp.norm, { level: 'word', phoneme: null, score: sc === null ? 0 : sc, produced: null });
          }
        }
      } else if (substitutions[idx] !== undefined) {
        w.parts.push({ score: 0, errorType: 'Substitution' });
        w.heardAs = (w.heardAs ? w.heardAs + ' ' : '') + spoken[substitutions[idx]].raw.Word;
        if (isTarget) addTarget(w, rp.norm, { level: 'word', phoneme: null, score: 0, produced: null, reason: 'replaced', heardAs: spoken[substitutions[idx]].raw.Word });
      } else {
        w.parts.push({ score: 0, errorType: 'Omission' });
        if (isTarget) addTarget(w, rp.norm, { level: 'word', phoneme: null, score: 0, produced: null, reason: 'omitted' });
      }
    });

    var severity = { None: 0, Mispronunciation: 1, UnexpectedBreak: 1, MissingBreak: 1, Monotone: 1, Substitution: 2, Omission: 3 };
    words.forEach(function (w) {
      w.score = Math.min.apply(null, w.parts.map(function (p) { return p.score; }));
      w.errorType = w.parts.reduce(function (acc, p) {
        return (severity[p.errorType] || 0) > (severity[acc] || 0) ? p.errorType : acc;
      }, 'None');
      w.band = bandFor(w.score);
      w.drifts = w.phonemes.filter(function (p) {
        return p.score !== null && (p.score < PHONEME_DRIFT_THRESHOLD || p.targetFailed);
      });
      delete w.parts;
    });

    var insertions = spoken
      .filter(function (s, i) { return !spokenUsed[i] && s.norm; })
      .map(function (s) { return s.raw.Word; });

    // ---- Aggregate scores ----
    var accuracy, fluency, prosody, completeness, overall;
    var matchedCount = refMatch.filter(function (x) { return x >= 0; }).length;
    if (best.length === 1) {
      var s = pa(best[0]);
      accuracy = roundScore(s.AccuracyScore);
      fluency = roundScore(s.FluencyScore);
      prosody = roundScore(s.ProsodyScore);
      completeness = roundScore(s.CompletenessScore);
      overall = roundScore(s.PronScore);
    } else {
      // Continuous mode: weight segment scores by word count, recompute the rest.
      var totalW = 0, fl = 0, pr = 0, prW = 0, acc = 0, accN = 0;
      best.forEach(function (nb) {
        var n = (nb.Words || []).filter(function (w) { return pa(w).ErrorType !== 'Omission'; }).length || 1;
        var ss = pa(nb);
        totalW += n;
        if (isFinite(ss.FluencyScore)) fl += ss.FluencyScore * n;
        if (isFinite(ss.ProsodyScore)) { pr += ss.ProsodyScore * n; prW += n; }
      });
      refMatch.forEach(function (si) {
        if (si >= 0) { acc += pa(spoken[si].raw).AccuracyScore || 0; accN++; }
      });
      accuracy = roundScore(accN ? acc / accN : 0);
      fluency = roundScore(totalW ? fl / totalW : null);
      prosody = prW ? roundScore(pr / prW) : null;
      overall = null;
    }
    if (completeness === null || completeness === undefined) {
      completeness = roundScore(refParts.length ? (100 * matchedCount) / refParts.length : 0);
    }
    if (overall === null || overall === undefined) {
      // Azure's documented aggregation: lowest component weighted 0.4, others 0.2.
      var comps = [accuracy, fluency, completeness].concat(prosody === null ? [] : [prosody])
        .filter(function (x) { return x !== null; })
        .sort(function (x, y) { return x - y; });
      if (comps.length === 1) overall = comps[0];
      else if (comps.length > 1) {
        var rest = comps.slice(1).reduce(function (x, y) { return x + y; }, 0) / (comps.length - 1);
        overall = roundScore(comps[0] * 0.4 + rest * 0.6);
      } else overall = 0;
    }

    var targetFailures = targets.filter(function (t) { return t.failed; });
    var targetScore = targets.length
      ? Math.min.apply(null, targets.map(function (t) { return t.score === null ? 0 : t.score; }))
      : null;
    var targetLevel = !targets.length ? null
      : targets.every(function (t) { return t.level === 'phoneme' || t.reason; }) ? 'phoneme' : 'word';
    var weakestTarget = null;
    targets.forEach(function (t) { if (!weakestTarget || t.score < weakestTarget.score) weakestTarget = t; });

    var rating = starsFor(overall, targetScore, targetFailures.length);

    var mispronouncedWords = words
      .filter(function (w) { return w.band !== 'green' || w.errorType !== 'None'; })
      .map(function (w) { return { word: cleanWord(w.display), accuracy: w.score, error_type: w.errorType === 'None' ? 'Mispronunciation' : w.errorType }; })
      .concat(insertions.map(function (iw) { return { word: iw, accuracy: null, error_type: 'Insertion' }; }));

    // Phoneme errors = every drift (< 60) plus every failed target phoneme (< 65
    // or substituted), each flagged with whether it is one of the exercise targets.
    var phonemeErrors = [];
    words.forEach(function (w) {
      w.phonemes.forEach(function (p) {
        if (!p.phoneme || p.score === null) return;
        var drift = p.score < PHONEME_DRIFT_THRESHOLD;
        if (!drift && !p.targetFailed) return;
        phonemeErrors.push({
          word: cleanWord(w.display),
          expected: p.phoneme,
          produced: p.produced || 'distorted',
          accuracy: p.score,
          target: !!p.isTarget,
        });
      });
    });

    return {
      recognized: true,
      overall: rating.score,
      stars: rating.stars,
      label: rating.label,
      tone: rating.tone,
      accuracy: accuracy,
      fluency: fluency,
      prosody: prosody,
      completeness: completeness,
      words: words,
      insertions: insertions,
      mispronouncedWords: mispronouncedWords,
      phonemeErrors: phonemeErrors,
      capped: rating.capped,
      targets: targets,
      targetScore: targetScore === null ? null : roundScore(targetScore),
      targetLevel: targetLevel,
      targetFailures: targetFailures,
      weakestTarget: weakestTarget,
      needsCoaching: rating.stars < 3 || targetFailures.length > 0 || phonemeErrors.length > 0 || mispronouncedWords.length > 0,
    };
  }

  /* -------------------------------------------------------------- */
  /* Session analytics                                               */
  /* -------------------------------------------------------------- */

  /* -------------------------------------------------------------- */
  /* Coaching status (what the learner sees instead of numbers)      */
  /* -------------------------------------------------------------- */

  var STATUS = {
    spot_on: { key: 'spot_on', label: 'Spot On! Crisp & Natural', tone: 'green' },
    almost: { key: 'almost', label: 'Almost There — Just Minor Polish', tone: 'amber' },
    needs_work: { key: 'needs_work', label: 'Needs Work on Target Sound', tone: 'red' },
  };

  /**
   * Discrete pass/miss per target-sound check, then one of three statuses:
   *   spot_on    every target sound passed (≥ targetPass, no substitution/omission)
   *   almost     fluent, and exactly one target sound slipped (scored below the
   *              pass mark but was not substituted, skipped or clearly failed)
   *   needs_work a target sound was substituted, skipped or failed, more than one
   *              slipped, or the delivery wasn't fluent
   * Without any target checks (no target words in the attempt) the star rating decides.
   */
  function feedbackStatus(analysis) {
    var targets = (analysis && analysis.targets) || [];
    var checks = targets.map(function (t) {
      var substituted = t.reason === 'heard_as' || t.reason === 'omitted' || t.reason === 'replaced';
      var passed = !substituted && t.score !== null && t.score >= THRESHOLDS.targetPass;
      var hard = substituted || t.score === null || t.score < THRESHOLDS.targetFail;
      return {
        word: t.word, wordIndex: t.wordIndex, phoneme: t.phoneme, produced: t.produced || null,
        reason: substituted ? t.reason : passed ? null : (hard ? 'failed' : 'slipped'),
        heardAs: t.heardAs || null, passed: passed, hard: !passed && hard,
      };
    });
    var misses = checks.filter(function (c) { return !c.passed; });
    var fluent = (analysis.fluency === null || analysis.fluency === undefined || analysis.fluency >= THRESHOLDS.fluent)
      && !(analysis.words || []).some(function (w) { return w.errorType === 'Omission'; });
    var status;
    if (!checks.length) {
      status = analysis.stars >= 3 ? STATUS.spot_on : analysis.stars === 2 ? STATUS.almost : STATUS.needs_work;
    } else if (!misses.length) {
      status = STATUS.spot_on;
    } else if (misses.length === 1 && !misses[0].hard && fluent) {
      status = STATUS.almost;
    } else {
      status = STATUS.needs_work;
    }
    var missedWords = {};
    misses.forEach(function (m) { if (m.wordIndex >= 0) missedWords[m.wordIndex] = true; });
    return {
      key: status.key, label: status.label, tone: status.tone,
      passes: checks.length - misses.length, total: checks.length,
      checks: checks, misses: misses, missedWords: missedWords, fluent: fluent,
    };
  }

  /* -------------------------------------------------------------- */
  /* Onboarding diagnostic                                           */
  /* -------------------------------------------------------------- */

  // A sound is a focus when fewer than this share of its occurrences pass.
  var DIAGNOSTIC_WEAK_PASS_RATE = 0.75;
  // At or above this share of passes a sound reads as "clear".
  var DIAGNOSTIC_CLEAR_PASS_RATE = 0.85;

  /**
   * Per-sound accuracy for the diagnostic paragraph.
   *
   * Every named phoneme in the attempt that is one of `diag.measured` counts as a
   * sample (so all /θ/ in the paragraph are averaged, not just one word). When
   * Azure returns no phoneme names for a word (en-GB), or the word was replaced by
   * another word, the word's own score stands in for each measured sound it
   * carries, using `diag.sound_words`. Skipped words are not samples (a skipped
   * "the" says nothing about /ð/), but they are counted.
   *
   * Each occurrence passes or misses discretely: it passes at the pass mark
   * (THRESHOLDS.targetPass) when Azure didn't hear a different sound. A sound is
   * a focus when fewer than 75% of its occurrences pass. Averages are kept only
   * for ordering and for the coach; the learner never sees a number.
   *
   * @returns {{ scores, weakPhonemes, strongest, level, omitted, passMark }}
   *   scores: [{ phoneme, score|null, samples, passes, rating, best_word, weakest_word, level }] in `measured` order
   *     rating: 'clear' | 'nearly' | 'focus' | null (not heard)
   *   weakPhonemes: up to 2 focus sounds, weakest first
   */
  function diagnosticProfile(analysis, diag) {
    var measured = (diag && diag.measured) || [];
    var passMark = (diag && diag.pass_mark) || THRESHOLDS.targetPass;
    var soundWords = (diag && diag.sound_words) || {};
    var buckets = {};
    measured.forEach(function (ph) { buckets[ph] = []; });
    var omitted = 0;

    ((analysis && analysis.words) || []).forEach(function (w) {
      var word = cleanWord(w.display);
      if (w.errorType === 'Omission') { omitted++; return; }
      var named = (w.phonemes || []).filter(function (p) { return p.phoneme && p.score !== null; });
      if (named.length) {
        named.forEach(function (p) {
          if (buckets[p.phoneme]) {
            buckets[p.phoneme].push({ word: word, score: p.score, level: 'phoneme', passed: p.score >= passMark && !p.produced, substituted: !!p.produced });
          }
        });
        return;
      }
      var parts = word.split(/[-–—]/).map(normalizeWord).filter(Boolean);
      measured.forEach(function (ph) {
        var carries = (soundWords[ph] || []).some(function (sw) { return parts.indexOf(sw) !== -1; });
        if (carries && w.score !== null) {
          buckets[ph].push({ word: word, score: w.score, level: 'word', passed: w.errorType !== 'Substitution' && w.score >= passMark, substituted: w.errorType === 'Substitution' });
        }
      });
    });

    var scores = measured.map(function (ph) {
      var list = buckets[ph];
      if (!list.length) return { phoneme: ph, score: null, samples: 0, passes: 0, substitutions: 0, rating: null, best_word: null, weakest_word: null, level: null };
      var sum = 0, passes = 0, subs = 0, best = list[0], worst = list[0];
      list.forEach(function (x) {
        sum += x.score;
        if (x.passed) passes++;
        if (x.substituted) subs++;
        if (x.score > best.score) best = x;
        if (x.score < worst.score) worst = x;
      });
      return {
        phoneme: ph,
        score: roundScore(sum / list.length),
        samples: list.length,
        passes: passes,
        substitutions: subs,
        rating: passes / list.length < DIAGNOSTIC_WEAK_PASS_RATE ? 'focus'
          : passes / list.length >= DIAGNOSTIC_CLEAR_PASS_RATE ? 'clear' : 'nearly',
        best_word: best.word,
        weakest_word: worst.word,
        level: list.every(function (x) { return x.level === 'phoneme'; }) ? 'phoneme' : 'word',
      };
    });

    var measuredScores = scores.filter(function (x) { return x.score !== null; });
    function rate(x) { return x.passes / x.samples; }
    var weakPhonemes = measuredScores
      .filter(function (x) { return x.rating === 'focus'; })
      // fewest clean occurrences first; then the sound Azure heard as another sound most often; then lowest score
      .sort(function (a, b) { return (rate(a) - rate(b)) || (b.substitutions / b.samples - a.substitutions / a.samples) || (a.score - b.score); })
      .slice(0, 2)
      .map(function (x) { return x.phoneme; });
    var strongest = measuredScores.slice().sort(function (a, b) { return (rate(b) - rate(a)) || (b.score - a.score); })[0] || null;

    return {
      scores: scores,
      weakPhonemes: weakPhonemes,
      strongest: strongest,
      level: measuredScores.some(function (x) { return x.level === 'word'; }) ? 'word' : 'phoneme',
      omitted: omitted,
      passMark: passMark,
    };
  }

  /**
   * Personalised ordering of the library: drills whose focus includes a weak
   * sound come first (more weak sounds first, then the weakest measured focus
   * sound), then the rest; ties keep curriculum order.
   *
   * @param {object[]} exercises
   * @param {string[]} weakPhonemes
   * @param {object}   [scoreBySound]  { 'θ': 54, … } from the diagnostic
   * @returns {{ exercise, weakHits, recommended }[]}
   */
  function rankExercises(exercises, weakPhonemes, scoreBySound) {
    var weak = weakPhonemes || [];
    var scoresMap = scoreBySound || {};
    return (exercises || [])
      .map(function (ex, i) {
        var focus = ex.focus || [];
        var weakHits = focus.filter(function (f) { return weak.indexOf(f) !== -1; }).length;
        var minScore = focus.reduce(function (m, f) {
          var v = scoresMap[f];
          return typeof v === 'number' && v < m ? v : m;
        }, 101);
        return { exercise: ex, weakHits: weakHits, recommended: weakHits > 0, minScore: minScore, index: i };
      })
      .sort(function (a, b) {
        return (b.weakHits - a.weakHits) || (a.recommended ? a.minScore - b.minScore : 0) || (a.index - b.index);
      })
      .map(function (r) { return { exercise: r.exercise, weakHits: r.weakHits, recommended: r.recommended }; });
  }

  function topTroubleSounds(attempts, n) {
    var counts = {};
    (attempts || []).forEach(function (a) {
      (a.phoneme_errors || []).forEach(function (p) {
        if (!counts[p.expected]) counts[p.expected] = { phoneme: p.expected, count: 0, words: [] };
        counts[p.expected].count++;
        if (counts[p.expected].words.indexOf(p.word) === -1) counts[p.expected].words.push(p.word);
      });
    });
    return Object.keys(counts)
      .map(function (k) { return counts[k]; })
      .sort(function (x, y) { return y.count - x.count || x.phoneme.localeCompare(y.phoneme); })
      .slice(0, n || 2);
  }

  var CSV_COLUMNS = [
    'timestamp', 'exercise_id', 'target_text', 'overall_score', 'star_rating',
    'fluency_score', 'prosody_score', 'mispronounced_words', 'phoneme_errors',
    'target_phoneme_score', 'accent',
  ];

  function csvCell(value) {
    var s = value === null || value === undefined ? '' : String(value);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(attempts) {
    var lines = [CSV_COLUMNS.join(',')];
    (attempts || []).forEach(function (a) {
      var mis = (a.mispronounced_words || []).map(function (w) {
        return w.error_type === 'Insertion' ? '+' + w.word : w.word + ' (' + (w.accuracy === null ? '-' : w.accuracy) + ')';
      }).join('; ');
      var ph = (a.phoneme_errors || []).map(function (p) {
        return (p.target ? '[target] ' : '') + p.word + ': /' + p.expected + '/→' + (p.produced === 'distorted' ? 'distorted' : '/' + p.produced + '/') + ' (' + p.accuracy + ')';
      }).join('; ');
      lines.push([
        a.timestamp, a.exercise_id, a.target_text, a.overall_score, a.star_rating,
        a.fluency_score, a.prosody_score, mis, ph,
        a.target_phoneme_score, a.accent,
      ].map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  return {
    THRESHOLDS: THRESHOLDS,
    PHONEME_DRIFT_THRESHOLD: PHONEME_DRIFT_THRESHOLD,
    CSV_COLUMNS: CSV_COLUMNS,
    roundScore: roundScore,
    starsFor: starsFor,
    bandFor: bandFor,
    normalizeWord: normalizeWord,
    tokenizeReference: tokenizeReference,
    analyzeAttempt: analyzeAttempt,
    topTroubleSounds: topTroubleSounds,
    diagnosticProfile: diagnosticProfile,
    feedbackStatus: feedbackStatus,
    STATUS: STATUS,
    rankExercises: rankExercises,
    toCsv: toCsv,
  };
});
