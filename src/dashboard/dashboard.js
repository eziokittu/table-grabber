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
import { IMPORT_FORMATS, parseText, detectFormat } from "../shared/import.js";
import { findTables, extractTable } from "../shared/extract.js";

const $ = (id) => document.getElementById(id);

const els = {
  loading: $("loading"), error: $("error"), errorMsg: $("error-msg"), errorPaste: $("error-paste"),
  app: $("app"), exportbar: $("exportbar"),
  sourceTitle: $("source-title"), sourceUrl: $("source-url"),
  statRows: $("stat-rows"), statCols: $("stat-cols"), openPaste: $("open-paste"),
  columns: $("columns"), colsAll: $("cols-all"), colsNone: $("cols-none"), colsReset: $("cols-reset"),
  optDropEmpty: $("opt-drop-empty"), optDedupe: $("opt-dedupe"),
  optClean: $("opt-clean"), optDates: $("opt-dates"), optFraction: $("opt-fraction"),
  optTrim: $("opt-trim"), optFillDown: $("opt-filldown"), optHeaderCase: $("opt-header-case"),
  optFind: $("opt-find"), optReplace: $("opt-replace"), optRegex: $("opt-regex"), optCase: $("opt-case"),
  optTranspose: $("opt-transpose"), optSkip: $("opt-skip"), optLimit: $("opt-limit"),
  patternError: $("pattern-error"), resetAll: $("reset-all"),
  deepSection: $("deep-section"), deepHint: $("deep-hint"), deepStatus: $("deep-status"),
  deepScroll: $("deep-scroll"), deepPage: $("deep-page"),
  search: $("search"), sortChip: $("sort-chip"), previewRows: $("preview-rows"),
  gridHead: $("grid-head"), gridBody: $("grid-body"), gridNote: $("grid-note"), gridEmpty: $("grid-empty"),
  format: $("format"), formatBlurb: $("format-blurb"),
  wrapDelim: $("wrap-delim"), optDelim: $("opt-delim"),
  wrapSql: $("wrap-sql"), optDialect: $("opt-dialect"),
  wrapSqlName: $("wrap-sqlname"), optSqlName: $("opt-sqlname"),
  wrapHeaders: $("wrap-headers"), optHeaders: $("opt-headers"),
  copy: $("copy"), download: $("download"), exportStatus: $("export-status"),
  pasteDialog: $("paste-dialog"), pasteText: $("paste-text"), pasteFormat: $("paste-format"),
  pasteHeader: $("paste-header"), pasteFile: $("paste-file"), pasteBrowse: $("paste-browse"),
  pasteStatus: $("paste-status"), pasteGo: $("paste-go"), pasteCancel: $("paste-cancel"),
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
      previewRows: els.previewRows.value,
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
  if (prefs.previewRows) els.previewRows.value = prefs.previewRows;
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

  buildFormatOptions();
  buildImportOptions();
  applyPrefs(await loadPrefs());
  syncFormatOptions();

  if (params.get("paste") === "1") {
    els.loading.hidden = true;
    fail("Nothing loaded yet. Paste or drop your data to get started.");
    openPasteDialog();
    return;
  }

  let payload = null;

  if (key) {
    const res = await chrome.runtime.sendMessage({ type: "fetchHandoff", key });
    payload = res?.payload || null;
  }

  // The handoff is dropped once read, and very large tables skip it entirely,
  // so falling back to the source tab is a normal path rather than an error.
  if (!payload?.table && sourceTabId && tableId) {
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
    fail("That table could not be loaded. It may have been closed or navigated away from — grab it again from the page, or paste the data here.");
    return;
  }

  sourceTabId = payload.sourceTabId ?? sourceTabId;
  tableId = payload.tableId ?? tableId;
  adopt(payload.table, payload.source || payload.table.meta || {});
}

