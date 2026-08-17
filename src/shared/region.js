/**
 * Region capture: turning a dragged rectangle into a table.
 *
 * Two different problems hide behind one gesture.
 *
 *   Part of a real table.  The box lands on a <table> but only covers some of
 *   it. Nothing needs inventing here — the markup already says where the rows
 *   and columns are, so the job is to work out which of them the box touches
 *   and slice. See sliceTable.
 *
 *   Something that is not a table at all.  A price list laid out with flexbox,
 *   a dashboard of stat tiles, a receipt in a <pre>. There is no structure to
 *   read, only positions on screen — which is exactly what a human is using to
 *   see the table that is obviously there. So synthesiseTable rebuilds it from
 *   geometry: things that share a horizontal band are a row, things that share
 *   a vertical band are a column.
 *
 * Both take their rectangles from a `rectOf` callback rather than calling
 * getBoundingClientRect themselves. That keeps the whole module pure — the
 * tests hand it plain numbers, with no DOM anywhere — and it is the reason the
 * clustering below can be asserted on at all.
 */

import {
  DEFAULT_OPTIONS,
  buildCellGrid,
  detectHeaderRows,
  cellText,
  uniqueHeaders,
  tableFromRows,
  emptyTable,
  SPAN_POLICY,
} from "./extract.js";

// ── Rectangle helpers ──────────────────────────────────────────────────────

export const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

const overlap1d = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

