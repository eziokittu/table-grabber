/**
 * Throwaway diagnostic harness. Loads the extension against the fixture page
 * and evaluates whatever expression you put in PROBES, in the page context.
 *
 * Kept in the repo because "why did the scroller not scroll" is a question that
 * recurs, and rebuilding this each time is worse than reading it.
 * Run: node scripts/probe.mjs
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
  "/usr/bin/google-chrome",
].filter(Boolean).find((p) => existsSync(p));

const PORT = String(9800 + Math.floor(Math.random() * 100));
const DEMO_PORT = String(4800 + Math.floor(Math.random() * 100));
const DEMO = "http://localhost:" + DEMO_PORT + "/";
const staged = stageExtension(["http://localhost/*"]);
const PROFILE = mkdtempSync(join(tmpdir(), "tg-probe-"));

const demoServer = spawn(process.execPath, [join(ROOT, "scripts/serve-demo.mjs")], {
  env: { ...process.env, PORT: DEMO_PORT }, stdio: "ignore",
});
const chrome = spawn(CHROME, [
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
  "--headless=new", "--window-size=1400,900",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-features=CalculateNativeWinOcclusion",
  DEMO,
], { stdio: "ignore" });

function shutdown() {
  try { chrome.kill(); } catch {}
  try { demoServer.kill(); } catch {}
  staged.cleanup();
}
process.on("exit", shutdown);

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

const targets = (await send("Target.getTargets")).targetInfos;
const page = targets.find((t) => t.type === "page" && t.url.startsWith(DEMO));
const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) return "EXCEPTION: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const PROBES = {
  "virtual scroll mechanics": `
    (async () => {
      const s = document.getElementById("virtual");
      const tbody = document.querySelector("#virtual-table tbody");
      let fired = 0;
      s.addEventListener("scroll", () => fired++);

      const snap = (label) => ({
        label,
        scrollTop: s.scrollTop,
        clientHeight: s.clientHeight,
        scrollHeight: s.scrollHeight,
        tbodyRows: tbody.children.length,
        indices: [...tbody.querySelectorAll("tr[aria-rowindex]")].map(r => +r.getAttribute("aria-rowindex")),
        spacerHeights: [...tbody.querySelectorAll("td[colspan]")].map(td => td.getBoundingClientRect().height)
      });

      const before = snap("at rest");
      s.scrollTop = 400;
      await new Promise(r => setTimeout(r, 800));
      const after = snap("after scrollTop=400 alone");

      // Does a synthetic event drive the fixture's own renderer?
      s.dispatchEvent(new Event("scroll", { bubbles: false }));
      await new Promise(r => setTimeout(r, 120));
      const afterSynthetic = snap("after a synthetic scroll event");

      return {
        firedTotal: fired,
        rafWorks: await Promise.race([
          new Promise(r => requestAnimationFrame(() => r(true))),
          new Promise(r => setTimeout(() => r(false), 500)),
        ]),
        before: { ...before, indices: [before.indices[0], "..", before.indices.at(-1)] },
        after: { ...after, indices: [after.indices[0], "..", after.indices.at(-1)] },
        afterSynthetic: { ...afterSynthetic, indices: [afterSynthetic.indices[0], "..", afterSynthetic.indices.at(-1)] }
      };
    })()`,

  "scroller detection": `
    (async () => {
      const cap = await import("${"chrome-extension://" + extId + "/src/shared/capture.js"}");
      const el = document.getElementById("virtual-table");
      const s = cap.findScroller(el);
      return {
        found: s ? (s.id || s.tagName) : null,
        clientHeight: s?.clientHeight,
        scrollHeight: s?.scrollHeight,
        scrollTop: s?.scrollTop,
        canScroll: s ? s.scrollHeight > s.clientHeight : false
      };
    })()`,

  "manual scroll moves it": `
    (() => {
      const s = document.getElementById("virtual");
      const before = s.scrollTop;
      s.scrollTop = 400;
      const after = s.scrollTop;
      const idx = [...s.querySelectorAll("tr[aria-rowindex]")].map(r => r.getAttribute("aria-rowindex"));
      return { before, after, renderedIndices: idx.slice(0, 3).concat(["...", idx[idx.length-1]]) };
    })()`,

  "rows visible after settle": `
    (async () => {
      const s = document.getElementById("virtual");
      s.scrollTop = 0;
      await new Promise(r => setTimeout(r, 120));
      const a = s.querySelectorAll("tr[aria-rowindex]").length;
      s.scrollTop = 128;
      await new Promise(r => setTimeout(r, 120));
      const idx = [...s.querySelectorAll("tr[aria-rowindex]")].map(r => +r.getAttribute("aria-rowindex"));
      return { atTop: a, afterScroll: idx.length, first: idx[0], last: idx[idx.length-1], scrollTop: s.scrollTop };
    })()`,

  "div grid candidates": `
    (async () => {
      const ex = await import("${"chrome-extension://" + extId + "/src/shared/extract.js"}");
      const container = document.querySelector(".grid");
      const kids = [...container.children];
      const sig = el => el.tagName + "|" + [...el.classList].slice(0,3).sort().join(".");
      return {
        childCount: kids.length,
        signatures: kids.map(sig),
        childWidths: kids.map(k => k.children.length)
      };
    })()`,

  "next control detection": `
    (async () => {
      const cap = await import("${"chrome-extension://" + extId + "/src/shared/capture.js"}");
      const el = document.getElementById("paged");
      const next = cap.findNextControl(el);
      const btn = document.getElementById("next");
      return {
        found: next ? (next.id || next.tagName + ":" + next.textContent.trim()) : null,
        actualButtonText: JSON.stringify(btn.textContent),
        actualButtonId: btn.id
      };
    })()`,
};

for (const [label, expr] of Object.entries(PROBES)) {
  const out = await evaluate(expr);
  console.log("\n### " + label);
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
}

shutdown();
process.exit(0);
