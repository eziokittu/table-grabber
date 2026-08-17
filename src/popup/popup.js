/**
 * Popup controller.
 *
 * Two jobs, in order of how often they are wanted: start a pick on the page,
 * and list what a plain scan already found. The three quick copies (CSV, TSV,
 * Markdown) are here too because they are one click from the answer; anything
 * that needs room goes to the editor tab.
 *
 * Note what this file does *not* do: wait for the result of a pick. The popup
 * is closed by the time anyone clicks a table — that is unavoidable, the page
 * needs the focus — so the page finishes the job itself. The old version
 * awaited a reply that could never arrive, which is why the pick button looked
 * broken.
 */

import { copyToClipboard } from "../shared/export.js";

const $ = (id) => document.getElementById(id);

const els = {
  loading: $("loading"), blocked: $("blocked"), blockedMsg: $("blocked-msg"),
  empty: $("empty"), results: $("results"), list: $("list"), count: $("count"),
  status: $("status"), rescan: $("rescan"),
  pick: $("pick"), region: $("region"), paste: $("paste"),
  picking: $("picking"), cancelPick: $("cancel-pick"),
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
    node.querySelector(".item-preview").textContent = preview || "(no column names)";

    const badges = node.querySelector(".item-badges");
    if (t.virtualised) {
      badges.append(badge("partial", "pill-warn", "Only the visible rows are loaded — open the editor to collect them all"));
    }
    if (t.kind === "grid") {
      badges.append(badge("grid", "pill-blue", "Built from plain boxes rather than a real <table>"));
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

/**
 * Hands the page over to the picker and gets out of the way.
 *
 * The message is sent and *not* awaited past the send: the popup has to close
 * for the page to receive the pointer at all, and anything this window is still
 * waiting for dies with it.
 */
async function startPick(mode) {
  if (!tabId) return;
  try {
    await relay({ type: "pick", mode });
    window.close();
  } catch {
    status("This page cannot be picked on.", "err");
  }
}

async function openPaste() {
  await chrome.runtime.sendMessage({ type: "openPaste" });
  window.close();
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
      els.pick.disabled = true;
      els.region.disabled = true;
      return;
    }

    // A pick already running on the page gets a cancel button here, so the
    // toolbar icon is always a way *out* of picking as well as in.
    const state = await relay({ type: "state" });
    els.picking.hidden = !state?.picking;

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
els.pick.addEventListener("click", () => startPick("element"));
els.region.addEventListener("click", () => startPick("region"));
els.paste.addEventListener("click", openPaste);
els.cancelPick.addEventListener("click", async () => {
  await relay({ type: "cancelPick" });
  els.picking.hidden = true;
  status("Picking cancelled", "ok");
});

scan();
