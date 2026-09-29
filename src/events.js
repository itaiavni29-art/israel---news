// Event detection: group headlines by meaning and keep at most `maxEvents` multi-source events.
//
// Similarity between two headlines is the cosine of their embeddings. Because cross-language
// pairs (Hebrew ↔ English) score systematically lower, each pair is compared against its own
// threshold, and we work with the *margin* = similarity − threshold (≥ 0 means "same event").
//
// 1. A new headline first tries to join an existing event (active or retired): it joins the event
//    whose members it matches best on average (average margin ≥ 0).
// 2. Headlines that joined nothing are clustered among themselves with average-linkage
//    agglomerative clustering (clusters merge only while their average margin stays ≥ 0 —
//    this avoids "chaining" unrelated stories through one ambiguous headline).
// 3. A cluster becomes an event only when it has ≥ minSources DIFFERENT sources.
// 4. The event list is capped at maxEvents; when full, the event with the oldest detection time
//    is retired. Retired events keep absorbing their follow-up headlines (hidden), so an evicted
//    story does not immediately re-enter as a "new" event.
import { randomUUID } from 'node:crypto';
import { cosine } from './embedder.js';
import { isHebrew, cleanTitle } from './text.js';

export class EventStore {
  constructor({ maxEvents = 10, minSources = 2, similarityThreshold, crossLanguageThreshold, retentionMs = 24 * 3600_000 }) {
    Object.assign(this, { maxEvents, minSources, similarityThreshold, retentionMs });
    this.crossLanguageThreshold = crossLanguageThreshold ?? similarityThreshold;
    this.active = [];   // shown events
    this.retired = [];  // evicted events that still absorb their follow-ups
    this.assigned = new Map(); // article key -> event id
  }

  margin(a, b) {
    const th = a.hebrew === b.hebrew ? this.similarityThreshold : this.crossLanguageThreshold;
    return cosine(a.vec, b.vec) - th;
  }

  avgMargin(article, members) {
    let s = 0;
    for (const m of members) s += this.margin(article, m);
    return s / members.length;
  }

  /**
   * @param {Array<{key,sourceId,title,link,publishedAt,vec:Float32Array|number[]}>} articles current pool (all feeds)
   * @param {number} now
   * @returns {{created: object[], updated: object[], retired: object[]}}
   */
  update(articles, now = Date.now()) {
    const created = [], updated = new Set(), retired = [];
    const fresh = articles
      .filter(a => !this.assigned.has(a.key))
      .map(a => ({ ...a, hebrew: a.hebrew ?? isHebrew(a.title), firstSeenAt: a.firstSeenAt ?? now }));

    // 1. Attach to existing events.
    const pool = [];
    for (const a of fresh) {
      let best = null, bestScore = 0;
      for (const ev of [...this.active, ...this.retired]) {
        const score = this.avgMargin(a, ev.articles);
        if (score >= bestScore) { best = ev; bestScore = score; }
      }
      if (best) {
        best.articles.push(a);
        best.lastUpdatedAt = now;
        this.assigned.set(a.key, best.id);
        if (this.active.includes(best)) updated.add(best);
      } else pool.push(a);
    }

    // 2–3. Cluster the rest; promote clusters with enough distinct sources.
    for (const members of this.cluster(pool)) {
      const sources = new Set(members.map(m => m.sourceId));
      if (sources.size < this.minSources) continue;
      const ev = { id: randomUUID(), detectedAt: now, lastUpdatedAt: now, articles: members };
      members.forEach(m => this.assigned.set(m.key, ev.id));
      this.active.push(ev);
      created.push(ev);
    }

    // 3b. Merge events that turned out to be the same story (e.g. a new headline bridged two of them).
    for (const merged of this.mergeDuplicates()) { updated.add(merged.into); created.splice(0, created.length, ...created.filter(e => e !== merged.gone)); updated.delete(merged.gone); }

    // 4. Enforce the cap: retire by oldest detection time (ties → the one whose news is stalest).
    this.active.sort((a, b) => b.detectedAt - a.detectedAt || latest(b) - latest(a));
    while (this.active.length > this.maxEvents) {
      const ev = this.active.pop();
      ev.retiredAt = now;
      this.retired.push(ev);
      retired.push(ev);
      updated.delete(ev);
    }

    this.prune(now);
    return { created: created.filter(e => this.active.includes(e)), updated: [...updated], retired };
  }

  /**
   * Merge active events whose articles are, on average, similar enough to be one story — the same
   * average-margin rule used everywhere else. The merged event keeps the OLDER detection time, so its
   * position in the list does not change. Repeats until no pair qualifies.
   * @returns {{into: object, gone: object}[]}
   */
  mergeDuplicates() {
    const merges = [];
    for (;;) {
      let best = null, bestScore = 0;
      for (let i = 0; i < this.active.length; i++)
        for (let j = i + 1; j < this.active.length; j++) {
          let s = 0;
          for (const a of this.active[i].articles) s += this.avgMargin(a, this.active[j].articles);
          s /= this.active[i].articles.length;
          if (s >= bestScore) { bestScore = s; best = [this.active[i], this.active[j]]; }
        }
      if (!best) return merges;
      const [into, gone] = best[0].detectedAt <= best[1].detectedAt ? best : [best[1], best[0]];
      into.articles.push(...gone.articles);
      into.lastUpdatedAt = Math.max(into.lastUpdatedAt, gone.lastUpdatedAt);
      for (const a of gone.articles) this.assigned.set(a.key, into.id);
      this.active = this.active.filter(e => e !== gone);
      merges.push({ into, gone });
    }
  }

