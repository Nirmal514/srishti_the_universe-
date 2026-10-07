'use strict';
/*
  SHRISHTI server. No dependencies, Node 18+.
  - serves ./public
  - Google sign-in: verifies the Google ID token, then sets an HttpOnly session cookie
  - /api/sample: forwards prompts to Gemini; the API key never reaches the browser
  - /api/db/*: per-user history and shared galaxies in a JSON file
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
} catch (e) { /* no .env file */ }

const HOST = process.env.HOST || '0.0.0.0';
const PORT = +process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
const ALLOWED = (process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const RATE_MAX = +process.env.RATE_MAX || 30;
const RATE_WINDOW = 10 * 60 * 1000;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const PUBLIC = path.join(__dirname, 'public');

/* ---------- storage: one JSON file, written atomically ---------- */
let db = { users: {}, sessions: {}, docs: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* first run */ }
let saving = false, dirty = false;
function save() {
  dirty = true;
  if (saving) return;
  saving = true;
  setTimeout(() => {
    dirty = false;
    const tmp = DATA_FILE + '.tmp';
    try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); } catch (e) { /* ignore */ }
    fs.writeFile(tmp, JSON.stringify(db), (err) => {
      if (err) { saving = false; console.error('save failed:', err.message); return; }
      fs.rename(tmp, DATA_FILE, () => { saving = false; if (dirty) save(); });
    });
  }, 150);
}
setInterval(() => {
  const now = Date.now();
  Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].exp < now) delete db.sessions[k]; });
}, 3600 * 1000).unref();

/* ---------- helpers ---------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {}));
  res.end(body);
}
const fail = (res, code, errCode, message) => send(res, code, { error: { code: errCode, message } });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject({ status: 413 }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject({ status: 400 }); } });
    req.on('error', () => reject({ status: 400 }));
  });
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function sessionUser(req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const s = db.sessions[sha(sid)];
  if (!s || s.exp < Date.now()) return null;
  const u = db.users[s.uid];
  return u ? { id: s.uid, name: u.name, picture: u.picture || '' } : null;
}
function startSession(res, uid) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(sid)] = { uid, exp: Date.now() + SESSION_MS };
  save();
  return 'sid=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_MS / 1000) + (COOKIE_SECURE ? '; Secure' : '');
}
const rate = new Map();
function limited(uid) {
  const now = Date.now();
  const arr = (rate.get(uid) || []).filter((t) => now - t < RATE_WINDOW);
  if (arr.length >= RATE_MAX) { rate.set(uid, arr); return true; }
  arr.push(now); rate.set(uid, arr); return false;
}

/* ---------- Google sign-in ---------- */
async function verifyGoogle(credential) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) throw new Error('Google rejected the token');
  const t = await r.json();
  if (t.aud !== GOOGLE_CLIENT_ID) throw new Error('Token is for another client');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(t.iss) < 0) throw new Error('Bad issuer');
  if (+t.exp * 1000 < Date.now()) throw new Error('Token expired');
  if (String(t.email_verified) !== 'true') throw new Error('Email not verified');
  return { sub: t.sub, email: String(t.email || '').toLowerCase(), name: t.name || t.email, picture: t.picture || '' };
}
function upsertUser(key, info) {
  const uid = 'u_' + sha(key).slice(0, 20);
  db.users[uid] = { name: String(info.name || 'Explorer').slice(0, 80), picture: info.picture || '', email: info.email || '' };
  return uid;
}

