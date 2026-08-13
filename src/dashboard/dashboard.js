/**
 * Editor controller.
 *
 * Holds two tables: `raw`, exactly as it came off the page, and `view`, the
 * result of applying the user's settings. Every control writes to `state` and
 * recomputes `view`; nothing mutates `raw`, so any setting can be undone by
 * toggling it back.
 *
 * Exports always use `view` in full — the preview cap is a rendering limit, not
 * a data limit. That distinction is the entire product, so it is also stated in
 * the UI next to the row count.
 */

import { applyState, DEFAULT_STATE, TYPES, columnStats } from "../shared/transform.js";
import { FORMATS, serialise, formatMeta, suggestFilename, copyToClipboard } from "../shared/export.js";

const $ = (id) => document.getElementById(id);

const els = {
  loading: $("loading"), error: $("error"), errorMsg: $("error-msg"),
  app: $("app"), exportbar: $("exportbar"),
  sourceTitle: $("source-title"), sourceUrl: $("source-url"),
  statRows: $("stat-rows"), statCols: $("stat-cols"),
  columns: $("columns"), colsAll: $("cols-all"), colsNone: $("cols-none"),
  optDropEmpty: $("opt-drop-empty"), optDedupe: $("opt-dedupe"),
  optClean: $("opt-clean"), optDates: $("opt-dates"), optFraction: $("opt-fraction"),
  optTrim: $("opt-trim"), optFillDown: $("opt-filldown"), optHeaderCase: $("opt-header-case"),
  optFind: $("opt-find"), optReplace: $("opt-replace"), optRegex: $("opt-regex"), optCase: $("opt-case"),
  optTranspose: $("opt-transpose"), optSkip: $("opt-skip"), optLimit: $("opt-limit"),
  deepSection: $("deep-section"), deepHint: $("deep-hint"), deepStatus: $("deep-status"),
  deepScroll: $("deep-scroll"), deepPage: $("deep-page"),
  search: $("search"), sortCol: $("sort-col"), sortDir: $("sort-dir"), previewRows: $("preview-rows"),
  gridHead: $("grid-head"), gridBody: $("grid-body"), gridNote: $("grid-note"),
  format: $("format"), formatBlurb: $("format-blurb"),
  wrapDelim: $("wrap-delim"), optDelim: $("opt-delim"),
  wrapSql: $("wrap-sql"), optDialect: $("opt-dialect"),
  wrapSqlName: $("wrap-sqlname"), optSqlName: $("opt-sqlname"),
  wrapHeaders: $("wrap-headers"), optHeaders: $("opt-headers"),
  copy: $("copy"), download: $("download"), exportStatus: $("export-status"),
};

let raw = null;
let view = null;
let source = {};
let sourceTabId = null;
let tableId = null;

const state = { ...DEFAULT_STATE, hiddenColumns: [], renames: {}, columnOrder: [] };

/**
 * Settings that should survive between grabs.
 *
 * Only preferences — never data. Someone who always wants snake_case headers
 * and numeric values should say so once, not on every table.
 */
const STICKY = ["format", "headerCase", "cleanValues", "normaliseDates", "percentAsFraction", "trimCells", "dropEmpty", "delimiter", "dialect"];

async function loadPrefs() {
  try {
    const { prefs } = await chrome.storage.local.get("prefs");
    return prefs || {};
  } catch {
    return {};
  }
}

let savePending = null;
function savePrefs() {
  clearTimeout(savePending);
  savePending = setTimeout(() => {
    const prefs = {
      format: els.format.value,
      headerCase: els.optHeaderCase.value,
      cleanValues: els.optClean.checked,
      normaliseDates: els.optDates.checked,
      percentAsFraction: els.optFraction.checked,
      trimCells: els.optTrim.checked,
      dropEmpty: els.optDropEmpty.checked,
      delimiter: els.optDelim.value,
      dialect: els.optDialect.value,
    };
    chrome.storage.local.set({ prefs }).catch(() => {});
  }, 400);
}

function applyPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  if (prefs.format && FORMATS.some((f) => f.id === prefs.format)) els.format.value = prefs.format;
  if (prefs.headerCase) els.optHeaderCase.value = prefs.headerCase;
  if (prefs.delimiter) els.optDelim.value = prefs.delimiter;
  if (prefs.dialect) els.optDialect.value = prefs.dialect;
  els.optClean.checked = !!prefs.cleanValues;
  els.optDates.checked = !!prefs.normaliseDates;
  els.optFraction.checked = !!prefs.percentAsFraction;
  els.optTrim.checked = !!prefs.trimCells;
  if (typeof prefs.dropEmpty === "boolean") els.optDropEmpty.checked = prefs.dropEmpty;
}

// ── Loading ────────────────────────────────────────────────────────────────

async function boot() {
  const params = new URLSearchParams(location.search);
  const key = params.get("k");
  sourceTabId = params.get("tab") ? Number(params.get("tab")) : null;
  tableId = params.get("id");

  let payload = null;

  if (key) {
    const res = await chrome.runtime.sendMessage({ type: "fetchHandoff", key });
    payload = res?.payload || null;
  }

  // The handoff is dropped once read, and very large tables skip it entirely,
  // so falling back to the source tab is a normal path rather than an error.
  if (!payload && sourceTabId && tableId) {
    const res = await chrome.runtime.sendMessage({
      type: "relay",
      tabId: sourceTabId,
      message: { type: "get", id: tableId },
    });
    if (res?.table) {
      payload = { table: res.table, tableId, sourceTabId, source: res.table.meta };
    }
  }

  if (!payload?.table) {
    fail("That table could not be loaded. It may have been closed or navigated away from — grab it again from the page.");
    return;
  }

  raw = payload.table;
  source = payload.source || raw.meta || {};
  sourceTabId = payload.sourceTabId ?? sourceTabId;
  tableId = payload.tableId ?? tableId;

  els.sourceTitle.textContent = source.title || raw.caption || "Grabbed table";
  if (source.url) {
    els.sourceUrl.textContent = source.url;
    els.sourceUrl.href = source.url;
  }

  buildFormatOptions();
  applyPrefs(await loadPrefs());
  syncFormatOptions();
  buildColumns();
  setupDeepCapture();
  recompute();

  els.loading.hidden = true;
  els.app.hidden = false;
  els.exportbar.hidden = false;
}

function fail(message) {
  els.loading.hidden = true;
  els.errorMsg.textContent = message;
  els.error.hidden = false;
}

// ── Controls ───────────────────────────────────────────────────────────────

function buildFormatOptions() {
  for (const f of FORMATS) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.label;
    els.format.append(opt);
  }
  els.format.value = "csv";
  syncFormatOptions();
}

function syncFormatOptions() {
  const id = els.format.value;
  els.formatBlurb.textContent = formatMeta(id).blurb;
  els.wrapDelim.hidden = id !== "csv";
  els.wrapSql.hidden = id !== "sql";
  els.wrapSqlName.hidden = id !== "sql";
  // Only the delimited and text formats have an optional header row; the rest
  // either always carry names (JSON, SQL) or always show them (Markdown).
  els.wrapHeaders.hidden = !["csv", "tsv", "text", "json-arrays"].includes(id);
}

