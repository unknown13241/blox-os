/*
 * ProxyPlay - a tiny, dependency-free web proxy + static site server.
 *
 * Run:  node server.js
 * Then open http://localhost:3000
 *
 * The proxy endpoint rewrites links so that every request goes back through
 * this server, which is what makes "unblocking" / filter-bypassing work.
 * It is intentionally small and readable so you can extend it.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
// Bind to all interfaces by default so the site can be reached via a custom
// hostname, a LAN address, or a tunnel. Set HOST=127.0.0.1 to keep it local.
const HOST = process.env.HOST || '0.0.0.0';
// Use the public/ folder when present (local dev). On hosts where only the
// bundled site files were uploaded to the repo root, serve that root instead.
const LOCAL_PUBLIC = path.join(__dirname, 'public');
const PUBLIC_DIR = fs.existsSync(LOCAL_PUBLIC) ? LOCAL_PUBLIC : __dirname;
const DATA_DIR = path.join(__dirname, 'data');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(REVIEWS_FILE)) fs.writeFileSync(REVIEWS_FILE, '[]');
if (!fs.existsSync(CHAT_FILE)) fs.writeFileSync(CHAT_FILE, '[]');
const PROXY_PREFIX = '/api/proxy/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

const b64encode = (s) => Buffer.from(s, 'utf8').toString('base64url');
const b64decode = (s) => {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return null;
  }
};

// Block requests to internal/private addresses (basic SSRF protection).
function isBlocked(target) {
  let host;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return false;
}

// Turn any URL found in a page into a URL that routes through this proxy.
function proxify(value, base) {
  let absolute;
  try {
    absolute = new URL(value, base).href;
  } catch {
    return value;
  }
  const protocol = new URL(absolute).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return value;
  return PROXY_PREFIX + b64encode(absolute);
}

function shouldSkip(value) {
  return /^\s*(?:#|javascript:|data:|mailto:|tel:|about:|blob:|chrome:|edge:|view-source:)/i.test(
    value
  );
}

/* ------------------------------------------------------------------ */
/* Content rewriting                                                   */
/* ------------------------------------------------------------------ */

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
      if (shouldSkip(value)) return match;
      return `url(${quote}${proxify(value, base)}${quote})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, value) => {
      if (shouldSkip(value)) return match;
      return `@import ${quote}${proxify(value, base)}${quote}`;
    });
}

function rewriteHtml(html, base) {
  // A <base> tag would change how our relative /api/proxy/ links resolve.
  html = html.replace(/<base\b[^>]*>/gi, '');

  // Quoted URL attributes.
  html = html.replace(
    /(\b(?:href|src|action|poster|background|data-src|data-href|data-url|formaction)\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (match, prefix, quote, value) => {
      if (shouldSkip(value)) return match;
      return prefix + quote + proxify(value, base) + quote;
    }
  );

  // Unquoted URL attributes (less common but happens).
  html = html.replace(
    /(\b(?:href|src|action)\s*=\s*)([^\s"'>]+)/gi,
    (match, prefix, value) => {
      if (shouldSkip(value)) return match;
      return prefix + proxify(value, base);
    }
  );

  // Responsive image sets.
  html = html.replace(
    /(\bsrcset\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (match, prefix, quote, value) => {
      const rewritten = value
        .split(',')
        .map((entry) => {
          const trimmed = entry.trim();
          const split = trimmed.search(/\s/);
          const url = split === -1 ? trimmed : trimmed.slice(0, split);
          const rest = split === -1 ? '' : trimmed.slice(split);
          if (shouldSkip(url)) return trimmed;
          return proxify(url, base) + rest;
        })
        .join(', ');
      return prefix + quote + rewritten + quote;
    }
  );

  // Inline <style> blocks.
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (match, open, css, close) => open + rewriteCss(css, base) + close
  );

  // Inline style attributes.
  html = html.replace(
    /(\bstyle\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (match, prefix, quote, css) => prefix + quote + rewriteCss(css, base) + quote
  );

  html = injectClientHelper(html, base);
  return html;
}

// A small helper that catches links created by JavaScript and routes them
// through the proxy too. Static links are already rewritten above.
function injectClientHelper(html, base) {
  const script = `<script>
