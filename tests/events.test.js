// EventStore rules with synthetic vectors (no model needed): distinct-source minimum,
// 10-event cap by detection time, stable position on updates, retired events absorbing follow-ups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore, pickHeadline, presentEvent } from '../src/events.js';

// Unit vector pointing mostly along axis `topic` — same topic ⇒ cosine ≈ 0.995, different ⇒ ≈ 0.
function vec(topic, jitter = 0) {
  const v = new Float32Array(64);
  v[topic] = 1;
  v[(topic + 17 + jitter) % 64] = 0.1;
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}
let k = 0;
const art = (sourceId, topic, title = `כותרת בנושא ${topic} מאת ${sourceId}`, jitter = 0) =>
  ({ key: `k${k++}`, sourceId, title, link: `https://example.com/${k}`, publishedAt: Date.now(), vec: vec(topic, jitter) });
const store = (o = {}) => new EventStore({ maxEvents: 10, minSources: 2, similarityThreshold: 0.89, ...o });

test('two articles from the SAME source do not make an event', () => {
  const s = store();
  const r = s.update([art('ynet', 1), art('ynet', 1, 'עוד כותרת', 1)], 1000);
  assert.equal(r.created.length, 0);
  assert.equal(s.active.length, 0);
});

test('two different sources on the same event create one event; unrelated story stays out', () => {
  const s = store();
  const r = s.update([art('ynet', 1), art('maariv', 1), art('haaretz', 2)], 1000);
  assert.equal(r.created.length, 1);
  assert.deepEqual(new Set(s.active[0].articles.map(a => a.sourceId)), new Set(['ynet', 'maariv']));
});

test('a single-source story becomes an event when a second source arrives later', () => {
  const s = store();
  const a = art('ynet', 3);
  s.update([a], 1000);
  assert.equal(s.active.length, 0);
  s.update([a, art('globes', 3)], 2000);
  assert.equal(s.active.length, 1);
  assert.equal(s.active[0].detectedAt, 2000);
});

test('minSources is configurable (3)', () => {
  const s = store({ minSources: 3 });
  const pool = [art('ynet', 4), art('maariv', 4)];
  s.update(pool, 1000);
  assert.equal(s.active.length, 0); // 2 sources are not enough
  s.update([...pool, art('haaretz', 4)], 2000); // the scanner passes the whole pool every scan
  assert.equal(s.active.length, 1);
});

test('cap of 10: the event with the OLDEST detection time is removed', () => {
  const s = store();
  for (let t = 0; t < 10; t++) s.update([art('ynet', 10 + t), art('maariv', 10 + t)], 1000 + t);
  assert.equal(s.active.length, 10);
  const oldest = s.active.find(e => e.detectedAt === 1000);
  const r = s.update([art('ynet', 40), art('haaretz', 40)], 5000);
  assert.equal(s.active.length, 10);
  assert.equal(r.retired.length, 1);
  assert.equal(r.retired[0].id, oldest.id);
  assert.ok(!s.active.some(e => e.id === oldest.id));
});

test('new coverage updates sources but keeps detection time and list position', () => {
  const s = store();
  s.update([art('ynet', 20), art('maariv', 20)], 1000);
  s.update([art('ynet', 21), art('maariv', 21)], 2000);
  const before = s.active.map(e => e.id);
  const target = s.active.find(e => e.detectedAt === 1000);
  const r = s.update([art('haaretz', 20), art('globes', 20)], 3000);
  assert.equal(r.created.length, 0);
  assert.deepEqual(s.active.map(e => e.id), before);         // order unchanged
  assert.equal(target.detectedAt, 1000);                       // first-detection time preserved
  assert.equal(new Set(target.articles.map(a => a.sourceId)).size, 4);
});

test('a retired event absorbs its follow-ups instead of re-appearing as "new"', () => {
  const s = store({ maxEvents: 1 });
  s.update([art('ynet', 30), art('maariv', 30)], 1000);
  s.update([art('ynet', 31), art('maariv', 31)], 2000); // evicts topic 30
  const r = s.update([art('haaretz', 30), art('globes', 30)], 3000);
  assert.equal(r.created.length, 0);
  assert.equal(s.active[0].detectedAt, 2000);
});

test('state survives save/load', () => {
  const s = store();
  s.update([art('ynet', 50), art('maariv', 50)], 1000);
  const copy = store();
  copy.load(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(copy.active[0].detectedAt, 1000);
  assert.equal(copy.update([art('haaretz', 50)], 2000).created.length, 0); // joins restored event
});

test('disabling a source removes its articles; events left with one source are dropped', () => {
  const s = store();
  s.update([art('ynet', 70), art('jpost', 70)], 1000);
  s.update([art('ynet', 71), art('maariv', 71), art('jpost', 71)], 2000);
  s.removeSources(['jpost']);
  assert.equal(s.active.length, 1);
  assert.deepEqual(new Set(s.active[0].articles.map(a => a.sourceId)), new Set(['ynet', 'maariv']));
});

test('headline: prefers Hebrew, then the shortest among the most representative', () => {
  const ev = { articles: [
    { ...art('jpost', 60, 'Netanyahu met Trump at the White House'), hebrew: false },
    { ...art('ynet', 60, 'נתניהו נפגש עם טראמפ בבית הלבן', 1), hebrew: true },
    { ...art('maariv', 60, 'פגישה ארוכה בין נתניהו לטראמפ התקיימה היום בבית הלבן בוושינגטון', 2), hebrew: true },
  ] };
  assert.equal(pickHeadline(ev).title, 'נתניהו נפגש עם טראמפ בבית הלבן');
  const view = presentEvent({ id: 'x', detectedAt: 1, lastUpdatedAt: 1, ...ev }, { ynet: { name: 'ynet', color: '#f00' } });
  assert.equal(view.sourceCount, 3);
  assert.ok(view.articles.every(a => Object.keys(a).every(k => ['sourceId', 'sourceName', 'color', 'title', 'link', 'publishedAt'].includes(k))));
});
