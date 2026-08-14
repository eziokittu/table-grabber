/**
 * Captures the Chrome Web Store screenshots from a real browser.
 *
 * Everything here is a genuine capture of the extension doing the thing the
 * caption claims — no mockups, no composited fakes. The store rejects
 * misleading imagery, and a screenshot that does not match the product is worse
 * than no screenshot.
 *
 * Output: store/screenshots/*.png at exactly 1280x800, which is one of the two
 * sizes the store accepts.
 *
 * Run: npm run screenshots
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageExtension } from "./stage-extension.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "store", "screenshots");
const W = 1280;
const H = 800;

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

mkdirSync(OUT, { recursive: true });

const PORT = String(9700 + Math.floor(Math.random() * 100));
const DEMO_PORT = String(4700 + Math.floor(Math.random() * 100));
const DEMO = "http://localhost:" + DEMO_PORT + "/";
const staged = stageExtension(["http://localhost/*"]);
const PROFILE = mkdtempSync(join(tmpdir(), "tg-shots-"));

const demoServer = spawn(process.execPath, [join(ROOT, "scripts/serve-demo.mjs")], {
  env: { ...process.env, PORT: DEMO_PORT }, stdio: "ignore",
});

const chrome = spawn(CHROME, [
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + PROFILE,
  "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  `--window-size=${W},${H + 120}`,
  DEMO,
], { stdio: "ignore" });

function shutdown() {
  try { chrome.kill(); } catch {}
  try { demoServer.kill(); } catch {}
  staged.cleanup();
}
process.on("exit", shutdown);
process.on("SIGINT", () => { shutdown(); process.exit(130); });

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("never came up: " + url);
}
await waitFor(DEMO);
await waitFor("http://localhost:" + PORT + "/json/version");

const version = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params, sessionId) =>
  new Promise((res, rej) => {
    const msgId = ++id;
    pending.set(msgId, { res, rej });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {}, sessionId }));
    setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); rej(new Error(method + " timed out")); } }, 40000);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extId = (await send("Extensions.loadUnpacked", { path: staged.path })).id;
await sleep(1200);

/**
 * @param {string} targetId
 * @param {boolean} [renders] true for page targets. A service worker has no
 *   Page or Emulation domain, and asking for them throws.
 */
