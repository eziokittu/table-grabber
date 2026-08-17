/**
 * Renders the Chrome Web Store promotional tiles.
 *
 * Drawn as HTML and captured in a real browser rather than composed from
 * signed-distance functions like the icons: these need actual typography, and
 * fighting a hand-rolled rasteriser for kerning is not a good use of anyone's
 * afternoon. No design tool and no binary assets in the repo either way.
 *
 * Output (both sizes the store offers):
 *   store/promo-small-440x280.png
 *   store/promo-marquee-1400x560.png
 *
 * Run: npm run promo
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "store");
mkdirSync(OUT, { recursive: true });

const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  console.error("Could not find Chrome. Set the CHROME environment variable.");
  process.exit(1);
}

// The icon is embedded so the tile needs no network and no local file access.
const iconData = readFileSync(join(ROOT, "icons", "icon-128.png")).toString("base64");

const SHARED_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    background: #0c1a1d;
    color: #eaf5f3;
    overflow: hidden;
  }
  .tile {
    width: 100%; height: 100vh;
    position: relative;
    display: flex; align-items: center;
    background:
      radial-gradient(ellipse 70% 90% at 15% 30%, rgba(23,140,130,.48) 0%, transparent 62%),
      radial-gradient(ellipse 60% 80% at 88% 78%, rgba(255,200,87,.14) 0%, transparent 62%),
      #0c1a1d;
    overflow: hidden;
  }
  /* A faint grid, echoing the product. */
  .tile::before {
    content: ""; position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(160,220,214,.10) 1px, transparent 1px),
      linear-gradient(90deg, rgba(160,220,214,.10) 1px, transparent 1px);
    background-size: 34px 34px;
    mask-image: radial-gradient(ellipse 80% 80% at 50% 50%, #000 30%, transparent 75%);
  }
  .inner { position: relative; z-index: 1; display: flex; align-items: center; }
  .name { font-weight: 800; letter-spacing: -.02em; line-height: 1; }
  .name .a { color: #eaf5f3; }
  .name .b { color: #55c9bb; }
  .tag { color: #b6cecb; font-weight: 500; }
  .chips { display: flex; flex-wrap: wrap; }
  .chip {
    color: #cfe6e3; font-weight: 600;
    background: rgba(85,201,187,.14);
    border: 1px solid rgba(85,201,187,.36);
    border-radius: 999px; white-space: nowrap;
  }
  .free {
    color: #241703; background: #ffc857; font-weight: 800;
    border-radius: 999px; white-space: nowrap;
  }
  img.mark { display: block; }
`;

const CHIPS = ["CSV", "Excel", "Markdown", "JSON", "SQL", "XML", "YAML", "LaTeX"];

const small = `<!doctype html><meta charset="utf-8"><style>${SHARED_CSS}
  .inner { flex-direction: column; align-items: flex-start; gap: 10px; padding: 0 26px; width: 100%; }
  .row { display: flex; align-items: center; gap: 12px; }
  img.mark { width: 44px; height: 44px; border-radius: 10px; }
  .name { font-size: 30px; }
  .tag { font-size: 13.5px; line-height: 1.4; }
  .chips { gap: 5px; margin-top: 2px; }
  .chip { font-size: 10.5px; padding: 3px 9px; }
</style>
<div class="tile"><div class="inner">
  <div class="row">
    <img class="mark" src="data:image/png;base64,${iconData}" alt="">
    <div class="name"><span class="a">Table</span> <span class="b">Grabber</span></div>
  </div>
  <div class="tag">Any table, any format.<br>Unlimited rows, nothing uploaded.</div>
  <div class="chips">${CHIPS.slice(0, 5).map((c) => `<span class="chip">${c}</span>`).join("")}</div>
</div></div>`;

const marquee = `<!doctype html><meta charset="utf-8"><style>${SHARED_CSS}
  .inner { justify-content: space-between; width: 100%; padding: 0 90px; gap: 60px; }
  .left { display: flex; flex-direction: column; gap: 22px; max-width: 720px; }
  .row { display: flex; align-items: center; gap: 26px; }
  img.mark { width: 104px; height: 104px; border-radius: 24px; }
  .name { font-size: 76px; }
  .tag { font-size: 27px; line-height: 1.45; }
  .chips { gap: 10px; }
  .chip { font-size: 19px; padding: 8px 20px; }
  .free { font-size: 19px; padding: 8px 22px; }
  /* A miniature of the real thing, so the tile shows the product. */
  .preview {
    background: #10262a; border: 1px solid rgba(85,201,187,.38);
    border-radius: 14px; overflow: hidden; flex-shrink: 0;
    box-shadow: 0 30px 70px rgba(0,0,0,.6);
    font-family: ui-monospace, Consolas, monospace; font-size: 16px;
  }
  .preview .bar {
    background: rgba(85,201,187,.16); padding: 9px 16px;
    font-family: "Segoe UI", sans-serif; font-size: 14px; font-weight: 700; color: #cfe6e3;
    border-bottom: 1px solid rgba(85,201,187,.28);
  }
  table { border-collapse: collapse; }
  th, td { padding: 9px 18px; border-bottom: 1px solid rgba(85,201,187,.16); text-align: left; }
  th { color: #9fbdb9; font-family: "Segoe UI", sans-serif; font-size: 13.5px; font-weight: 700; }
  td { color: #eaf5f3; }
  td.n { text-align: right; color: #ffc857; }
</style>
<div class="tile"><div class="inner">
  <div class="left">
    <div class="row">
      <img class="mark" src="data:image/png;base64,${iconData}" alt="">
      <div class="name"><span class="a">Table</span> <span class="b">Grabber</span></div>
    </div>
    <div class="tag">Copy any table on any page into the format you actually need &mdash; merged cells aligned, numbers still numbers.</div>
    <div class="chips">
      <span class="free">FREE &middot; NO ROW LIMIT</span>
      ${CHIPS.slice(0, 4).map((c) => `<span class="chip">${c}</span>`).join("")}
    </div>
  </div>
  <div class="preview">
    <div class="bar">Sales by city &mdash; 4 rows &times; 3 cols</div>
    <table>
      <tr><th>Region &ndash; Country</th><th>Region &ndash; City</th><th>Sales</th></tr>
      <tr><td>UK</td><td>London</td><td class="n">1200.50</td></tr>
      <tr><td>UK</td><td>Leeds</td><td class="n">800</td></tr>
      <tr><td>France</td><td>Paris</td><td class="n">2400</td></tr>
    </table>
  </div>
</div></div>`;

// ── Render ─────────────────────────────────────────────────────────────────

const PORT = String(9900 + Math.floor(Math.random() * 90));
const PROFILE = mkdtempSync(join(tmpdir(), "tg-promo-"));

const chrome = spawn(CHROME, [
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + PROFILE,
  "--headless=new",
  "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-device-scale-factor=1",
  "about:blank",
], { stdio: "ignore" });

process.on("exit", () => { try { chrome.kill(); } catch {} });

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  throw new Error("Chrome never came up");
}
await waitFor(`http://localhost:${PORT}/json/version`);

const version = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params, sessionId) =>
  new Promise((res, rej) => {
    const msgId = ++id;
    pending.set(msgId, { res, rej });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {}, sessionId }));
    setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); rej(new Error(method + " timed out")); } }, 30000);
  });
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);

async function tile(html, width, height, name) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) }, sessionId);
  await new Promise((r) => setTimeout(r, 900));
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const buf = Buffer.from(data, "base64");
  writeFileSync(join(OUT, name), buf);
  console.log(`  ${name}  ${width}x${height}  ${Math.round(buf.length / 1024)} KB`);
}

console.log("\nPromotional tiles");
await tile(small, 440, 280, "promo-small-440x280.png");
await tile(marquee, 1400, 560, "promo-marquee-1400x560.png");

try { chrome.kill(); } catch {}
process.exit(0);