  // Average-linkage agglomerative clustering on margins.
  cluster(items) {
    const n = items.length;
    if (!n) return [];
    const clusters = items.map((it, i) => ({ members: [it], alive: true, i }));
    // sum[i][j] = total margin between members of cluster i and cluster j
    const sum = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) sum[i][j] = sum[j][i] = this.margin(items[i], items[j]);

    for (;;) {
      let bi = -1, bj = -1, best = 0;
      for (let i = 0; i < n; i++) {
        if (!clusters[i].alive) continue;
        for (let j = i + 1; j < n; j++) {
          if (!clusters[j].alive) continue;
          const avg = sum[i][j] / (clusters[i].members.length * clusters[j].members.length);
          if (avg >= best) { best = avg; bi = i; bj = j; }
        }
      }
      if (bi < 0) break;
      // merge j into i
      clusters[bi].members.push(...clusters[bj].members);
      clusters[bj].alive = false;
      for (let k = 0; k < n; k++) { sum[bi][k] += sum[bj][k]; sum[k][bi] = sum[bi][k]; }
    }
    return clusters.filter(c => c.alive).map(c => c.members);
  }

  prune(now) {
    const cutoff = now - this.retentionMs;
    const [keep, drop] = partition(this.retired, ev => latest(ev) >= cutoff);
    this.retired = keep;
    for (const ev of drop) for (const a of ev.articles) this.assigned.delete(a.key);
  }

  /** Remove articles of disabled sources; events left with too few sources are dropped. */
  removeSources(sourceIds) {
    const gone = new Set(sourceIds);
    const clean = list => list.filter(ev => {
      ev.articles = ev.articles.filter(a => !gone.has(a.sourceId));
      return new Set(ev.articles.map(a => a.sourceId)).size >= this.minSources;
    });
    this.active = clean(this.active);
    this.retired = clean(this.retired);
    this.assigned = new Map();
    for (const ev of [...this.active, ...this.retired]) for (const a of ev.articles) this.assigned.set(a.key, ev.id);
  }

  get(id) { return this.active.find(e => e.id === id) ?? null; }

  toJSON() {
    const ser = ev => ({ ...ev, articles: ev.articles.map(a => ({ ...a, vec: Array.from(a.vec, x => +x.toFixed(5)) })) });
    return { active: this.active.map(ser), retired: this.retired.map(ser) };
  }

  load(json) {
    const de = ev => ({ ...ev, articles: ev.articles.map(a => ({ ...a, vec: Float32Array.from(a.vec) })) });
    this.active = (json.active ?? []).map(de);
    this.retired = (json.retired ?? []).map(de);
    this.assigned = new Map();
    for (const ev of [...this.active, ...this.retired]) for (const a of ev.articles) this.assigned.set(a.key, ev.id);
  }
}

export const latest = ev => Math.max(...ev.articles.map(a => a.publishedAt ?? 0));

/** Pick the event headline: among the most representative Hebrew headlines, the shortest. */
export function pickHeadline(ev) {
  const heb = ev.articles.filter(a => a.hebrew);
  const cands = heb.length ? heb : ev.articles;
  if (cands.length === 1) return cands[0];
  const centrality = cands.map(a => ev.articles.reduce((s, b) => s + (a === b ? 0 : cosine(a.vec, b.vec)), 0) / (ev.articles.length - 1));
  const top = Math.max(...centrality);
  const words = a => cleanTitle(a.title).split(' ').length;
  return cands
    .filter((a, i) => centrality[i] >= top - 0.03 && words(a) >= 4)
    .sort((a, b) => cleanTitle(a.title).length - cleanTitle(b.title).length)[0]
    ?? cands[centrality.indexOf(top)];
}

/** Public, copy-free view of an event: headlines and links only. */
export function presentEvent(ev, sourcesById) {
  const bySource = new Map();
  for (const a of [...ev.articles].sort((x, y) => (x.publishedAt ?? 0) - (y.publishedAt ?? 0)))
    if (!bySource.has(a.sourceId)) bySource.set(a.sourceId, a); // earliest article per source
  const head = pickHeadline(ev);
  return {
    id: ev.id,
    detectedAt: ev.detectedAt,
    lastUpdatedAt: ev.lastUpdatedAt,
    title: head.title,
    sourceCount: bySource.size,
    sources: [...bySource.keys()].map(id => ({ id, name: sourcesById[id]?.name ?? id, color: sourcesById[id]?.color ?? '#666' })),
    articles: [...ev.articles]
      .sort((x, y) => (x.publishedAt ?? 0) - (y.publishedAt ?? 0))
      .map(a => ({ sourceId: a.sourceId, sourceName: sourcesById[a.sourceId]?.name ?? a.sourceId,
        color: sourcesById[a.sourceId]?.color ?? '#666', title: a.title, link: a.link, publishedAt: a.publishedAt })),
  };
}

function partition(arr, pred) {
  const a = [], b = [];
  for (const x of arr) (pred(x) ? a : b).push(x);
  return [a, b];
}
