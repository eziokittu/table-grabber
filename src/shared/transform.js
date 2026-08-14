/**
 * Column typing, value cleaning and table reshaping.
 *
 * Extraction gives you strings. That is correct — the page said "$1,234.00" —
 * but pasting that into a spreadsheet produces text, not a number, and the
 * user's SUM() returns 0. This module works out what each column actually is
 * and can rewrite the values so the destination understands them.
 *
 * Everything here is pure: (table, state) -> new table. No DOM, no chrome.*.
 */

export const TYPES = {
  TEXT: "text",
  NUMBER: "number",
  CURRENCY: "currency",
  PERCENT: "percent",
  DATE: "date",
  BOOLEAN: "boolean",
  URL: "url",
  EMPTY: "empty",
};

const CURRENCY_SYMBOLS = "$€£¥₹₽₩₪R\\$";
const BOOL_TRUE = new Set(["true", "yes", "y", "✓", "✔", "1", "on", "enabled"]);
const BOOL_FALSE = new Set(["false", "no", "n", "✗", "✘", "×", "0", "off", "disabled"]);

// ── Number parsing ─────────────────────────────────────────────────────────

/**
 * Parses the number a human sees, or null.
 *
 * Handles thousands separators in both conventions, accounting negatives,
 * currency symbols, percent signs and unicode minus. The ambiguous case is
 * "1.234" — European thousands or English decimal? We treat exactly three
 * digits after a lone separator as thousands only when a sibling value in the
 * column disambiguates; standalone, English wins because it is far more common
 * on the English-language web.
 */
export function parseNumber(raw, hint) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  s = s.replace(/[−–—]/g, "-").replace(/ /g, " ");

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }

  s = s.replace(new RegExp(`[${CURRENCY_SYMBOLS}]`, "g"), "");
  const hadPercent = /%/.test(s);
  s = s.replace(/%/g, "");
  s = s.replace(/\s/g, "").trim();

  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);

  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  let normalised;

  if (commas && dots) {
    // Whichever appears last is the decimal separator.
    normalised = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (commas) {
    const parts = s.split(",");
    const groupedLikeThousands = parts.slice(1).every((p) => p.length === 3);
    // "1,234" -> thousands.  "1,5" or "1,23" -> European decimal.
    normalised = groupedLikeThousands && (parts[0].length <= 3 || parts.length > 2) && hint !== "decimal-comma"
      ? s.replace(/,/g, "")
      : s.replace(",", ".");
  } else if (dots) {
    const parts = s.split(".");
    const groupedLikeThousands = parts.length > 2 && parts.slice(1).every((p) => p.length === 3);
    normalised = groupedLikeThousands ? s.replace(/\./g, "") : s;
  } else {
    normalised = s;
  }

  const n = Number(normalised);
  if (!Number.isFinite(n)) return null;
  const value = negative ? -n : n;
  return hadPercent ? value : value;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;
const SLASH_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
const TEXT_DATE = /^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}$|^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}$/;

function looksDate(s) {
  return ISO_DATE.test(s) || SLASH_DATE.test(s) || TEXT_DATE.test(s);
}

function looksUrl(s) {
  return /^(https?:\/\/|www\.)\S+$/i.test(s) || /^mailto:/i.test(s);
}

/**
 * Values that mean "no value" rather than being data of their own.
 *
 * These are excluded from the denominator when typing a column. Without that,
 * a single "N/A" in a short sales column drags the whole thing to text, and the
 * export stops producing numbers — which is the failure people actually notice.
 */
const PLACEHOLDERS = new Set([
  "-", "--", "–", "—", ".", "..", "…", "?", "*",
  "n/a", "n.a.", "na", "n/k", "nil", "null", "none", "nan",
  "tbd", "tba", "unknown", "pending", "empty", "no data", "not available",
]);

const isPlaceholder = (s) => PLACEHOLDERS.has(s.trim().toLowerCase());

// ── Column typing ──────────────────────────────────────────────────────────

/**
 * Classifies each column by sampling its values.
 *
 * A column is typed when a clear majority of its non-empty values agree; a
 * stray "N/A" or a footnote row should not knock a numeric column into text.
 */
