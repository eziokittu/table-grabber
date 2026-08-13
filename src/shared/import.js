/**
 * Importers.
 *
 * Extraction reads tables out of a DOM. These read them out of text, which is
 * what turns the tool from "web table to X" into "anything to anything": paste
 * a CSV and get Markdown, paste JSON and get a spreadsheet, paste a Markdown
 * table and get SQL.
 *
 * Every parser returns the same table shape the extractor produces, so
 * everything downstream — typing, cleaning, filtering, all eleven exporters —
 * works on imported data with no special cases.
 *
 * No chrome.* APIs and no DOM, so this runs in the extension, on the website
 * and in the test harness identically.
 */

import { uniqueHeaders } from "./extract.js";

export const IMPORT_FORMATS = [
  { id: "auto", label: "Detect automatically" },
  { id: "html", label: "HTML table" },
  { id: "csv", label: "CSV" },
  { id: "tsv", label: "TSV" },
  { id: "json", label: "JSON" },
  { id: "jsonl", label: "JSON Lines" },
  { id: "markdown", label: "Markdown table" },
];

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Guesses what a blob of text is.
 *
 * Order matters: JSON and HTML have unambiguous openers, Markdown needs its
 * separator row, and delimited text is the fallback because almost anything
 * with a comma in it would otherwise match.
 */
export function detectFormat(text) {
  const s = String(text || "").trim();
  if (!s) return "csv";

  if (/^<|<table[\s>]|<\/table>/i.test(s)) return "html";

  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      JSON.parse(s);
      return "json";
    } catch {
      /* not valid JSON; fall through */
    }
  }

  // JSON Lines: several lines that each parse as an object on their own.
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1 && lines.slice(0, 5).every((l) => /^\s*\{.*\}\s*$/.test(l))) {
    return "jsonl";
  }

  // A Markdown table is pipes plus a |---|---| separator on the second line.
  if (lines.length >= 2 && lines[0].includes("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[1])) {
    return "markdown";
  }

  return sniffDelimiter(s) === "\t" ? "tsv" : "csv";
}

/**
 * Picks the delimiter by counting candidates outside quoted regions and
 * choosing the one whose count is most consistent from line to line.
 *
 * Consistency beats raw frequency: prose full of commas scores high on commas
 * but wildly differently per line, whereas a real delimiter appears the same
 * number of times in every row.
 */
export function sniffDelimiter(text) {
  const candidates = ["\t", ",", ";", "|"];
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (lines.length === 0) return ",";

  let best = ",";
  let bestScore = -1;

  for (const d of candidates) {
    const counts = lines.map((line) => countOutsideQuotes(line, d));
    const nonZero = counts.filter((c) => c > 0).length;
    if (nonZero === 0) continue;

    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    // Reward frequency and coverage, punish inconsistency.
    const score = mean * (nonZero / lines.length) - variance;

    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
    } else if (c === delimiter && !inQuotes) {
      count++;
    }
  }
  return count;
}

// ── Delimited ──────────────────────────────────────────────────────────────

/**
 * RFC 4180 parser.
 *
 * Written as a character-level state machine rather than split() because
 * quoted fields legitimately contain the delimiter, doubled quotes and raw
 * newlines — and every split()-based CSV reader silently mangles all three.
 */
export function parseDelimited(text, options) {
  const o = { delimiter: null, ...(options || {}) };
  const src = String(text).replace(/^﻿/, ""); // strip a UTF-8 BOM
  const delimiter = o.delimiter || sniffDelimiter(src);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < src.length) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"' && field === "") { inQuotes = true; i++; continue; }
    if (c === delimiter) { endField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endRow(); i++; continue; }

    field += c; i++;
  }
  // A trailing newline should not invent an empty final row.
  if (field !== "" || row.length > 0) endRow();

  return toTable(rows.filter((r) => r.some((v) => String(v).trim() !== "")), o);
}

// ── JSON ───────────────────────────────────────────────────────────────────

const scalar = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

export function parseJson(text, options) {
  const data = JSON.parse(String(text));
  return fromJsonValue(data, options);
}

export function parseJsonLines(text, options) {
  const rows = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return fromJsonValue(rows, options);
}

