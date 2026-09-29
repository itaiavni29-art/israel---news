// Diagnose missed events: re-cluster the current headline pool at several thresholds and list
// multi-source stories from the last few hours that are NOT among the detected events.
//   node scripts/diagnose.js <state.json> [hours]
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { buildFilter } from '../src/filters.js';
import { articleKey } from '../src/feeds.js';
import { Embedder } from '../src/embedder.js';
import { EventStore } from '../src/events.js';
import { isHebrew } from '../src/text.js';

const [file, hours = '4'] = process.argv.slice(2);
const cfg = loadConfig();
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const now = s.lastScan?.at ?? Date.now();
const since = now - +hours * 3600_000;
const detected = new Set([...s.store.active, ...s.store.retired].flatMap(e => e.articles.map(a => a.key)));

const pool = [];
for (const src of cfg.sources.filter(x => x.enabled !== false)) {
  const reject = buildFilter(src, cfg.globalFilters);
  for (const url of src.feeds) for (const it of s.feeds[url]?.items ?? [])
    if (!reject(it) && it.publishedAt && now - it.publishedAt < 24 * 3600_000) pool.push({ ...it, key: articleKey(it.link), sourceId: src.id });
}
const uniq = [...new Map(pool.map(a => [a.key, a])).values()];
const recent = uniq.filter(a => a.publishedAt >= since);
console.log(`pool ${uniq.length} headlines (24h), ${recent.length} in the last ${hours}h; per source:`,
  Object.fromEntries(cfg.sources.filter(x => x.enabled !== false).map(x => [x.id, recent.filter(a => a.sourceId === x.id).length])));

const emb = new Embedder(cfg.embeddingModel);
const vecs = await emb.embed(recent.map(a => a.title));
const arts = recent.map((a, i) => ({ ...a, vec: vecs[i], hebrew: isHebrew(a.title) }));
const il = t => new Date(t).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
for (const th of [0.89, 0.87, 0.86, 0.85]) {
  const st = new EventStore({ maxEvents: 1000, minSources: 2, similarityThreshold: th, crossLanguageThreshold: 0.84 });
  st.update(arts, now);
  const missed = st.active.filter(e => !e.articles.some(a => detected.has(a.key)));
  console.log(`\n== threshold ${th}: ${st.active.length} multi-source stories in ${hours}h, ${missed.length} not detected by the live system`);
  if (th === +process.env.SHOW) for (const e of missed) console.log(`  [${[...new Set(e.articles.map(a => a.sourceId))]}] ${e.articles.map(a => il(a.publishedAt) + ' ' + a.title.slice(0, 48)).join('  ||  ')}`);
}
