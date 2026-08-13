/**
 * Popup controller.
 *
 * Scan on open, list what was found, and offer the three things people want
 * most often (copy as CSV / TSV / Markdown) without a second click. Anything
 * that needs room — renaming columns, filtering, deep capture, other formats —
 * goes to the editor tab.
 */

import { copyToClipboard } from "../shared/export.js";

const $ = (id) => document.getElementById(id);

const els = {
  loading: $("loading"),
  blocked: $("blocked"),
  blockedMsg: $("blocked-msg"),
  empty: $("empty"),
  results: $("results"),
  list: $("list"),
  count: $("count"),
  status: $("status"),
  rescan: $("rescan"),
  pick: $("pick"),
  pickEmpty: $("pick-empty"),
  template: $("row-template"),
};

let tabId = null;
let tables = [];

// ── Plumbing ───────────────────────────────────────────────────────────────

/** Everything goes through the service worker so injection is handled once. */
function relay(message) {
  return chrome.runtime.sendMessage({ type: "relay", tabId, message });
}

function show(which) {
  for (const key of ["loading", "blocked", "empty", "results"]) {
    els[key].hidden = key !== which;
  }
}

let statusTimer = null;
function status(text, kind) {
  els.status.textContent = text || "";
  els.status.className = "status" + (kind ? " " + kind : "");
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => status(""), 2600);
}

// ── Rendering ──────────────────────────────────────────────────────────────

function render() {
  els.list.replaceChildren();
  els.count.textContent = tables.length === 1 ? "1 table" : `${tables.length} tables`;

  for (const t of tables) {
    const node = els.template.content.cloneNode(true);
    const item = node.querySelector(".item");
    item.dataset.id = t.id;

    node.querySelector(".item-label").textContent = t.label || "Table";
    node.querySelector(".item-dims").textContent =
      `${t.rowCount.toLocaleString()} rows × ${t.colCount} cols`;

    const preview = (t.headers || []).filter(Boolean).slice(0, 6).join(" · ");
    node.querySelector(".item-preview").textContent = preview || "(no headers)";

    const badges = node.querySelector(".item-badges");
    if (t.virtualised) {
      badges.append(badge("partial", "pill-warn", "Only the visible rows are loaded — open the editor to grab them all"));
    }
    if (t.kind === "grid") {
      badges.append(badge("grid", "pill-purple", "Built from plain boxes rather than a real <table>"));
    }
    if (t.hasMerges) {
      badges.append(badge("merged", "", "Contains merged cells, which are expanded on export"));
    }

    els.list.append(node);
  }

  show("results");
}

function badge(text, cls, title) {
  const span = document.createElement("span");
  span.className = "pill " + (cls || "");
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

// ── Actions ────────────────────────────────────────────────────────────────

async function fetchTable(id) {
  const res = await relay({ type: "get", id });
  if (res?.error || !res?.table) throw new Error(res?.error || "That table is no longer on the page.");
  return res.table;
}

async function quickCopy(id, format) {
  try {
    status("Copying…");
    const table = await fetchTable(id);
    await copyToClipboard(table, format);
    const label = { csv: "CSV", tsv: "TSV", markdown: "Markdown" }[format] || format;
    status(`${table.rowCount.toLocaleString()} rows copied as ${label}`, "ok");
  } catch (e) {
    status(e.message, "err");
  }
}

async function openEditor(id) {
  try {
    const table = await fetchTable(id);
    const tab = await chrome.tabs.get(tabId);
    await chrome.runtime.sendMessage({
      type: "openDashboard",
      payload: {
        table,
        tableId: id,
        sourceTabId: tabId,
        source: { url: tab.url, title: tab.title },
      },
    });
    window.close();
  } catch (e) {
    status(e.message, "err");
  }
}

async function pick() {
  // The picker needs the page, and the popup closing is what gives it focus.
  const pending = relay({ type: "pick" });
  window.close();
  await pending;
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function scan() {
  show("loading");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");
    tabId = tab.id;

    const ready = await chrome.runtime.sendMessage({ type: "ensure", tabId });
    if (!ready?.ok) {
      els.blockedMsg.textContent = ready?.error || "This page cannot be read.";
      show("blocked");
      return;
    }

    const res = await relay({ type: "scan", options: {} });
    if (res?.error) {
      els.blockedMsg.textContent = res.error;
      show("blocked");
      return;
    }

    tables = res.tables || [];
    if (tables.length === 0) {
      show("empty");
      return;
    }

    // Biggest first: on a page full of layout tables, the data table wins.
    tables.sort((a, b) => b.rowCount * b.colCount - a.rowCount * a.colCount);
    render();
  } catch (e) {
    els.blockedMsg.textContent = String(e?.message || e);
    show("blocked");
  }
}

els.list.addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;

  const actionBtn = e.target.closest("[data-act]");
  if (actionBtn) {
    const act = actionBtn.dataset.act;
    if (act === "open") openEditor(id);
    else quickCopy(id, act);
    return;
  }

  if (e.target.closest(".item-main")) relay({ type: "highlight", id });
});

els.rescan.addEventListener("click", scan);
els.pick.addEventListener("click", pick);
els.pickEmpty.addEventListener("click", pick);

scan();
