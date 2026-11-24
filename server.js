const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;
const DATA_DIR = process.env.YUGEN_DATA_DIR || path.join(ROOT, 'data');
const DATA_PATH = path.resolve(DATA_DIR);
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'app.js']);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const authAttempts = new Map();
const catalogCache = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
let writeQueue = Promise.resolve();
let pgPool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  pgPool.on('error', error => console.error('Database connection error:', error.message));
}

async function readUsers() {
  try { return JSON.parse(await fs.readFile(USERS_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
async function saveUsers(users) {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temp = `${USERS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(users, null, 2), { mode: 0o600 });
    await fs.rename(temp, USERS_FILE);
  });
  return writeQueue;
}
function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const pair = raw.split(';').map(s => s.trim()).find(s => s.startsWith('yugen_session='));
  return pair ? decodeURIComponent(pair.slice('yugen_session='.length)) : '';
}
function sessionUser(req) {
  const token = cookieToken(req);
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return session.user || null;
}
function publicUser(user) { return { id: user.id, email: user.email, name: user.name }; }
function tokenDigest(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
async function findSessionUser(req) {
  const token = cookieToken(req);
  if (!token) return null;
  if (!pgPool) return sessionUser(req);
  const result = await pgPool.query('SELECT u.id, u.email, u.name, u.list FROM yugen_sessions s JOIN yugen_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()', [tokenDigest(token)]);
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return { id: row.id, email: row.email, name: row.name, list: row.list || [] };
}
function sessionCookie(token, req, clear = false) {
  const secure = process.env.NODE_ENV === 'production' || (req.socket.encrypted === true);
  return `yugen_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; ${clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_MS / 1000)}`}${secure ? '; Secure' : ''}`;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}
function rateLimit(req, res) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  const state = authAttempts.get(ip) || { start: now, count: 0 };
  if (now - state.start > 15 * 60 * 1000) { state.start = now; state.count = 0; }
  state.count += 1;
  authAttempts.set(ip, state);
  if (state.count > 12) { send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' }); return false; }
  return true;
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 24_000) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('Please check the submitted information.'), { status: 400 }); }
}
async function fetchKitsuJson(key, url) {
  const now = Date.now();
  const cached = catalogCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const response = await fetch(url, { headers: { Accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Object.assign(new Error('The anime catalog is temporarily unavailable.'), { status: 502 });
  const value = await response.json();
  catalogCache.set(key, { value, expiresAt: now + 5 * 60 * 1000 });
  if (catalogCache.size > 250) {
    for (const [cacheKey, entry] of catalogCache) if (entry.expiresAt <= now) catalogCache.delete(cacheKey);
    while (catalogCache.size > 250) catalogCache.delete(catalogCache.keys().next().value);
  }
  return value;
}
async function issueSession(user, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_MS);
  if (pgPool) await pgPool.query('INSERT INTO yugen_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenDigest(token), user.id, expiresAt]);
  else sessions.set(token, { user, expiresAt: expiresAt.getTime() });
  return send(res, 200, { user: publicUser(user), list: user.list || [] }, { 'Set-Cookie': sessionCookie(token, req) });
}
async function initializeDatabase() {
  if (!pgPool) return;
  await pgPool.query(`CREATE TABLE IF NOT EXISTS yugen_users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    salt text NOT NULL,
    password_hash text NOT NULL,
    list jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  await pgPool.query(`CREATE TABLE IF NOT EXISTS yugen_sessions (
    token_hash char(64) PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES yugen_users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
  )`);
  await pgPool.query('DELETE FROM yugen_sessions WHERE expires_at < NOW()');
}
async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    if (!pgPool) return send(res, process.env.NODE_ENV === 'production' ? 503 : 200, { ok: !process.env.NODE_ENV || process.env.NODE_ENV !== 'production', database: 'local' });
    await pgPool.query('SELECT 1');
    return send(res, 200, { ok: true, database: 'postgres' });
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    const mediaType = url.searchParams.get('type') === 'manga' ? 'manga' : 'anime';
    const search = (url.searchParams.get('q') || '').trim().slice(0, 120);
    const status = url.searchParams.get('status') || '';
    const ids = (url.searchParams.get('ids') || '').split(',').map(id => id.trim()).filter(id => /^\d{1,12}$/.test(id)).slice(0, 50);
    const offset = Math.min(10000, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const genres = { action:'action', fantasy:'fantasy', romance:'romance', 'sci-fi':'science-fiction', 'slice of life':'slice-of-life', comedy:'comedy', drama:'drama' };
    const genreInput = (url.searchParams.get('genre') || '').trim().toLowerCase();
    const kitsuUrl = new URL(`https://kitsu.io/api/edge/${mediaType}`);
    kitsuUrl.searchParams.set('page[limit]', ids.length ? String(ids.length) : '20');
    kitsuUrl.searchParams.set('page[offset]', String(offset));
    kitsuUrl.searchParams.set('include', mediaType === 'manga' ? 'categories' : 'categories,streamingLinks');
    kitsuUrl.searchParams.set(`fields[${mediaType}]`, mediaType === 'manga' ? 'slug,synopsis,titles,averageRating,userCount,startDate,endDate,status,chapterCount,volumeCount,posterImage,subtype,serialization,nsfw' : 'slug,synopsis,titles,averageRating,userCount,startDate,nextRelease,status,episodeCount,episodeLength,posterImage,youtubeVideoId,subtype,nsfw');
    kitsuUrl.searchParams.set('fields[categories]', 'title,slug');
    kitsuUrl.searchParams.set('fields[streamingLinks]', 'url,subs,dubs');
    if (ids.length) kitsuUrl.searchParams.set('filter[id]', ids.join(','));
    else if (search) { kitsuUrl.searchParams.set('filter[text]', search); kitsuUrl.searchParams.set('sort', '-userCount'); }
    else {
      if (status === 'current') kitsuUrl.searchParams.set('filter[status]', 'current');
      if (genres[genreInput]) kitsuUrl.searchParams.set('filter[categories]', genres[genreInput]);
      kitsuUrl.searchParams.set('sort', status === 'current' ? '-nextRelease' : '-userCount');
    }
    try {
      const payload = await fetchKitsuJson(`catalog:${kitsuUrl.toString()}`, kitsuUrl);
      return send(res, 200, payload, { 'Cache-Control': 'public, max-age=300' });
    } catch (error) { return send(res, error.status || 502, { error: `The ${mediaType} catalog is temporarily unavailable.` }); }
  }
  const episodeMatch = url.pathname.match(/^\/api\/catalog\/(\d{1,12})\/episodes$/);
  if (req.method === 'GET' && episodeMatch) {
    const offset = Math.min(2000, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const kitsuUrl = new URL(`https://kitsu.io/api/edge/anime/${episodeMatch[1]}/episodes`);
    kitsuUrl.searchParams.set('page[limit]', '20');
    kitsuUrl.searchParams.set('page[offset]', String(offset));
    kitsuUrl.searchParams.set('sort', 'number');
    try {
      const payload = await fetchKitsuJson(`episodes:${episodeMatch[1]}:${offset}`, kitsuUrl);
      return send(res, 200, { ...payload, hasMore: Boolean(payload.links?.next) }, { 'Cache-Control': 'public, max-age=300' });
    } catch (error) { return send(res, error.status || 502, { error: 'Episode details are temporarily unavailable.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = await findSessionUser(req);
    return send(res, 200, { user: user ? publicUser(user) : null, list: user?.list || [] });
  }
  if (req.method === 'POST' && ['/api/signup', '/api/login', '/api/logout'].includes(url.pathname)) {
    if (!sameOrigin(req)) return send(res, 403, { error: 'This request could not be verified. Reload the page and try again.' });
    if (!rateLimit(req, res)) return;
  }
  if (req.method === 'POST' && url.pathname === '/api/signup') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 50);
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return send(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 128) return send(res, 400, { error: 'Use a password between 10 and 128 characters.' });
    if (!name) return send(res, 400, { error: 'Please enter your name.' });
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    const user = { id: crypto.randomUUID(), email, name, salt: salt.toString('hex'), passwordHash: hash.toString('hex'), list: [], createdAt: new Date().toISOString() };
    if (pgPool) {
      try { await pgPool.query('INSERT INTO yugen_users (id,email,name,salt,password_hash) VALUES ($1,$2,$3,$4,$5)', [user.id,email,name,user.salt,user.passwordHash]); }
      catch (error) { if (error.code === '23505') return send(res, 409, { error: 'An account with this email already exists. Try signing in.' }); throw error; }
    } else {
      const users = await readUsers();
      if (users[email]) return send(res, 409, { error: 'An account with this email already exists. Try signing in.' });
      users[email] = user;
      await saveUsers(users);
    }
    return await issueSession(user, req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const users = pgPool ? null : await readUsers();
    let user;
    if (pgPool) {
      const result = await pgPool.query('SELECT id,email,name,salt,password_hash,list FROM yugen_users WHERE email=$1', [email]);
      const row = result.rows[0];
      if (row) user = { id: row.id, email: row.email, name: row.name, salt: row.salt, passwordHash: row.password_hash, list: row.list || [] };
    } else user = users[email];
    if (!user || password.length > 128) return send(res, 401, { error: 'Email or password is incorrect.' });
    const supplied = await scrypt(password, Buffer.from(user.salt, 'hex'), 64);
    const expected = Buffer.from(user.passwordHash, 'hex');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(res, 401, { error: 'Email or password is incorrect.' });
    return await issueSession(user, req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = cookieToken(req);
    sessions.delete(token);
    if (pgPool && token) await pgPool.query('DELETE FROM yugen_sessions WHERE token_hash=$1', [tokenDigest(token)]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, true) });
  }
  if (url.pathname === '/api/list' && (req.method === 'GET' || req.method === 'PUT')) {
    const user = await findSessionUser(req);
    if (!user) return send(res, 401, { error: 'Sign in to sync your list.' });
    if (req.method === 'GET') return send(res, 200, { list: user.list || [] });
    if (!sameOrigin(req)) return send(res, 403, { error: 'This request could not be verified. Reload the page and try again.' });
    const body = await readBody(req);
    user.list = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter(id => typeof id === 'string' && id.length <= 80))].slice(0, 300);
    if (pgPool) await pgPool.query('UPDATE yugen_users SET list=$1::jsonb WHERE id=$2', [JSON.stringify(user.list), user.id]);
    else {
      const users = await readUsers();
      const stored = Object.values(users).find(candidate => candidate.id === user.id);
      if (!stored) return send(res, 401, { error: 'Sign in to sync your list.' });
      stored.list = user.list;
      await saveUsers(users);
    }
    return send(res, 200, { list: user.list });
  }
  return send(res, 404, { error: 'Not found.' });
}
async function serve(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { return await api(req, res, url); }
    catch (error) { return send(res, error.status || 500, { error: error.status ? error.message : 'The account service had a problem. Please try again.' }); }
  }
  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Method not allowed.' });
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!PUBLIC_FILES.has(relative)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  const file = path.resolve(ROOT, relative);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  if (file === DATA_PATH || file.startsWith(DATA_PATH + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  try {
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
}

if (process.env.NODE_ENV === 'production' && !pgPool) {
  console.error('DATABASE_URL is required in production; refusing to store public accounts in a local file.');
  process.exit(1);
}
initializeDatabase().then(() => {
  http.createServer(serve).listen(PORT, HOST, () => {
    console.log(`Yūgen is available at http://${HOST}:${PORT}`);
    console.log(pgPool ? 'Using PostgreSQL for accounts and watchlists.' : `Local mode: account data will be stored in ${DATA_DIR}`);
  });
}).catch(error => {
  console.error('Could not initialize account storage:', error.message);
  process.exit(1);
});