function buildColumns() {
  els.columns.replaceChildren();

  const base = applyState(raw, { ...DEFAULT_STATE, dropEmpty: false });
  const types = base.types || [];
  const stats = columnStats(base);

  // The panel is drawn in the user's chosen order, so moving a column here
  // matches what the preview and the export will do.
  const order = state.columnOrder.length
    ? [...state.columnOrder, ...raw.headers.map((_, i) => i).filter((i) => !state.columnOrder.includes(i))]
    : raw.headers.map((_, i) => i);

  order.forEach((i, position) => {
    const header = raw.headers[i];
    const li = document.createElement("li");
    li.className = "col" + (state.hiddenColumns.includes(i) ? " off" : "");
    li.dataset.index = String(i);

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = !state.hiddenColumns.includes(i);
    check.setAttribute("aria-label", `Include column ${header}`);
    check.addEventListener("change", () => {
      state.hiddenColumns = check.checked
        ? state.hiddenColumns.filter((c) => c !== i)
        : [...state.hiddenColumns, i];
      li.classList.toggle("off", !check.checked);
      recompute();
    });

    const name = document.createElement("input");
    name.type = "text";
    name.value = state.renames[i] ?? header;
    name.setAttribute("aria-label", `Rename column ${header}`);
    name.addEventListener("input", () => {
      state.renames[i] = name.value;
      recompute();
    });

    const type = document.createElement("span");
    type.className = "col-type";
    type.dataset.t = types[i] || TYPES.TEXT;
    type.textContent = shortType(types[i]);
    type.title = describeStats(stats[i], types[i]);

    const move = document.createElement("span");
    move.className = "col-move";
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "▲";
    up.title = "Move up";
    up.disabled = position === 0;
    up.addEventListener("click", () => reorder(order, position, position - 1));
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "▼";
    down.title = "Move down";
    down.disabled = position === order.length - 1;
    down.addEventListener("click", () => reorder(order, position, position + 1));
    move.append(up, down);

    li.append(check, name, type, move);
    els.columns.append(li);
  });
}

function reorder(order, from, to) {
  const next = order.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  state.columnOrder = next;
  buildColumns();
  recompute();
}

/** Tooltip text: the column summary, which is where most surprises show up. */
function describeStats(stat, type) {
  if (!stat) return "";
  const parts = [`Detected as ${type || "text"}`, `${stat.filled} filled, ${stat.empty} empty`, `${stat.unique} distinct`];
  if (stat.sum !== undefined) {
    const n = (v) => (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 4 }));
    parts.push(`min ${n(stat.min)}, max ${n(stat.max)}`, `sum ${n(stat.sum)}, mean ${n(stat.mean)}`);
  }
  return parts.join("\n");
}

function shortType(t) {
  return { number: "num", currency: "cur", percent: "pct", date: "date", boolean: "bool", url: "url", empty: "—" }[t] || "txt";
}

function setupDeepCapture() {
  // Deep capture drives the live page, so it needs the tab to still be there.
  if (!sourceTabId || !tableId) return;

  const virtualised = raw.meta?.virtualised;
  els.deepSection.hidden = false;
  els.deepHint.textContent = virtualised
    ? "This grid only keeps the visible rows in the page, so the count above is probably short. Scrolling collects the rest."
    : "If this table is paginated or loads more as you scroll, collect the remaining rows here.";

  chrome.runtime
    .sendMessage({ type: "relay", tabId: sourceTabId, message: { type: "canPaginate", id: tableId } })
    .then((res) => {
      if (res?.can) els.deepPage.hidden = false;
    })
    .catch(() => {});
}

async function deepCapture(mode) {
  els.deepScroll.disabled = true;
  els.deepPage.disabled = true;
  els.deepStatus.textContent = mode === "paginate" ? "Walking pages — watch the tab…" : "Scrolling the table…";

  try {
    await chrome.tabs.update(sourceTabId, { active: true });
    const res = await chrome.runtime.sendMessage({
      type: "relay",
      tabId: sourceTabId,
      message: { type: "deepCapture", id: tableId, mode, options: {} },
    });

    if (res?.error) {
      els.deepStatus.textContent = res.error;
      return;
    }

    const fresh = await chrome.runtime.sendMessage({
      type: "relay",
      tabId: sourceTabId,
      message: { type: "get", id: tableId },
    });

    if (fresh?.table) {
      const before = raw.rowCount;
      raw = fresh.table;
      buildColumns();
      recompute();
      const gained = raw.rowCount - before;
      els.deepStatus.textContent = res.complete
        ? `Got ${raw.rowCount.toLocaleString()} rows (+${gained.toLocaleString()}).`
        : `Stopped at ${raw.rowCount.toLocaleString()} rows — the page kept going. Run it again to continue.`;
    }
  } catch (e) {
    els.deepStatus.textContent = String(e?.message || e);
  } finally {
    els.deepScroll.disabled = false;
    els.deepPage.disabled = false;
    // Bring the reader back to the editor now the work is done.
    const self = await chrome.tabs.getCurrent();
    if (self?.id) chrome.tabs.update(self.id, { active: true });
  }
}

