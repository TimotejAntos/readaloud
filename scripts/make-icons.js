// Draw the app icons (blue square, four white sound bars) as PNG files.
// No image library: pixels by hand, PNG written with Node's zlib.
//   node scripts/make-icons.js   ->  public/icons/*.png

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(OUT, { recursive: true });

const BLUE = [0x3b, 0x5b, 0xdb];
// Bars as in the logo: x centre, height (fractions of the icon size).
const BARS = [
  [0.3, 0.26],
  [0.43, 0.5],
  [0.57, 0.34],
  [0.7, 0.18],
];

function draw(size, { rounded }) {
  const px = Buffer.alloc(size * size * 4);
  const r = rounded ? size * 0.22 : 0;
  const barW = size * 0.085;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded square (corner test), 1px soft edge.
      let a = 1;
      if (r) {
        const cx = Math.min(Math.max(x + 0.5, r), size - r);
        const cy = Math.min(Math.max(y + 0.5, r), size - r);
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        a = Math.max(0, Math.min(1, r - d + 0.5));
      }
      let c = BLUE;
      for (const [bx, bh] of BARS) {
        const half = (bh * size) / 2;
        const dx = Math.abs(x + 0.5 - bx * size) - barW / 2;
        const dy = Math.abs(y + 0.5 - size / 2) - (half - barW / 2);
        // Capsule: rectangle with round ends.
        const dist = dx <= 0 && dy <= 0 ? -1 : dy <= 0 ? dx : Math.hypot(Math.max(dx, -barW / 2) + barW / 2, dy) - barW / 2;
        const inside = Math.max(0, Math.min(1, 0.5 - dist));
        if (inside > 0) c = c.map((v, k) => Math.round(v * (1 - inside) + 255 * inside));
      }
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

writeFileSync(path.join(OUT, "icon-192.png"), draw(192, { rounded: true }));
writeFileSync(path.join(OUT, "icon-512.png"), draw(512, { rounded: true }));
writeFileSync(path.join(OUT, "maskable-512.png"), draw(512, { rounded: false }));
writeFileSync(path.join(OUT, "apple-touch-icon.png"), draw(180, { rounded: false }));
writeFileSync(
  path.join(OUT, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3b5bdb"/><path d="M9 12v8M14 9v14M19 12v8M24 14v4" stroke="white" stroke-width="2.6" stroke-linecap="round"/></svg>\n`,
);
console.log("icons written to", OUT);
