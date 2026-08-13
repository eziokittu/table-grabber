/**
 * End-to-end test. Drives a real Chrome over the DevTools Protocol:
 *
 *   1. starts the fixture server and a throwaway Chrome profile
 *   2. loads this extension unpacked
 *   3. injects the content script the way the service worker does
 *   4. asserts what the engine actually extracts from a live DOM
 *   5. exercises deep capture — scrolling a virtualised grid, walking pages
 *   6. opens the editor and asserts it renders and exports
 *
 * Run with `npm run e2e`. Requires Chrome; set CHROME to override the path.
 *
 * Chrome must be started with --enable-unsafe-extension-debugging: plain
 * --load-extension stopped working in Chrome 137, and CDP's
 * Extensions.loadUnpacked is the supported replacement. It wants a
 * forward-slash path even on Windows.
 *
 * This catches what the DOM-only checks in check.mjs cannot — a manifest Chrome
 * refuses, a dynamic import that 404s because it is not web-accessible, a panel
 * that is [hidden] but still displayed, and any code path that only misbehaves
 * against a real layout engine.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageExtension } from "./stage-extension.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
]
  .filter(Boolean)
  .find((p) => existsSync(p));

if (!CHROME) {
  console.error("Could not find Chrome. Set the CHROME environment variable to its path.");
  process.exit(1);
}

const PORT = String(9600 + Math.floor(Math.random() * 200));
const DEMO_PORT = String(4600 + Math.floor(Math.random() * 200));
const DEMO = "http://localhost:" + DEMO_PORT + "/";

const staged = stageExtension(["http://localhost/*", "https://localhost/*"]);
const PROFILE = mkdtempSync(join(tmpdir(), "table-grabber-e2e-"));

const demoServer = spawn(process.execPath, [join(ROOT, "scripts/serve-demo.mjs")], {
  env: { ...process.env, PORT: DEMO_PORT },
  stdio: "ignore",
});

const chrome = spawn(
  CHROME,
  [
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion",
    // Without these an unfocused window stops painting, and a renderer that is
    // not painting never dispatches scroll events — which silently turns the
    // deep-capture assertions into a test of nothing.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--window-size=1400,900",
    DEMO,
  ],
  { stdio: "ignore" }
);

let cleanedUp = false;
function shutdown() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { chrome.kill(); } catch { /* already gone */ }
  try { demoServer.kill(); } catch { /* already gone */ }
  staged.cleanup();
}
process.on("exit", shutdown);
process.on("SIGINT", () => { shutdown(); process.exit(130); });

async function waitFor(url, label) {
  for (let i = 0; i < 60; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error(label + " never came up");
}

await waitFor(DEMO, "fixture server");
await waitFor("http://localhost:" + PORT + "/json/version", "Chrome");

const version = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);

let id = 0;
const pending = new Map();
const send = (method, params, sessionId) => {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {}, sessionId }));
    setTimeout(() => {
      if (pending.has(msgId)) {
        pending.delete(msgId);
        reject(new Error(method + " timed out"));
      }
    }, 60000);
  });
};

ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message + (m.error.data ? " - " + m.error.data : "")));
    else resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  -> " + detail : "")); }
};

async function attach(targetId) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  return sessionId;
}

async function evaluate(sessionId, expression) {
  const res = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

/** Console errors from any surface are failures; collected as we go. */
const consoleErrors = [];
function watchConsole(sessionId, where) {
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      consoleErrors.push(where + ": " + m.params.args.map((a) => a.description || a.value).join(" "));
    }
    if (m.method === "Runtime.exceptionThrown") {
      consoleErrors.push(where + ": " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });
}

// ── 1. Load the extension ──────────────────────────────────────────────────
console.log("\nLoading extension");
let extId;
try {
  extId = (await send("Extensions.loadUnpacked", { path: staged.path })).id;
  check("Chrome accepted the manifest", !!extId, "no id returned");
  console.log("        id " + extId);
} catch (e) {
  check("Chrome accepted the manifest", false, e.message);
  console.log("\nCannot continue without a loaded extension.");
  process.exit(1);
}

await sleep(1200);

// ── 2. Attach to the service worker ────────────────────────────────────────
console.log("\nService worker");
let targets = (await send("Target.getTargets")).targetInfos;
let sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
if (!sw) {
  // MV3 workers idle out; a message wakes one. Give it a moment either way.
  await sleep(2000);
  targets = (await send("Target.getTargets")).targetInfos;
  sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
}
check("service worker is running", !!sw, "no service_worker target");
if (!sw) process.exit(1);

const swSession = await attach(sw.targetId);
watchConsole(swSession, "service worker");

