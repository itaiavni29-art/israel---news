// /api/push-tick — called by the scanner after every scan (every ~10 minutes). Looks at the published events and,
// when a big story has just appeared, notifies every subscribed browser, once per story. Anyone may call it: it
// only ever sends stories it has not sent before, at most one every MIN_GAP, and never at night.
//
// The notification is the one in the promo: the story's headline, and how many sites are covering it now.
import webpush from 'web-push';
import { json, readState, writeState, allSubscriptions, removeSubscription, VAPID_PUBLIC, storeReady } from './_push.js';

const EVENTS = 'https://raw.githubusercontent.com/itaiavni29-art/israel---news/data/events.json';
const SITE = 'https://zmanemetnews.co.il';
const MIN_SOURCES = 4;               // a story that at least this many sites are covering…
const FRESH_MS = 90 * 60_000;        // …that was first seen in the last hour and a half
const MIN_GAP = 30 * 60_000;         // at most one notification every half hour
const QUIET = [23.5, 6.5];           // no notifications between 23:30 and 06:30 (Israel time)

const shortId = id => String(id).replace(/-/g, '').slice(0, 10);
const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(ms);
const hourIL = ms => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms).split(':'); return +h + +m / 60; };

export function pick(events, state, now) {
  const qualifies = e => e.summary?.text && (e.sourceCount >= MIN_SOURCES || e.lead) && now - e.detectedAt < FRESH_MS && !state.sentIds.includes(e.id);
  return events.filter(qualifies).sort((a, b) => b.sourceCount - a.sourceCount || b.detectedAt - a.detectedAt)[0] ?? null;
}

export function message(ev) {
  const names = ev.sources.map(s => s.name), shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  return { title: ev.title, body: `${ev.sourceCount} אתרים מסקרים עכשיו: ${shown}`, url: `${SITE}/e/${dayOf(ev.detectedAt)}/${shortId(ev.id)}`, tag: shortId(ev.id) };
}

export default async function handler(req, res) {
  const now = Date.now();
  if (!process.env.VAPID_PRIVATE_KEY || !VAPID_PUBLIC || !storeReady()) return json(res, 200, { skipped: 'not configured' });
  const state = await readState();
  const data = await fetch(EVENTS + '?t=' + now, { headers: { 'User-Agent': 'zmanemetnews.co.il' } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!data?.events) return json(res, 200, { skipped: 'no events' });

  // first run: whatever is on the site already counts as sent, so nobody gets a pile of old stories
  if (!state) {
    await writeState({ sentIds: data.events.map(e => e.id), lastSentAt: now });
    return json(res, 200, { started: true });
  }
  const h = hourIL(now);
  if (h >= QUIET[0] || h < QUIET[1]) return json(res, 200, { skipped: 'night' });
  if (now - (state.lastSentAt ?? 0) < MIN_GAP) return json(res, 200, { skipped: 'too soon' });
  const ev = pick(data.events, state, now);
  if (!ev) return json(res, 200, { skipped: 'nothing new' });

  // mark it sent before sending, so two ticks at once cannot both send it
  state.sentIds = [ev.id, ...state.sentIds].slice(0, 300); state.lastSentAt = now;
  await writeState(state);

  webpush.setVapidDetails(SITE, VAPID_PUBLIC, process.env.VAPID_PRIVATE_KEY);
  const payload = JSON.stringify(message(ev));
  let sent = 0, gone = 0, failed = 0;
  const subs = await allSubscriptions();
  for (let i = 0; i < subs.length; i += 20) {
    await Promise.all(subs.slice(i, i + 20).map(async ({ key, sub }) => {
      try { await webpush.sendNotification(sub, payload, { TTL: 3 * 3600, urgency: 'high', topic: shortId(ev.id) }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { gone++; await removeSubscription(key); } else failed++; }
    }));
  }
  json(res, 200, { sent, gone, failed, story: ev.title });
}
