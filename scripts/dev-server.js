#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency local dev server that mirrors Vercel's routing:
 *   /api/<name>  → api/<name>.js  (same handler module that deploys)
 *   everything else → static files from public/
 *
 * Reads secrets from .env (never committed). Usage: `npm run dev`.
 * You can also use `vercel dev` if you have the Vercel CLI — both work.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

// --- .env loader (KEY=value, # comments, optional quotes) ---
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Apply the same response headers (CSP etc.) that vercel.json sets in production,
// so a CSP mistake shows up locally instead of after deploy.
const vercelHeaders = (JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).headers || [])
  .map((h) => ({ re: new RegExp('^' + h.source.replace(/\(\.\*\)/g, '(.*)') + '$'), headers: h.headers }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  for (const rule of vercelHeaders) {
    if (rule.re.test(url.pathname)) rule.headers.forEach((h) => res.setHeader(h.key, h.value));
  }

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/\/$/, '');
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return notFound(res);
    const file = path.join(ROOT, 'api', `${name}.js`);
    if (!fs.existsSync(file)) return notFound(res);
    try {
      delete require.cache[require.resolve(file)]; // hot reload handlers
      await require(file)(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('{"error":"internal"}');
      }
    }
    log(req, res);
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return notFound(res);
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
});

function notFound(res) {
  res.statusCode = 404;
  res.end('Not found');
}

function log(req, res) {
  console.log(`${req.method} ${req.url} → ${res.statusCode}`);
}

server.listen(PORT, () => {
  const az = process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION ? '✓' : '✗ (set AZURE_SPEECH_KEY + AZURE_SPEECH_REGION)';
  const gq = process.env.GROQ_API_KEY ? '✓' : '✗ (coach will use built-in fallback tips)';
  console.log(`\nAccent Coach dev server → http://localhost:${PORT}`);
  console.log(`  Azure Speech: ${az}`);
  console.log(`  Groq:         ${gq}\n`);
});
