// Scan: fetch feeds → embed new headlines → update events → persist → publish JSON for the web page.
//
// Two ways to run it:
//   • cloud (GitHub Actions): scripts/scan-once.js runs ONE scan every few minutes; state lives in the
//     repo's `data` branch between runs.
//   • local: server.js keeps a Scanner alive and calls scanOnce() every scanIntervalMinutes.
// Either way the page only reads the published events.json / status.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { FeedFetcher } from './feeds.js';
import { Embedder } from './embedder.js';
import { EventStore, presentEvent } from './events.js';
import { isHebrew } from './text.js';
import { Categorizer, CATEGORIES, categoryInfo, eventCategory } from './categories.js';
import { Summarizer } from './summarizer.js';
import { log } from './log.js';

export class Scanner {
  /**
   * @param {object} config
   * @param {{stateDir?: string, publishDir?: string}} dirs where state is kept / where events.json is written
   */
  constructor(config, { stateDir = path.join(ROOT, 'data'), publishDir = path.join(ROOT, 'public') } = {}) {
    this.config = config;
    this.stateFile = path.join(stateDir, 'state.json');
    this.publishDir = publishDir;
    this.fetcher = new FeedFetcher(config, log);
    this.embedder = new Embedder(config.embeddingModel);
    this.categorizer = new Categorizer(this.embedder);
    // Summaries: on only when config allows and GEMINI_API_KEY is present (GitHub secret in the cloud).
    this.summarizer = new Summarizer({
      apiKey: config.summaries?.enabled ? process.env.GEMINI_API_KEY : undefined, log,
      singleSource: !!config.summaries?.singleSource, // also summarize "hot" single-source stories
    });
    this.lastSummaries = null;
    this.store = new EventStore({
      maxEvents: config.maxEvents,
      minSources: config.minSources,
      similarityThreshold: config.similarityThreshold,
      crossLanguageThreshold: config.crossLanguageThreshold,
      retentionMs: config.articleMaxAgeHours * 3600_000,
      singleSourceFallbackMs: (config.singleSourceFallbackMinutes ?? 0) * 60_000,
      eventMergeThreshold: config.eventMergeThreshold,
      noSharedNamePenalty: config.noSharedNamePenalty,
      storyMergeThreshold: config.storyMergeThreshold,
      // When hot stories get AI summaries, choose only ones that came with a teaser to summarize.
      hotNeedsTeaser: this.summarizer.enabled && !!config.summaries?.singleSource,
    });
    this.pool = new Map(); // key -> article seen in the last articleMaxAgeHours
    this.sourcesById = Object.fromEntries(config.sources.map(s => [s.id, s]));
    this.lastScan = null;
    this.nextScanAt = null;
    this.scanning = false;
    this.loadState();
  }