export function inferColumnTypes(table) {
  const { headers, rows } = table;
  const colCount = headers.length;
  const types = [];

  for (let c = 0; c < colCount; c++) {
    const sample = [];
    for (let r = 0; r < rows.length && sample.length < 200; r++) {
      const v = (rows[r][c] ?? "").trim();
      if (v) sample.push(v);
    }

    if (sample.length === 0) { types.push(TYPES.EMPTY); continue; }

    // Judge the column on values that carry meaning, not on its blanks.
    const meaningful = sample.filter((v) => !isPlaceholder(v));
    if (meaningful.length === 0) { types.push(TYPES.TEXT); continue; }

    let currency = 0, percent = 0, number = 0, date = 0, bool = 0, url = 0;
    for (const v of meaningful) {
      const low = v.toLowerCase();
      if (BOOL_TRUE.has(low) || BOOL_FALSE.has(low)) bool++;
      if (looksUrl(v)) url++;
      if (looksDate(v)) date++;
      const hasCurrency = new RegExp(`[${CURRENCY_SYMBOLS}]`).test(v);
      const hasPercent = /%/.test(v);
      if (parseNumber(v) !== null) {
        number++;
        if (hasCurrency) currency++;
        if (hasPercent) percent++;
      }
    }

    const n = meaningful.length;
    const majority = (count) => count >= n * 0.8;

    // Order matters: a currency column is also numeric, so check it first.
    if (majority(bool)) types.push(TYPES.BOOLEAN);
    else if (majority(url)) types.push(TYPES.URL);
    else if (majority(number) && currency >= n * 0.5) types.push(TYPES.CURRENCY);
    else if (majority(number) && percent >= n * 0.5) types.push(TYPES.PERCENT);
    else if (majority(date) && !majority(number)) types.push(TYPES.DATE);
    else if (majority(number)) types.push(TYPES.NUMBER);
    else types.push(TYPES.TEXT);
  }

  return types;
}

/**
 * Rewrites a value into a machine-readable form for its column type.
 * Returns the original string when it cannot do better, so nothing is ever lost.
 */
export function cleanValue(raw, type, opts) {
  const options = opts || {};
  const s = String(raw ?? "").trim();
  if (!s) return "";

  switch (type) {
    case TYPES.NUMBER:
    case TYPES.CURRENCY: {
      const n = parseNumber(s);
      return n === null ? s : String(n);
    }
    case TYPES.PERCENT: {
      const n = parseNumber(s);
      if (n === null) return s;
      return options.percentAsFraction ? String(n / 100) : String(n);
    }
    case TYPES.BOOLEAN: {
      const low = s.toLowerCase();
      if (BOOL_TRUE.has(low)) return "true";
      if (BOOL_FALSE.has(low)) return "false";
      return s;
    }
    case TYPES.DATE: {
      if (!options.normaliseDates) return s;
      const iso = toIsoDate(s);
      return iso || s;
    }
    default:
      return s;
  }
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Converts a date we are confident about to YYYY-MM-DD, else null. */
export function toIsoDate(s) {
  const t = s.trim();

  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "12 March 2024" / "March 12, 2024"
  let m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }

  // Numeric slash dates are genuinely ambiguous (US vs rest of world), so we
  // only convert when the day is unambiguous.
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) return `${m[3]}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
    if (b > 12 && a <= 12) return `${m[3]}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
  }

  return null;
}

// ── Reshaping ──────────────────────────────────────────────────────────────

/** How header names are rewritten on export. */
export const HEADER_CASE = {
  NONE: "none",
  SNAKE: "snake",
  CAMEL: "camel",
  TITLE: "title",
  UPPER: "upper",
  LOWER: "lower",
};

/**
 * Rewrites a header name into a target convention.
 *
 * Worth having because the destination usually has one: SQL columns want
 * snake_case, JSON keys want camelCase, and doing it by hand for a forty-column
 * table is exactly the kind of tedium this tool exists to remove.
 */
