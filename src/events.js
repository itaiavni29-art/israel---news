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
import { LexicalIndex } from './lexical.js';

export class EventStore {
  constructor({ maxEvents = 10, minSources = 2, similarityThreshold, crossLanguageThreshold, retentionMs = 24 * 3600_000, singleSourceFallbackMs = 0, eventMergeThreshold, noSharedNamePenalty = 0, storyMergeThreshold = 0, hotNeedsTeaser = false, noHotSources = [] }) {
    this.noHotSources = new Set(noHotSources); // sources that never appear alone as a "hot" story
    this.hotNeedsTeaser = hotNeedsTeaser; // pick single-source "hot" stories only if they can be summarized
    // Events that share a story keyword ("פליי דובאי") merge at this lower average similarity. 0 = off.
    this.storyMergeThreshold = storyMergeThreshold;
    // Hebrew pairs that share no rare word (name, company, place) must be this much more similar.
    this.noSharedNamePenalty = noSharedNamePenalty;
    this.lex = null;
    Object.assign(this, { maxEvents, minSources, similarityThreshold, retentionMs, singleSourceFallbackMs });
    // Existing events merge a little more readily than headlines cluster (see mergeDuplicates).
    this.mergeSlack = Math.max(0, similarityThreshold - (eventMergeThreshold ?? similarityThreshold));
    this.crossLanguageThreshold = crossLanguageThreshold ?? similarityThreshold;
    this.active = [];   // shown events
    this.retired = [];  // evicted events that still absorb their follow-ups
    this.assigned = new Map(); // article key -> event id
    this.lastMultiAt = 0;  // last time a multi-source event was detected
    this.lastSingleAt = 0; // last time a single-source ("hot") story was added
  }

  sourceCount(ev) { return new Set(ev.articles.map(a => a.sourceId)).size; }

