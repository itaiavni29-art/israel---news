// Fetch all configured feeds once and save the filtered headlines to data/snapshot-<time>.json.
// Used to build labelled test fixtures from real feed data.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { FeedFetcher } from '../src/feeds.js';

const config = loadConfig();
const { articles, report } = await new FeedFetcher(config).fetchAll();
for (const r of report) console.log(r.id.padEnd(12), 'kept', String(r.kept).padStart(3), 'dropped', JSON.stringify(r.dropped), r.feeds.map(f => f.status).join(','));
const file = `data/snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(file, JSON.stringify(articles.map(({ sourceId, title, link, publishedAt }) =>
  ({ sourceId, title, link, publishedAt: new Date(publishedAt).toISOString() })), null, 1));
console.log(`${articles.length} articles -> ${file}`);