function fromJsonValue(data, options) {
  const o = { ...(options || {}) };

  // A bare object is a single record; a wrapper like {data: [...]} is common
  // enough in API responses to be worth unwrapping.
  let value = data;
  if (value && !Array.isArray(value) && typeof value === "object") {
    const arrayKey = Object.keys(value).find((k) => Array.isArray(value[k]));
    value = arrayKey ? value[arrayKey] : [value];
  }
  if (!Array.isArray(value)) throw new Error("That JSON is not a list of records.");
  if (value.length === 0) return emptyTable();

  // Array of arrays.
  if (Array.isArray(value[0])) {
    return toTable(value.map((r) => r.map(scalar)), o);
  }

  // Array of objects: the header set is the union of keys, in first-seen order,
  // so records with missing or extra fields still line up.
  const keys = [];
  for (const record of value) {
    if (!record || typeof record !== "object") continue;
    for (const k of Object.keys(record)) if (!keys.includes(k)) keys.push(k);
  }
  if (keys.length === 0) {
    return toTable(value.map((v) => [scalar(v)]), { ...o, hasHeader: false });
  }

  return {
    ...emptyTable(),
    headers: uniqueHeaders(keys),
    rows: value.map((record) => keys.map((k) => scalar(record?.[k]))),
    rowCount: value.length,
    colCount: keys.length,
  };
}

// ── Markdown ───────────────────────────────────────────────────────────────

export function parseMarkdown(text, options) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const cells = (line) => {
    let s = line;
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    // Split on unescaped pipes, then unescape.
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"));
  };

  const isSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

  const body = lines.filter((l) => l.includes("|"));
  if (body.length === 0) throw new Error("No Markdown table found.");

  const rows = [];
  let headers = null;

  for (let i = 0; i < body.length; i++) {
    if (isSeparator(body[i])) {
      // Everything before the separator was the header.
      if (rows.length > 0 && headers === null) headers = rows.pop();
      continue;
    }
    rows.push(cells(body[i]));
  }

  if (headers) {
    const width = Math.max(headers.length, ...rows.map((r) => r.length));
    return {
      ...emptyTable(),
      headers: uniqueHeaders(pad(headers, width)),
      rows: rows.map((r) => pad(r, width)),
      rowCount: rows.length,
      colCount: width,
    };
  }
  return toTable(rows, options);
}

// ── Shared ─────────────────────────────────────────────────────────────────

const pad = (arr, n) => arr.concat(new Array(Math.max(0, n - arr.length)).fill(""));

function emptyTable() {
  return { headers: [], rows: [], rowCount: 0, colCount: 0, headerRowCount: 0, hasMerges: false, caption: "" };
}

/**
 * Turns a raw grid of strings into a table, deciding whether row 0 is a header.
 *
 * Same heuristic as the DOM extractor: a first row of short non-numeric labels
 * above a row that contains numbers is a header.
 */
function toTable(grid, options) {
  const o = { hasHeader: null, ...(options || {}) };
  if (grid.length === 0) return emptyTable();

  const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const rows = grid.map((r) => pad(r, width));

  let hasHeader = o.hasHeader;
  if (hasHeader === null) {
    if (rows.length < 2) {
      hasHeader = false;
    } else {
      // Text formats carry a much stronger convention than HTML does: the first
      // line of a CSV is a header unless it obviously is not. Requiring numbers
      // in row two — the rule the DOM extractor uses — throws the header away
      // on every all-text export, which is a very common shape.
      const numeric = (s) => s !== "" && /^[-+(]?[$€£¥₹]?\s?[\d,.\s]+%?\)?$/.test(s.trim());
      const first = rows[0];
      hasHeader =
        first.every((c) => !numeric(c)) &&
        first.filter((c) => c.trim() !== "").length >= Math.max(1, Math.floor(width * 0.6)) &&
        first.every((c) => c.length <= 80);
    }
  }

  const headers = hasHeader ? uniqueHeaders(rows[0]) : uniqueHeaders(new Array(width).fill(""));
  const body = hasHeader ? rows.slice(1) : rows;

  return {
    ...emptyTable(),
    headers,
    rows: body,
    rowCount: body.length,
    colCount: width,
    headerRowCount: hasHeader ? 1 : 0,
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Parses text in whichever format it turns out to be.
 * HTML is not handled here — it needs a DOM, so the caller routes it to
 * extract.js instead.
 *
 * @returns {{table: object, format: string}}
 */
export function parseText(text, format, options) {
  const chosen = !format || format === "auto" ? detectFormat(text) : format;

  switch (chosen) {
    case "json":
      return { table: parseJson(text, options), format: chosen };
    case "jsonl":
      return { table: parseJsonLines(text, options), format: chosen };
    case "markdown":
      return { table: parseMarkdown(text, options), format: chosen };
    case "tsv":
      return { table: parseDelimited(text, { ...options, delimiter: "\t" }), format: chosen };
    case "csv":
      return { table: parseDelimited(text, options), format: chosen };
    default:
      throw new Error(`${chosen} needs a DOM; use the extractor.`);
  }
}