export function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** How much of `inner` (by area) sits inside `outer`. 0..1 */
export function coverage(inner, outer) {
  const w = overlap1d(inner.left, inner.right, outer.left, outer.right);
  const h = overlap1d(inner.top, inner.bottom, outer.top, outer.bottom);
  const area = Math.max(1, (inner.right - inner.left) * (inner.bottom - inner.top));
  return (w * h) / area;
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// ── Slicing a real table ───────────────────────────────────────────────────

/**
 * Extracts the part of a <table> that a rectangle covers.
 *
 * Row and column membership is decided by how much of each one the box covers,
 * not by whether it touches: a box that clips two pixels off the next row down
 * should not silently include it. Header rows are kept whatever the box says,
 * because a slice with no column names is nearly useless and the box is drawn
 * around the *data* people want almost every time.
 *
 * @param {Element} tableEl
 * @param {{left:number,top:number,right:number,bottom:number}} box
 * @param {{rectOf?: Function, threshold?: number}} [config]
 * @returns {{table: object, rowsKept: number, colsKept: number, rowsTotal: number, colsTotal: number, partial: boolean}}
 */
export function sliceTable(tableEl, box, config) {
  const cfg = { rectOf, threshold: 0.35, options: {}, ...(config || {}) };
  const opts = { ...DEFAULT_OPTIONS, ...cfg.options };
  const measure = cfg.rectOf;

  const { grid, meta, rowEls, width } = buildCellGrid(tableEl);
  if (width === 0 || grid.length === 0) {
    return { table: emptyTable(), rowsKept: 0, colsKept: 0, rowsTotal: 0, colsTotal: 0, partial: false };
  }

  const headerRowCount = detectHeaderRows(tableEl, grid, rowEls, opts);

  // Rows: measured from the <tr>, which is the one element guaranteed to span
  // the whole row even when its cells are merged.
  const keepRow = [];
  for (let r = 0; r < grid.length; r++) {
    if (r < headerRowCount) { keepRow.push(true); continue; }
    const el = rowEls[r];
    if (!el) { keepRow.push(false); continue; }
    const rect = measure(el);
    const h = Math.max(1, rect.bottom - rect.top);
    keepRow.push(overlap1d(rect.top, rect.bottom, box.top, box.bottom) / h >= cfg.threshold);
  }

  // Columns have no element of their own, so each one is measured from its
  // narrowest cell — a cell that spans two columns says nothing about where the
  // boundary between them is.
  const keepCol = [];
  for (let c = 0; c < width; c++) {
    let left = Infinity;
    let right = -Infinity;
    for (let r = 0; r < grid.length; r++) {
      const cell = grid[r]?.[c];
      const info = meta[r]?.[c];
      if (!cell || !info || info.colSpan > 1) continue;
      const rect = measure(cell);
      if (rect.right <= rect.left) continue;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    if (!Number.isFinite(left) || right <= left) { keepCol.push(true); continue; }
    keepCol.push(overlap1d(left, right, box.left, box.right) / (right - left) >= cfg.threshold);
  }

  const cols = [];
  for (let c = 0; c < width; c++) if (keepCol[c]) cols.push(c);
  const bodyRows = [];
  for (let r = headerRowCount; r < grid.length; r++) if (keepRow[r]) bodyRows.push(r);

  const readCell = (r, c) => {
    const cell = grid[r]?.[c];
    const info = meta[r]?.[c];
    if (!cell) return "";
    if (info && !info.master) {
      if (opts.spanPolicy === SPAN_POLICY.BLANK) return "";
      if (opts.spanPolicy === SPAN_POLICY.MARK) return "↳";
    }
    let text = cellText(cell, opts);
    if (opts.imageAltText && !text) {
      const img = cell.querySelector?.("img");
      if (img) text = img.getAttribute("alt") || img.getAttribute("src") || "";
    }
    return text;
  };

  // Stack the header rows the same way the full extractor does, so a sliced
  // grouped header still reads "Region – Country".
  let headers = [];
  if (headerRowCount > 0 && cols.length) {
    const stacked = [];
    for (let r = 0; r < headerRowCount; r++) stacked.push(cols.map((c) => readCell(r, c)));
    headers = cols.map((_, i) => {
      const parts = [];
      for (const row of stacked) {
        const v = (row[i] || "").trim();
        if (v && parts[parts.length - 1] !== v) parts.push(v);
      }
      return parts.join(" – ");
    });
    headers = uniqueHeaders(headers);
  } else {
    headers = uniqueHeaders(new Array(cols.length).fill(""));
  }

  const rows = bodyRows
    .map((r) => cols.map((c) => readCell(r, c)))
    .filter((row) => row.some((v) => v !== ""));

  const totalBody = grid.length - headerRowCount;

  return {
    table: {
      ...emptyTable(),
      headers,
      rows,
      rowCount: rows.length,
      colCount: headers.length,
      headerRowCount: headerRowCount > 0 ? 1 : 0,
      caption: "",
    },
    rowsKept: rows.length,
    colsKept: cols.length,
    rowsTotal: totalBody,
    colsTotal: width,
    partial: rows.length < totalBody || cols.length < width,
  };
}

// ── Synthesising a table from positions ────────────────────────────────────

/**
 * Groups positioned text into rows.
 *
 * Two fragments belong to the same row when their vertical extents genuinely
 * overlap — not when their tops happen to match. Baseline alignment inside a
 * row is the exception on the web, not the rule: a cell with a two-line address
 * next to a one-line name shares no coordinate with it except the band they
 * both sit in.
 */
function clusterRows(items, tolerance) {
  const sorted = items.slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const rows = [];

  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row) {
      const h = Math.min(item.bottom - item.top, row.bottom - row.top) || 1;
      const share = overlap1d(item.top, item.bottom, row.top, row.bottom) / h;
      const centresClose = Math.abs((item.top + item.bottom) / 2 - (row.top + row.bottom) / 2) <= tolerance;
      if (share >= 0.5 || centresClose) {
        row.items.push(item);
        row.top = Math.min(row.top, item.top);
        row.bottom = Math.max(row.bottom, item.bottom);
        continue;
      }
    }
    rows.push({ top: item.top, bottom: item.bottom, items: [item] });
  }

  for (const row of rows) row.items.sort((a, b) => a.left - b.left);
  return rows;
}