// ── Recompute + render ─────────────────────────────────────────────────────

function readState() {
  state.dropEmpty = els.optDropEmpty.checked;
  state.dedupe = els.optDedupe.checked;
  state.cleanValues = els.optClean.checked;
  state.normaliseDates = els.optDates.checked;
  state.percentAsFraction = els.optFraction.checked;
  state.trimCells = els.optTrim.checked;
  state.fillDown = els.optFillDown.checked;
  state.headerCase = els.optHeaderCase.value;
  state.transpose = els.optTranspose.checked;
  state.skipRows = Math.max(0, Number(els.optSkip.value) || 0);
  state.limit = Math.max(0, Number(els.optLimit.value) || 0);
  state.search = els.search.value.trim();

  const find = els.optFind.value;
  state.replace = find
    ? { find, replaceWith: els.optReplace.value, regex: els.optRegex.checked, caseSensitive: els.optCase.checked }
    : null;

  const col = Number(els.sortCol.value);
  state.sort = col >= 0 ? { column: col, direction: els.sortDir.value } : null;

  els.optDates.disabled = !state.cleanValues;
  els.optFraction.disabled = !state.cleanValues;

  // Transposing makes per-column controls meaningless — the columns are now the
  // old rows — so say so rather than letting them silently do nothing.
  const t = state.transpose;
  els.optHeaderCase.disabled = t;
  els.sortCol.disabled = t;
  els.sortDir.disabled = t;

  savePrefs();
}

function recompute() {
  readState();
  view = applyState(raw, state);
  syncSortOptions();
  renderGrid();

  els.statRows.textContent = `${view.rowCount.toLocaleString()} rows`;
  els.statCols.textContent = `${view.colCount} cols`;
}

function syncSortOptions() {
  const wanted = els.sortCol.value;
  els.sortCol.replaceChildren();

  const none = document.createElement("option");
  none.value = "-1";
  none.textContent = "No sort";
  els.sortCol.append(none);

  view.headers.forEach((h, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = h.length > 28 ? h.slice(0, 27) + "…" : h;
    els.sortCol.append(opt);
  });

  // Keep the choice if it still exists, otherwise fall back to no sort.
  els.sortCol.value = Number(wanted) < view.headers.length ? wanted : "-1";
}

function renderGrid() {
  const limit = Number(els.previewRows.value);
  const shown = Math.min(limit, view.rowCount);
  const numeric = (view.types || []).map((t) =>
    [TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(t)
  );

  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "rownum";
  corner.textContent = "#";
  headRow.append(corner);
  for (const h of view.headers) {
    const th = document.createElement("th");
    th.textContent = h;
    th.title = h;
    headRow.append(th);
  }
  els.gridHead.replaceChildren(headRow);

  // Built into a fragment so a 2,000-row preview is one reflow, not 2,000.
  const frag = document.createDocumentFragment();
  for (let r = 0; r < shown; r++) {
    const tr = document.createElement("tr");
    const num = document.createElement("td");
    num.className = "rownum";
    num.textContent = String(r + 1);
    tr.append(num);

    for (let c = 0; c < view.headers.length; c++) {
      const td = document.createElement("td");
      const v = view.rows[r][c] ?? "";
      td.textContent = v;
      if (v !== "") td.title = v;
      else td.className = "empty";
      if (numeric[c]) td.classList.add("num");
      tr.append(td);
    }
    frag.append(tr);
  }
  els.gridBody.replaceChildren(frag);

  if (view.rowCount === 0) {
    els.gridNote.textContent = state.search
      ? "No rows match that filter."
      : "This table has no rows once the clean-up settings are applied.";
  } else if (shown < view.rowCount) {
    els.gridNote.textContent =
      `Showing the first ${shown.toLocaleString()} of ${view.rowCount.toLocaleString()} rows. ` +
      `Exports include all ${view.rowCount.toLocaleString()}.`;
  } else {
    els.gridNote.textContent = `All ${view.rowCount.toLocaleString()} rows shown.`;
  }
}

// ── Export ─────────────────────────────────────────────────────────────────

function exportOptions() {
  const id = els.format.value;
  const opts = { includeHeaders: els.optHeaders.checked };
  if (id === "csv") {
    const d = els.optDelim.value;
    opts.delimiter = d === "\\t" ? "\t" : d;
  }
  if (id === "sql") {
    opts.dialect = els.optDialect.value;
    opts.tableName = els.optSqlName.value || "grabbed_table";
  }
  if (id === "xlsx") {
    opts.sheetName = (source.title || raw.caption || "Sheet1").slice(0, 31);
  }
  return opts;
}

let statusTimer = null;
function exportStatus(text, kind) {
  els.exportStatus.textContent = text || "";
  els.exportStatus.className = "status" + (kind ? " " + kind : "");
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => exportStatus(""), 3200);
}

