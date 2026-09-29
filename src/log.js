import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const errFile = path.join(ROOT, 'data', 'errors.log');
const stamp = () => new Date().toISOString();

// Errors go to the console and to data/errors.log (kept under ~1 MB).
export const log = {
  info: (...a) => console.log(stamp(), ...a),
  error: (...a) => {
    console.error(stamp(), ...a);
    try {
      fs.mkdirSync(path.dirname(errFile), { recursive: true });
      if (fs.existsSync(errFile) && fs.statSync(errFile).size > 1_000_000) fs.renameSync(errFile, errFile + '.old');
      fs.appendFileSync(errFile, `${stamp()} ${a.join(' ')}\n`);
    } catch { /* logging must never crash the app */ }
  },
};