/* ---------- Gemini ---------- */
async function gemini(turns, asJson) {
  const contents = [];
  turns.forEach((t) => {
    const role = t.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n\n' + t.content;
    else contents.push({ role, parts: [{ text: t.content }] });
  });
  const gc = { temperature: asJson ? 0.3 : 0.5, maxOutputTokens: +process.env.GEMINI_MAX_TOKENS || 32768 };
  if (asJson) gc.responseMimeType = 'application/json';
  if (process.env.GEMINI_THINKING_BUDGET !== undefined && process.env.GEMINI_THINKING_BUDGET !== '') {
    gc.thinkingConfig = { thinkingBudget: +process.env.GEMINI_THINKING_BUDGET };
  }
  const models = Array.from(new Set([GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter(Boolean)));
  let lastErr = null;
  for (const modelName of models) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 180000);
    try {
      const r = await fetch(GEMINI_BASE + '/v1beta/models/' + encodeURIComponent(modelName) + ':generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({ contents, generationConfig: gc }),
        signal: ctl.signal
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        const info = { status: r.status, detail: detail.slice(0, 400) };
        lastErr = info;
        console.error('Gemini error', modelName, r.status, info.detail);
        if (r.status !== 404 || modelName === GEMINI_FALLBACK_MODEL) {
          throw { status: r.status === 429 ? 429 : 502, code: r.status === 429 ? 'rate_limited' : 'upstream_error', message: 'The model service returned an error (' + r.status + ').' };
        }
        continue;
      }
      const j = await r.json();
      const c = j.candidates && j.candidates[0];
      const text = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || '').join('') : '';
      if (!text.trim()) {
        const blocked = (j.promptFeedback && j.promptFeedback.blockReason) || (c && c.finishReason === 'SAFETY');
        throw { status: 422, code: blocked ? 'refused' : 'empty_completion', message: blocked ? 'The model declined this input.' : 'The model returned nothing.' };
      }
      return { text, truncated: !!(c && c.finishReason === 'MAX_TOKENS') };
    } catch (e) {
      if (e && e.code) throw e;
      if (e && e.name === 'AbortError') throw { status: 504, code: 'upstream_error', message: 'The model took too long.' };
      console.error('Gemini request failed:', modelName, e && e.message);
      if (modelName !== GEMINI_FALLBACK_MODEL) continue;
      throw { status: 502, code: 'upstream_error', message: 'The model service could not be reached.' };
    } finally { clearTimeout(timer); }
  }
  if (lastErr) {
    throw { status: 502, code: 'upstream_error', message: 'The model service returned an error (' + lastErr.status + ').' };
  }
  throw { status: 502, code: 'upstream_error', message: 'The model service could not be reached.' };
}