const swAlive = await evaluate(swSession, `typeof chrome.scripting === "object"`);
check("service worker has the scripting API", swAlive === true);

// ── 3. Find the fixture tab ────────────────────────────────────────────────
const demoTabId = await evaluate(
  swSession,
  `chrome.tabs.query({}).then(ts => (ts.find(t => t.url && t.url.startsWith(${JSON.stringify(DEMO)})) || {}).id ?? null)`
);
check("fixture page is open", typeof demoTabId === "number", "no tab matching " + DEMO);
if (typeof demoTabId !== "number") process.exit(1);

/** Calls into the content script exactly as the popup does. */
async function relay(message) {
  return evaluate(
    swSession,
    `(async () => {
       try {
         return await chrome.tabs.sendMessage(${demoTabId}, ${JSON.stringify(message)});
       } catch (e) { return { error: String(e && e.message || e) }; }
     })()`
  );
}

// ── 4. Inject and scan ─────────────────────────────────────────────────────
console.log("\nInjection");
const injected = await evaluate(
  swSession,
  `chrome.scripting.executeScript({ target: { tabId: ${demoTabId} }, files: ["src/content/content.js"] })
     .then(() => true).catch(e => String(e.message || e))`
);
check("content script injects", injected === true, String(injected));

await sleep(400);
const pong = await relay({ type: "ping" });
check("content script answers", pong?.ok === true, JSON.stringify(pong));

console.log("\nScanning the fixture page");
const scan = await relay({ type: "scan", options: {} });
check("scan succeeded", !scan?.error && Array.isArray(scan?.tables), JSON.stringify(scan?.error));

const tables = scan?.tables || [];
console.log("        found " + tables.length + " tables");
for (const t of tables) {
  console.log(`          ${t.id}  ${t.kind.padEnd(5)}  ${String(t.rowCount).padStart(4)}x${t.colCount}  ${t.virtualised ? "[virtual] " : ""}${t.label}`);
}
check("finds at least six tables", tables.length >= 6, "got " + tables.length);

// ── 5. Merged cells, against a real DOM ────────────────────────────────────
console.log("\nMerged cells");
const mergedSummary = tables.find((t) => (t.caption || "").includes("Sales by city"));
check("merged-header table found by caption", !!mergedSummary);

if (mergedSummary) {
  const got = await relay({ type: "get", id: mergedSummary.id });
  const tbl = got?.table;
  check("keeps 3 columns under a colspan header", tbl?.colCount === 3, "got " + tbl?.colCount);
  check("keeps 4 body rows", tbl?.rowCount === 4, "got " + tbl?.rowCount);
  check(
    "stacked header reads 'Region – Country'",
    tbl?.headers?.[0] === "Region – Country",
    JSON.stringify(tbl?.headers)
  );
  const leeds = tbl?.rows?.find((r) => r[1] === "Leeds");
  check("rowspan carries UK down to the Leeds row", leeds?.[0] === "UK", JSON.stringify(leeds));
  check("columns stay aligned under the rowspan", leeds?.[2] === "$800", JSON.stringify(leeds));
  check("hasMerges is reported", tbl?.hasMerges === true);
}

// ── 6. Awkward cell content ────────────────────────────────────────────────
console.log("\nCell content");
const awkward = tables.find((t) => (t.headers || []).includes("Flag"));
check("awkward-content table found", !!awkward);
if (awkward) {
  const tbl = (await relay({ type: "get", id: awkward.id }))?.table;
  const japan = tbl?.rows?.find((r) => String(r[0]).startsWith("Japan"));
  check("footnote marker stripped from 'Japan[a]'", japan?.[0] === "Japan", JSON.stringify(japan?.[0]));
  check("<br> becomes a newline", japan?.[1]?.includes("\n"), JSON.stringify(japan?.[1]));
  check("image alt text used for an image-only cell", japan?.[2] === "Flag of Japan", JSON.stringify(japan?.[2]));
  const brazil = tbl?.rows?.find((r) => String(r[0]) === "Brazil");
  check(
    "nested table's text does not leak into the parent cell",
    brazil && !String(brazil[1]).includes("NESTED-A"),
    JSON.stringify(brazil?.[1])
  );
}

// ── 7. Div grid and shadow DOM ─────────────────────────────────────────────
console.log("\nHard-to-find tables");
const divGrid = tables.find((t) => t.kind === "grid" && (t.headers || []).includes("Role"));
check("grid built from divs is found", !!divGrid, JSON.stringify(tables.filter((t) => t.kind === "grid").map((t) => t.headers)));
if (divGrid) {
  const tbl = (await relay({ type: "get", id: divGrid.id }))?.table;
  check("div grid has 4 rows", tbl?.rowCount === 4, "got " + tbl?.rowCount);
  check("div grid keeps its header row", tbl?.headers?.[0] === "Name", JSON.stringify(tbl?.headers));
}