els.copy.addEventListener("click", async () => {
  const id = els.format.value;
  if (id === "xlsx") {
    exportStatus("Excel files can only be downloaded.", "err");
    return;
  }
  try {
    await copyToClipboard(view, id, exportOptions());
    exportStatus(`${view.rowCount.toLocaleString()} rows copied as ${formatMeta(id).label}.`, "ok");
  } catch (e) {
    exportStatus(String(e?.message || e), "err");
  }
});

els.download.addEventListener("click", async () => {
  const id = els.format.value;
  try {
    const payload = serialise(view, id, exportOptions());
    const meta = formatMeta(id);
    const blob =
      payload instanceof Blob
        ? payload
        // The BOM is what makes Excel open a UTF-8 CSV without mangling accents.
        : new Blob([id === "csv" ? "﻿" + payload : payload], { type: `${meta.mime};charset=utf-8` });

    const url = URL.createObjectURL(blob);
    const filename = suggestFilename(view, id, source);

    await chrome.downloads.download({ url, filename, saveAs: false });
    // Revoke once the download has had time to start reading the blob.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    exportStatus(`Saved ${filename}`, "ok");
  } catch (e) {
    exportStatus(String(e?.message || e), "err");
  }
});

// ── Wiring ─────────────────────────────────────────────────────────────────

for (const el of [
  els.optDropEmpty, els.optDedupe, els.optClean, els.optDates, els.optFraction,
  els.optTrim, els.optFillDown, els.optHeaderCase, els.optTranspose,
  els.optRegex, els.optCase, els.sortCol, els.sortDir,
]) {
  el.addEventListener("change", recompute);
}

els.previewRows.addEventListener("change", renderGrid);

/** Text inputs are debounced so typing does not re-run the pipeline per key. */
const debounced = (fn, ms) => {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
};
const recomputeSoon = debounced(recompute, 180);

for (const el of [els.search, els.optFind, els.optReplace, els.optSkip, els.optLimit]) {
  el.addEventListener("input", recomputeSoon);
}

els.format.addEventListener("change", () => { syncFormatOptions(); savePrefs(); });
els.optDelim.addEventListener("change", savePrefs);
els.optDialect.addEventListener("change", savePrefs);

els.colsAll.addEventListener("click", () => {
  state.hiddenColumns = [];
  buildColumns();
  recompute();
});

els.colsNone.addEventListener("click", () => {
  // Leave one column: an export with no columns is never what anyone wants.
  const first = els.columns.querySelector(".col")?.dataset.index;
  state.hiddenColumns = raw.headers.map((_, i) => i).filter((i) => String(i) !== first);
  buildColumns();
  recompute();
});

els.deepScroll.addEventListener("click", () => deepCapture("scroll"));
els.deepPage.addEventListener("click", () => deepCapture("paginate"));

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    els.download.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
    e.preventDefault();
    els.copy.click();
  }
});

boot();
