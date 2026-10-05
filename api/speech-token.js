'use strict';

/**
 * GET /api/speech-token
 *
 * Exchanges the server-side Azure Speech key for a short-lived (10 minute)
 * authorization token. The browser uses that token with
 * `SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region)` — the raw key
 * never leaves this function.
 *
 * Response: { token: string, region: string, expires_in: number (seconds) }
 */

const {
  sendJson,
  methodNotAllowed,
  clientIp,
  isOriginAllowed,
  createRateLimiter,
} = require('./_lib/http');

const AZURE_TOKEN_LIFETIME_S = 600; // fixed by Azure
const CACHE_TTL_MS = 5 * 60 * 1000; // re-use a token for at most 5 min → clients always get ≥ ~4.5 min
const SAFETY_MARGIN_S = 30;
const UPSTREAM_TIMEOUT_MS = 5000;

// One token is valid for every visitor in the region, so a warm instance can
// share it. This cuts STS calls from "one per recording" to "one per 5 minutes".
let cached = null; // { token, region, issuedAt }

const limiter = createRateLimiter({
  limit: Number(process.env.TOKEN_RATE_LIMIT || 30),
  windowMs: 10 * 60 * 1000,
});

async function issueToken(key, region) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': '0',
        },
        signal: controller.signal,
      }
    );
    if (!resp.ok) {
      const err = new Error(`azure_sts_${resp.status}`);
      err.upstreamStatus = resp.status;
      throw err;
    }
    const token = (await resp.text()).trim();
    if (!token) throw new Error('azure_sts_empty');
    return token;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!isOriginAllowed(req)) return sendJson(res, 403, { error: 'origin_not_allowed' });

  const rl = limiter(clientIp(req));
  if (!rl.ok) {
    return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rl.retryAfter) });
  }

  const key = process.env.AZURE_SPEECH_KEY;
  const region = (process.env.AZURE_SPEECH_REGION || '').trim().toLowerCase();
  if (!key || !region) {
    return sendJson(res, 503, {
      error: 'not_configured',
      message: 'AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be set on the server.',
    });
  }
  if (!/^[a-z0-9]+$/.test(region)) {
    return sendJson(res, 500, { error: 'invalid_region_config' });
  }

  const now = Date.now();
  if (cached && cached.region === region && now - cached.issuedAt < CACHE_TTL_MS) {
    const age = Math.floor((now - cached.issuedAt) / 1000);
    return sendJson(res, 200, {
      token: cached.token,
      region,
      expires_in: AZURE_TOKEN_LIFETIME_S - age - SAFETY_MARGIN_S,
    });
  }

  try {
    const token = await issueToken(key, region);
    cached = { token, region, issuedAt: now };
    return sendJson(res, 200, {
      token,
      region,
      expires_in: AZURE_TOKEN_LIFETIME_S - SAFETY_MARGIN_S,
    });
  } catch (err) {
    // Log the detail server-side; never echo upstream bodies to the browser.
    console.error('[speech-token] issue failed:', err.message);
    const status = err.upstreamStatus === 401 || err.upstreamStatus === 403 ? 503 : 502;
    return sendJson(res, status, {
      error: status === 503 ? 'not_configured' : 'upstream_unavailable',
    });
  }
};

// Exposed for tests only.
module.exports._resetCache = () => {
  cached = null;
};