/** Installs a table — from the page, or from a paste — and rebuilds everything. */
function adopt(table, meta) {
  raw = table;
  source = meta || {};

  state.hiddenColumns = [];
  state.renames = {};
  state.columnOrder = [];
  state.sort = null;

  els.sourceTitle.textContent = source.title || raw.caption || "Grabbed table";
  if (source.url) {
    els.sourceUrl.textContent = source.url;
    els.sourceUrl.href = source.url;
    els.sourceUrl.hidden = false;
  } else {
    els.sourceUrl.hidden = true;
  }

  buildColumns();
  setupDeepCapture();
  recompute();

  els.loading.hidden = true;
  els.error.hidden = true;
  els.app.hidden = false;
  els.exportbar.hidden = false;
}

function fail(message) {
  els.loading.hidden = true;
  els.errorMsg.textContent = message;
  els.error.hidden = false;
  els.app.hidden = true;
  els.exportbar.hidden = true;
}

// ── Controls ───────────────────────────────────────────────────────────────

function buildFormatOptions() {
  els.format.replaceChildren();
  for (const f of FORMATS) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.label;
    els.format.append(opt);
  }
  els.format.value = "csv";
}

function buildImportOptions() {
  els.pasteFormat.replaceChildren();
  for (const f of IMPORT_FORMATS) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.label;
    els.pasteFormat.append(opt);
  }
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

/** The column order as original indices, always complete and never stale. */
function currentOrder() {
  const known = state.columnOrder.filter((i) => i >= 0 && i < raw.headers.length);
  const missing = raw.headers.map((_, i) => i).filter((i) => !known.includes(i));
  return [...known, ...missing];
}

function buildColumns() {
  els.columns.replaceChildren();

  const base = applyState(raw, { ...DEFAULT_STATE, dropEmpty: false });
  const types = base.types || [];
  const stats = columnStats(base);
  const order = currentOrder();

  for (const i of order) {
    const header = raw.headers[i];
    const li = document.createElement("li");
    li.className = "col" + (state.hiddenColumns.includes(i) ? " off" : "");
    li.dataset.index = String(i);
    li.draggable = true;

    const handle = document.createElement("span");
    handle.className = "col-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";

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
      recomputeSoon();
    });
    // Dragging must start from the row, not from inside a text field the user
    // is trying to select text in.
    name.addEventListener("mousedown", () => { li.draggable = false; });
    name.addEventListener("blur", () => { li.draggable = true; });

    const type = document.createElement("span");
    type.className = "col-type";
    type.dataset.t = types[i] || TYPES.TEXT;
    type.textContent = shortType(types[i]);
    type.title = describeStats(stats[i], types[i]);

    li.append(handle, check, name, type);
    els.columns.append(li);
  }
}

/**
 * Drag-to-reorder for the column list.
 *
 * The old pair of ▲▼ buttons worked on a stale copy of the order captured when
 * the row was drawn, so a second move without an intervening rebuild put the
 * column somewhere nobody asked for. Reordering is a spatial act anyway; doing
 * it by dragging removes both the bug and the arithmetic.
 */
function setupColumnDrag() {
  let dragged = null;

  els.columns.addEventListener("dragstart", (e) => {
    const li = e.target.closest?.(".col");
    if (!li) return;
    dragged = li;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    // Firefox needs data set for the drag to start at all.
    e.dataTransfer.setData("text/plain", li.dataset.index);
  });

  els.columns.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    const li = e.target.closest?.(".col");
    for (const el of els.columns.children) el.classList.remove("drop-before", "drop-after");
    if (!li || li === dragged) return;
    const box = li.getBoundingClientRect();
    li.classList.add(e.clientY < box.top + box.height / 2 ? "drop-before" : "drop-after");
  });

  els.columns.addEventListener("drop", (e) => {
    if (!dragged) return;
    e.preventDefault();
    const li = e.target.closest?.(".col");
    const order = currentOrder();
    const from = order.indexOf(Number(dragged.dataset.index));

    let to = order.length - 1;
    if (li && li !== dragged) {
      const box = li.getBoundingClientRect();
      const before = e.clientY < box.top + box.height / 2;
      to = order.indexOf(Number(li.dataset.index)) + (before ? 0 : 1);
    }

    const next = order.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    state.columnOrder = next;

    cleanUpDrag();
    buildColumns();
    recompute();
  });

  els.columns.addEventListener("dragend", cleanUpDrag);

  function cleanUpDrag() {
    dragged?.classList.remove("dragging");
    for (const el of els.columns.children) el.classList.remove("drop-before", "drop-after");
    dragged = null;
  }
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

