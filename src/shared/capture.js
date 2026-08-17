/**
 * Deep capture: getting the rows that are not in the DOM yet.
 *
 * Two situations defeat plain extraction, and both are paywalled features in
 * the incumbent extensions:
 *
 *   Virtualised bodies — AG Grid, TanStack, react-window and friends keep only
 *   the visible rows mounted. Reading the DOM once gets you twenty rows out of
 *   fifty thousand. The fix is to scroll the container in steps and accumulate.
 *
 *   Pagination — the rest of the data is behind a "Next" button. The fix is to
 *   click it, wait for the body to change, and extract again.
 *
 * Both are inherently best-effort: we are automating a UI that has no contract
 * with us. So both report honestly (`complete: true/false`) rather than
 * pretending a truncated capture is the whole table, and both stop at hard
 * limits so a runaway page cannot hang the tab.
 */

import { extractTable, extractGrid, findTables } from "./extract.js";
import { mergeTables } from "./transform.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Moves a scroller and makes sure its listeners actually hear about it.
 *
 * Assigning `scrollTop` normally causes the browser to fire a `scroll` event —
 * but only as part of the rendering steps, which a browser is free to skip when
 * the tab is not being painted. That is not a corner case here: a capture of
 * fifty thousand rows takes a while and people switch tabs while it runs. When
 * that happens the position changes, no event is dispatched, the page's
 * virtualiser never re-renders, and the capture quietly stalls having collected
 * only the rows that happened to be mounted.
 *
 * Dispatching the event ourselves closes that gap. A duplicate `scroll` event
 * is harmless — listeners are written to be called at any time, often many
 * times per frame — and window-level listeners get one too, because page-level
 * infinite scroll usually listens there rather than on an element.
 */
function scrollTo(scroller, top) {
  scroller.scrollTop = top;

  try {
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));

    const doc = scroller.ownerDocument || document;
    if (scroller === doc.scrollingElement || scroller === doc.documentElement || scroller === doc.body) {
      doc.dispatchEvent(new Event("scroll", { bubbles: false }));
      doc.defaultView?.dispatchEvent(new Event("scroll", { bubbles: false }));
    }
  } catch {
    /* a page that throws in its own scroll handler is not our problem */
  }

  return scroller.scrollTop;
}

/** Attributes libraries use to number rows. Using them beats guessing. */
const ROW_INDEX_ATTRS = ["aria-rowindex", "data-row-index", "data-rowindex", "row-index", "data-index"];

