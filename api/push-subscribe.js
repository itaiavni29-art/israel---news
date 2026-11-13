// /api/push-subscribe — a browser asks for notifications (POST, its push subscription) or stops them (DELETE).
import { body, json, subKey, validSubscription, saveSubscription, removeSubscription, storeReady } from './_push.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return json(res, 405, { error: 'method' });
  if (!storeReady()) return json(res, 503, { error: 'not ready' });
  const s = await body(req);
  if (req.method === 'DELETE') {
    if (typeof s?.endpoint !== 'string') return json(res, 400, { error: 'endpoint' });
    await removeSubscription(subKey(s.endpoint));
    return json(res, 200, { ok: true });
  }
  if (!validSubscription(s)) return json(res, 400, { error: 'subscription' });
  await saveSubscription({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, at: Date.now() });
  json(res, 200, { ok: true });
}