// ── Deep capture ───────────────────────────────────────────────────────────

function setupDeepCapture() {
  els.deepStatus.textContent = "";
  els.deepPage.hidden = true;

  // Deep capture drives the live page, so it needs the tab and a table that is
  // still in it. A pasted table or a synthesised region has neither.
  const possible = sourceTabId && tableId && raw.meta?.canDeepCapture !== false;
  els.deepSection.hidden = !possible;
  if (!possible) return;

  els.deepHint.textContent = raw.meta?.virtualised
    ? "This grid only keeps the visible rows in the page, so the count above is short. Scrolling it collects the rest."
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
  els.deepStatus.textContent =
    mode === "paginate"
      ? "Walking pages in the source tab — it will come back here when it is done."
      : "Scrolling the table in the source tab…";

  try {
    // The page only renders rows while it is visible, so the tab has to be at
    // the front for this to collect anything at all. Saying so beats the tab
    // apparently hijacking itself.
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

    if (!fresh?.table) {
      els.deepStatus.textContent = "The page did not hand the table back. Try grabbing it again.";
      return;
    }

    const before = raw.rowCount;
    raw = fresh.table;
    buildColumns();
    recompute();

    const gained = raw.rowCount - before;
    if (gained <= 0) {
      els.deepStatus.textContent =
        "No extra rows appeared — this looks like the whole table already.";
    } else if (res.stopped) {
      els.deepStatus.textContent = `Stopped at ${raw.rowCount.toLocaleString()} rows (+${gained.toLocaleString()}). Run it again to carry on.`;
    } else if (res.complete) {
      els.deepStatus.textContent = `Got ${raw.rowCount.toLocaleString()} rows (+${gained.toLocaleString()}).`;
    } else {
      els.deepStatus.textContent = `${raw.rowCount.toLocaleString()} rows (+${gained.toLocaleString()}) — the page kept going. Run it again to continue.`;
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
  state.columnOrder = currentOrder();

  const find = els.optFind.value;
  state.replace = find
    ? { find, replaceWith: els.optReplace.value, regex: els.optRegex.checked, caseSensitive: els.optCase.checked }
    : null;

  els.optDates.disabled = !state.cleanValues;
  els.optFraction.disabled = !state.cleanValues;

  // Transposing makes the per-column controls meaningless — the columns are now
  // the old rows — so they are turned off rather than left to do nothing.
  els.optHeaderCase.disabled = state.transpose;

  savePrefs();
}

function recompute() {
  readState();
  view = applyState(raw, state);
  renderSortChip();
  renderGrid();

  // A refused find pattern has to say so. Silently doing nothing is worse than
  // an error here, because the user assumes the replace worked and exports
  // data that was never changed.
  els.patternError.textContent = view.patternError || "";
  els.patternError.hidden = !view.patternError;

  els.statRows.textContent = `${view.rowCount.toLocaleString()} rows`;
  els.statCols.textContent = `${view.colCount} cols`;
}

/**
 * Click a header to sort by it: ascending, then descending, then not at all.
 *
 * The sort is pinned to the column's original index rather than its position,
 * so hiding or reordering other columns leaves it where the user put it.
 */
function toggleSort(viewIndex) {
  if (state.transpose) return;
  const original = view.columnSources?.[viewIndex];
  if (original === undefined) return;

  if (state.sort?.originalColumn !== original) {
    state.sort = { originalColumn: original, direction: "asc" };
  } else if (state.sort.direction === "asc") {
    state.sort = { originalColumn: original, direction: "desc" };
  } else {
    state.sort = null;
  }
  recompute();
}

function renderSortChip() {
  if (!state.sort) {
    els.sortChip.hidden = true;
    return;
  }
  const index = view.columnSources?.indexOf(state.sort.originalColumn) ?? -1;
  if (index < 0) {
    els.sortChip.hidden = true;
    return;
  }
  els.sortChip.hidden = false;
  els.sortChip.textContent =
    `Sorted by ${view.headers[index]} ${state.sort.direction === "asc" ? "↑" : "↓"} ✕`;
  els.sortChip.title = "Clear the sort";
}

function renderGrid() {
  const limit = Number(els.previewRows.value) || 500;
  const shown = Math.min(limit, view.rowCount);
  const numeric = (view.types || []).map((t) =>
    [TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(t)
  );
  const sortedIndex = state.sort ? view.columnSources?.indexOf(state.sort.originalColumn) : -1;

  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "rownum";
  corner.textContent = "#";
  corner.style.cursor = "default";
  headRow.append(corner);

  view.headers.forEach((h, c) => {
    const th = document.createElement("th");
    th.textContent = h;
    th.title = `${h} — click to sort`;
    const sorted = c === sortedIndex;
    th.setAttribute("aria-sort", sorted ? (state.sort.direction === "asc" ? "ascending" : "descending") : "none");

    const mark = document.createElement("span");
    mark.className = "sort-mark";
    mark.textContent = sorted ? (state.sort.direction === "asc" ? "▲" : "▼") : "▲";
    th.append(mark);

    th.addEventListener("click", () => toggleSort(c));
    headRow.append(th);
  });
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

  els.gridEmpty.hidden = view.rowCount !== 0;
  if (view.rowCount === 0) {
    els.gridEmpty.textContent = state.search
      ? "No rows match that filter."
      : "This table has no rows once the clean-up settings are applied.";
    els.gridNote.textContent = "";
    return;
  }

  els.gridNote.textContent =
    shown < view.rowCount
      ? `Showing the first ${shown.toLocaleString()} of ${view.rowCount.toLocaleString()} rows — every export includes all ${view.rowCount.toLocaleString()}.`
      : `All ${view.rowCount.toLocaleString()} rows shown.`;
}

// ── Paste / import ─────────────────────────────────────────────────────────

function openPasteDialog() {
  els.pasteStatus.textContent = "";
  els.pasteStatus.className = "status";
  els.pasteDialog.showModal();
  els.pasteText.focus();
}

function pasteStatus(text, kind) {
  els.pasteStatus.textContent = text || "";
  els.pasteStatus.className = "status" + (kind ? " " + kind : "");
}

/**
 * Reads pasted text into a table.
 *
 * HTML is the one format that cannot go through import.js — it needs a DOM to
 * parse — so it is routed to the same extractor the page uses. Which means a
 * copied table pasted here is read by exactly the code that would have read it
 * in place, merged cells and all.
 */
function tableFromText(text, format, headerChoice) {
  const chosen = !format || format === "auto" ? detectFormat(text) : format;
  const hasHeader = headerChoice === "yes" ? true : headerChoice === "no" ? false : null;

  if (chosen === "html") {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const found = findTables(doc, {});
    if (found.length) {
      const biggest = found.reduce((a, b) =>
        b.table.rowCount * b.table.colCount > a.table.rowCount * a.table.colCount ? b : a
      );
      return { table: biggest.table, format: "html" };
    }
    const el = doc.querySelector("table");
    if (el) return { table: extractTable(el, {}), format: "html" };
    throw new Error("No table found in that HTML.");
  }

  return parseText(text, chosen, { hasHeader });
}

function usePastedText(text) {
  if (!text.trim()) {
    pasteStatus("Nothing to read — paste some data first.", "err");
    return;
  }
  try {
    const { table, format } = tableFromText(text, els.pasteFormat.value, els.pasteHeader.value);
    if (!table || table.rowCount === 0) {
      pasteStatus("That parsed to zero rows. Try picking the format by hand.", "err");
      return;
    }
    els.pasteDialog.close();
    sourceTabId = null;
    tableId = null;
    adopt(table, { title: `Pasted ${format.toUpperCase()} · ${table.rowCount} rows` });
    exportStatus(`Read ${table.rowCount.toLocaleString()} rows from pasted ${format.toUpperCase()}.`, "ok");
  } catch (e) {
    pasteStatus(String(e?.message || e), "err");
  }
}

function setupPaste() {
  els.openPaste.addEventListener("click", openPasteDialog);
  els.errorPaste.addEventListener("click", openPasteDialog);
  els.pasteCancel.addEventListener("click", () => els.pasteDialog.close());
  els.pasteGo.addEventListener("click", () => usePastedText(els.pasteText.value));
  els.pasteBrowse.addEventListener("click", () => els.pasteFile.click());

  els.pasteFile.addEventListener("change", async () => {
    const file = els.pasteFile.files?.[0];
    if (!file) return;
    els.pasteText.value = await file.text();
    pasteStatus(`Loaded ${file.name} (${Math.round(file.size / 1024).toLocaleString()} KB).`, "ok");
  });

  for (const type of ["dragenter", "dragover"]) {
    els.pasteText.addEventListener(type, (e) => {
      e.preventDefault();
      els.pasteText.classList.add("drop");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    els.pasteText.addEventListener(type, () => els.pasteText.classList.remove("drop"));
  }
  els.pasteText.addEventListener("drop", async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    els.pasteText.value = await file.text();
    pasteStatus(`Loaded ${file.name}.`, "ok");
  });

  // Pasting rich content copies the HTML too, which parses far better than the
  // flattened plain text a browser hands over for a copied table.
  els.pasteText.addEventListener("paste", (e) => {
    const html = e.clipboardData?.getData("text/html");
    if (!html || !/<t[dhr][\s>]/i.test(html)) return;
    e.preventDefault();
    els.pasteText.value = html;
    els.pasteFormat.value = "html";
    pasteStatus("Pasted an HTML table — reading it as markup keeps the columns.", "ok");
  });
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
  els.optRegex, els.optCase,
]) {
  el.addEventListener("change", recompute);
}

els.previewRows.addEventListener("change", () => { savePrefs(); renderGrid(); });

/** Text inputs are debounced so typing does not re-run the pipeline per key. */
const debounced = (fn, ms) => {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
};
const recomputeSoon = debounced(recompute, 180);

for (const el of [els.search, els.optFind, els.optReplace, els.optSkip, els.optLimit]) {
  el.addEventListener("input", recomputeSoon);
}

els.sortChip.addEventListener("click", () => {
  state.sort = null;
  recompute();
});

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
  const first = currentOrder()[0];
  state.hiddenColumns = raw.headers.map((_, i) => i).filter((i) => i !== first);
  buildColumns();
  recompute();
});

els.colsReset.addEventListener("click", () => {
  state.hiddenColumns = [];
  state.renames = {};
  state.columnOrder = [];
  buildColumns();
  recompute();
});

els.resetAll.addEventListener("click", () => {
  state.hiddenColumns = [];
  state.renames = {};
  state.columnOrder = [];
  state.sort = null;
  for (const el of [els.optDedupe, els.optClean, els.optDates, els.optFraction, els.optTrim, els.optFillDown, els.optTranspose, els.optRegex, els.optCase]) {
    el.checked = false;
  }
  els.optDropEmpty.checked = true;
  els.optHeaderCase.value = "none";
  els.search.value = "";
  els.optFind.value = "";
  els.optReplace.value = "";
  els.optSkip.value = "0";
  els.optLimit.value = "0";
  buildColumns();
  recompute();
  exportStatus("Back to the table as it was grabbed.", "ok");
});

els.deepScroll.addEventListener("click", () => deepCapture("scroll"));
els.deepPage.addEventListener("click", () => deepCapture("paginate"));

document.addEventListener("keydown", (e) => {
  if (els.pasteDialog.open) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    els.download.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
    e.preventDefault();
    els.copy.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    els.search.focus();
    els.search.select();
  }
});

setupColumnDrag();
setupPaste();
boot();
