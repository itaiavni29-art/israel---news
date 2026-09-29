// Evaluate event detection on hand-labelled REAL headlines (tests/fixtures/labeled.json).
//
//   node scripts/eval.js                 # model + thresholds from config.json
//   node scripts/eval.js <hf-model-id>   # try another model
//   VERBOSE=1 node scripts/eval.js       # list every mistake
//
// Reports three things:
//   1. Pair accuracy: for every labelled pair, is "similarity ≥ threshold" the right answer?
//   2. Honest (out-of-sample) accuracy: 2-fold cross-validation — the threshold is tuned on half
//      of the events and measured on the other half, so it is not graded on its own training data.
//   3. End-to-end: the real EventStore clusters the whole snapshot (all ~240 headlines, not only the
//      labelled ones); we check that labelled events end up together and hard negatives apart.
import fs from 'node:fs';
import { Embedder, cosine } from '../src/embedder.js';
import { EventStore } from '../src/events.js';
import { loadConfig, ROOT } from '../src/config.js';
import { isHebrew } from '../src/text.js';

const config = loadConfig();
const model = process.argv[2] ?? config.embeddingModel;
const TH = +(process.env.THRESHOLD ?? config.similarityThreshold), CROSS = +(process.env.CROSS_THRESHOLD ?? config.crossLanguageThreshold ?? TH);
const data = JSON.parse(fs.readFileSync(`${ROOT}/tests/fixtures/labeled.json`, 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(`${ROOT}/${data.snapshot}`, 'utf8'));

const pairs = [];
data.groups.forEach((g, gi) => {
  for (let i = 0; i < g.articles.length; i++)
    for (let j = i + 1; j < g.articles.length; j++) pairs.push({ a: g.articles[i].title, b: g.articles[j].title, same: true, fold: gi % 2, why: g.event });
});
data.negatives.forEach((n, ni) => pairs.push({ a: n.a.title, b: n.b.title, same: false, fold: ni % 2, why: n.why }));

const rss0 = process.memoryUsage().rss;
const emb = new Embedder(model);
let t = performance.now();
await emb.load();
const loadMs = performance.now() - t;
const allTitles = [...new Set([...snapshot.map(a => a.title), ...pairs.flatMap(p => [p.a, p.b])])];
t = performance.now();
const vecs = new Map((await emb.embed(allTitles)).map((v, i) => [allTitles[i], v]));
const msPerTitle = (performance.now() - t) / allTitles.length;
const ramMb = (process.memoryUsage().rss - rss0) / 2 ** 20;

for (const p of pairs) { p.sim = cosine(vecs.get(p.a), vecs.get(p.b)); p.cross = isHebrew(p.a) !== isHebrew(p.b); }
const correct = (p, th, cross) => (p.sim >= (p.cross ? cross : th)) === p.same;
const acc = (ps, th, cross) => ps.filter(p => correct(p, th, cross)).length / ps.length;
const pct = x => (100 * x).toFixed(1) + '%';

console.log(`model ${model}`);
console.log(`  load ${(loadMs / 1000).toFixed(1)}s, ${msPerTitle.toFixed(1)} ms per headline, ~${ramMb.toFixed(0)} MB RAM, ${vecs.get(allTitles[0]).length}-dim vectors`);
console.log(`  data: ${data.groups.length} labelled events → ${pairs.filter(p => p.same).length} same-event pairs, ${pairs.filter(p => !p.same).length} hard different-event pairs (from ${data.snapshot})`);

// 1. Pair accuracy at the configured thresholds.
const same = pairs.filter(p => p.same), diff = pairs.filter(p => !p.same);
console.log(`\n1) Pair accuracy @ threshold ${TH} (cross-language ${CROSS})`);
console.log(`   accuracy ${pct(acc(pairs, TH, CROSS))} | same-event found ${pct(acc(same, TH, CROSS))} | different-event kept apart ${pct(acc(diff, TH, CROSS))}`);
const heOnly = pairs.filter(p => !p.cross);
console.log(`   Hebrew↔Hebrew only: ${pct(acc(heOnly, TH, CROSS))} of ${heOnly.length} pairs;  Hebrew↔English: ${pct(acc(pairs.filter(p => p.cross), TH, CROSS))} of ${pairs.length - heOnly.length} pairs`);

// 2. 2-fold cross-validation on the same-language threshold.
const grid = Array.from({ length: 66 }, (_, i) => +(0.3 + i * 0.01).toFixed(2));
let cvCorrect = 0;
const chosen = [];
for (const fold of [0, 1]) {
  const train = pairs.filter(p => p.fold !== fold), test = pairs.filter(p => p.fold === fold);
  const best = grid.reduce((b, th) => (acc(train, th, CROSS) > acc(train, b, CROSS) ? th : b), grid[0]);
  chosen.push(best);
  cvCorrect += test.filter(p => correct(p, best, CROSS)).length;
}
console.log(`\n2) Out-of-sample (2-fold CV): accuracy ${pct(cvCorrect / pairs.length)} (thresholds chosen per fold: ${chosen.join(', ')})`);

// 3. End-to-end clustering of the full snapshot.
const store = new EventStore({ maxEvents: 1000, minSources: 1, similarityThreshold: TH, crossLanguageThreshold: CROSS, eventMergeThreshold: config.eventMergeThreshold, noSharedNamePenalty: +(process.env.PENALTY ?? config.noSharedNamePenalty ?? 0) });
const now = Date.now();
store.update(snapshot.map((a, i) => ({ ...a, key: String(i), publishedAt: Date.parse(a.publishedAt), vec: vecs.get(a.title) })), now);
const clusterOf = new Map();
for (const ev of store.active) for (const a of ev.articles) clusterOf.set(a.title, ev.id);
let togetherPairs = 0, apartNeg = 0, intact = 0;
for (const p of same) if (clusterOf.get(p.a) === clusterOf.get(p.b)) togetherPairs++;
for (const p of diff) if (clusterOf.get(p.a) !== clusterOf.get(p.b)) apartNeg++; else if (process.env.VERBOSE) console.log(`   merged different events: ${p.a.slice(0, 45)} || ${p.b.slice(0, 45)}`);
for (const g of data.groups) if (new Set(g.articles.map(a => clusterOf.get(a.title))).size === 1) intact++;
const multi = store.active.filter(ev => new Set(ev.articles.map(a => a.sourceId)).size >= config.minSources);
console.log(`\n3) End-to-end clustering of all ${snapshot.length} headlines`);
console.log(`   same-event pairs placed together ${pct(togetherPairs / same.length)} | different-event pairs kept apart ${pct(apartNeg / diff.length)} | events fully intact ${intact}/${data.groups.length}`);
console.log(`   → ${multi.length} candidate events with ≥${config.minSources} sources in this snapshot`);

if (process.env.VERBOSE) {
  console.log('\nMistakes at configured thresholds:');
  for (const p of pairs) if (!correct(p, TH, CROSS))
    console.log(`  ${p.same ? 'MISSED' : 'MERGED'} ${p.sim.toFixed(3)} ${p.cross ? '(he↔en)' : ''} | ${p.a.slice(0, 50)} || ${p.b.slice(0, 50)}`);
  console.log('\nMulti-source events found in the snapshot:');
  for (const ev of multi.sort((a, b) => b.articles.length - a.articles.length))
    console.log(`  [${[...new Set(ev.articles.map(a => a.sourceId))].join(',')}] ${ev.articles.map(a => a.title.slice(0, 45)).join('  ||  ')}`);
}
