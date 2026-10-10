// PokeScan accounts and collection sync — part of the Cloudflare Worker (tools/au-sold-worker.js).
//
// Anyone can sign up with a username and password. The app never sends the password: it sends
// a key derived from it in the browser (PBKDF2-SHA256, 150,000 rounds, salted with the
// username — the slow part, done on the phone), and the worker stores only a salted SHA-256
// of that key. Sessions are random tokens; the worker keeps only their SHA-256.
//
// Storage (the AU_KV namespace, key prefixes):
//   user:<name>  { salt, hash, created }
//   sess:<sha256(token)>  { user }              (expires after SESSION_DAYS)
//   coll:<name>  { rev, updatedAt, collection }  (the user's collection, as the app stores it)
//   fail:<name>  failed logins in the last 15 min;  signup:<ip>  signups from an IP today
//
// POST /auth/signup  { username, key }      → { ok, username, token } | 409 taken
// POST /auth/login   { username, key }      → { ok, username, token } | 401 | 429 (too many tries)
// POST /auth/logout  (Authorization: Bearer <token>)
// GET  /sync         (Bearer)               → { ok, rev, updatedAt, collection | null }
// PUT  /sync         (Bearer) { base, collection } → { ok, rev, updatedAt }
//                    | 409 { rev, collection } when someone else saved since `base` (the app merges)

const SESSION_DAYS = 120;
const MAX_FAILS = 10;           // per username per 15 minutes
const MAX_SIGNUPS_PER_IP = 5;   // per day
const MAX_COLLECTION = 2e6;     // bytes of JSON
export const USERNAME = /^[a-z0-9_]{3,20}$/;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function newSession(env, user) {
  const token = randomHex(32);
  await env.AU_KV.put(`sess:${await sha256(token)}`, JSON.stringify({ user }), { expirationTtl: SESSION_DAYS * 86400 });
  return token;
}

async function sessionUser(request, env) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const s = await env.AU_KV.get(`sess:${await sha256(m[1])}`, 'json');
  return s?.user ?? null;
}

/* Handles /auth/* and /sync. `reply(body, status)` makes the JSON response (with CORS). */
export async function handleAccount(request, env, url, reply) {
  if (!env.AU_KV) return reply({ ok: false, reason: 'no-storage' }, 500);
  const path = url.pathname;

  if (path === '/auth/signup' || path === '/auth/login') {
    if (request.method !== 'POST') return reply({ ok: false, reason: 'method' }, 405);
    const body = await readJson(request);
    const username = String(body?.username || '').trim().toLowerCase();
    const key = String(body?.key || '');
    if (!USERNAME.test(username)) return reply({ ok: false, reason: 'username' }, 400);
    if (!/^[0-9a-f]{64}$/.test(key)) return reply({ ok: false, reason: 'key' }, 400);
    const userKey = `user:${username}`;

    if (path === '/auth/signup') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const ipKey = `signup:${await sha256(ip)}`;
      const count = Number(await env.AU_KV.get(ipKey)) || 0;
      if (count >= MAX_SIGNUPS_PER_IP) return reply({ ok: false, reason: 'too-many-signups' }, 429);
      if (await env.AU_KV.get(userKey)) return reply({ ok: false, reason: 'taken' }, 409);
      const salt = randomHex(16);
      await env.AU_KV.put(userKey, JSON.stringify({ salt, hash: await sha256(salt + key), created: new Date().toISOString() }));
      await env.AU_KV.put(ipKey, String(count + 1), { expirationTtl: 86400 });
      return reply({ ok: true, username, token: await newSession(env, username) });
    }

    const failKey = `fail:${username}`;
    const fails = Number(await env.AU_KV.get(failKey)) || 0;
    if (fails >= MAX_FAILS) return reply({ ok: false, reason: 'too-many-tries' }, 429);
    const user = await env.AU_KV.get(userKey, 'json');
    if (!user || await sha256(user.salt + key) !== user.hash) {
      await env.AU_KV.put(failKey, String(fails + 1), { expirationTtl: 900 });
      return reply({ ok: false, reason: 'wrong' }, 401);
    }
    return reply({ ok: true, username, token: await newSession(env, username) });
  }

  if (path === '/auth/logout') {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
    if (m) await env.AU_KV.delete(`sess:${await sha256(m[1])}`);
    return reply({ ok: true });
  }

  if (path === '/sync') {
    const user = await sessionUser(request, env);
    if (!user) return reply({ ok: false, reason: 'login' }, 401);
    const collKey = `coll:${user}`;
    const saved = await env.AU_KV.get(collKey, 'json');
    if (request.method === 'GET') {
      return reply({ ok: true, user, rev: saved?.rev ?? 0, updatedAt: saved?.updatedAt ?? null, collection: saved?.collection ?? null });
    }
    if (request.method !== 'PUT') return reply({ ok: false, reason: 'method' }, 405);
    const text = await request.text();
    if (text.length > MAX_COLLECTION) return reply({ ok: false, reason: 'too-big' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return reply({ ok: false, reason: 'json' }, 400); }
    if (!Array.isArray(body?.collection)) return reply({ ok: false, reason: 'collection' }, 400);
    const rev = saved?.rev ?? 0;
    if (Number(body.base) !== rev) return reply({ ok: false, reason: 'conflict', rev, collection: saved?.collection ?? [] }, 409);
    const next = { rev: rev + 1, updatedAt: new Date().toISOString(), collection: body.collection };
    await env.AU_KV.put(collKey, JSON.stringify(next));
    return reply({ ok: true, rev: next.rev, updatedAt: next.updatedAt });
  }

  return reply({ ok: false, reason: 'not-found' }, 404);
}