export function applyHeaderCase(name, style) {
  const raw = String(name ?? "").trim();
  if (!raw || style === HEADER_CASE.NONE || !style) return raw;

  // Split on anything non-alphanumeric, plus camelCase boundaries, plus the
  // boundary between a word and a trailing number ("Sales2024" -> "Sales 2024").
  // The {2,} guard keeps short label-and-number pairs together, so "Q1" stays
  // "q1" rather than becoming "q_1".
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z]{2,})(\d)/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return raw;

  switch (style) {
    case HEADER_CASE.SNAKE:
      return words.map((w) => w.toLowerCase()).join("_");
    case HEADER_CASE.CAMEL:
      return words
        .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
        .join("");
    case HEADER_CASE.TITLE:
      return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
    case HEADER_CASE.UPPER:
      return words.join(" ").toUpperCase();
    case HEADER_CASE.LOWER:
      return words.join(" ").toLowerCase();
    default:
      return raw;
  }
}

export const DEFAULT_STATE = {
  /** Indices of columns to omit. */
  hiddenColumns: [],
  /** Original column indices, in the order they should appear. Empty = source order. */
  columnOrder: [],
  /** Sparse map of columnIndex -> replacement header. */
  renames: {},
  /** One of HEADER_CASE, applied after renames. */
  headerCase: "none",
  /** Drop this many rows from the top before anything else. */
  skipRows: 0,
  /** Copy the value above into an empty cell. Fixes tables that only label the first row of a group. */
  fillDown: false,
  /** Strip leading and trailing whitespace from every cell. */
  trimCells: false,
  /** { find, replaceWith, regex, caseSensitive } — applied to every cell. */
  replace: null,
  /** Swap rows and columns. Applied last, because it changes the shape. */
  transpose: false,
  /** Case-insensitive substring filter across all cells. */
  search: "",
  /** { column: number, direction: "asc"|"desc" } or null. */
  sort: null,
  /** Drop rows identical to an earlier row. */
  dedupe: false,
  /** Drop rows where every cell is empty, and columns that are entirely empty. */
  dropEmpty: true,
  /** Rewrite values to match the inferred column type. */
  cleanValues: false,
  normaliseDates: false,
  percentAsFraction: false,
  /** Keep only the first N rows. 0 means all. */
  limit: 0,
};

/**
 * Applies the user's view settings to a table.
 * Returns a new table object; the input is never mutated.
 */
