// Draws the "כאן ועכשיו" app icon (dark square, two white corner marks framing a red dot) as PNG files.
// iPhone "Add to Home Screen" needs a PNG (apple-touch-icon); it rounds the corners itself, so the
// icon is drawn full-bleed. No image library needed: shapes are rasterized here and encoded with zlib.
//   node scripts/make-icons.js
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const BG = [14, 19, 23], WHITE = [255, 255, 255], RED = [224, 40, 46];
// Geometry in 0..1 units of the icon's side.
const T = 0.055; // stroke thickness
const RECTS = [
  [0.27, 0.27, 0.45, 0.27 + T], [0.27, 0.27, 0.27 + T, 0.45],   // top-left corner
  [0.55, 0.73 - T, 0.73, 0.73], [0.73 - T, 0.55, 0.73, 0.73],   // bottom-right corner
];
const DOT = { x: 0.5, y: 0.5, r: 0.052 };

function colorAt(u, v) {
  if (Math.hypot(u - DOT.x, v - DOT.y) <= DOT.r) return RED;
  for (const [x0, y0, x1, y1] of RECTS) if (u >= x0 && u < x1 && v >= y0 && v < y1) return WHITE;
  return BG;
}

function png(size, ss = 4) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = colorAt((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (ss * ss));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(ROOT, 'public', 'icons');
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  fs.writeFileSync(path.join(out, name), png(size));
  console.log(name, size + 'x' + size);
}
