// Want-list phone notifications (Web Push) — part of the Cloudflare Worker (tools/au-sold-worker.js).
//
// A phone that turns notifications on sends its push subscription and its want list (the eBay
// search for each item and the target price). Every hour (cron in wrangler.jsonc) the worker
// checks each item with a target against eBay Australia listings (the free eBay Browse API —
// never SoldComps) and sends a notification when a copy is listed at or under the target —
// once per price (again only if it gets cheaper).
//
// Storage (AU_KV):
//   vapid            { pub, jwk }   the worker's own signing key pair, made on first use
//   push:<hash>      { sub, wants: [{ key, name, target, q, n, t, s, e }], seen: { key: aud }, at }
//
// GET  /push/key                       → { ok, key }   (public key for pushManager.subscribe)
// POST /push/subscribe { sub, wants }  → { ok, items }  (also used to update the want list)
// POST /push/unsubscribe { endpoint }  → { ok }
// POST /push/test { endpoint }         → { ok }         (sends a test notification)
import { findListings } from './ebay-listings.mjs';

const MAX_WANTS = 60;
const MAX_SUBS = 100;
const KEEP_HOURS = 0.9; // listing answers fresh enough for the hourly check

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const enc = new TextEncoder();
async function sha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function vapid(env) {
  const saved = await env.AU_KV.get('vapid', 'json');
  if (saved) return saved;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { pub: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)), jwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
  await env.AU_KV.put('vapid', JSON.stringify(v));
  return v;
}

/* RFC 8291 (aes128gcm) encryption of the message for one subscription. */
async function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256);
  const hkdf = async (salt, ikm, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));
  const ikm = await hkdf(auth, new Uint8Array(shared), concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, body);
}

/* Send one notification. → HTTP status (404 / 410: the subscription is gone). */
export async function sendPush(env, sub, message) {
  const v = await vapid(env);
  const aud = new URL(sub.endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://roboy2911.github.io/pokescan/' })));
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { authorization: `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.pub}`, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' },
    body: await encrypt(sub, JSON.stringify(message)),
  });
  return res.status;
}

const cleanWants = (wants) => (Array.isArray(wants) ? wants : []).slice(0, MAX_WANTS).filter((w) => w && typeof w.key === 'string' && typeof w.q === 'string')
  .map((w) => ({ key: w.key.slice(0, 60), name: String(w.name || '').slice(0, 80), target: Number(w.target) > 0 ? Number(w.target) : null,
    q: w.q.slice(0, 120), n: String(w.n || '').slice(0, 20), t: String(w.t || '').slice(0, 5), s: String(w.s || '').slice(0, 60), e: String(w.e || '').slice(0, 60) }));
const validSub = (sub) => sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys?.p256dh && sub.keys?.auth;

export async function handlePush(request, env, url, reply) {
  if (!env.AU_KV) return reply({ ok: false, reason: 'no-storage' }, 500);
  if (url.pathname === '/push/key') return reply({ ok: true, key: (await vapid(env)).pub });
  if (request.method !== 'POST') return reply({ ok: false, reason: 'method' }, 405);
  const body = await request.json().catch(() => ({}));
  const endpoint = body.sub?.endpoint || body.endpoint;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) return reply({ ok: false, reason: 'endpoint' }, 400);
  const id = `push:${await sha256(endpoint)}`;
  if (url.pathname === '/push/subscribe') {
    if (!validSub(body.sub)) return reply({ ok: false, reason: 'subscription' }, 400);
    const saved = await env.AU_KV.get(id, 'json');
    if (!saved && (await env.AU_KV.list({ prefix: 'push:', limit: MAX_SUBS })).keys.length >= MAX_SUBS) return reply({ ok: false, reason: 'full' }, 429);
    const wants = cleanWants(body.wants);
    const seen = Object.fromEntries(Object.entries(saved?.seen ?? {}).filter(([k]) => wants.some((w) => w.key === k)));
    await env.AU_KV.put(id, JSON.stringify({ sub: { endpoint, keys: body.sub.keys }, wants, seen, at: new Date().toISOString() }));
    return reply({ ok: true, items: wants.filter((w) => w.target != null).length });
  }
  if (url.pathname === '/push/unsubscribe') {
    await env.AU_KV.delete(id);
    return reply({ ok: true });
  }
  if (url.pathname === '/push/test') {
    const saved = await env.AU_KV.get(id, 'json');
    if (!saved) return reply({ ok: false, reason: 'not-subscribed' }, 404);
    const status = await sendPush(env, saved.sub, { title: 'PokeScan', body: `Notifications are on — you'll hear when a want-list card is listed on eBay Australia at or under your target.`, url: './#collection', tag: 'test' });
    return reply({ ok: status < 300, status });
  }
  return reply({ ok: false, reason: 'not-found' }, 404);
}

/* The hourly check (cron). Each search is shared by every phone that wants the same card. */
export async function checkWants(env) {
  if (!env.AU_KV || !env.EBAY_CLIENT_ID) return;
  const subs = [];
  let cursor;
  do {
    const page = await env.AU_KV.list({ prefix: 'push:', cursor });
    for (const k of page.keys) subs.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const answers = new Map();
  const listing = (w) => {
    const k = `${w.q}|${w.n}|${w.t}|${w.s}|${w.e}`.toLowerCase();
    if (!answers.has(k)) answers.set(k, findListings(env, w, { keepHours: KEEP_HOURS }).catch(() => null));
    return answers.get(k);
  };
  for (const id of subs) {
    const rec = await env.AU_KV.get(id, 'json');
    if (!rec) continue;
    const hits = [];
    let changed = false;
    for (const w of rec.wants.filter((x) => x.target != null)) {
      const r = await listing(w);
      if (!r?.ok) continue;
      const c = r.count ? r.cheapest[0] : null;
      if (!c || c.aud > w.target + 0.005) {
        // Back above the target (or sold out): a new copy at the target is news again.
        if (rec.seen[w.key] != null) { delete rec.seen[w.key]; changed = true; }
        continue;
      }
      if (rec.seen[w.key] != null && c.aud >= rec.seen[w.key] - 0.005) continue; // told at this price already
      hits.push({ w, c, count: r.count });
    }
    if (!hits.length) {
      if (changed) await env.AU_KV.put(id, JSON.stringify(rec));
      continue;
    }
    const msg = hits.length === 1
      ? { title: `🛒 ${hits[0].w.name} — A$${hits[0].c.aud.toFixed(2)}`, body: `For sale on eBay Australia at or under your A$${hits[0].w.target} target (${hits[0].count} listed). Tap to open the listing.`, url: hits[0].c.url, tag: hits[0].w.key }
      : { title: `🛒 ${hits.length} want-list cards are at your target`, body: hits.slice(0, 4).map((h) => `${h.w.name} A$${h.c.aud.toFixed(2)}`).join(' · '), url: './#wants', tag: 'wants' };
    const status = await sendPush(env, rec.sub, msg).catch(() => 0);
    if (status === 404 || status === 410) { await env.AU_KV.delete(id); continue; }
    if (status >= 200 && status < 300) {
      for (const h of hits) rec.seen[h.w.key] = h.c.aud;
      await env.AU_KV.put(id, JSON.stringify(rec));
    }
  }
}
