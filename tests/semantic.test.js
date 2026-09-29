// Semantic tests with the real local model and hand-labelled REAL headlines from the feeds
// (tests/fixtures/labeled.json, built by scripts/build-fixtures.js from a feed snapshot).
// First run downloads the model (~120 MB) into ./models; later runs are offline.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Embedder, cosine } from '../src/embedder.js';
import { EventStore } from '../src/events.js';
import { loadConfig, ROOT } from '../src/config.js';
import { isHebrew } from '../src/text.js';

const config = loadConfig();
const TH = config.similarityThreshold, CROSS = config.crossLanguageThreshold;
const data = JSON.parse(fs.readFileSync(`${ROOT}/tests/fixtures/labeled.json`, 'utf8'));
const emb = new Embedder(config.embeddingModel);
let sim;

before(async () => {
  const titles = [...new Set([...data.groups.flatMap(g => g.articles.map(a => a.title)), ...data.negatives.flatMap(n => [n.a.title, n.b.title]),
    'נתניהו נפגש עם טראמפ בבית הלבן', 'פגישה בין נתניהו לטראמפ התקיימה בבית הלבן'])];
  const v = new Map((await emb.embed(titles)).map((x, i) => [titles[i], x]));
  sim = (a, b) => cosine(v.get(a), v.get(b));
});

const passes = (a, b) => sim(a, b) >= (isHebrew(a) === isHebrew(b) ? TH : CROSS);

test('paraphrases of the same event match (the example from the spec)', () => {
  assert.ok(passes('נתניהו נפגש עם טראמפ בבית הלבן', 'פגישה בין נתניהו לטראמפ התקיימה בבית הלבן'));
});

test('real Hebrew headlines: ≥ 85% pair accuracy at the configured threshold', () => {
  const pairs = [];
  for (const g of data.groups) for (let i = 0; i < g.articles.length; i++) for (let j = i + 1; j < g.articles.length; j++)
    pairs.push([g.articles[i].title, g.articles[j].title, true]);
  for (const n of data.negatives) pairs.push([n.a.title, n.b.title, false]);
  const heb = pairs.filter(([a, b]) => isHebrew(a) && isHebrew(b));
  const acc = heb.filter(([a, b, same]) => passes(a, b) === same).length / heb.length;
  console.log(`   Hebrew pair accuracy: ${(acc * 100).toFixed(1)}% on ${heb.length} pairs`);
  assert.ok(acc >= 0.85, `accuracy ${acc}`);
});

test('hard negatives: similar vocabulary, different events are kept apart (≥ 90%)', () => {
  const heb = data.negatives.filter(n => isHebrew(n.a.title) && isHebrew(n.b.title));
  const apart = heb.filter(n => !passes(n.a.title, n.b.title));
  for (const n of heb) if (passes(n.a.title, n.b.title)) console.log(`   merged: ${n.a.title.slice(0, 40)} || ${n.b.title.slice(0, 40)}`);
  assert.ok(apart.length / heb.length >= 0.9, `${apart.length}/${heb.length}`);
});

test('end-to-end: the big multi-source stories each form one event', async () => {
  const s = new EventStore({ maxEvents: 100, minSources: 2, similarityThreshold: TH, crossLanguageThreshold: CROSS });
  const arts = data.groups.flatMap((g, gi) => g.articles.map((a, i) => ({ ...a, key: `${gi}-${i}`, link: `https://x/${gi}/${i}`, publishedAt: 0 })));
  const vecs = await emb.embed(arts.map(a => a.title));
  s.update(arts.map((a, i) => ({ ...a, vec: vecs[i] })), 1);
  const eventOf = t => s.active.find(e => e.articles.some(a => a.title === t))?.id;
  for (const name of ['רונן בר מגיש תביעת דיבה נגד נתניהו', 'רביב דרוקר זומן לחקירה', 'שחרור החשודים בפיגוע בבסיס בבריטניה', 'מות אופיר שריד', 'האוצר נגד עסקת צים']) {
    const g = data.groups.find(x => x.event === name);
    const ids = new Set(g.articles.map(a => eventOf(a.title)));
    assert.equal(ids.size, 1, `${name} split into ${ids.size}`);
    assert.ok([...ids][0], `${name} did not become an event`);
  }
});