const shadow = tables.find((t) => (t.headers || []).includes("Symbol"));
check("table inside a shadow root is found", !!shadow);
if (shadow) {
  const tbl = (await relay({ type: "get", id: shadow.id }))?.table;
  check("shadow table has 3 rows", tbl?.rowCount === 3, "got " + tbl?.rowCount);
}

// ── 8. Virtualised deep capture ────────────────────────────────────────────
console.log("\nVirtualised grid");
const virt = tables.find((t) => (t.headers || []).includes("Label"));
check("virtualised table found", !!virt);
if (virt) {
  console.log("        first read saw " + virt.rowCount + " of 500 rows");
  check("a plain read is incomplete, as expected", virt.rowCount < 100, "got " + virt.rowCount);

  const deep = await relay({ type: "deepCapture", id: virt.id, mode: "scroll", options: {} });
  check("scroll capture ran", deep?.ok === true, JSON.stringify(deep));
  if (deep?.ok) {
    console.log("        strategy " + deep.strategy + ", " + deep.scrolls + " scrolls, " + deep.rowCount + " rows");
    check("scroll capture used the grid's own row indices", deep.strategy === "row-index", deep.strategy);
    check("scroll capture collected all 500 rows", deep.rowCount === 500, "got " + deep.rowCount);
    check("scroll capture reports completion", deep.complete === true);

    const tbl = (await relay({ type: "get", id: virt.id }))?.table;
    check("row 1 is first", tbl?.rows?.[0]?.[1] === "Item 001", JSON.stringify(tbl?.rows?.[0]));
    check("row 500 is last", tbl?.rows?.[499]?.[1] === "Item 500", JSON.stringify(tbl?.rows?.[499]));
  }
}

// ── 9. Pagination ──────────────────────────────────────────────────────────
console.log("\nPagination");
const paged = tables.find((t) => (t.headers || []).includes("Product"));
check("paginated table found", !!paged);
if (paged) {
  const can = await relay({ type: "canPaginate", id: paged.id });
  check("next control detected", can?.can === true, JSON.stringify(can));

  const walked = await relay({ type: "deepCapture", id: paged.id, mode: "paginate", options: {} });
  check("pagination capture ran", walked?.ok === true, JSON.stringify(walked));
  if (walked?.ok) {
    console.log("        walked " + walked.pages + " pages, " + walked.rowCount + " rows");
    check("collected all 15 rows across 3 pages", walked.rowCount === 15, "got " + walked.rowCount);
    check("stopped on the last page", walked.complete === true);
  }
}

// ── 10. The editor ─────────────────────────────────────────────────────────
console.log("\nEditor");
const grabTarget = mergedSummary || tables[0];
const openedUrl = await evaluate(
  swSession,
  `(async () => {
     const res = await chrome.tabs.sendMessage(${demoTabId}, { type: "get", id: ${JSON.stringify(grabTarget.id)} });
     const key = "handoff:e2e";
     await chrome.storage.session.set({ [key]: {
       table: res.table, tableId: ${JSON.stringify(grabTarget.id)}, sourceTabId: ${demoTabId},
       source: { url: ${JSON.stringify(DEMO)}, title: "fixtures" }
     }});
     const tab = await chrome.tabs.create({
       url: chrome.runtime.getURL("src/dashboard/dashboard.html?k=" + key + "&tab=${demoTabId}&id=" + ${JSON.stringify(grabTarget.id)})
     });
     // A freshly created tab reports its address on pendingUrl until it commits.
     return { id: tab.id, url: tab.url || tab.pendingUrl || "" };
   })()`
);
// Chrome reports an empty url *and* pendingUrl for the first moment of a tab's
// life, so the id is the only thing worth asserting here; the address is
// verified below, once the target has committed.
check("editor tab opened", typeof openedUrl?.id === "number", JSON.stringify(openedUrl));

await sleep(1500);
targets = (await send("Target.getTargets")).targetInfos;
const dash = targets.find((t) => t.type === "page" && t.url.includes("dashboard.html"));
check("editor target exists", !!dash);

