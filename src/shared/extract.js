/**
 * Table extraction.
 *
 * This module is the heart of Table Grabber and it is deliberately free of any
 * `chrome.*` API: it takes a DOM and returns plain data. That is what lets the
 * identical logic run inside the extension (against a live page) and on
 * glitchbong.com (against HTML parsed by DOMParser) with no second
 * implementation to keep in sync.
 *
 * The hard parts, in the order they bite:
 *
 *   1. rowspan / colspan.  One <td> can occupy several visual positions, so a
 *      naive `row.cells` walk silently misaligns every column after the span.
 *      We lay cells onto a grid by coordinate instead.
 *   2. Tables that are not <table>.  Modern apps draw grids out of divs
 *      (CSS grid, flexbox, AG Grid, TanStack). Those have no semantics at all,
 *      so they are found by looking for repeating sibling structure.
 *   3. Virtualised bodies.  Libraries keep only the visible ~20 rows in the
 *      DOM. Extraction alone cannot fix that; see capture.js, which scrolls and
 *      accumulates. Here we just flag it so the UI can offer the deep capture.
 *   4. Shadow DOM and same-origin iframes.  Tables hide inside both, and a
 *      plain querySelectorAll walks past them.
 */

/** How a cell covered by a rowspan/colspan should be filled. */
export const SPAN_POLICY = {
  /** Repeat the spanning cell's value into every position it covers. Best for spreadsheets. */
  FILL: "fill",
  /** Value in the first position, empty elsewhere. Mirrors how the table looks. */
  BLANK: "blank",
  /** Value in the first position, "↳" elsewhere, so merges stay visible in text formats. */
  MARK: "mark",
};

export const DEFAULT_OPTIONS = {
  spanPolicy: SPAN_POLICY.FILL,
  /** Collapse runs of whitespace and trim. Almost always wanted. */
  trimWhitespace: true,
  /** Turn <br> into a newline rather than gluing words together. */
  preserveLineBreaks: true,
  /** Drop <sup> footnote markers ("Population[a]" -> "Population"). */
  stripFootnotes: true,
  /** Pull href out of a cell's first link into its own adjacent column. */
  extractLinks: false,
  /** Use an <img>'s alt (then src) when a cell has no text of its own. */
  imageAltText: true,
  /** Treat the first row as headers when no <th>/<thead> says otherwise. */
  inferHeaders: true,
  /** Ignore tables smaller than this. Layout tables are usually 1x1 or 1x2. */
  minRows: 2,
  minCols: 2,
};

// ── Text extraction ────────────────────────────────────────────────────────

const BLOCKISH = new Set([
  "P", "DIV", "LI", "TR", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE",
]);

/**
 * Reads a cell's visible text.
 *
 * `innerText` would be ideal — it respects `display:none` and collapses
 * whitespace the way a human reads it — but it forces layout (slow across
 * hundreds of cells) and returns "" in a detached DOMParser document, which is
 * exactly the situation on the website. So we walk the tree ourselves and get
 * identical results in both environments.
 */
export function cellText(el, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const parts = [];

  const walk = (node) => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return;

    // A nested table is its own table; its text does not belong to this cell.
    if (tag === "TABLE") return;

    if (opts.stripFootnotes && (tag === "SUP" || node.classList?.contains("reference"))) return;

    // Explicitly hidden content is not part of what the reader sees. Checking
    // the attribute and inline style covers the common cases without layout.
    if (node.hasAttribute?.("hidden")) return;
    if (node.style?.display === "none" || node.style?.visibility === "hidden") return;
    if (node.getAttribute?.("aria-hidden") === "true") return;

    if (tag === "BR") {
      parts.push(opts.preserveLineBreaks ? "\n" : " ");
      return;
    }

    if (tag === "IMG" && opts.imageAltText) {
      const alt = node.getAttribute("alt");
      if (alt) parts.push(alt);
      return;
    }

    if (tag === "INPUT") {
      // Grids often render editable cells as inputs; the value is the data.
      const type = (node.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        parts.push(node.checked ? "true" : "false");
      } else if (type !== "hidden" && type !== "password") {
        parts.push(node.value ?? node.getAttribute("value") ?? "");
      }
      return;
    }
    if (tag === "SELECT") {
      const sel = node.selectedOptions?.[0] || node.querySelector("option[selected]");
      parts.push(sel ? sel.textContent : "");
      return;
    }

    for (const child of node.childNodes) walk(child);

    if (BLOCKISH.has(tag)) parts.push(opts.preserveLineBreaks ? "\n" : " ");
  };

  walk(el);

  let text = parts.join("");
  if (opts.trimWhitespace) {
    // Collapse spaces/tabs but keep deliberate newlines, then tidy the edges.
    text = text
      .replace(/ /g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }
  return text;
}