(function () {
  var BASE = ${JSON.stringify(base)};
  var PREFIX = ${JSON.stringify(PROXY_PREFIX)};
  function encode(s) {
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function prox(u) {
    try { return PREFIX + encode(new URL(u, BASE).href); }
    catch (e) { return u; }
  }
  function isHttp(u) {
    try { var p = new URL(u, location.href).protocol; return p === 'http:' || p === 'https:'; }
    catch (e) { return false; }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || /^(#|javascript:|data:|mailto:|tel:)/i.test(href)) return;
    if (href.indexOf(PREFIX) === 0) return;
    if (isHttp(href)) { e.preventDefault(); location.href = prox(href); }
  }, true);
  var origOpen = window.open;
  window.open = function (u) {
    if (u && isHttp(String(u))) return origOpen.call(window, prox(String(u)));
    return origOpen.apply(window, arguments);
  };
})();
<\/script>`;

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, script + '</head>');
  }
  return script + html;
}

/* ------------------------------------------------------------------ */
/* Proxy endpoint                                                      */
/* ------------------------------------------------------------------ */

async function handleProxy(res, encoded) {
  const target = b64decode(encoded);
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Invalid or missing target URL.');
  }
  if (isBlocked(target)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('This address is blocked by the proxy.');
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Could not reach that site: ' + err.message);
  }

  const finalUrl = upstream.url || target;
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await upstream.arrayBuffer());
  let body = buffer;

  if (/text\/html|application\/xhtml\+xml/.test(contentType)) {
    body = Buffer.from(rewriteHtml(buffer.toString('utf8'), finalUrl), 'utf8');
  } else if (/text\/css/.test(contentType)) {
    body = Buffer.from(rewriteCss(buffer.toString('utf8'), finalUrl), 'utf8');
  }

  // Note: we deliberately do NOT forward Content-Security-Policy or
  // X-Frame-Options from the upstream site, because those would stop the
  // page from loading inside our iframe.
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* Reviews API (persisted to data/reviews.json)                         */
/* ------------------------------------------------------------------ */

const reviewLimit = new Map();

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[<>\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function handleReviews(req, res) {
  if (req.method === 'GET') {
    try {
      const reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
      return jsonResponse(res, 200, reviews);
    } catch {
      return jsonResponse(res, 200, []);
    }
  }

  if (req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const last = reviewLimit.get(ip) || 0;
    if (Date.now() - last < 30000) {
      return jsonResponse(res, 429, { ok: false, error: 'Please wait 30 seconds before posting again.' });
    }
    let data;
    try { data = JSON.parse(await readBody(req)); }
    catch { return jsonResponse(res, 400, { ok: false, error: 'Invalid request.' }); }

    const name = cleanText(data.name, 40);
    const text = cleanText(data.text, 500);
    const rating = Math.min(5, Math.max(1, Number(data.rating) || 5));
    if (!name || !text) {
      return jsonResponse(res, 400, { ok: false, error: 'Name and review are required.' });
    }

    const review = {
      id: Date.now().toString(36),
      name, text, rating,
      date: new Date().toISOString().slice(0, 10),
    };
    try {
      const reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
      reviews.unshift(review);
      fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews.slice(0, 200), null, 2));
      reviewLimit.set(ip, Date.now());
      return jsonResponse(res, 201, { ok: true, review });
    } catch {
      return jsonResponse(res, 500, { ok: false, error: 'Could not save review.' });
    }
  }

  res.writeHead(405); res.end('Method not allowed');
}

/* ------------------------------------------------------------------ */
/* Chat room — shared messages stored on the server                      */
/* ------------------------------------------------------------------ */

const chatLimit = new Map();

function readChat() {
  try { const data = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); return Array.isArray(data) ? data : []; }
  catch { return []; }
}

async function handleChat(req, res) {
  if (req.method === 'GET') {
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
    const messages = readChat().filter((m) => m.ts > since);
    return jsonResponse(res, 200, { ok: true, messages, now: Date.now() });
  }

  if (req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const last = chatLimit.get(ip) || 0;
    if (Date.now() - last < 2000) {
      return jsonResponse(res, 429, { ok: false, error: 'Slow down a little (2 second cooldown).' });
    }
    let data;
    try { data = JSON.parse(await readBody(req)); }
    catch { return jsonResponse(res, 400, { ok: false, error: 'Invalid request.' }); }

    const name = cleanText(data.name, 24) || 'Guest';
    const text = cleanText(data.text, 400);
    if (!text) return jsonResponse(res, 400, { ok: false, error: 'Message is empty.' });

    const message = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, text, ts: Date.now() };
    const messages = readChat();
    messages.push(message);
    fs.writeFileSync(CHAT_FILE, JSON.stringify(messages.slice(-200)));
    chatLimit.set(ip, Date.now());
    return jsonResponse(res, 201, { ok: true, message });
  }

  res.writeHead(405); res.end('Method not allowed');
}

/* ------------------------------------------------------------------ */
/* Presence API — real active visitors for this deployment              */
/* ------------------------------------------------------------------ */

const presence = new Map(); // clientId -> { ip, last }

async function handlePresence(req, res) {
  const now = Date.now();
  for (const [id, value] of presence) if (now - value.last > 60000) presence.delete(id);

  if (req.method === 'POST') {
    try {
      const data = JSON.parse(await readBody(req, 2000));
      const id = String(data.id || '').slice(0, 64);
      if (id) presence.set(id, { ip: req.socket.remoteAddress || 'unknown', last: now });
    } catch { /* ignore malformed heartbeats */ }
    return jsonResponse(res, 200, { ok: true });
  }

  const ips = new Set();
  let connections = 0;
  for (const value of presence.values()) {
    if (now - value.last < 30000) {
      connections++;
      ips.add(value.ip);
    }
  }
  return jsonResponse(res, 200, { online: ips.size, connections });
}

/* ------------------------------------------------------------------ */
/* AI API — forwards to a free provider with a strict safety prompt     */
/* ------------------------------------------------------------------ */

const AI_SYSTEM_PROMPT = [
  'You are Blox AI, a helpful, friendly assistant inside Blox OS.',
  'You can answer general questions, explain concepts, and help with legitimate coding, debugging, and learning.',
  'HARD RULES: Refuse any request that asks for malware, viruses, ransomware, spyware, keyloggers, exploit code,',
  'credential theft, phishing, DDoS, bombs, weapons, illegal drug or hacking instructions, or anything intended',
  'to harm, spy on, or exploit other people. Do not write such code even for "educational" framing.',
  'For those requests, reply with a brief refusal and offer a safe alternative.',
  'Otherwise be concise, accurate, and kind.',
].join(' ');

const aiLimits = new Map();
const aiLastRequest = new Map();

async function handleAi(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let limit = aiLimits.get(ip);
  if (!limit || now > limit.reset) {
    limit = { count: 0, reset: now + 60 * 60 * 1000 };
    aiLimits.set(ip, limit);
  }
  if (limit.count >= 15) {
    return jsonResponse(res, 429, { ok: false, error: 'Hourly AI limit reached (15 requests). Try again later.' });
  }

  let data;
  try { data = JSON.parse(await readBody(req)); }
  catch { return jsonResponse(res, 400, { ok: false, error: 'Invalid request.' }); }

  const messages = Array.isArray(data.messages)
    ? data.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }))
        .slice(-12)
    : [];
  if (!messages.length) return jsonResponse(res, 400, { ok: false, error: 'Empty message.' });
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars > 6000) {
    return jsonResponse(res, 413, { ok: false, error: 'Message too long (6,000 character limit).' });
  }

  const userKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
  const chatMessages = [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...messages];

  // With a personal Groq key the user gets much higher limits.
  if (userKey) {
    try {
      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userKey },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: chatMessages,
          max_tokens: 1024,
        }),
      });
      if (!upstream.ok) {
        const errText = (await upstream.text()).slice(0, 160);
        return jsonResponse(res, 502, { ok: false, error: 'Groq key rejected: ' + errText });
      }
      const result = await upstream.json();
      const text = (result.choices && result.choices[0] && result.choices[0].message
        ? result.choices[0].message.content : '').slice(0, 8000);
      limit.count++;
      return jsonResponse(res, 200, { ok: true, answer: text, remaining: 15 - limit.count, provider: 'Groq (your key)' });
    } catch (err) {
      return jsonResponse(res, 502, { ok: false, error: 'Groq unavailable: ' + err.message });
    }
  }

  // Free anonymous provider: one reply every 45 seconds per IP.
  const last = aiLastRequest.get(ip) || 0;
  const waitMs = 45000 - (now - last);
  if (waitMs > 0) {
    return jsonResponse(res, 429, {
      ok: false,
      error: `Free AI limit: one message every 45 seconds. Try again in ${Math.ceil(waitMs / 1000)}s.`,
      retryAfter: Math.ceil(waitMs / 1000),
    });
  }

  limit.count++;
  aiLastRequest.set(ip, Date.now());
  try {
    const model = data.model === 'mistral' ? 'mistral' : 'openai';
    const upstream = await fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: chatMessages }),
    });
    if (!upstream.ok) throw new Error('provider ' + upstream.status);
    const text = (await upstream.text()).slice(0, 8000);
    return jsonResponse(res, 200, { ok: true, answer: text, remaining: 15 - limit.count, provider: 'Free tier' });
  } catch (err) {
    return jsonResponse(res, 502, { ok: false, error: 'AI provider unavailable: ' + err.message });
  }
}

/* ------------------------------------------------------------------ */
/* Static file server                                                  */
/* ------------------------------------------------------------------ */

function serveStatic(res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative === '/' || relative === '') relative = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Friendly fallback to the SPA shell for unknown client-side routes.
      if (!path.extname(relative)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e, shell) => {
          if (e) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Not found');
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(shell);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (pathname === '/api/chat') return handleChat(req, res);
  if (pathname === '/api/reviews') return handleReviews(req, res);
  if (pathname === '/api/presence') return handlePresence(req, res);
  if (pathname === '/api/ai') return handleAi(req, res);

  if (pathname.startsWith(PROXY_PREFIX)) {
    const encoded = pathname.slice(PROXY_PREFIX.length);
    return handleProxy(res, encoded);
  }

  serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Blox OS is running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<your-ip>:${PORT}`);
  console.log(`  Custom:  set HOST/PORT env vars, or point a domain at this port (see README).`);
});