if (dash) {
  const dashSession = await attach(dash.targetId);
  watchConsole(dashSession, "editor");
  await sleep(800);

  const state = await evaluate(
    dashSession,
    `({
       loadingHidden: document.getElementById("loading").hidden,
       errorHidden: document.getElementById("error").hidden,
       errorText: document.getElementById("error-msg").textContent,
       appVisible: !document.getElementById("app").hidden,
       exportVisible: !document.getElementById("exportbar").hidden,
       rows: document.getElementById("stat-rows").textContent,
       cols: document.getElementById("stat-cols").textContent,
       headerCells: document.querySelectorAll("#grid-head th").length,
       bodyRows: document.querySelectorAll("#grid-body tr").length,
       columnControls: document.querySelectorAll("#columns .col").length,
       formats: document.querySelectorAll("#format option").length,
       deepVisible: !document.getElementById("deep-section").hidden
     })`
  );
  check("editor finished loading", state.loadingHidden === true);
  check("editor shows no error", state.errorHidden === true, state.errorText);
  check("editor rendered the app", state.appVisible === true);
  check("export bar is visible", state.exportVisible === true);
  check("stats populated", /\d/.test(state.rows) && /\d/.test(state.cols), state.rows + " / " + state.cols);
  check("grid drew a header per column plus the gutter", state.headerCells === 4, "got " + state.headerCells);
  check("grid drew the body rows", state.bodyRows === 4, "got " + state.bodyRows);
  check("column panel built", state.columnControls === 3, "got " + state.columnControls);
  check("every format is offered", state.formats >= 13, "got " + state.formats);
  check("deep-capture panel offered", state.deepVisible === true);

  // Exercise the transforms through the real UI, not the module.
  const afterHide = await evaluate(
    dashSession,
    `(() => {
       const box = document.querySelector("#columns .col input[type=checkbox]");
       box.checked = false;
       box.dispatchEvent(new Event("change", { bubbles: true }));
       return document.getElementById("stat-cols").textContent;
     })()`
  );
  check("hiding a column updates the view", afterHide.startsWith("2"), afterHide);

  const afterSearch = await evaluate(
    dashSession,
    `(async () => {
       const s = document.getElementById("search");
       s.value = "Paris";
       s.dispatchEvent(new Event("input", { bubbles: true }));
       await new Promise(r => setTimeout(r, 300));
       return document.getElementById("stat-rows").textContent;
     })()`
  );
  check("filtering rows updates the view", afterSearch.startsWith("1"), afterSearch);

  // Reset the view, then prove the export engine loads and runs *inside the
  // real extension page* — module resolution and CSP both differ from Node.
  const csv = await evaluate(
    dashSession,
    `(async () => {
       const s = document.getElementById("search");
       s.value = "";
       s.dispatchEvent(new Event("input", { bubbles: true }));
       const box = document.querySelector("#columns .col input[type=checkbox]");
       box.checked = true;
       box.dispatchEvent(new Event("change", { bubbles: true }));
       await new Promise(r => setTimeout(r, 300));

       const m = await import("../shared/export.js");
       return m.toCsv({ headers: ["a", "b"], rows: [["1", "x,y"]] });
     })().catch(e => "ERR " + e.message)`
  );
  check(
    "export engine runs inside the editor page",
    typeof csv === "string" && csv.includes('"x,y"'),
    String(csv).slice(0, 120)
  );

  // And the xlsx writer, which is the one that fails in ways nothing else does.
  const xlsx = await evaluate(
    dashSession,
    `(async () => {
       const m = await import("../shared/export.js");
       const blob = m.toXlsx({ headers: ["n"], rows: [["1,234"]], types: ["number"] });
       const buf = new Uint8Array(await blob.arrayBuffer());
       return { size: buf.length, pk: buf[0] === 0x50 && buf[1] === 0x4b };
     })().catch(e => ({ err: e.message }))`
  );
  check("xlsx writer produces a real ZIP in the browser", xlsx?.pk === true && xlsx.size > 1000, JSON.stringify(xlsx));

  const stateAfterReset = await evaluate(dashSession, `document.getElementById("stat-rows").textContent`);
  check("clearing the filter restores every row", stateAfterReset.startsWith("4"), stateAfterReset);
}

// ── 11. Console hygiene ────────────────────────────────────────────────────
console.log("\nConsole");
await sleep(500);
// Chrome logs a benign warning when a service worker is attached by CDP.
const real = consoleErrors.filter((e) => !/DevTools|Extensions\.loadUnpacked/i.test(e));
check("no console errors anywhere", real.length === 0, real.slice(0, 5).join(" | "));

// ── Result ─────────────────────────────────────────────────────────────────
console.log("\n" + (fail === 0 ? `All ${pass} browser checks passed.` : `${fail} of ${pass + fail} browser checks FAILED.`));
shutdown();
process.exit(fail === 0 ? 0 : 1);
