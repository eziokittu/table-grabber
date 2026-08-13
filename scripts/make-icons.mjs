/**
 * Generates the extension's PNG icons from code — no binary assets in git, no
 * image library, nothing license-encumbered. Run: `npm run icons`.
 *
 * The mark is a table with one row being pulled out of it: purple grid, neon
 * row sliding to the right. That is literally what the extension does, and it
 * reads at 16px, which most "document with an arrow" marks do not.
 *
 * Everything is drawn from signed-distance functions and 4x supersampled.
 * 16px gets a simplified composition — see the `small` branch in sample() —
 * because grid lines thinner than a device pixel turn into grey mush.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [16, 32, 48, 128];

// ── Palette ────────────────────────────────────────────────────────────────
const PLATE_TOP = [42, 11, 74];   // #2a0b4a
const PLATE_BOT = [16, 4, 30];    // #10041e
const NEON = [57, 255, 20];       // #39ff14
const PURPLE = [168, 85, 247];    // #a855f7
const PURPLE_DIM = [124, 58, 237];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Coverage from a signed distance, antialiased over roughly one pixel. */
function cover(d, aa) {
  return clamp(0.5 - d / aa, 0, 1);
}

/** Paints `src` over `dst` with alpha `a`. */
function over(dst, src, a) {
  if (a <= 0) return dst;
  return [
    dst[0] + (src[0] - dst[0]) * a,
    dst[1] + (src[1] - dst[1]) * a,
    dst[2] + (src[2] - dst[2]) * a,
  ];
}

/**
 * Colour and alpha at a point in the unit square.
 * @returns {[number, number, number, number]} r, g, b, a — all 0..255 except a
 */
function sample(x, y, size) {
  const small = size <= 16;
  const aa = 1.6 / size;

  // Plate
  const plate = sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, small ? 0.16 : 0.2);
  const plateA = cover(plate, aa);
  if (plateA <= 0) return [0, 0, 0, 0];

  let rgb = mix(PLATE_TOP, PLATE_BOT, clamp(y * 1.1, 0, 1));

  if (small) {
    // 16px: three fat bars. Header purple, one body bar dim, the last neon and
    // nudged right so the "pulled out" idea survives at this size.
    const bar = (cy, w, off) => sdRoundRect(x, y, 0.5 + off, cy, w, 0.075, 0.035);
    rgb = over(rgb, PURPLE, cover(bar(0.28, 0.3, 0), aa));
    rgb = over(rgb, PURPLE_DIM, cover(bar(0.5, 0.3, 0), aa) * 0.85);
    rgb = over(rgb, NEON, cover(bar(0.72, 0.28, 0.06), aa));
    return [...rgb.map((c) => clamp(c, 0, 255)), Math.round(plateA * 255)];
  }

  // Table outline
  const outer = sdRoundRect(x, y, 0.47, 0.5, 0.29, 0.31, 0.05);
  const ring = Math.abs(outer) - 0.022;
  rgb = over(rgb, PURPLE, cover(ring, aa) * 0.95);

  // Header band
  const header = sdRoundRect(x, y, 0.47, 0.29, 0.29, 0.10, 0.05);
  rgb = over(rgb, PURPLE, cover(header, aa) * 0.5);

  // Header underline
  const underline = sdRoundRect(x, y, 0.47, 0.385, 0.29, 0.012, 0.006);
  rgb = over(rgb, PURPLE, cover(underline, aa));

  // Two dim body rows. No column divider: at 32px it collapses into the rows
  // and the whole mark turns to mush.
  const row1 = sdRoundRect(x, y, 0.47, 0.50, 0.235, 0.040, 0.02);
  rgb = over(rgb, PURPLE_DIM, cover(row1, aa) * 0.75);
  const row2 = sdRoundRect(x, y, 0.47, 0.60, 0.235, 0.040, 0.02);
  rgb = over(rgb, PURPLE_DIM, cover(row2, aa) * 0.45);

  // The grabbed row: neon, wider, shifted right and out past the table edge.
  const grabbed = sdRoundRect(x, y, 0.60, 0.71, 0.30, 0.062, 0.03);
  const grabbedA = cover(grabbed, aa);
  // A soft glow sells it as lifted off the surface.
  const glow = cover(sdRoundRect(x, y, 0.60, 0.71, 0.32, 0.082, 0.04), aa * 3);
  rgb = over(rgb, NEON, glow * 0.22);
  rgb = over(rgb, NEON, grabbedA);

  return [...rgb.map((c) => clamp(c, 0, 255)), Math.round(plateA * 255)];
}

// ── Rasteriser ─────────────────────────────────────────────────────────────

function render(size) {
  const SS = 4; // supersampling factor
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [sr, sg, sb, sa] = sample(u, v, size);
          const af = sa / 255;
          // Premultiply so edges do not fringe dark.
          r += sr * af; g += sg * af; b += sb * af; a += af;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (y * size + x) * 4;
      if (alpha > 0.0001) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ── PNG encoder ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Filter type 0 (None) on every scanline: these images are tiny and the
  // extra compression from smarter filters is not worth the complexity.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Run ────────────────────────────────────────────────────────────────────

mkdirSync(join(ROOT, "icons"), { recursive: true });
mkdirSync(join(ROOT, "store"), { recursive: true });

for (const size of SIZES) {
  const png = encodePng(size, render(size));
  writeFileSync(join(ROOT, "icons", `icon-${size}.png`), png);
  console.log(`  icons/icon-${size}.png  ${png.length} bytes`);
}

// The store wants a 512px version for the listing.
const big = encodePng(512, render(512));
writeFileSync(join(ROOT, "store", "icon-512.png"), big);
console.log(`  store/icon-512.png  ${big.length} bytes`);