function firstLink(el) {
  const a = el.querySelector?.("a[href]");
  if (!a) return "";
  return a.getAttribute("href") || "";
}

// ── Grid normalisation ─────────────────────────────────────────────────────

/**
 * Lays a <table> onto a rectangular grid, expanding rowspan/colspan so that
 * grid[r][c] is the cell visually occupying that position.
 *
 * This is the step every naive table scraper skips, and it is why their output
 * shifts left on any table with a merged header.
 */
function buildGrid(tableEl) {
  const rowEls = [];
  // Walk sections in document order so thead/tbody/tfoot come out right. Rows
  // belonging to a *nested* table must not be swept up.
  const collectRows = (node) => {
    for (const child of node.children) {
      if (child.tagName === "TABLE") continue;
      if (child.tagName === "TR") rowEls.push(child);
      else if (["THEAD", "TBODY", "TFOOT"].includes(child.tagName)) collectRows(child);
    }
  };
  collectRows(tableEl);

  const grid = [];
  const meta = [];

  for (let r = 0; r < rowEls.length; r++) {
    if (!grid[r]) { grid[r] = []; meta[r] = []; }
    let c = 0;

    for (const cell of rowEls[r].children) {
      if (cell.tagName !== "TD" && cell.tagName !== "TH") continue;

      // Step past any position already claimed by a span from an earlier row.
      while (grid[r][c] !== undefined) c++;

      const rowSpan = Math.max(1, Math.min(parseInt(cell.getAttribute("rowspan") || "1", 10) || 1, 1000));
      const colSpan = Math.max(1, Math.min(parseInt(cell.getAttribute("colspan") || "1", 10) || 1, 1000));

      for (let dr = 0; dr < rowSpan; dr++) {
        const rr = r + dr;
        if (!grid[rr]) { grid[rr] = []; meta[rr] = []; }
        for (let dc = 0; dc < colSpan; dc++) {
          if (grid[rr][c + dc] === undefined) {
            grid[rr][c + dc] = cell;
            meta[rr][c + dc] = { master: dr === 0 && dc === 0, rowSpan, colSpan };
          }
        }
      }
      c += colSpan;
    }
  }

  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return { grid, meta, rowEls, width };
}

// ── Header detection ───────────────────────────────────────────────────────

/**
 * Works out how many leading rows are headers.
 *
 * Explicit markup wins. Failing that, a first row made entirely of <th>, or of
 * short non-numeric strings while the row below has numbers, is a header —
 * which is the shape of nearly every real data table.
 */
function detectHeaderRows(tableEl, grid, rowEls, opts) {
  const thead = [...tableEl.children].find((c) => c.tagName === "THEAD");
  if (thead) {
    const count = [...thead.querySelectorAll("tr")].length;
    if (count > 0 && count < grid.length) return count;
  }

  if (!opts.inferHeaders || grid.length < 2) return 0;

  const isTh = (row) => row.length > 0 && row.every((cell) => cell && cell.tagName === "TH");
  if (isTh(grid[0])) {
    // Multi-row header: keep consuming all-<th> rows (e.g. grouped headers).
    let n = 1;
    while (n < grid.length - 1 && isTh(grid[n])) n++;
    return n;
  }

  const looksNumeric = (s) => s !== "" && /^[-+(]?[$€£¥₹]?\s?[\d,.\s]+%?\)?$/.test(s);
  const first = grid[0].map((c) => (c ? cellText(c, opts) : ""));
  const second = grid[1].map((c) => (c ? cellText(c, opts) : ""));

  const firstNumeric = first.filter(looksNumeric).length;
  const secondNumeric = second.filter(looksNumeric).length;
  const firstFilled = first.filter((s) => s !== "").length;

  // Headers are labels: non-numeric, present, and shortish, sitting above data
  // that does contain numbers.
  if (
    firstFilled >= Math.max(2, Math.floor(first.length * 0.6)) &&
    firstNumeric === 0 &&
    secondNumeric > 0 &&
    first.every((s) => s.length <= 60)
  ) {
    return 1;
  }
  return 0;
}