async function attach(targetId, renders = true) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);

  if (renders) {
    await send("Page.enable", {}, sessionId);
    // Pin the rendering surface to exactly the store's size, whatever the OS
    // decided the window chrome should be.
    await send("Emulation.setDeviceMetricsOverride", {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
  }
  return sessionId;
}

const evaluate = async (sessionId, expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

async function shoot(sessionId, name) {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  ${name}  ${Math.round(Buffer.from(data, "base64").length / 1024)} KB`);
}

const targets = () => send("Target.getTargets").then((r) => r.targetInfos);

// ── The fixture page ───────────────────────────────────────────────────────
const page = (await targets()).find((t) => t.type === "page" && t.url.startsWith(DEMO));
const pageSession = await attach(page.targetId);

const swTarget = (await targets()).find((t) => t.type === "service_worker" && t.url.includes(extId));
const swSession = await attach(swTarget.targetId, false);

const tabId = await evaluate(
  swSession,
  `chrome.tabs.query({}).then(ts => (ts.find(t => t.url && t.url.startsWith(${JSON.stringify(DEMO)})) || {}).id ?? null)`
);

await evaluate(swSession, `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["src/content/content.js"] }).then(() => true)`);
await sleep(500);
const scan = await evaluate(swSession, `chrome.tabs.sendMessage(${tabId}, { type: "scan", options: {} })`);
console.log(`\nFound ${scan.tables.length} tables on the fixture page.`);

// ── 1. The picker overlay, live on the page ────────────────────────────────
console.log("\nCapturing");
const merged = scan.tables.find((t) => (t.caption || "").includes("Sales by city")) || scan.tables[0];

await evaluate(pageSession, `window.scrollTo(0, 0)`);
// Drive the real picker, then park the highlight over the merged-header table.
evaluate(swSession, `chrome.tabs.sendMessage(${tabId}, { type: "pick" })`).catch(() => {});
await sleep(400);
await evaluate(
  pageSession,
  `(() => {
     const el = document.querySelector("table");
     const r = el.getBoundingClientRect();
     el.dispatchEvent(new MouseEvent("mousemove", {
       clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true
     }));
     document.dispatchEvent(new MouseEvent("mousemove", {
       clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true
     }));
     return true;
   })()`
);
await sleep(500);
await shoot(pageSession, "01-picker.png");
await evaluate(pageSession, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(300);

// ── 2-4. The editor ────────────────────────────────────────────────────────
const full = await evaluate(swSession, `chrome.tabs.sendMessage(${tabId}, { type: "get", id: ${JSON.stringify(merged.id)} })`);

await evaluate(
  swSession,
  `(async () => {
     const key = "handoff:shot";
     await chrome.storage.session.set({ [key]: {
       table: ${JSON.stringify(full.table)},
       tableId: ${JSON.stringify(merged.id)},
       sourceTabId: ${tabId},
       source: { url: ${JSON.stringify(DEMO)}, title: "Sales by city — fixtures" }
     }});
     await chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html?k=" + key + "&tab=${tabId}&id=" + ${JSON.stringify(merged.id)}) });
     return true;
   })()`
);
await sleep(1800);

console.log(`  (handing over ${full.table.rowCount} rows x ${full.table.colCount} cols)`);

const dash = (await targets()).find((t) => t.type === "page" && t.url.includes("dashboard.html"));
const dashSession = await attach(dash.targetId);

// Surface anything the editor complains about; a blank screenshot is otherwise
// indistinguishable from a slow one.
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.sessionId !== dashSession) return;
  if (m.method === "Runtime.exceptionThrown") {
    console.log("  editor error: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
});

// Wait for the editor to actually finish loading rather than hoping a fixed
// delay was long enough.
for (let i = 0; i < 40; i++) {
  const ready = await evaluate(dashSession, `!document.getElementById("app").hidden`);
  if (ready) break;
  await sleep(250);
}
const state = await evaluate(
  dashSession,
  `({ loading: !document.getElementById("loading").hidden,
      error: document.getElementById("error-msg").textContent,
      rows: document.getElementById("stat-rows").textContent })`
);
if (state.loading) console.log(`  editor still loading — error: ${JSON.stringify(state.error)}, ${state.rows}`);

await sleep(500);
await shoot(dashSession, "02-editor.png");

// The format list, open, showing that everything is included.
await evaluate(
  dashSession,
  `(() => {
     const sel = document.getElementById("format");
     sel.size = 13;
     sel.style.position = "fixed";
     sel.style.bottom = "58px";
     sel.style.right = "24px";
     sel.style.zIndex = "50";
     sel.style.boxShadow = "0 -10px 40px rgba(0,0,0,.6)";
     return true;
   })()`
);
await sleep(400);
await shoot(dashSession, "03-formats.png");
await evaluate(dashSession, `(() => { const s = document.getElementById("format"); s.size = 0; s.style.cssText = ""; return true; })()`);

// The clean-up controls doing something visible: numbers, snake_case headers.
await evaluate(
  dashSession,
  `(async () => {
     document.getElementById("opt-clean").checked = true;
     document.getElementById("opt-clean").dispatchEvent(new Event("change", { bubbles: true }));
     document.getElementById("opt-header-case").value = "snake";
     document.getElementById("opt-header-case").dispatchEvent(new Event("change", { bubbles: true }));
     document.getElementById("format").value = "markdown";
     document.getElementById("format").dispatchEvent(new Event("change", { bubbles: true }));
     await new Promise(r => setTimeout(r, 300));
     return true;
   })()`
);
await sleep(600);
await shoot(dashSession, "04-transforms.png");

// ── 5. The popup ───────────────────────────────────────────────────────────
// chrome.action.openPopup() is the only honest way to capture the real popup;
// CDP cannot click a toolbar icon. It is not available in every channel, so the
// fallback is recorded rather than faked.
const opened = await evaluate(
  swSession,
  `(async () => {
     try { await chrome.action.openPopup(); return "ok"; }
     catch (e) { return "unavailable: " + (e.message || e); }
   })()`
).catch((e) => "threw: " + e.message);

if (opened === "ok") {
  await sleep(1200);
  const popup = (await targets()).find((t) => t.url.includes("popup.html"));
  if (popup) {
    // The popup is its own small native window and rejects a metrics override,
    // so it is captured at its real size. That is not one of the two sizes the
    // store accepts, so this is a supplementary asset rather than a listing
    // screenshot — see store/listing.md.
    const popupSession = await attach(popup.targetId, false);
    await send("Page.enable", {}, popupSession).catch(() => {});
    await sleep(700);
    try {
      await shoot(popupSession, "supplementary-popup.png");
      console.log("                (natural size — pad to 1280x800 before uploading, or leave it out)");
    } catch (e) {
      console.log("  supplementary-popup.png  SKIPPED (" + e.message + ")");
    }
  } else {
    console.log("  popup  SKIPPED (opened, but no target appeared)");
  }
} else {
  console.log(`  popup  SKIPPED (${opened})`);
  console.log("         Capture by hand if wanted: open the fixture page, click the toolbar icon.");
}

console.log(`\nWrote to store/screenshots/ at ${W}x${H}.`);
shutdown();
process.exit(0);
