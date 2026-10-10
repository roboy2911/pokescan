// Grader tuning samples — part of the Cloudflare Worker (tools/au-sold-worker.js).
//
// From the grader's report, the owner can send that grading's photos with their own verdict
// (the card's real condition / PSA grade), to tune the grader on real cards. Each sample gets a
// random code (e.g. "K7Q2-M9XD") that the owner passes on; anyone with the code can read it,
// nobody can list them. Kept 60 days.
//
// POST /grade-sample  { card, verdict, report, images: { front, back, tilt1?, tilt2?, frontRaw?, backRaw? } (JPEG base64) }
//   → { ok, code }
// GET  /grade-sample?code=K7Q2-M9XD  → the sample
//
// KV (AU_KV): gs:<code> (the sample), gscount:<day> (a daily cap).

const MAX_BYTES = 12e6;
const DAILY_CAP = 60;
const KEEP_DAYS = 60;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L

const newCode = () => {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const c = [...r].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

export async function handleGradeSample(request, env, url, reply) {
  if (!env.AU_KV) return reply({ ok: false, reason: 'no-storage' }, 500);
  if (request.method === 'GET') {
    const code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8) return reply({ ok: false, reason: 'code' }, 400);
    const v = await env.AU_KV.get(`gs:${code.slice(0, 4)}-${code.slice(4)}`);
    if (!v) return reply({ ok: false, reason: 'not-found' }, 404);
    return new Response(v, { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
  }
  if (request.method !== 'POST') return reply({ ok: false, reason: 'method' }, 405);
  const text = await request.text();
  if (text.length > MAX_BYTES) return reply({ ok: false, reason: 'too-big' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return reply({ ok: false, reason: 'json' }, 400); }
  if (!body?.images?.front || typeof body.images.front !== 'string') return reply({ ok: false, reason: 'images' }, 400);
  const day = new Date().toISOString().slice(0, 10);
  const countKey = `gscount:${day}`;
  const used = Number(await env.AU_KV.get(countKey)) || 0;
  if (used >= DAILY_CAP) return reply({ ok: false, reason: 'daily-limit' }, 429);
  await env.AU_KV.put(countKey, String(used + 1), { expirationTtl: 2 * 86400 });
  const code = newCode();
  const sample = { code, at: new Date().toISOString(), card: body.card ?? null, verdict: body.verdict ?? null, report: body.report ?? null, images: body.images };
  await env.AU_KV.put(`gs:${code}`, JSON.stringify(sample), { expirationTtl: KEEP_DAYS * 86400 });
  return reply({ ok: true, code });
}