export function applyState(table, state) {
  const s = { ...DEFAULT_STATE, ...(state || {}) };
  let headers = table.headers.slice();
  let rows = table.rows.map((r) => r.slice());

  // Pad short rows so every downstream step can assume a rectangle.
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  headers = headers.concat(new Array(Math.max(0, width - headers.length)).fill(""));
  rows = rows.map((r) => r.concat(new Array(Math.max(0, width - r.length)).fill("")));

  if (s.skipRows > 0) rows = rows.slice(s.skipRows);

  /** Set when a find pattern was refused, so the UI can say why. */
  let patternError = null;

  const types = inferColumnTypes({ headers, rows });

  // Renames are keyed by *original* column index, so they must be applied
  // before any column is dropped or the keys stop lining up.
  for (const [index, name] of Object.entries(s.renames)) {
    const i = Number(index);
    if (Number.isInteger(i) && i >= 0 && i < headers.length && name != null && name !== "") {
      headers[i] = name;
    }
  }

  if (s.cleanValues) {
    rows = rows.map((row) =>
      row.map((v, c) =>
        cleanValue(v, types[c], { normaliseDates: s.normaliseDates, percentAsFraction: s.percentAsFraction })
      )
    );
  }

  // Fill-down before empties are dropped, so a group label written once at the
  // top of a run reaches every row of that run.
  if (s.fillDown) {
    for (let c = 0; c < width; c++) {
      let last = "";
      for (const row of rows) {
        const v = String(row[c] ?? "").trim();
        if (v !== "") last = row[c];
        else if (last !== "") row[c] = last;
      }
    }
  }

  if (s.trimCells) {
    rows = rows.map((r) => r.map((v) => String(v ?? "").trim()));
  }

  if (s.replace && s.replace.find) {
    const { find, replaceWith = "", regex = false, caseSensitive = false } = s.replace;
    const compiled = compilePattern(find, regex, caseSensitive);
    if (compiled.pattern) {
      rows = rows.map((r) => r.map((v) => String(v ?? "").replace(compiled.pattern, replaceWith)));
    }
    // Surfaced so the UI can explain a rejected pattern instead of silently
    // doing nothing.
    if (compiled.error) patternError = compiled.error;
  }

  if (s.dropEmpty) {
    rows = rows.filter((r) => r.some((v) => String(v).trim() !== ""));
  }

  // Column removal: explicit hides, plus wholly empty columns when asked.
  const drop = new Set(s.hiddenColumns);
  if (s.dropEmpty) {
    for (let c = 0; c < width; c++) {
      const headerEmpty = !String(headers[c] ?? "").trim() || /^Column \d+$/.test(headers[c]);
      const bodyEmpty = rows.every((r) => String(r[c] ?? "").trim() === "");
      if (headerEmpty && bodyEmpty) drop.add(c);
    }
  }

  // Build the surviving column list, honouring an explicit order when one is
  // set. Anything the order forgot is appended, so a reorder can never silently
  // lose a column.
  let keep = [];
  for (let c = 0; c < width; c++) if (!drop.has(c)) keep.push(c);

  if (s.columnOrder && s.columnOrder.length) {
    const ordered = s.columnOrder.filter((c) => keep.includes(c));
    const missing = keep.filter((c) => !ordered.includes(c));
    keep = [...ordered, ...missing];
  }

  headers = keep.map((c) => headers[c]);
  rows = rows.map((r) => keep.map((c) => r[c]));

  if (s.headerCase && s.headerCase !== HEADER_CASE.NONE) {
    headers = uniqueNames(headers.map((h) => applyHeaderCase(h, s.headerCase)));
  }

  if (s.search) {
    const needle = s.search.toLowerCase();
    rows = rows.filter((r) => r.some((v) => String(v).toLowerCase().includes(needle)));
  }

  if (s.dedupe) {
    const seen = new Set();
    rows = rows.filter((r) => {
      const key = r.join(" ");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (s.sort && s.sort.column >= 0 && s.sort.column < headers.length) {
    const col = s.sort.column;
    const dir = s.sort.direction === "desc" ? -1 : 1;
    const keptTypes = inferColumnTypes({ headers, rows });
    const numeric = [TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(keptTypes[col]);

    rows.sort((a, b) => {
      const av = a[col] ?? "", bv = b[col] ?? "";
      if (numeric) {
        const an = parseNumber(av), bn = parseNumber(bv);
        if (an === null && bn === null) return 0;
        if (an === null) return 1;   // blanks last, regardless of direction
        if (bn === null) return -1;
        return (an - bn) * dir;
      }
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
  }

  if (s.limit > 0) rows = rows.slice(0, s.limit);

  // Transpose last: it redefines what a row and a column are, so every filter
  // above would mean something different if it ran after.
  if (s.transpose) {
    const matrix = [headers, ...rows];
    const height = matrix.length;
    const cols = Math.max(0, ...matrix.map((r) => r.length));
    const flipped = [];
    for (let c = 0; c < cols; c++) {
      const line = [];
      for (let r = 0; r < height; r++) line.push(matrix[r][c] ?? "");
      flipped.push(line);
    }
    headers = uniqueNames(flipped[0] || []);
    rows = flipped.slice(1);
  }

  return {
    ...table,
    headers,
    rows,
    rowCount: rows.length,
    colCount: headers.length,
    types: inferColumnTypes({ headers, rows }),
    patternError,
  };
}

// ── Regex safety ───────────────────────────────────────────────────────────

/**
 * Catastrophic backtracking is a real hazard here, not a theoretical one.
 *
 * The find-and-replace box accepts a regular expression and runs it over every
 * cell. A pattern like `(a+)+$` against a long run of the same character takes
 * exponential time, and JavaScript cannot interrupt a regex once it starts —
 * there is no timeout, no abort, and no way back. The tab simply stops
 * responding, taking the user's ungrabbed table with it. Measured on this
 * codebase before the guard: 300 rows never finished at all.
 *
 * So a candidate pattern is tried against a short adversarial string first. A
 * safe pattern finishes in microseconds; a catastrophic one blows past the
 * budget on a 24-character input while still returning in well under a second,
 * because the cost is exponential in the length we control.
 */
const CANARY_BUDGET_MS = 40;

function isPatternSafe(pattern) {
  // Inputs shaped to trigger the usual nested-quantifier blowups. Short enough
  // that even a pathological pattern returns, long enough that it is slow.
  const canaries = [
    "a".repeat(24) + "!",
    "ab".repeat(12) + "!",
    " ".repeat(24) + "x",
    "0".repeat(24) + "!",
  ];

  for (const canary of canaries) {
    const started = Date.now();
    try {
      // A fresh regex each time: `g` patterns carry lastIndex between calls.
      new RegExp(pattern.source, pattern.flags).test(canary);
    } catch {
      return false;
    }
    if (Date.now() - started > CANARY_BUDGET_MS) return false;
  }
  return true;
}

/**
 * Builds the find pattern, refusing anything that looks ruinous.
 * @returns {{pattern: RegExp|null, error: string|null}}
 */
export function compilePattern(find, regex, caseSensitive) {
  if (!find) return { pattern: null, error: null };

  const flags = caseSensitive ? "g" : "gi";

  if (!regex) {
    // Escape the needle so a literal search for "1.5" cannot also match "125".
    return { pattern: new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags), error: null };
  }

  let pattern;
  try {
    pattern = new RegExp(find, flags);
  } catch (e) {
    return { pattern: null, error: `Not a valid regular expression: ${e.message}` };
  }

  if (!isPatternSafe(pattern)) {
    return {
      pattern: null,
      error:
        "That pattern backtracks catastrophically and would freeze the page. Nested quantifiers such as (a+)+ are the usual cause — try rewriting it without them.",
    };
  }

  return { pattern, error: null };
}

/** Local copy of the de-duplicator, so this module stays free of DOM imports. */
function uniqueNames(names) {
  const seen = new Map();
  return names.map((raw, i) => {
    const name = (raw || "").toString().trim() || `Column ${i + 1}`;
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name} (${count + 1})`;
  });
}

// ── Column statistics ──────────────────────────────────────────────────────

/**
 * Per-column summary, shown beside each column in the editor.
 *
 * Cheap to compute and disproportionately useful: it is how you notice that a
 * capture is short, that a column you thought was numeric has thirty text
 * values in it, or that a "unique id" column has duplicates.
 *
 * @returns {Array<{type: string, filled: number, empty: number, unique: number,
 *                  min?: number, max?: number, sum?: number, mean?: number}>}
 */
export function columnStats(table) {
  const types = table.types || inferColumnTypes(table);
  const out = [];

  for (let c = 0; c < table.headers.length; c++) {
    const seen = new Set();
    let filled = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let numeric = 0;

    for (const row of table.rows) {
      const raw = String(row[c] ?? "").trim();
      if (raw === "") continue;
      filled++;
      if (seen.size < 10000) seen.add(raw);

      if ([TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(types[c])) {
        const n = parseNumber(raw);
        if (n !== null) {
          numeric++;
          sum += n;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      }
    }

    const stat = {
      type: types[c],
      filled,
      empty: table.rows.length - filled,
      unique: seen.size,
    };
    if (numeric > 0) {
      stat.min = min;
      stat.max = max;
      stat.sum = Number(sum.toFixed(6));
      stat.mean = Number((sum / numeric).toFixed(6));
    }
    out.push(stat);
  }
  return out;
}

/** Merges tables that share a header shape — used by paginated capture. */
export function mergeTables(tables) {
  if (tables.length === 0) return null;
  if (tables.length === 1) return tables[0];

  const base = tables[0];
  const rows = base.rows.slice();
  let merged = 1;

  for (const t of tables.slice(1)) {
    // Same column count is the only hard requirement; header text often drifts
    // slightly between pages (sort arrows, counts) so it is not compared.
    if (t.colCount !== base.colCount) continue;
    rows.push(...t.rows);
    merged++;
  }

  // Pagination frequently re-serves the last page; drop exact duplicate rows
  // only when they are adjacent, so legitimately repeated data survives.
  const deduped = rows.filter((r, i) => i === 0 || r.join(" ") !== rows[i - 1].join(" "));

  return { ...base, rows: deduped, rowCount: deduped.length, mergedFrom: merged };
}