/**
 * Works out where the columns are.
 *
 * Left edges alone are not enough: a right-aligned number column shares its
 * right edge and nothing else, and a centred column shares neither. What every
 * column does have is a *band* on the x axis that its cells stay inside, so the
 * bands are seeded from the widest row and then grown by whatever else lands in
 * them. A fragment that overlaps nothing opens a new column, which is how a
 * table with a value missing from its first row still ends up with the right
 * shape.
 */
function buildColumns(rows) {
  const seed = rows.reduce((best, row) => (row.items.length > best.items.length ? row : best), rows[0]);
  const bands = seed.items.map((item) => ({ left: item.left, right: item.right }));

  const bestBand = (item) => {
    let index = -1;
    let score = 0;
    for (let i = 0; i < bands.length; i++) {
      const share = overlap1d(item.left, item.right, bands[i].left, bands[i].right);
      if (share > score) { score = share; index = i; }
    }
    return score > 0 ? index : -1;
  };

  for (const row of rows) {
    if (row === seed) continue;
    for (const item of row.items) {
      const i = bestBand(item);
      if (i === -1) {
        bands.push({ left: item.left, right: item.right });
        bands.sort((a, b) => a.left - b.left);
      } else {
        bands[i].left = Math.min(bands[i].left, item.left);
        bands[i].right = Math.max(bands[i].right, item.right);
      }
    }
  }

  // Growing bands can make two of them touch; merging keeps the column count
  // honest rather than emitting a column no row ever fills on its own.
  bands.sort((a, b) => a.left - b.left);
  const merged = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last && band.left < last.right - 1) {
      last.right = Math.max(last.right, band.right);
    } else {
      merged.push({ ...band });
    }
  }
  return merged;
}

/**
 * Rebuilds a table from positioned text fragments.
 *
 * @param {Array<{text:string,left:number,top:number,right:number,bottom:number}>} items
 * @param {object} [options]
 * @returns {{table: object, rows: number, cols: number, confidence: number}}
 */
export function synthesiseTable(items, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const usable = (items || []).filter((i) => i && String(i.text ?? "").trim() !== "");
  if (usable.length === 0) return { table: emptyTable(), rows: 0, cols: 0, confidence: 0 };

  const heights = usable.map((i) => Math.max(1, i.bottom - i.top));
  const tolerance = Math.max(3, median(heights) * 0.5);

  const rowGroups = clusterRows(usable, tolerance);
  const bands = buildColumns(rowGroups);
  if (bands.length === 0) return { table: emptyTable(), rows: 0, cols: 0, confidence: 0 };

  const grid = rowGroups.map((row) => {
    const cells = new Array(bands.length).fill("");
    for (const item of row.items) {
      let index = 0;
      let best = 0;
      for (let i = 0; i < bands.length; i++) {
        const share = overlap1d(item.left, item.right, bands[i].left, bands[i].right);
        if (share > best) { best = share; index = i; }
      }
      const text = String(item.text).trim();
      // Two fragments in one cell — an icon's alt text beside a label, a link
      // split across spans — are joined rather than fighting over the slot.
      cells[index] = cells[index] ? `${cells[index]} ${text}` : text;
    }
    return cells;
  });

  // Columns nothing ever landed in are an artefact of the banding, not data.
  const keep = [];
  for (let c = 0; c < bands.length; c++) {
    if (grid.some((row) => row[c] !== "")) keep.push(c);
  }
  const trimmed = grid.map((row) => keep.map((c) => row[c])).filter((row) => row.some((v) => v !== ""));
  if (trimmed.length === 0) return { table: emptyTable(), rows: 0, cols: 0, confidence: 0 };

  const table = tableFromRows(trimmed, opts, keep.length);

  // How full the grid is, which is the honest signal for "did this actually
  // find a table". A real one is nearly complete; a paragraph of prose chopped
  // into bands is mostly holes.
  const cellCount = trimmed.length * keep.length;
  const filled = trimmed.flat().filter((v) => v !== "").length;

  return {
    table,
    rows: table.rowCount,
    cols: table.colCount,
    confidence: cellCount ? filled / cellCount : 0,
  };
}
