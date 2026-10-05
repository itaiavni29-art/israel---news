// Long-running scan for GitHub Actions: scans every scanIntervalMinutes for `loopMinutes`, and after
// every scan publishes events.json / status.json / state.json to the `data` branch.
// Being one long job (instead of one job per scan) means we do not depend on GitHub's cron, which
// often skips or delays runs. The workflow starts the next job when this one ends.
//
//   node scripts/scan-loop.js <dir> [loopMinutes]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, ROOT } from '../src/config.js';
import { Scanner } from '../src/scanner.js';
import { log } from '../src/log.js';

const dir = path.resolve(process.argv[2] ?? path.join(ROOT, 'data'));
const loopMinutes = +(process.argv[3] ?? 330);
const config = loadConfig();
const scanner = new Scanner(config, { stateDir: dir, publishDir: dir });
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN;
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

// Publish the data directory as a single fresh commit on the `data` branch (history never grows).
function publish() {
  if (!repo || !token) return; // local run: nothing to publish
  try {
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    // The site is also hosted on Vercel, linked to this repository: tell it not to build the data branch,
    // otherwise every scan would use up one of the free plan's daily deployments.
    fs.writeFileSync(path.join(dir, 'vercel.json'), JSON.stringify({ git: { deploymentEnabled: false } }));
    git('init', '-q', '-b', 'data');
    git('add', '-A');
    git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-qm', `scan ${new Date().toISOString()}`);
    git('push', '-qf', `https://x-access-token:${token}@github.com/${repo}.git`, 'data:data');
  } catch (e) { log.error('[publish] failed:', String(e.stderr ?? e.message).replace(token, '***')); }
}

// New code pushed to main? Stop, so the next job (started by the workflow) runs the new version.
function codeChanged() {
  if (!repo || !process.env.GITHUB_SHA) return false;
  try {
    const head = execFileSync('git', ['ls-remote', `https://github.com/${repo}.git`, 'refs/heads/main'], { stdio: 'pipe' }).toString().split('\t')[0];
    return !!head && head !== process.env.GITHUB_SHA;
  } catch { return false; }
}

const deadline = Date.now() + loopMinutes * 60_000;
const intervalMs = config.scanIntervalMinutes * 60_000;
log.info(`[loop] scanning every ${config.scanIntervalMinutes} min for ${loopMinutes} min`);
while (Date.now() < deadline) {
  const started = Date.now();
  await scanner.scanOnce();
  publish();
  if (codeChanged()) { log.info('[loop] new code on main — handing over to a fresh job'); break; }
  const wait = Math.max(0, intervalMs - (Date.now() - started));
  if (Date.now() + wait >= deadline) break;
  await new Promise(r => setTimeout(r, wait));
}
log.info('[loop] done');
