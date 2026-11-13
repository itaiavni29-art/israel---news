// Push notifications: who subscribed, what was already sent. Kept in a small Upstash Redis database connected to the
// project through the Vercel marketplace (its REST address and token are in the project's environment):
//   hash  push:subs   field = sha256 of the endpoint, value = the browser's push subscription (JSON)
//   key   push:state  { sentIds: [...], lastSentAt }
// Sending is signed with the VAPID keys: the public key is in public/app.js, the private one only in Vercel's
// environment (VAPID_PRIVATE_KEY) — never in the repository.
import crypto from 'node:crypto';

export const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? '';
const URL_ = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
export const storeReady = () => !!(URL_ && TOKEN);

async function redis(...command) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}

export const readState = async () => { const s = await redis('GET', 'push:state'); return s ? JSON.parse(s) : null; };
export const writeState = state => redis('SET', 'push:state', JSON.stringify(state));

export const subKey = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 40);
export const saveSubscription = sub => redis('HSET', 'push:subs', subKey(sub.endpoint), JSON.stringify(sub));
export const removeSubscription = key => redis('HDEL', 'push:subs', key).catch(() => {});
export async function allSubscriptions() {
  const flat = (await redis('HGETALL', 'push:subs')) ?? [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push({ key: flat[i], sub: JSON.parse(flat[i + 1]) }); } catch { /* skip a broken entry */ } }
  return out;
}

// Only the browsers' own push services: the server will POST to this address, so nothing else is accepted.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.api\.chromium\.org$/];
export function validSubscription(s) {
  try {
    const u = new URL(s?.endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some(h => h.test(u.hostname)) && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string'
      && s.keys.p256dh.length < 200 && s.keys.auth.length < 100 && s.endpoint.length < 1000;
  } catch { return false; }
}

export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let s = ''; for await (const chunk of req) { s += chunk; if (s.length > 10_000) break; }
  try { return JSON.parse(s || 'null'); } catch { return null; }
}
export function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}