/** Makes header names unique and non-empty so exports never collide. */
export function uniqueHeaders(names) {
  const seen = new Map();
  return names.map((raw, i) => {
    let name = (raw || "").trim() || `Column ${i + 1}`;
    name = name.replace(/\s*\n\s*/g, " ");
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name} (${count + 1})`;
  });
}

// ── Public extraction ──────────────────────────────────────────────────────

/**
 * Turns one <table> element into a Table Grabber table object.
 *
 * @returns {{headers: string[], rows: string[][], rowCount: number, colCount: number,
 *            headerRowCount: number, hasMerges: boolean, caption: string}}
 */
export function extractTable(tableEl, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const { grid, meta, rowEls, width } = buildGrid(tableEl);
  if (width === 0 || grid.length === 0) {
    return { headers: [], rows: [], rowCount: 0, colCount: 0, headerRowCount: 0, hasMerges: false, caption: "" };
  }

  const headerRowCount = detectHeaderRows(tableEl, grid, rowEls, opts);
  let hasMerges = false;

  const readRow = (r) => {
    const out = [];
    for (let c = 0; c < width; c++) {
      const cell = grid[r]?.[c];
      const info = meta[r]?.[c];
      if (!cell) { out.push(""); continue; }

      if (info && !info.master) {
        hasMerges = true;
        if (opts.spanPolicy === SPAN_POLICY.BLANK) { out.push(""); continue; }
        if (opts.spanPolicy === SPAN_POLICY.MARK) { out.push("↳"); continue; }
      } else if (info && (info.rowSpan > 1 || info.colSpan > 1)) {
        hasMerges = true;
      }

      let text = cellText(cell, opts);
      if (opts.imageAltText && !text) {
        const img = cell.querySelector?.("img");
        if (img) text = img.getAttribute("alt") || img.getAttribute("src") || "";
      }
      out.push(text);

      if (opts.extractLinks) out.push(firstLink(cell));
    }
    return out;
  };

  // Header names come from stacking the header rows, so grouped headers read
  // "Region – Q1" rather than losing the group entirely.
  let headers = [];
  if (headerRowCount > 0) {
    const stacked = [];
    for (let r = 0; r < headerRowCount; r++) stacked.push(readRow(r));
    const cols = stacked[0].length;
    for (let c = 0; c < cols; c++) {
      const parts = [];
      for (const row of stacked) {
        const v = (row[c] || "").trim();
        if (v && parts[parts.length - 1] !== v) parts.push(v);
      }
      headers.push(parts.join(" – "));
    }
    headers = uniqueHeaders(headers);
  }

  const rows = [];
  for (let r = headerRowCount; r < grid.length; r++) {
    const row = readRow(r);
    if (row.some((v) => v !== "")) rows.push(row);
  }

  if (headers.length === 0) {
    const cols = rows[0]?.length || width;
    headers = uniqueHeaders(new Array(cols).fill(""));
  }

  const captionEl = [...tableEl.children].find((c) => c.tagName === "CAPTION");

  return {
    headers,
    rows,
    rowCount: rows.length,
    colCount: headers.length,
    headerRowCount,
    hasMerges,
    caption: captionEl ? cellText(captionEl, opts) : "",
  };
}

// ── Div-grid detection ─────────────────────────────────────────────────────

/**
 * Finds "tables" built out of divs.
 *
 * The signal is repeating structure: a container whose children are numerous,
 * share a tag and class, and each hold the same number of leaf children. That
 * describes AG Grid, TanStack, and hand-rolled CSS-grid tables alike, without
 * hardcoding any library's class names.
 */
function findDivGrids(root, opts) {
  const found = [];
  const containers = root.querySelectorAll?.("div, ul, ol, section, main, tbody[role], [role='table'], [role='grid'], [role='rowgroup']");
  if (!containers) return found;

  for (const container of containers) {
    const children = [...container.children].filter(
      (c) => c.tagName !== "SCRIPT" && c.tagName !== "STYLE" && c.tagName !== "TEMPLATE"
    );
    if (children.length < Math.max(2, opts.minRows)) continue;
    if (children.length > 5000) continue;

    // Rows must look alike — but compare against the *most common* shape, not
    // the first child. Header rows almost always carry an extra class, and
    // anchoring on child[0] threw away every grid with a styled header.
    const sig = (el) => `${el.tagName}|${[...el.classList].slice(0, 3).sort().join(".")}`;
    const counts = new Map();
    for (const c of children) counts.set(sig(c), (counts.get(sig(c)) || 0) + 1);
    const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const body = children.filter((c) => sig(c) === modal);
    if (body.length < Math.max(2, opts.minRows)) continue;

    // A differently-shaped first child is a header, so keep it; anything else
    // that does not match the modal shape is chrome and is dropped.
    const header = children[0] !== body[0] && sig(children[0]) !== modal ? children[0] : null;
    const sameShape = header ? [header, ...body] : body;
    if (sameShape.length < children.length * 0.8) continue;

    // Each row must hold the same number of cells, and more than one.
    const widths = sameShape.slice(0, 20).map((r) => [...r.children].length);
    const cols = widths[0];
    if (!cols || cols < opts.minCols) continue;
    if (!widths.every((w) => w === cols)) continue;

    // Skip anything that is really a <table> we already handle, or a nav list.
    if (container.closest?.("table")) continue;

    const rows = sameShape.map((rowEl) => [...rowEl.children].map((cell) => cellText(cell, opts)));
    const nonEmpty = rows.filter((r) => r.some((v) => v !== ""));
    if (nonEmpty.length < opts.minRows) continue;

    // Reject "grids" that are actually a wall of empty boxes or a card list
    // where each card is one blob of text.
    const filled = nonEmpty.flat().filter((v) => v !== "").length;
    if (filled < nonEmpty.length * cols * 0.4) continue;

    found.push({ element: container, rows: nonEmpty, cols });
  }

  // Keep only the outermost of any nested matches — an AG Grid matches at
  // several depths and we want the one that holds every row.
  return found.filter((f) => !found.some((o) => o !== f && o.element.contains(f.element)));
}

function divGridToTable(grid, opts) {
  const rows = grid.rows;
  let headers;
  let body;

  const looksNumeric = (s) => s !== "" && /^[-+(]?[$€£¥₹]?\s?[\d,.\s]+%?\)?$/.test(s);
  const firstHasNumbers = rows[0].some(looksNumeric);

  if (opts.inferHeaders && rows.length > 1 && !firstHasNumbers && rows[0].every((s) => s.length <= 60)) {
    headers = uniqueHeaders(rows[0]);
    body = rows.slice(1);
  } else {
    headers = uniqueHeaders(new Array(grid.cols).fill(""));
    body = rows;
  }

  return {
    headers,
    rows: body,
    rowCount: body.length,
    colCount: headers.length,
    headerRowCount: headers.length && body !== rows ? 1 : 0,
    hasMerges: false,
    caption: "",
  };
}

// ── Traversal ──────────────────────────────────────────────────────────────

/** Collects roots to search: the document plus every open shadow root and same-origin iframe. */
function allRoots(root, depth = 0) {
  const roots = [root];
  if (depth > 6) return roots;

  const walker = root.querySelectorAll ? root.querySelectorAll("*") : [];
  for (const el of walker) {
    if (el.shadowRoot) roots.push(...allRoots(el.shadowRoot, depth + 1));
    if (el.tagName === "IFRAME") {
      try {
        // Throws on cross-origin, which is exactly the frames we must not read.
        const doc = el.contentDocument;
        if (doc && doc.body) roots.push(...allRoots(doc, depth + 1));
      } catch {
        /* cross-origin: skip */
      }
    }
  }
  return roots;
}

/** True when a table's body is probably virtualised, so most rows are not in the DOM. */
function looksVirtualised(el) {
  const scroller = el.closest?.("[class*='virtual'], [class*='Virtual'], .ag-body-viewport, [data-virtuoso-scroller]");
  if (scroller) return true;
  const style = el.getAttribute?.("style") || "";
  if (/transform:\s*translate/i.test(style)) return true;
  const parent = el.parentElement;
  if (parent && parent.scrollHeight > parent.clientHeight * 2 && parent.clientHeight > 0) return true;
  return false;
}

/**
 * Finds every table on a page, real or improvised.
 *
 * @returns {Array<{id: string, kind: "table"|"grid", element: Element, table: object,
 *                  virtualised: boolean, label: string}>}
 */
export function findTables(root, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const results = [];
  let n = 0;

  for (const r of allRoots(root)) {
    const tables = r.querySelectorAll ? r.querySelectorAll("table") : [];
    for (const el of tables) {
      // A nested table is extracted on its own pass; skip it here so its rows
      // are not counted twice.
      const table = extractTable(el, opts);
      if (table.rowCount < opts.minRows || table.colCount < opts.minCols) continue;

      results.push({
        id: `t${++n}`,
        kind: "table",
        element: el,
        table,
        virtualised: looksVirtualised(el),
        label: table.caption || describe(el, table),
      });
    }
  }

  // Only look for div-grids where real tables are scarce; otherwise a page with
  // proper tables also reports every sidebar list as a grid.
  if (results.length < 8) {
    for (const r of allRoots(root)) {
      for (const grid of findDivGrids(r, opts)) {
        if (results.some((res) => res.element.contains(grid.element) || grid.element.contains(res.element))) continue;
        const table = divGridToTable(grid, opts);
        if (table.rowCount < opts.minRows || table.colCount < opts.minCols) continue;
        results.push({
          id: `g${++n}`,
          kind: "grid",
          element: grid.element,
          table,
          virtualised: looksVirtualised(grid.element),
          label: describe(grid.element, table),
        });
      }
    }
  }

  return results;
}

/** A short human label, used in the table list when there is no caption. */
function describe(el, table) {
  const named = el.getAttribute?.("aria-label") || el.getAttribute?.("summary") || el.getAttribute?.("id");
  if (named) return named.slice(0, 60);

  const heading = table.headers.filter(Boolean).slice(0, 3).join(", ");
  if (heading) return heading.slice(0, 60);

  return `${table.rowCount}×${table.colCount} table`;
}
