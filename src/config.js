import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(file = path.join(ROOT, 'config.json')) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const need = (cond, msg) => { if (!cond) throw new Error(`config.json: ${msg}`); };
  need(Number.isInteger(c.minSources) && c.minSources >= 2, 'minSources must be an integer ≥ 2');
  need(c.similarityThreshold > 0 && c.similarityThreshold < 1, 'similarityThreshold must be between 0 and 1');
  need(c.scanIntervalMinutes >= 1, 'scanIntervalMinutes must be ≥ 1 (be gentle with the sites)');
  need(c.crossLanguageThreshold == null || (c.crossLanguageThreshold > 0 && c.crossLanguageThreshold < 1), 'crossLanguageThreshold must be between 0 and 1');
  need(Array.isArray(c.sources) && c.sources.length, 'sources must be a non-empty list');
  const ids = new Set();
  for (const s of c.sources) {
    need(s.id && s.name && Array.isArray(s.feeds) && s.feeds.length, `source ${s.id ?? '?'} needs id, name and feeds`);
    need(!ids.has(s.id), `duplicate source id ${s.id}`);
    ids.add(s.id);
  }
  return { maxEvents: 10, articleMaxAgeHours: 24, delayBetweenRequestsMs: 1500, requestTimeoutMs: 20000, port: 3000, ...c };
}
