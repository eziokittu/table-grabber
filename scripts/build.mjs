/**
 * Packs the extension into `dist/`. Two archives come out, because the two
 * audiences need opposite layouts:
 *
 *   table-grabber-<v>-webstore.zip   manifest.json at the archive root, which
 *                                    is what the Chrome Web Store requires.
 *   table-grabber-<v>.zip            everything inside one folder, plus
 *                                    INSTALL.txt. This is the download on
 *                                    glitchbong.com — a flat archive would
 *                                    empty a pile of loose files into someone's
 *                                    Downloads folder.
 *
 * SHA-256 checksums go to dist/checksums.txt and are printed, so the download
 * page can publish a hash people can verify before loading unpacked.
 *
 * The ZIP container is written by hand so the build has zero dependencies:
 * clone the repo, run `npm run build`, with nothing installed.
 */
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Only these ship. Tests, docs and store assets stay out. */
const INCLUDE = ["manifest.json", "icons", "src", "LICENSE"];
const EXCLUDE = [/\.map$/, /\.DS_Store$/, /Thumbs\.db$/, /~$/];

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const VERSION = manifest.version;
const NAME = "table-grabber";

// ── Collect ────────────────────────────────────────────────────────────────

function collect(entry) {
  const full = join(ROOT, entry);
  if (statSync(full).isFile()) return [entry];
  return readdirSync(full).flatMap((child) => collect(join(entry, child)));
}

const files = INCLUDE.flatMap(collect)
  .map((p) => p.split(sep).join("/"))
  .filter((p) => !EXCLUDE.some((re) => re.test(p)))
  .sort();

// ── ZIP ────────────────────────────────────────────────────────────────────

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

/** @param {{name: string, data: Buffer}[]} entries */
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data, { level: 9 });
    // Storing beats deflating when deflating made it bigger (tiny files).
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);          // time
    header.writeUInt16LE(0x21, 12);       // date: 1996-01-01, so builds are reproducible
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(e.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    local.push(header, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);

    central.push(dir, name);
    offset += header.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuf, end]);
}

// ── Write ──────────────────────────────────────────────────────────────────

const DIST = join(ROOT, "dist");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const payload = files.map((f) => ({ name: f, data: readFileSync(join(ROOT, f)) }));

const storeZip = zip(payload);
const storeName = `${NAME}-${VERSION}-webstore.zip`;
writeFileSync(join(DIST, storeName), storeZip);

const INSTALL = `Table Grabber v${VERSION}
==============================

1. Unzip this folder somewhere you will keep it.
2. Open chrome://extensions
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked" and choose the "${NAME}" folder inside this archive
   — the one containing manifest.json.
5. Pin it to the toolbar, then open any page with a table and click the icon.

Unpacked extensions do not update themselves. New versions:
https://glitchbong.com/tools/table-grabber

Nothing you grab ever leaves your browser. There is no server.
`;

const folderPayload = [
  ...payload.map((p) => ({ name: `${NAME}/${p.name}`, data: p.data })),
  { name: `${NAME}/INSTALL.txt`, data: Buffer.from(INSTALL, "utf8") },
];
const userZip = zip(folderPayload);
const userName = `${NAME}-${VERSION}.zip`;
writeFileSync(join(DIST, userName), userZip);

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const checksums = `${sha(storeZip)}  ${storeName}\n${sha(userZip)}  ${userName}\n`;
writeFileSync(join(DIST, "checksums.txt"), checksums);

const kb = (b) => `${Math.round(b / 1024)} KB`;
console.log(`\nPacked ${files.length} files.\n`);
console.log(`  dist/${storeName}  ${kb(storeZip.length)}   (upload this to the Web Store)`);
console.log(`  dist/${userName}  ${kb(userZip.length)}   (put this on glitchbong.com)\n`);
console.log("SHA-256");
console.log("  " + checksums.trim().split("\n").join("\n  ") + "\n");