  margin(a, b) {
    let th = a.hebrew === b.hebrew ? this.similarityThreshold : this.crossLanguageThreshold;
    if (this.noSharedNamePenalty && this.lex && a.hebrew && b.hebrew && !this.lex.sharesRareWord(a.title, b.title)) th += this.noSharedNamePenalty;
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
    if (this.noSharedNamePenalty || this.storyMergeThreshold) this.lex = new LexicalIndex([...articles, ...this.active, ...this.retired].flatMap(x => x.articles ? x.articles.map(a => a.title) : [x.title]));
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
        if (best.provisional && this.sourceCount(best) >= this.minSources) {
          // A single-source story was just confirmed by another site: it is now a real event,
          // detected now (so it moves to the top), even if it had been pushed out of the list.
          delete best.provisional;
          best.detectedAt = now;
          this.lastMultiAt = now;
          if (!this.active.includes(best)) { this.retired = this.retired.filter(e => e !== best); delete best.retiredAt; this.active.push(best); }
          created.push(best);
        } else if (this.active.includes(best)) updated.add(best);
      } else pool.push(a);
    }

    // 2–3. Cluster the rest; promote clusters with enough distinct sources.
    const leftovers = [];
    for (const members of this.cluster(pool)) {
      const sources = new Set(members.map(m => m.sourceId));
      if (sources.size < this.minSources) { leftovers.push(members); continue; }
      const ev = { id: randomUUID(), detectedAt: now, lastUpdatedAt: now, articles: members };
      members.forEach(m => this.assigned.set(m.key, ev.id));
      this.active.push(ev);
      created.push(ev);
      this.lastMultiAt = now;
    }

    // 3a. Quiet period: no multi-source event for singleSourceFallbackMs → add the "hottest" single-source story.
    let single = null;
    if (this.singleSourceFallbackMs > 0 && now - Math.max(this.lastMultiAt, this.lastSingleAt) >= this.singleSourceFallbackMs) {
      single = this.hottest(leftovers, pool, now);
      if (single) {
        const ev = { id: randomUUID(), detectedAt: now, lastUpdatedAt: now, articles: single.members, provisional: true, hot: single.reasons };
        single.members.forEach(m => this.assigned.set(m.key, ev.id));
        this.active.push(ev);
        this.lastSingleAt = now;
        single = ev;
      }
    }

    // 3b. Merge events that turned out to be the same story (e.g. a new headline bridged two of them).
    for (const merged of this.mergeDuplicates()) { updated.add(merged.into); created.splice(0, created.length, ...created.filter(e => e !== merged.gone)); updated.delete(merged.gone); }
    for (const ev of this.active) if (ev.provisional && this.sourceCount(ev) >= this.minSources) delete ev.provisional;

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
    return { created: created.filter(e => this.active.includes(e)), updated: [...updated], retired, single: single && this.active.includes(single) ? single : null };
  }

  /**
   * Pick the single-source story most likely to be big. RSS has no ratings or view counts, so we use
   * what the feeds do tell us, in this order of weight:
   *   • the site published several articles on it (it is investing in the story)       +2 per extra article
   *   • another site has an almost-matching headline (it is spreading)                  +2
   *   • it came from the site's own breaking-news feed                                 +1
   *   • freshness (0..1, newer is better)
   * Only stories published in the last hour qualify.
   */
  hottest(clusters, pool, now) {
    const HOUR = 3600_000;
    let best = null;
    for (const members of clusters) {
      const newest = Math.max(...members.map(m => m.publishedAt ?? 0));
      if (now - newest > HOUR) continue;
      if (members.some(m => this.noHotSources.has(m.sourceId))) continue;
      // With AI summaries on, only stories that came with a real teaser qualify: a bare headline
      // (e.g. a one-line news flash) leaves nothing to summarize, and every card should have a summary.
      if (this.hotNeedsTeaser && !members.some(m => (m.teaser ?? '').split(' ').length >= 12)) continue;
      const reasons = [];
      let score = 1 - (now - newest) / HOUR;
      if (members.length > 1) { score += 2 * (members.length - 1); reasons.push('several-articles'); }
      const src = members[0].sourceId;
      const nearMiss = pool.some(o => o.sourceId !== src && members.some(m => this.margin(m, o) >= -0.04));
      if (nearMiss) { score += 2; reasons.push('near-match-elsewhere'); }
      if (members.some(m => m.breaking)) { score += 1; reasons.push('breaking'); }
      if (!best || score > best.score) best = { members, score, reasons };
    }
    return best;
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
      // Two events are one story when their headlines are close on average (within mergeSlack of the
      // threshold) AND at least one pair of headlines passes the full threshold. The second condition
      // stops "style twins" — unrelated stories with similar wording — which never reach the threshold.
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < this.active.length; i++)
        for (let j = i + 1; j < this.active.length; j++) {
          let sum = 0, n = 0, strongest = -Infinity;
          for (const a of this.active[i].articles) for (const b of this.active[j].articles) {
            const m = this.margin(a, b);
            sum += m; n++; if (m > strongest) strongest = m;
          }
          const avg = sum / n;
          const sameStory = avg >= -this.mergeSlack && strongest >= 0;
          if ((sameStory || this.sharesStory(this.active[i], this.active[j])) && avg > bestScore) { bestScore = avg; best = [this.active[i], this.active[j]]; }
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

  /** Different angles of one story: a shared story keyword and a high average similarity. */
  sharesStory(a, b) {
    if (!this.storyMergeThreshold || !this.lex) return false;
    let sum = 0, n = 0;
    for (const x of a.articles) for (const y of b.articles) { sum += cosine(x.vec, y.vec); n++; }
    if (sum / n < this.storyMergeThreshold) return false;
    const kb = this.lex.keywords(b.articles.map(x => x.title));
    return [...this.lex.keywords(a.articles.map(x => x.title))].some(k => kb.has(k));
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
      const n = this.sourceCount(ev);
      return n >= this.minSources || (ev.provisional && n >= 1);
    });
    this.active = clean(this.active);
    this.retired = clean(this.retired);
    this.assigned = new Map();
    for (const ev of [...this.active, ...this.retired]) for (const a of ev.articles) this.assigned.set(a.key, ev.id);
  }

  get(id) { return this.active.find(e => e.id === id) ?? null; }

  toJSON() {
    // (teasers are not saved: the state is public and teasers are the sites' text)
    const ser = ev => ({ ...ev, articles: ev.articles.map(({ teaser, ...a }) => ({ ...a, vec: Array.from(a.vec, x => +x.toFixed(5)) })) });
    return { active: this.active.map(ser), retired: this.retired.map(ser), lastMultiAt: this.lastMultiAt, lastSingleAt: this.lastSingleAt };
  }

  load(json) {
    const de = ev => ({ ...ev, articles: ev.articles.map(a => ({ ...a, vec: Float32Array.from(a.vec) })) });
    this.active = (json.active ?? []).map(de);
    this.retired = (json.retired ?? []).map(de);
    this.assigned = new Map();
    for (const ev of [...this.active, ...this.retired]) for (const a of ev.articles) this.assigned.set(a.key, ev.id);
    // State saved before these fields existed: derive from the newest multi-source detection.
    this.lastMultiAt = json.lastMultiAt ?? Math.max(0, ...[...this.active, ...this.retired].filter(e => !e.provisional).map(e => e.detectedAt));
    this.lastSingleAt = json.lastSingleAt ?? 0;
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
  // One photo per event, as published in a source's own feed: the headline article's photo if it has
  // one, otherwise the earliest article that does. Only the URL is used (the image is never copied).
  const pic = head.image ? head : [...ev.articles].sort((x, y) => (x.publishedAt ?? 0) - (y.publishedAt ?? 0)).find(a => a.image);
  return {
    id: ev.id,
    detectedAt: ev.detectedAt,
    lastUpdatedAt: ev.lastUpdatedAt,
    title: head.title,
    image: pic ? { url: pic.image, sourceName: sourcesById[pic.sourceId]?.name ?? pic.sourceId, link: pic.link } : null,
    sourceCount: bySource.size,
    singleSource: !!ev.provisional, // not (yet) confirmed by a second site — shown as a "hot" story
    hot: ev.provisional ? ev.hot ?? [] : undefined,
    sources: [...bySource.keys()].map(id => ({ id, name: sourcesById[id]?.name ?? id, color: sourcesById[id]?.color ?? '#666' })),
    articles: [...ev.articles]
      .sort((x, y) => (x.publishedAt ?? 0) - (y.publishedAt ?? 0))
      .map(a => ({ sourceId: a.sourceId, sourceName: sourcesById[a.sourceId]?.name ?? a.sourceId, category: a.category ?? null,
        color: sourcesById[a.sourceId]?.color ?? '#666', title: a.title, link: a.link, publishedAt: a.publishedAt })),
  };
}

function partition(arr, pred) {
  const a = [], b = [];
  for (const x of arr) (pred(x) ? a : b).push(x);
  return [a, b];
}