function rowIndexOf(el) {
  for (const attr of ROW_INDEX_ATTRS) {
    const v = el.getAttribute?.(attr);
    if (v != null && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Finds the element that actually scrolls a table's rows. */
export function findScroller(el) {
  const known = el.closest?.(".ag-body-viewport, [data-virtuoso-scroller], [class*='virtual'], [class*='Virtual']");
  if (known) return known;

  let node = el;
  for (let i = 0; i < 12 && node; i++) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    const overflowY = style?.overflowY;
    const scrolls = overflowY === "auto" || overflowY === "scroll";
    if (scrolls && node.scrollHeight > node.clientHeight + 8) return node;
    node = node.parentElement;
  }

  // Falls back to the page itself, which is how most infinite-scroll lists work.
  const doc = el.ownerDocument;
  return doc?.scrollingElement || doc?.documentElement || null;
}

/**
 * Reads whatever the target currently shows, whether it is a real table or a
 * container of repeating boxes.
 *
 * The div-grid half of this used to be missing: harvest only ran extractTable,
 * which returns nothing for a container that is not a <table>, so scrolling an
 * AG Grid collected zero rows and then confidently replaced a perfectly good
 * twenty-row capture with an empty one. Every scroll capture on a modern data
 * grid — the exact case the feature exists for — destroyed the table.
 */
function readCurrent(target, options) {
  const el = target.element;
  if (target.kind === "grid") {
    return extractGrid(el, options) || extractTable(el, options);
  }
  const table = extractTable(el, options);
  if (table.rowCount > 0) return table;
  // A <table> whose body is drawn with divs (it happens) still reads as a grid.
  return extractGrid(el, options) || table;
}

/**
 * Scrolls a virtualised table and accumulates every row it renders.
 *
 * Rows are keyed by their library-provided index when one exists, which makes
 * the result exact. Without one we fall back to de-duplicating by content —
 * good enough in practice, but it will collapse genuinely identical rows, so
 * the caller is told which strategy was used.
 *
 * The contract that matters: this can come back with *less* than it hoped for,
 * but never with less than it started with. A capture that goes backwards is
 * indistinguishable from a broken extension, so if the walk ends up under the
 * row count we already had, the original is returned untouched.
 */
export async function captureByScrolling(target, options, onProgress, shouldStop) {
  const o = {
    maxScrolls: 600,
    settleMs: 110,
    stepRatio: 0.75,
    stallLimit: 4,
    ...(options || {}),
  };

  const el = target.element;
  const scroller = findScroller(el);
  if (!scroller) {
    return { table: target.table, complete: true, strategy: "none", scrolls: 0, gained: 0 };
  }

  const byIndex = new Map();
  const byContent = new Map();
  let usedIndex = false;
  let headers = target.table.headers;
  const headerKey = headers.join("\0");

  const harvest = () => {
    const fresh = readCurrent(target, options);
    if (fresh && fresh.headers.some(Boolean)) headers = fresh.headers;

    // Prefer real row indices when the grid exposes them.
    const rowEls = el.querySelectorAll?.("tr, [role='row']") || [];
    let indexed = 0;
    for (const rowEl of rowEls) {
      const idx = rowIndexOf(rowEl);
      if (idx === null) continue;
      const cells = [...rowEl.children].map((c) => (c.textContent || "").replace(/\s+/g, " ").trim());
      if (cells.length && cells.some(Boolean)) {
        byIndex.set(idx, cells);
        indexed++;
      }
    }
    if (indexed > 0) usedIndex = true;

    for (const row of fresh?.rows || []) {
      const key = row.join("\0");
      // The header re-appears in every harvest of a grid whose header row is
      // just another box; adding it once per scroll would pepper the result.
      if (key === headerKey) continue;
      if (!byContent.has(key)) byContent.set(key, row);
    }
  };

  const count = () => (usedIndex ? byIndex.size : byContent.size);
  const originalTop = scroller.scrollTop;

  harvest();
  scrollTo(scroller, 0);
  await sleep(o.settleMs);
  harvest();

  let stalls = 0;
  let scrolls = 0;
  let stuck = 0;
  let lastCount = count();
  let stopped = false;

  while (scrolls < o.maxScrolls) {
    if (shouldStop?.()) { stopped = true; break; }

    const viewport = scroller.clientHeight || 600;
    const before = scroller.scrollTop;
    const now = scrollTo(scroller, before + viewport * o.stepRatio);

    if (now === before) {
      const atBottom = now + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atBottom) break;
      // Not at the bottom and refusing to move: the page is holding the
      // scroller, and grinding out another 400 no-op steps helps nobody.
      if (++stuck >= 3) break;
    } else {
      stuck = 0;
    }

    await sleep(o.settleMs);
    harvest();
    scrolls++;

    const rows = count();
    if (onProgress) onProgress({ rows, scrolls });

    if (rows === lastCount) {
      stalls++;
      // Infinite-scroll lists often need a beat to fetch the next page.
      if (stalls === 2) await sleep(o.settleMs * 5);
      if (stalls >= o.stallLimit) break;
    } else {
      stalls = 0;
      lastCount = rows;
    }
  }

  scrollTo(scroller, originalTop);

  const collected = usedIndex
    ? [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells)
    : [...byContent.values()];

  if (collected.length <= target.table.rowCount) {
    return {
      table: target.table,
      complete: !stopped && scrolls < o.maxScrolls,
      strategy: usedIndex ? "row-index" : "content-dedupe",
      scrolls,
      stopped,
      gained: 0,
    };
  }

  return {
    table: {
      ...target.table,
      headers,
      rows: collected,
      rowCount: collected.length,
      colCount: headers.length,
    },
    complete: !stopped && scrolls < o.maxScrolls,
    strategy: usedIndex ? "row-index" : "content-dedupe",
    scrolls,
    stopped,
    gained: collected.length - target.table.rowCount,
  };
}

// ── Pagination ─────────────────────────────────────────────────────────────

const NEXT_SELECTORS = [
  "[aria-label*='next' i]:not([aria-disabled='true'])",
  "[rel='next']",
  ".pagination .next:not(.disabled) a, .pagination .next:not(.disabled)",
  "[class*='next' i]:not([class*='disabled' i])",
  "[id*='next' i]",
  "[data-testid*='next' i]",
  "button[title*='next' i]",
];

/**
 * Matched against normalised label text.
 *
 * Real controls read "Next ›", "Next page →", "Load more…" — decoration around
 * the word is the norm, not the exception. Anchoring the pattern to the bare
 * word made this miss essentially every real pagination control, so the label
 * is stripped of arrows and punctuation first.
 */
const NEXT_TEXT = /^(next|next page|older|load more|show more|view more|more results)$/i;
const ARROW_ONLY = /^[›»→⟩>▶❯]+$/;

/** "Next ›" -> "next"; "→" -> "→" (kept, so an arrow-only button still matches). */
function normaliseLabel(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (ARROW_ONLY.test(text)) return text;
  return text.replace(/[›»→⟩▶❯> ]+/g, " ").replace(/[.…]+$/, "").replace(/\s+/g, " ").trim();
}

function looksLikeNext(raw) {
  const label = normaliseLabel(raw);
  if (!label) return false;
  return NEXT_TEXT.test(label) || ARROW_ONLY.test(label);
}

/** Internals worth asserting on directly. Not part of the runtime API. */
export const __testables = { looksLikeNext, normaliseLabel };

/**
 * Whether a control is plausibly *this* table's pager.
 *
 * The whole-document fallback below is what finds the pager on pages that put
 * it in a footer bar rather than beside the table — and also what used to find
 * some *other* table's "Next" button halfway down the page, so a table with no
 * pagination at all was offered a "walk every page" button that could only ever
 * click the wrong thing. Proximity is a cheap way to tell the two apart.
 */
function isNearby(control, el) {
  const a = control.getBoundingClientRect?.();
  const b = el.getBoundingClientRect?.();
  // No layout to consult (a parsed document, a test harness): don't second-guess.
  if (!a || !b || (a.width === 0 && a.height === 0)) return true;
  const below = a.top >= b.top - 200 && a.top <= b.bottom + 400;
  const alongside = a.left < b.right + 250 && a.right > b.left - 250;
  return below && alongside;
}

/** Finds a clickable "next page" control near a table. */
export function findNextControl(el) {
  const doc = el.ownerDocument;
  const scopes = [
    { root: el.parentElement, near: false },
    { root: el.closest?.("[class*='table' i], [class*='grid' i], section, main, article"), near: false },
    { root: doc.body, near: true },
  ].filter((s) => s.root);

  for (const { root, near } of scopes) {
    const usable = (c) => isUsableControl(c) && (!near || isNearby(c, el));

    for (const sel of NEXT_SELECTORS) {
      let candidates;
      try {
        candidates = root.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const c of candidates) {
        if (usable(c)) return c;
      }
    }

    const clickables = root.querySelectorAll("a, button, [role='button']");
    for (const c of clickables) {
      if (looksLikeNext(c.textContent) || looksLikeNext(c.getAttribute("aria-label"))) {
        if (usable(c)) return c;
      }
    }
  }
  return null;
}

function isUsableControl(c) {
  if (!c) return false;
  if (c.disabled) return false;
  if (c.getAttribute("aria-disabled") === "true") return false;
  if (/\bdisabled\b/i.test(c.className || "")) return false;
  const rect = c.getBoundingClientRect?.();
  if (rect && rect.width === 0 && rect.height === 0) return false;
  return true;
}

/**
 * Walks a paginated table, collecting every page.
 *
 * This clicks controls on a page the user is looking at, so it is deliberately
 * conservative: a page cap, a stop when the body stops changing, and a stop the
 * caller can trigger. It never submits forms or follows links to other origins.
 */
export async function captureByPaging(target, options, onProgress, shouldStop) {
  const o = { maxPages: 100, waitMs: 700, pollMs: 60, maxWaitMs: 8000, ...(options || {}) };

  const el = target.element;
  const pages = [target.table];
  let page = 1;
  let complete = false;

  const signature = () => {
    const rows = el.querySelectorAll?.("tr, [role='row']") || [];
    const first = rows[1] || rows[0];
    return `${rows.length}:${(first?.textContent || "").slice(0, 120)}`;
  };

  while (page < o.maxPages) {
    if (shouldStop?.()) break;

    const next = findNextControl(el);
    if (!next) { complete = true; break; }

    const before = signature();
    try {
      next.click();
    } catch {
      complete = true;
      break;
    }

    // Wait for the body to actually change rather than trusting a fixed delay.
    let waited = 0;
    let changed = false;
    while (waited < o.maxWaitMs) {
      await sleep(o.pollMs);
      waited += o.pollMs;
      if (signature() !== before) { changed = true; break; }
    }
    if (!changed) { complete = true; break; }

    await sleep(o.waitMs);

    // The element can be replaced wholesale by a re-render, so re-find it.
    let liveEl = el.isConnected ? el : null;
    if (!liveEl) {
      const again = findTables(el.ownerDocument, options).find(
        (t) => t.table.colCount === target.table.colCount
      );
      if (!again) { complete = true; break; }
      liveEl = again.element;
    }

    const fresh = readCurrent({ ...target, element: liveEl }, options);
    if (!fresh || fresh.rowCount === 0) { complete = true; break; }

    pages.push(fresh);
    page++;
    if (onProgress) onProgress({ pages: page, rows: pages.reduce((n, t) => n + t.rowCount, 0) });
  }

  const merged = mergeTables(pages);
  return { table: merged, complete, pages: page };
}
