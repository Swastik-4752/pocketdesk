// Draws the PocketDesk app icons (PNG) with no image library: a rounded dark tile with a ">_" prompt.
// Usage: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [20, 22, 26], fg = [233, 236, 241], accent = [217, 119, 87];
  const r = size * 0.22;
  const set = (x, y, c, a = 255) => {
    const i = (y * size + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a;
  };
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // distance from point to segment
  const segDist = (x, y, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  };
  const s = size;
  const stroke = s * 0.075;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (!inRounded(x + 0.5, y + 0.5)) { set(x, y, bg, 0); continue; }
      let c = bg;
      // ">" chevron
      const d1 = Math.min(segDist(x, y, s * 0.27, s * 0.32, s * 0.47, s * 0.5), segDist(x, y, s * 0.47, s * 0.5, s * 0.27, s * 0.68));
      if (d1 < stroke / 2) c = accent;
      // "_" underscore
      if (y > s * 0.62 && y < s * 0.62 + stroke && x > s * 0.53 && x < s * 0.75) c = fg;
      set(x, y, c);
    }
  }
  const raw = Buffer.alloc((s * 4 + 1) * s);
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0;
    px.copy(raw, y * (s * 4 + 1) + 1, y * s * 4, (y + 1) * s * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), draw(size));
  console.log(`wrote icon-${size}.png`);
}
