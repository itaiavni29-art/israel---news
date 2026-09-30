// Polite RSS fetching: conditional GET (ETag / If-Modified-Since), identified User-Agent,
// timeouts, and per-feed back-off after failures. Only headline, link, date and the image URL the
// site itself put in its feed are kept — never article bodies, and images are never downloaded.
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { normalizeDate } from './dates.js';
import { decodeEntities } from './text.js';
import { buildFilter } from './filters.js';

// processEntities:false — Maariv's feed exceeds the parser's entity-expansion limit; we decode ourselves.
const parser = new XMLParser({ ignoreAttributes: false, processEntities: false, textNodeName: '#text' });
const text = v => decodeEntities(v == null ? '' : typeof v === 'object' ? (v['#text'] ?? v['@_href'] ?? '') : String(v))
  .replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();

// Bump when parseFeed starts extracting something new, so saved feed items are re-parsed once.
const PARSER_VERSION = 2; // 2: images

export function parseFeed(xml, source, { now = Date.now() } = {}) {
  const x = parser.parse(xml);
  const raw = [].concat(x?.rss?.channel?.item ?? x?.feed?.entry ?? []);
  if (!raw.length && !x?.rss && !x?.feed) throw new Error('response is not an RSS/Atom document');
  return raw.map(it => {
    const image = feedImage(it);
    return {
      title: text(it.title),
      link: text(it.link) || text(it.guid),
      publishedAt: normalizeDate(text(it.pubDate ?? it.published ?? it.updated ?? it['dc:date']),
        { labelIsLocalTime: !!source.dateLabelIsLocalTime, now }),
      ...(image && { image }),
    };
  });
}

// The image the publisher attached to the item in its own feed: <enclosure type="image/…">,
// <media:content>/<media:thumbnail>, or the first <img> in the description (ynet, Maariv).
function feedImage(it) {
  const attr = (v, name) => [].concat(v ?? []).map(x => x?.[`@_${name}`]).find(Boolean);
  const enclosures = [].concat(it.enclosure ?? []).filter(e => !e['@_type'] || /^image\//i.test(e['@_type']));
  let url = attr(enclosures, 'url') ?? attr(it['media:content'], 'url') ?? attr(it['media:thumbnail'], 'url')
    ?? decodeEntities(text(it.description)).match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  url = url && decodeEntities(url).trim();
  return url && /^https:\/\//i.test(url) ? url : null;
}

// Stable identity for an article link. Keep the query string (Globes identifies articles by ?did=)
// but drop tracking parameters and fragments.
export function articleKey(link) {
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|from$)/i.test(k)) u.searchParams.delete(k);
    return (u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') + (u.search || '')).toLowerCase();
  } catch { return String(link).trim().toLowerCase(); }
}

export class FeedFetcher {
  constructor(config, log = console) {
    this.config = config;
    this.log = log;
    this.state = new Map(); // url -> {etag, lastModified, hash, items, failures, skipUntil, lastOkAt, lastError}
  }

  feedState(url) {
    if (!this.state.has(url)) this.state.set(url, { failures: 0, skipUntil: 0, items: [] });
    return this.state.get(url);
  }

