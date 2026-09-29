// Run exactly one scan and exit — used by the GitHub Actions workflow every few minutes.
//   node scripts/scan-once.js [stateAndPublishDir]
// State (events, ETags) is read from and written back to the given directory (default: ./data).
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { Scanner } from '../src/scanner.js';

const dir = path.resolve(process.argv[2] ?? path.join(ROOT, 'data'));
const scanner = new Scanner(loadConfig(), { stateDir: dir, publishDir: dir });
const result = await scanner.scanOnce();
process.exit(result?.error ? 1 : 0);