  loadState() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.store.load(saved.store);
      this.summarizer.load(saved.summarizer);
      this.fetcher.load(saved.feeds);
      this.lastScan = saved.lastScan ?? null;
      // A source switched off in config.json disappears from saved events too.
      this.store.removeSources(this.config.sources.filter(s => s.enabled === false).map(s => s.id));
      log.info(`[scanner] restored ${this.store.active.length} events from ${path.relative(ROOT, this.stateFile)}`);
    } catch (e) { log.error('[scanner] could not read saved state, starting fresh:', e.message); }
  }

  saveState() {
    const write = (file, data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file);
    };
    try {
      write(this.stateFile, { savedAt: Date.now(), store: this.store.toJSON(), feeds: this.fetcher.toJSON(), lastScan: this.lastScan, summarizer: this.summarizer.toJSON() });
      write(path.join(this.publishDir, 'events.json'), this.eventsPayload());
      write(path.join(this.publishDir, 'status.json'), this.status());
    } catch (e) { log.error('[scanner] could not save state:', e.message); }
  }

  async scanOnce(now = Date.now()) {
    if (this.scanning) return this.lastScan;
    this.scanning = true;
    const t0 = Date.now();
    try {
      const { articles, report } = await this.fetcher.fetchAll(now);
      for (const a of articles) if (!this.pool.has(a.key)) this.pool.set(a.key, { ...a, firstSeenAt: now, hebrew: isHebrew(a.title) });
      const cutoff = now - this.config.articleMaxAgeHours * 3600_000;
      for (const [k, a] of this.pool) if (a.publishedAt < cutoff) this.pool.delete(k);

      const pending = [...this.pool.values()].filter(a => !a.vec);
      if (pending.length) (await this.embedder.embed(pending.map(a => a.title))).forEach((v, i) => { pending[i].vec = v; });
      await this.categorizer.init();
      for (const a of pending) a.category = this.categorizer.categorize(a);
      // Events saved before categories existed: label their articles once.
      for (const ev of [...this.store.active, ...this.store.retired]) for (const a of ev.articles) if (a.category === undefined) a.category = this.categorizer.categorize(a);

      const { created, updated, retired, single } = this.store.update([...this.pool.values()], now);
      if (this.summarizer.enabled) {
        this.lastSummaries = await this.summarizer.summarizeEvents(this.store.active, this.pool, this.sourcesById, this.config.minSources);
        log.info(`[summarizer] ${JSON.stringify(this.lastSummaries)}`);
      }
      this.lastScan = { at: now, durationMs: Date.now() - t0, articles: this.pool.size, created: created.length, single: single ? 1 : 0, updated: updated.length, retired: retired.length, report };
      log.info(`[scanner] ${this.pool.size} headlines, +${created.length} new events${single ? `, +1 hot single-source (${single.hot.join(",") || "fresh"}): ${single.articles[0].title.slice(0, 50)}` : ""}, ${updated.length} updated, ${retired.length} retired (${this.lastScan.durationMs} ms)`);
    } catch (e) {
      log.error('[scanner] scan failed:', e.stack ?? e.message);
      this.lastScan = { ...(this.lastScan ?? {}), at: now, error: e.message };
    } finally {
      this.scanning = false;
    }
    this.saveState();
    return this.lastScan;
  }

  start() {
    const loop = async () => {
      await this.scanOnce();
      const ms = this.config.scanIntervalMinutes * 60_000;
      this.nextScanAt = Date.now() + ms;
      this.timer = setTimeout(loop, ms);
    };
    loop();
  }

  stop() { clearTimeout(this.timer); }

  eventsPayload() {
    const src = id => this.sourcesById[id] ?? { name: id, color: '#666' };
    // Headline + link only (never article text) — for the live-updates timeline, search and topics.
    const item = a => ({ sourceId: a.sourceId, sourceName: src(a.sourceId).name, color: src(a.sourceId).color,
      title: a.title, link: a.link, publishedAt: a.publishedAt, category: categoryInfo(a.category) });
    const pool = [...this.pool.values()].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    // Events saved before images were read from the feeds: take the photo from the current feed item.
    for (const ev of this.store.active) for (const a of ev.articles) if (!a.image && this.pool.get(a.key)?.image) a.image = this.pool.get(a.key).image;
    return {
      generatedAt: Date.now(),
      lastScanAt: this.lastScan?.at ?? null,
      minSources: this.config.minSources,
      sources: this.config.sources.filter(s => s.enabled !== false).map(s => ({ id: s.id, name: s.name, color: s.color })),
      categories: CATEGORIES.map(({ id, name, color }) => ({ id, name, color })),
      // Photos stay off unless the sites allowed it (copyright: news photos are often licensed to the
      // site only). Turn on with "showPhotos": true in config.json.
      showPhotos: !!this.config.showPhotos,
      // Summaries are generated and published first, and shown in the app only once they were reviewed.
      showSummaries: !!this.config.summaries?.showOnSite,
      events: this.store.active.map(ev => {
        const e = { ...presentEvent(ev, this.sourcesById), category: categoryInfo(eventCategory(ev.articles)) };
        if (!this.config.showPhotos) e.image = null;
        e.summary = ev.summary ? { text: ev.summary.text, model: ev.summary.model, at: ev.summary.at, single: !!ev.summary.single } : null;
        return e;
      }),
      breaking: pool.filter(a => a.breaking).slice(0, 40).map(item),
      headlines: pool.slice(0, 400).map(item),
    };
  }

  status() {
    const feedState = this.fetcher.snapshotStatus();
    return {
      generatedAt: Date.now(),
      lastScan: this.lastScan && { ...this.lastScan, report: undefined },
      summarizer: { enabled: this.summarizer.enabled, ...this.summarizer.toJSON(), lastRun: this.lastSummaries },
      settings: {
        minSources: this.config.minSources, similarityThreshold: this.config.similarityThreshold,
        crossLanguageThreshold: this.config.crossLanguageThreshold, scanIntervalMinutes: this.config.scanIntervalMinutes,
        maxEvents: this.config.maxEvents, model: this.config.embeddingModel,
      },
      sources: this.config.sources.filter(s => s.enabled !== false).map(s => ({
        id: s.id, name: s.name, color: s.color,
        feeds: [...s.feeds, ...(s.breakingFeeds ?? [])].map(url => ({ url, ...(feedState[url] ?? { lastOkAt: null, failures: 0, lastError: null, items: 0 }) })),
      })),
    };
  }
}