  async fetchOne(source, url, now = Date.now()) {
    const st = this.feedState(url);
    if (now < st.skipUntil) return { url, status: 'backoff', items: st.items };
    const headers = { 'User-Agent': this.config.userAgent, Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' };
    // Items saved by an older parser (e.g. before images were read) must be fetched and parsed again.
    const current = st.parser === PARSER_VERSION;
    if (current && st.etag) headers['If-None-Match'] = st.etag;
    if (current && st.lastModified) headers['If-Modified-Since'] = st.lastModified;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
      if (res.status === 304) { st.failures = 0; st.lastOkAt = now; return { url, status: 'not-modified', items: st.items }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      st.etag = res.headers.get('etag') ?? undefined;
      st.lastModified = res.headers.get('last-modified') ?? undefined;
      const hash = createHash('sha1').update(body).digest('hex');
      const changed = hash !== st.hash || !current;
      if (changed) { st.items = parseFeed(body, source, { now }); st.hash = hash; st.parser = PARSER_VERSION; }
      st.failures = 0; st.lastOkAt = now; st.lastError = null;
      return { url, status: changed ? 'ok' : 'unchanged', items: st.items };
    } catch (err) {
      st.failures++;
      // Back off: skip 1, 2, 4... scans (capped at 30 minutes) so a broken site is not hammered.
      const waitMs = Math.min(30 * 60_000, this.config.scanIntervalMinutes * 60_000 * 2 ** (st.failures - 1));
      st.skipUntil = now + waitMs;
      st.lastError = `${err.name === 'TimeoutError' ? 'timeout' : err.message}`;
      this.log.error(`[feeds] ${source.id} ${url} failed (${st.failures}x): ${st.lastError}`);
      return { url, status: 'error', error: st.lastError, items: st.items };
    }
  }

  /** Fetch every enabled source sequentially with a pause between requests. Never throws. */
  async fetchAll(now = Date.now()) {
    const articles = [];
    const report = [];
    const maxAge = this.config.articleMaxAgeHours * 3600_000;
    const sources = this.config.sources.filter(s => s.enabled !== false);
    for (const [i, source] of sources.entries()) {
      const reject = buildFilter(source, this.config.globalFilters);
      const rep = { id: source.id, name: source.name, feeds: [], kept: 0, dropped: {} };
      // breakingFeeds: the site's own "breaking news" feed — items from it are flagged as breaking.
      const feeds = [...source.feeds.map(url => ({ url })), ...(source.breakingFeeds ?? []).map(url => ({ url, breaking: true }))];
      for (const { url, breaking } of feeds) {
        if (articles.length || i || rep.feeds.length) await sleep(this.config.delayBetweenRequestsMs);
        const r = await this.fetchOne(source, url, now);
        rep.feeds.push({ url, status: r.status, error: r.error ?? null, items: r.items.length });
        // An image URL shared by several items is a site logo / generic placeholder, not the story's photo.
        const imageUses = new Map();
        for (const it of r.items) if (it.image) imageUses.set(it.image, (imageUses.get(it.image) ?? 0) + 1);
        for (let it of r.items) {
          if (it.image && imageUses.get(it.image) > 2) { const { image, ...rest } = it; it = rest; }
          const why = reject(it) ?? (it.publishedAt == null ? 'bad-date' : now - it.publishedAt > maxAge ? 'too-old' : null);
          if (why) { rep.dropped[why] = (rep.dropped[why] ?? 0) + 1; continue; }
          articles.push({ ...it, key: articleKey(it.link), sourceId: source.id, ...(breaking && { breaking: true }) });
          rep.kept++;
        }
      }
      report.push(rep);
    }
    // The same article can appear in two feeds of one source (e.g. Globes) — dedupe by key,
    // keeping the "breaking" flag if any of its feeds had it.
    const byKey = new Map();
    for (const a of articles) byKey.set(a.key, byKey.has(a.key) ? { ...byKey.get(a.key), breaking: byKey.get(a.key).breaking || a.breaking } : a);
    const unique = [...byKey.values()];
    return { articles: unique, report };
  }

  // Persist ETag / Last-Modified and the last parsed items, so a fresh process (e.g. a GitHub Actions
  // run) can still send conditional requests and reuse items when the server answers 304.
  toJSON() { return Object.fromEntries(this.state); }
  load(json) { this.state = new Map(Object.entries(json ?? {})); }

  snapshotStatus() {
    return Object.fromEntries([...this.state].map(([url, s]) => [url,
      { lastOkAt: s.lastOkAt ?? null, failures: s.failures, lastError: s.lastError ?? null, items: s.items.length }]));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
