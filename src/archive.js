// A small archive of the events the app showed, so each one can have a page of its own
// (https://zmanemetnews.co.il/e/<day>/<id>) that search engines can find and people can share.
// Like the app itself it keeps only headlines, links and our own summaries — never article text.
//   <publishDir>/archive/<YYYY-MM-DD>.json   the events first detected on that day (Israel time)
//   <publishDir>/archive/index.json          the latest events, for the sitemap and the section pages
import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 365, INDEX_SIZE = 5000;
export const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(ms);
export const shortId = id => String(id).replace(/-/g, '').slice(0, 10);

const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); };

/**
 * @param {string} dir publish directory
 * @param {object[]} events events as published in events.json (with summary, category, articles)
 */
export function updateArchive(dir, events, now = Date.now()) {
  const root = path.join(dir, 'archive');
  const index = read(path.join(root, 'index.json'), { events: [] });
  const byKey = new Map(index.events.map(e => [e.day + '/' + e.id, e]));
  const days = new Map();
  for (const ev of events) {
    if (!ev.summary?.text) continue; // a page needs something of ours to say: the summary
    const day = dayOf(ev.detectedAt), id = shortId(ev.id);
    if (!days.has(day)) days.set(day, read(path.join(root, day + '.json'), { day, events: {} }));
    days.get(day).events[id] = {
      id, title: ev.title, detectedAt: ev.detectedAt, updatedAt: now, category: ev.category ?? null,
      single: !!ev.singleSource, summary: ev.summary.text,
      articles: ev.articles.map(a => ({ sourceName: a.sourceName, title: a.title, link: a.link, publishedAt: a.publishedAt })),
    };
    byKey.set(day + '/' + id, { id, day, title: ev.title, at: ev.detectedAt, updatedAt: now, category: ev.category?.id ?? null, sources: ev.sourceCount });
  }
  for (const [day, data] of days) write(path.join(root, day + '.json'), data);
  // forget days that are too old (their files and their index entries)
  const oldest = dayOf(now - KEEP_DAYS * 86400_000);
  if (fs.existsSync(root)) for (const f of fs.readdirSync(root)) if (/^\d{4}-\d\d-\d\d\.json$/.test(f) && f.slice(0, 10) < oldest) fs.rmSync(path.join(root, f));
  const list = [...byKey.values()].filter(e => e.day >= oldest).sort((a, b) => b.at - a.at).slice(0, INDEX_SIZE);
  write(path.join(root, 'index.json'), { generatedAt: now, events: list });
  return list.length;
}