/* ---------- document store with path rules ---------- */
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,100}$/;
function parsePath(raw) {
  const segs = raw.split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return ''; } });
  if (!segs.length || segs.length > 8 || segs.some((s) => !SEG.test(s) || s === '.' || s === '..')) return null;
  return segs;
}
function allowed(user, segs, write, doc) {
  if (segs[0] === 'data' && segs[1] === 'users') return segs.length >= 3 && segs[2] === user.id;
  if (segs[0] === 'shared' && segs.length === 2) {
    if (!write) return true;
    return !doc || doc.owner === user.id;
  }
  return false;
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file;
  try { file = path.normalize(path.join(PUBLIC, decodeURIComponent(rel))); } catch (e) { res.writeHead(400); return res.end(); }
  if (file.indexOf(PUBLIC + path.sep) !== 0) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin'
    });
    res.end(buf);
  });
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, p);
    }
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'shrishti') return fail(res, 403, 'forbidden', 'Missing request header.');

    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID, devLogin: DEV_LOGIN, gemini: !!GEMINI_API_KEY });
    }
    if (p === '/api/me' && req.method === 'GET') {
      const u = sessionUser(req);
      return u ? send(res, 200, { id: u.id, name: u.name, avatar: u.picture }) : fail(res, 401, 'session_expired', 'Not signed in.');
    }
    if (p === '/api/auth/google' && req.method === 'POST') {
      if (!GOOGLE_CLIENT_ID) return fail(res, 400, 'not_configured', 'Google sign-in is not configured.');
      const body = await readBody(req, 20000);
      let info;
      try { info = await verifyGoogle(String(body.credential || '')); } catch (e) { return fail(res, 401, 'session_expired', 'Google sign-in could not be verified.'); }
      if (ALLOWED.length && ALLOWED.indexOf(info.email) < 0) return fail(res, 403, 'not_allowed', 'This Google account is not allowed.');
      const uid = upsertUser('google:' + info.sub, info);
      return send(res, 200, { id: uid, name: db.users[uid].name }, { 'set-cookie': startSession(res, uid) });
    }
    if (p === '/api/auth/dev' && req.method === 'POST') {
      if (!DEV_LOGIN) return fail(res, 404, 'not_found', 'Not found.');
      const body = await readBody(req, 2000);
      const name = String(body.name || 'Explorer').trim().slice(0, 60) || 'Explorer';
      const uid = upsertUser('dev:' + name.toLowerCase(), { name });
      return send(res, 200, { id: uid, name }, { 'set-cookie': startSession(res, uid) });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const sid = cookies(req).sid;
      if (sid) { delete db.sessions[sha(sid)]; save(); }
      return send(res, 200, { ok: true }, { 'set-cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }

    const user = sessionUser(req);
    if (!user) return fail(res, 401, 'session_expired', 'Sign in first.');

    if (p === '/api/sample' && req.method === 'POST') {
      if (!GEMINI_API_KEY) return fail(res, 503, 'sampling_disabled', 'The server has no Gemini API key configured.');
      const body = await readBody(req, 300000);
      const turns = Array.isArray(body.turns) ? body.turns : [];
      let total = 0;
      const ok = turns.length > 0 && turns[0].role === 'user' && turns[turns.length - 1].role === 'user' &&
        turns.every((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim() && (total += t.content.length) < 262144);
      if (!ok) return fail(res, 400, 'invalid_request', 'Bad request.');
      if (limited(user.id)) return fail(res, 429, 'rate_limited', 'Too many requests. Try again in a few minutes.');
      try { return send(res, 200, await gemini(turns, !!body.json)); }
      catch (e) { return fail(res, e.status || 502, e.code || 'upstream_error', e.message || 'Upstream error.'); }
    }

    if (p === '/api/profiles' && req.method === 'POST') {
      const body = await readBody(req, 20000);
      const out = {};
      (Array.isArray(body.ids) ? body.ids : []).slice(0, 50).forEach((id) => {
        const u = db.users[String(id)];
        out[id] = { name: u ? u.name : '' };
      });
      return send(res, 200, out);
    }

    if (p.startsWith('/api/db/')) {
      const segs = parsePath(p.slice('/api/db/'.length));
      if (!segs || segs.length % 2 !== 0) return fail(res, 400, 'invalid_argument', 'Bad document path.');
      const key = segs.join('/'), doc = db.docs[key];
      if (req.method === 'GET') {
        if (!allowed(user, segs, false, doc)) return fail(res, 404, 'not_found', 'Not found.');
        return doc ? send(res, 200, { data: doc.data }) : fail(res, 404, 'not_found', 'Not found.');
      }
      if (req.method === 'PUT') {
        if (!allowed(user, segs, true, doc)) return fail(res, 403, 'invalid_argument', 'Not allowed.');
        const body = await readBody(req, 300000);
        if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return fail(res, 400, 'invalid_argument', 'Body must be an object.');
        if (JSON.stringify(body.data).length > 262144) return fail(res, 413, 'invalid_argument', 'Document too large.');
        db.docs[key] = { data: body.data, owner: doc ? doc.owner : user.id, updated: Date.now() };
        save();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (!allowed(user, segs, true, doc)) return fail(res, 403, 'invalid_argument', 'Not allowed.');
        delete db.docs[key]; save();
        return send(res, 200, { ok: true });
      }
    }
    if (p.startsWith('/api/dbc/') && req.method === 'GET') {
      const segs = parsePath(p.slice('/api/dbc/'.length));
      if (!segs || segs.length % 2 !== 1 || !allowed(user, segs, false, null)) return fail(res, 404, 'not_found', 'Not found.');
      const prefix = segs.join('/') + '/', docs = [];
      Object.keys(db.docs).forEach((k) => {
        if (k.startsWith(prefix) && k.slice(prefix.length).indexOf('/') < 0) docs.push({ id: k.slice(prefix.length), data: db.docs[k].data });
      });
      return send(res, 200, { docs });
    }
    return fail(res, 404, 'not_found', 'Not found.');
  } catch (e) {
    if (e && e.status) return fail(res, e.status, 'invalid_request', 'Bad request.');
    console.error(e);
    return fail(res, 500, 'upstream_error', 'Server error.');
  }
});

server.listen(PORT, HOST, () => {
  console.log('SHRISHTI running on http://localhost:' + PORT);
  console.log('SHRISHTI network access: http://' + HOST + ':' + PORT + ' (use your machine IP instead of 0.0.0.0 for teammates)');
  if (!GEMINI_API_KEY) console.log('  ! GEMINI_API_KEY is not set: research and Jigyasa are disabled.');
  if (!GOOGLE_CLIENT_ID && !DEV_LOGIN) console.log('  ! Neither GOOGLE_CLIENT_ID nor DEV_LOGIN=1 is set: nobody can sign in.');
  if (DEV_LOGIN && !GOOGLE_CLIENT_ID) console.log('  ! DEV_LOGIN is on: anyone can sign in with any name. Local use only.');
});
