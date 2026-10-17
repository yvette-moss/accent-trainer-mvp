/**
 * curriculum.js — pure topic / session logic (no DOM, network or audio).
 *
 * UMD like scoring.js: the browser uses window.AccentCurriculum, Node uses
 * require() (scripts/csv-to-json.js derives topic sounds with it, and the
 * tests exercise exactly the code that ships). Scoring is NOT done here:
 * star ratings come from AccentScoring.analyzeAttempt unchanged.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AccentCurriculum = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SESSION = { min: 5, max: 8, size: 6 };
  // A sound belongs to a topic when at least this share of its exercises target it.
  var TOPIC_SOUND_SHARE = 0.5;
  var RATING_ORDER = { focus: 0, nearly: 1, clear: 2 };

  /** The sounds a topic is "about": those targeted by ≥ 50% of its exercises, in first-seen order. */
  function topicSounds(exercises) {
    var counts = {}, order = [];
    (exercises || []).forEach(function (ex) {
      (ex.focus || []).forEach(function (f) {
        if (!counts[f]) { counts[f] = 0; order.push(f); }
        counts[f]++;
      });
    });
    var n = (exercises || []).length;
    return order.filter(function (f) { return n && counts[f] / n >= TOPIC_SOUND_SHARE; });
  }

  /**
   * Orders topics by learner need from the saved diagnostic.
   * High priority = the topic is about one of the diagnostic's weak sounds
   * (weakest sound first); the rest follow by their worst diagnostic rating,
   * then library order. Without a diagnostic, library order and no priorities.
   * @returns {{ topic, priority, rating }[]}  rating: worst of 'focus' | 'nearly' | 'clear' | null
   */
  function rankTopics(topics, diagnostic) {
    var weak = (diagnostic && diagnostic.weakPhonemes) || [];
    var ratingBySound = {};
    ((diagnostic && diagnostic.scores) || []).forEach(function (s) { if (s.rating) ratingBySound[s.phoneme] = s.rating; });
    return (topics || []).map(function (t, i) {
      var sounds = t.sounds || [];
      var weakIdx = sounds.map(function (s) { return weak.indexOf(s); }).filter(function (k) { return k >= 0; });
      var rating = null;
      sounds.forEach(function (s) {
        var r = ratingBySound[s];
        if (r && (rating === null || RATING_ORDER[r] < RATING_ORDER[rating])) rating = r;
      });
      return {
        topic: t, priority: weakIdx.length > 0, rating: rating, index: i,
        weakRank: weakIdx.length ? Math.min.apply(null, weakIdx) : 99,
      };
    }).sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      if (a.priority) return (a.weakRank - b.weakRank) || (a.index - b.index);
      var ra = a.rating === null ? 3 : RATING_ORDER[a.rating], rb = b.rating === null ? 3 : RATING_ORDER[b.rating];
      return (ra - rb) || (a.index - b.index);
    }).map(function (r) { return { topic: r.topic, priority: r.priority, rating: r.rating }; });
  }

  /** Topics active by default: every high-priority topic, or all topics when none is flagged. */
  function defaultTopicSelection(ranked) {
    var pri = (ranked || []).filter(function (r) { return r.priority; });
    return (pri.length ? pri : ranked || []).map(function (r) { return r.topic.id; });
  }

  /** Mulberry32 — small seeded PRNG so queues are reproducible in tests. */
  function seededRandom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rng) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * A randomized practice queue drawn ONLY from the active topics.
   *   - each topic's exercises are shuffled, never-practised ones first
   *     (then ones not in the previous set), so "Practice Again" moves on;
   *   - topics take turns (round-robin, in the order given) for variety;
   *   - size is clamped to 5–8, or fewer if the topics hold fewer exercises.
   * @param {object[]} exercises         whole library
   * @param {string[]} topicIds          active topics, priority order
   * @param {object}   [opts] { size, practised: {id:true}, previous: [ids], rng }
   */
  function buildQueue(exercises, topicIds, opts) {
    opts = opts || {};
    var rng = opts.rng || Math.random;
    var size = Math.max(SESSION.min, Math.min(SESSION.max, opts.size || SESSION.size));
    var practised = opts.practised || {};
    var previous = {};
    (opts.previous || []).forEach(function (id) { previous[id] = true; });
    function freshness(ex) { return (practised[ex.id] ? 2 : 0) + (previous[ex.id] ? 1 : 0); }

    var pools = (topicIds || []).map(function (tid) {
      var pool = shuffle((exercises || []).filter(function (ex) { return ex.topic_id === tid; }), rng);
      // stable sort keeps the shuffle within each freshness band
      return pool.map(function (ex, i) { return { ex: ex, i: i }; })
        .sort(function (a, b) { return (freshness(a.ex) - freshness(b.ex)) || (a.i - b.i); })
        .map(function (x) { return x.ex; });
    }).filter(function (p) { return p.length; });

    var queue = [];
    var round = 0;
    while (queue.length < size && pools.some(function (p) { return round < p.length; })) {
      pools.forEach(function (p) { if (queue.length < size && round < p.length) queue.push(p[round]); });
      round++;
    }
    return queue;
  }

  /** "★★☆" for 1–3 stars (rounded), "–" when nothing was rated. */
  function starString(avg) {
    if (avg === null || avg === undefined || isNaN(avg)) return '–';
    var n = Math.max(1, Math.min(3, Math.round(avg)));
    return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n);
  }

  /**
   * Per-topic progress for the session summary.
   * @param {object}   args.content          { topics, exercises }
   * @param {object[]} args.sessionAttempts  attempts logged during this session ({ exercise_id, star_rating })
   * @param {object}   args.practised        { exercise_id: true } for everything practised since the page loaded
   * @param {string[]} args.topicIds         topics in this session (shown even with no attempts)
   */
  function sessionReport(args) {
    var exById = {};
    (args.content.exercises || []).forEach(function (ex) { exById[ex.id] = ex; });
    var show = {};
    (args.topicIds || []).forEach(function (id) { show[id] = true; });
    (args.sessionAttempts || []).forEach(function (a) { var ex = exById[a.exercise_id]; if (ex) show[ex.topic_id] = true; });

    return (args.content.topics || []).filter(function (t) { return show[t.id]; }).map(function (t) {
      var attempts = (args.sessionAttempts || []).filter(function (a) { var ex = exById[a.exercise_id]; return ex && ex.topic_id === t.id; });
      var unique = {};
      attempts.forEach(function (a) { unique[a.exercise_id] = true; });
      var total = t.exercise_ids ? t.exercise_ids.length : (args.content.exercises || []).filter(function (ex) { return ex.topic_id === t.id; }).length;
      var done = (t.exercise_ids || []).filter(function (id) { return args.practised && args.practised[id]; }).length;
      var stars = attempts.map(function (a) { return a.star_rating; }).filter(function (s) { return typeof s === 'number'; });
      var avg = stars.length ? stars.reduce(function (x, y) { return x + y; }, 0) / stars.length : null;
      return {
        topic: t,
        attempts: attempts.length,
        exercisesAttempted: Object.keys(unique).length,
        stars: stars,
        averageStars: avg,
        averageLabel: starString(avg),
        coverage: { done: done, total: total, percent: total ? Math.round((100 * done) / total) : 0 },
      };
    });
  }

  return {
    SESSION: SESSION,
    topicSounds: topicSounds,
    rankTopics: rankTopics,
    defaultTopicSelection: defaultTopicSelection,
    seededRandom: seededRandom,
    shuffle: shuffle,
    buildQueue: buildQueue,
    starString: starString,
    sessionReport: sessionReport,
  };
});
