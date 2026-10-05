'use strict';

/**
 * Shared helpers for the serverless functions.
 *
 * Files under /api whose name starts with "_" are not deployed as routes by
 * Vercel, so this module is importable by handlers but never publicly reachable.
 *
 * Handlers only use plain Node `http` request/response APIs (no Vercel-specific
 * `res.status().json()` helpers), so the same code runs unchanged on Vercel and
 * in the zero-dependency local dev server (scripts/dev-server.js).
 */

const MAX_BODY_BYTES = 8 * 1024;

function sendJson(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allowed) {
  sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allowed.join(', ') });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Same-origin guard.
 *
 * Browsers always attach `Origin` to cross-origin fetches and to POSTs. If it is
 * present it must match this deployment's host, or one of ALLOWED_ORIGINS
 * (comma-separated, e.g. "https://my-app.vercel.app,https://coach.example.com").
 *
 * This stops other websites from hot-linking your Azure / Groq quota from their
 * visitors' browsers. It does NOT stop a determined script (curl can forge any
 * header) — that is what the rate limiter and Azure/Groq spending caps are for.
 */
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GET or non-browser client
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host && originHost === host) return true;
  const allowList = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowList.some((allowed) => {
    try {
      return new URL(allowed).host === originHost;
    } catch {
      return false;
    }
  });
}

/**
 * Best-effort fixed-window rate limiter.
 *
 * State lives in the function instance's memory, so on serverless it is per warm
 * instance, not global. That is deliberate: it costs nothing, needs no database,
 * and blunts casual abuse. For hard global limits, swap this for Vercel KV /
 * Upstash Redis — the call signature stays the same.
 */
function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      }
      return { ok: true, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count > limit) {
      return { ok: false, retryAfter: Math.ceil((entry.start + windowMs - now) / 1000) };
    }
    return { ok: true, retryAfter: 0 };
  };
}

/**
 * Returns the parsed JSON body. Vercel pre-parses JSON into `req.body`; the local
 * dev server and raw Node do not, so fall back to reading the stream.
 */
async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) {
      const err = new Error('payload_too_large');
      err.status = 413;
      throw err;
    }
    return req.body;
  }
  if (typeof req.body === 'string') return parseOrThrow(req.body);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('payload_too_large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return parseOrThrow(Buffer.concat(chunks).toString('utf8'));
}

function parseOrThrow(text) {
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    const err = new Error('payload_too_large');
    err.status = 413;
    throw err;
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    const err = new Error('invalid_json');
    err.status = 400;
    throw err;
  }
}

module.exports = {
  sendJson,
  methodNotAllowed,
  clientIp,
  isOriginAllowed,
  createRateLimiter,
  readJsonBody,
  MAX_BODY_BYTES,
};
