// חדשות ישראל — local mode: serves the web page and keeps scanning every scanIntervalMinutes.
// (In the cloud, GitHub Actions runs scripts/scan-once.js instead and GitHub Pages serves public/.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './src/config.js';
import { Scanner } from './src/scanner.js';
import { log } from './src/log.js';

const config = loadConfig();
const scanner = new Scanner(config); // writes public/events.json + public/status.json after each scan
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(file) === '.json') { res.writeHead(404).end(); return; } // no scan finished yet
      file = path.join(PUBLIC, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    log.error('[server]', e.stack ?? e.message);
    res.writeHead(500).end();
  }
});

server.listen(config.port, () => {
  log.info(`חדשות ישראל: http://localhost:${config.port}  (scan every ${config.scanIntervalMinutes} min, min ${config.minSources} sources, threshold ${config.similarityThreshold})`);
  scanner.start();
});

process.on('unhandledRejection', e => log.error('[unhandled]', e?.stack ?? e));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { scanner.stop(); server.close(); process.exit(0); });
