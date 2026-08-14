/**
 * Exporters.
 *
 * Every format below is generated in the browser from data already on screen.
 * There is no server, no upload and no format that costs money — the whole
 * point of this extension is that turning a grid of strings into CSV, Markdown
 * or a spreadsheet is arithmetic, not a service.
 *
 * The .xlsx writer is the only non-obvious one: a real workbook is a ZIP of
 * XML parts, so there is a minimal ZIP writer at the bottom. It writes STORED
 * (uncompressed) entries, which is a valid ZIP and means the whole thing has
 * no dependencies and runs anywhere, including inside a content script.
 */

import { TYPES, parseNumber, inferColumnTypes } from "./transform.js";

export const FORMATS = [
  { id: "csv", label: "CSV", ext: "csv", mime: "text/csv", blurb: "Comma-separated. Opens anywhere." },
  { id: "tsv", label: "TSV", ext: "tsv", mime: "text/tab-separated-values", blurb: "Tab-separated. Best for pasting." },
  { id: "xlsx", label: "Excel", ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", blurb: "Real workbook, numbers stay numbers." },
  { id: "json", label: "JSON", ext: "json", mime: "application/json", blurb: "Array of objects, keyed by header." },
  { id: "json-arrays", label: "JSON rows", ext: "json", mime: "application/json", blurb: "Array of arrays, header row first." },
  { id: "jsonl", label: "JSON Lines", ext: "jsonl", mime: "application/x-ndjson", blurb: "One record per line. What log and data pipelines want." },
  { id: "xml", label: "XML", ext: "xml", mime: "application/xml", blurb: "One element per row, headers as tag names." },
  { id: "markdown", label: "Markdown", ext: "md", mime: "text/markdown", blurb: "GitHub-flavoured, padded to align." },
  { id: "html", label: "HTML", ext: "html", mime: "text/html", blurb: "Clean table, no page styling." },
  { id: "sql", label: "SQL", ext: "sql", mime: "text/plain", blurb: "CREATE TABLE plus INSERTs." },
  { id: "yaml", label: "YAML", ext: "yaml", mime: "text/yaml", blurb: "One document, list of records." },
  { id: "latex", label: "LaTeX", ext: "tex", mime: "text/plain", blurb: "tabular environment." },
  { id: "text", label: "Plain text", ext: "txt", mime: "text/plain", blurb: "Fixed-width, aligned columns." },
];

// ── Delimited ──────────────────────────────────────────────────────────────

/**
 * RFC 4180 quoting: quote when the value contains the delimiter, a quote or a
 * newline, and double any embedded quotes.
 *
 * The leading-formula guard matters more than it looks. A cell reading
 * "=cmd|' /c calc'!A1" is a live formula when the CSV is opened in Excel, which
 * is a real injection route out of scraped pages. Prefixing a tab neutralises
 * it without visibly changing the value.
 */
function csvCell(value, delimiter, guardFormulas) {
  let s = String(value ?? "");
  if (guardFormulas && /^[=+\-@\t\r]/.test(s) && s.length > 1 && !/^-?[\d.,]+$/.test(s)) {
    s = "\t" + s;
  }
  if (s.includes(delimiter) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toDelimited(table, opts) {
  const o = {
    delimiter: ",",
    newline: "\r\n",
    includeHeaders: true,
    guardFormulas: true,
    ...(opts || {}),
  };
  const lines = [];
  if (o.includeHeaders && table.headers.length) {
    lines.push(table.headers.map((h) => csvCell(h, o.delimiter, false)).join(o.delimiter));
  }
  for (const row of table.rows) {
    lines.push(row.map((v) => csvCell(v, o.delimiter, o.guardFormulas)).join(o.delimiter));
  }
  return lines.join(o.newline);
}

export const toCsv = (table, opts) => toDelimited(table, { delimiter: ",", ...(opts || {}) });
export const toTsv = (table, opts) => toDelimited(table, { delimiter: "\t", ...(opts || {}) });

// ── JSON / YAML ────────────────────────────────────────────────────────────

/** Emits real JSON types when a column is confidently numeric or boolean. */
function typedValue(raw, type) {
  const s = String(raw ?? "");
  if (s === "") return null;
  if (type === TYPES.NUMBER || type === TYPES.CURRENCY || type === TYPES.PERCENT) {
    const n = parseNumber(s);
    return n === null ? s : n;
  }
  if (type === TYPES.BOOLEAN) {
    const low = s.toLowerCase();
    if (["true", "yes", "y", "1", "✓", "✔"].includes(low)) return true;
    if (["false", "no", "n", "0", "✗", "✘"].includes(low)) return false;
  }
  return s;
}

/**
 * Builds a record keyed by header name.
 *
 * The null prototype is not decoration. On a normal object literal,
 * `obj["__proto__"] = "x"` goes through the inherited accessor rather than
 * creating a property, so a column genuinely named `__proto__` — which any
 * scraped page can produce — vanished from the export without a word. A
 * null-prototype object has no such accessor, so the key is stored like any
 * other, and JSON.stringify serialises it normally.
 */
function record(headers, row, types, typed) {
  const obj = Object.create(null);
  headers.forEach((h, i) => {
    obj[h] = typed ? typedValue(row[i], types[i]) : String(row[i] ?? "");
  });
  return obj;
}

export function toJson(table, opts) {
  const o = { typed: true, indent: 2, ...(opts || {}) };
  const types = table.types || inferColumnTypes(table);
  const out = table.rows.map((row) => record(table.headers, row, types, o.typed));
  return JSON.stringify(out, null, o.indent);
}

export function toJsonArrays(table, opts) {
  const o = { indent: 2, includeHeaders: true, ...(opts || {}) };
  const out = o.includeHeaders ? [table.headers, ...table.rows] : table.rows;
  return JSON.stringify(out, null, o.indent);
}

/** Newline-delimited JSON: one record per line, no wrapping array. */
export function toJsonLines(table) {
  const types = table.types || inferColumnTypes(table);
  return (
    table.rows
      .map((row) => JSON.stringify(record(table.headers, row, types, true)))
      .join("\n") + "\n"
  );
}

// ── XML ────────────────────────────────────────────────────────────────────

/** Header text is arbitrary; XML tag names are not. */
function xmlTag(name, index) {
  let tag = String(name ?? "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[^A-Za-z_]+/, "");
  if (!tag) tag = `field_${index + 1}`;
  return tag;
}

export function toXml(table, opts) {
  const o = { root: "table", row: "row", indent: "  ", ...(opts || {}) };
  const types = table.types || inferColumnTypes(table);
  const tags = table.headers.map(xmlTag);

  const esc = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // Control characters are illegal in XML 1.0 and make parsers reject the file.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<${o.root}>`];
  for (const row of table.rows) {
    lines.push(`${o.indent}<${o.row}>`);
    tags.forEach((tag, i) => {
      const value = typedValue(row[i], types[i]);
      lines.push(`${o.indent}${o.indent}<${tag}>${esc(value === null ? "" : value)}</${tag}>`);
    });
    lines.push(`${o.indent}</${o.row}>`);
  }
  lines.push(`</${o.root}>`);
  return lines.join("\n") + "\n";
}

function yamlScalar(v) {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (s.includes("\n")) {
    return "|-\n" + s.split("\n").map((l) => "    " + l).join("\n");
  }
  if (/^[\s]|[\s]$|[:#\-?{}[\],&*!|>'"%@`]/.test(s) || /^(true|false|null|~|\d)/i.test(s)) {
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return s;
}

export function toYaml(table) {
  const types = table.types || inferColumnTypes(table);
  const lines = [];
  for (const row of table.rows) {
    lines.push("- " + table.headers.map((h, i) => {
      const value = yamlScalar(typedValue(row[i], types[i]));
      return `${/^[\w.-]+$/.test(h) ? h : `'${h.replace(/'/g, "''")}'`}: ${value}`;
    }).join("\n  "));
  }
  return lines.join("\n") + "\n";
}

// ── Markdown ───────────────────────────────────────────────────────────────

/**
 * GitHub-flavoured Markdown, padded so the source is readable too.
 *
 * Numeric columns get right alignment, which is what a reader expects and what
 * every renderer honours.
 */
export function toMarkdown(table, opts) {
  const o = { align: true, pad: true, ...(opts || {}) };
  const types = table.types || inferColumnTypes(table);

  const escape = (v) =>
    String(v ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, "<br>");

  const headers = table.headers.map(escape);
  const rows = table.rows.map((r) => r.map(escape));
  const cols = headers.length;

  const widths = headers.map((h, c) => {
    let w = h.length;
    for (const r of rows) w = Math.max(w, (r[c] ?? "").length);
    return o.pad ? Math.min(Math.max(w, 3), 60) : 3;
  });

  const rightAligned = types.map((t) => [TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(t));

  const padCell = (v, c) => {
    const s = v ?? "";
    if (!o.pad) return s;
    return rightAligned[c] ? s.padStart(widths[c]) : s.padEnd(widths[c]);
  };

  const line = (cells) => "| " + cells.join(" | ") + " |";

  const out = [line(headers.map(padCell))];
  out.push(
    "| " +
      widths
        .map((w, c) => {
          const dashes = "-".repeat(Math.max(3, w));
          if (!o.align) return dashes;
          return rightAligned[c] ? dashes.slice(0, -1) + ":" : dashes;
        })
        .join(" | ") +
      " |"
  );
  for (const r of rows) {
    out.push(line(Array.from({ length: cols }, (_, c) => padCell(r[c] ?? "", c))));
  }
  return out.join("\n") + "\n";
}

// ── HTML ───────────────────────────────────────────────────────────────────

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function toHtml(table, opts) {
  const o = { full: true, styled: true, ...(opts || {}) };
  const head = `<thead>\n<tr>${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>\n</thead>`;
  const body =
    "<tbody>\n" +
    table.rows.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("\n") +
    "\n</tbody>";
  const caption = table.caption ? `<caption>${escapeHtml(table.caption)}</caption>\n` : "";
  const tableHtml = `<table>\n${caption}${head}\n${body}\n</table>`;

  if (!o.full) return tableHtml;

  const style = o.styled
    ? `<style>
table{border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px}
caption{text-align:left;font-weight:600;padding:8px 0}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}
th{background:#f6f8fa;font-weight:600}
tr:nth-child(even) td{background:#fafbfc}
</style>\n`
    : "";

  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(table.caption || "Table")}</title>
${style}${tableHtml}
`;
}

// ── SQL ────────────────────────────────────────────────────────────────────

function sqlIdent(name, dialect) {
  const clean = String(name).replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "col";
  const safe = /^\d/.test(clean) ? "c_" + clean : clean;
  if (dialect === "mysql") return "`" + safe + "`";
  return '"' + safe + '"';
}

function sqlType(type, dialect) {
  switch (type) {
    case TYPES.NUMBER:
    case TYPES.CURRENCY:
    case TYPES.PERCENT:
      return dialect === "sqlite" ? "REAL" : "NUMERIC";
    case TYPES.BOOLEAN:
      return dialect === "mysql" ? "TINYINT(1)" : "BOOLEAN";
    case TYPES.DATE:
      return "DATE";
    default:
      return dialect === "mysql" ? "TEXT" : "TEXT";
  }
}

export function toSql(table, opts) {
  const o = { tableName: "grabbed_table", dialect: "postgres", batchSize: 500, ...(opts || {}) };
  const types = table.types || inferColumnTypes(table);
  const cols = table.headers.map((h) => sqlIdent(h, o.dialect));
  const name = sqlIdent(o.tableName, o.dialect);

  const lines = [];
  lines.push(`CREATE TABLE ${name} (`);
  lines.push(cols.map((c, i) => `  ${c} ${sqlType(types[i], o.dialect)}`).join(",\n"));
  lines.push(");");
  lines.push("");

  const literal = (raw, type) => {
    const s = String(raw ?? "");
    if (s === "") return "NULL";
    if ([TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(type)) {
      const n = parseNumber(s);
      if (n !== null) return String(n);
    }
    if (type === TYPES.BOOLEAN) {
      const low = s.toLowerCase();
      if (["true", "yes", "y", "1"].includes(low)) return o.dialect === "mysql" ? "1" : "TRUE";
      if (["false", "no", "n", "0"].includes(low)) return o.dialect === "mysql" ? "0" : "FALSE";
    }
    return "'" + s.replace(/'/g, "''") + "'";
  };

  for (let i = 0; i < table.rows.length; i += o.batchSize) {
    const batch = table.rows.slice(i, i + o.batchSize);
    lines.push(`INSERT INTO ${name} (${cols.join(", ")}) VALUES`);
    lines.push(
      batch
        .map((row) => "  (" + table.headers.map((_, c) => literal(row[c], types[c])).join(", ") + ")")
        .join(",\n") + ";"
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ── LaTeX / plain text ─────────────────────────────────────────────────────

export function toLatex(table) {
  const types = table.types || inferColumnTypes(table);
  const spec = types.map((t) => ([TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(t) ? "r" : "l")).join("");
  const esc = (v) =>
    String(v ?? "")
      .replace(/\\/g, "\\textbackslash{}")
      .replace(/([&%$#_{}])/g, "\\$1")
      .replace(/~/g, "\\textasciitilde{}")
      .replace(/\^/g, "\\textasciicircum{}")
      .replace(/\n/g, " ");

  const out = ["\\begin{tabular}{" + spec + "}", "\\hline"];
  out.push(table.headers.map((h) => "\\textbf{" + esc(h) + "}").join(" & ") + " \\\\");
  out.push("\\hline");
  for (const r of table.rows) out.push(r.map(esc).join(" & ") + " \\\\");
  out.push("\\hline", "\\end{tabular}");
  return out.join("\n");
}

export function toText(table) {
  const types = table.types || inferColumnTypes(table);
  const all = [table.headers, ...table.rows];
  const cols = table.headers.length;
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.min(60, all.reduce((w, r) => Math.max(w, String(r[c] ?? "").replace(/\n/g, " ").length), 0))
  );
  const right = types.map((t) => [TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(t));

  const fmt = (r) =>
    r
      .map((v, c) => {
        const s = String(v ?? "").replace(/\n/g, " ").slice(0, widths[c]);
        return right[c] ? s.padStart(widths[c]) : s.padEnd(widths[c]);
      })
      .join("  ")
      .trimEnd();

  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [fmt(table.headers), rule, ...table.rows.map(fmt)].join("\n") + "\n";
}

// ── XLSX ───────────────────────────────────────────────────────────────────

const xmlEscape = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters are illegal in XML 1.0 and make Excel refuse the file.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

function colName(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Builds a real .xlsx.
 *
 * Numeric cells are written as `t="n"`, which is the entire reason to prefer
 * this over CSV: the spreadsheet opens with numbers already numeric, so sums
 * and charts work without a re-import dance.
 */
export function toXlsx(table, opts) {
  const o = { sheetName: "Sheet1", freezeHeader: true, ...(opts || {}) };
  const types = table.types || inferColumnTypes(table);

  const rowsXml = [];
  const headerCells = table.headers
    .map((h, c) => `<c r="${colName(c)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEscape(h)}</t></is></c>`)
    .join("");
  rowsXml.push(`<row r="1">${headerCells}</row>`);

  table.rows.forEach((row, r) => {
    const rowNum = r + 2;
    const cells = row
      .map((raw, c) => {
        const ref = `${colName(c)}${rowNum}`;
        const s = String(raw ?? "");
        if (s === "") return "";
        const isNumeric = [TYPES.NUMBER, TYPES.CURRENCY, TYPES.PERCENT].includes(types[c]);
        if (isNumeric) {
          const n = parseNumber(s);
          if (n !== null) return `<c r="${ref}" t="n"><v>${n}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`;
      })
      .join("");
    rowsXml.push(`<row r="${rowNum}">${cells}</row>`);
  });

  const widths = table.headers
    .map((h, c) => {
      let w = String(h).length;
      for (const r of table.rows) w = Math.max(w, String(r[c] ?? "").length);
      return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, Math.max(8, w + 2))}" customWidth="1"/>`;
    })
    .join("");

  const freeze = o.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : "";

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<cols>${widths}</cols><sheetData>${rowsXml.join("")}</sheetData></worksheet>`;

  const safeSheetName = String(o.sheetName).replace(/[\\/*?:[\]]/g, "").slice(0, 31) || "Sheet1";

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  // Two styles: default, and a bold one for the header row.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

  return zipStore([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: wbRels },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}

// ── Minimal ZIP writer (STORED entries) ────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Packs files into an uncompressed ZIP and returns a Blob. */
function zipStore(entries) {
  const enc = new TextEncoder();
  const files = entries.map((e) => ({ name: e.name, bytes: enc.encode(e.data) }));

  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;

    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),               // time, date
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, f.bytes);

    central.push({ crc, size, nameBytes, offset });
    offset += local.length + nameBytes.length + size;
  }

  const centralChunks = [];
  let centralSize = 0;
  for (const c of central) {
    const header = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size),
      ...u16(c.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(c.offset),
    ];
    centralChunks.push(new Uint8Array(header), c.nameBytes);
    centralSize += header.length + c.nameBytes.length;
  }

  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);

  return new Blob([...chunks, ...centralChunks, end], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ── Dispatch ───────────────────────────────────────────────────────────────

/** Returns a string for text formats, or a Blob for xlsx. */
export function serialise(table, format, opts) {
  switch (format) {
    case "csv": return toCsv(table, opts);
    case "tsv": return toTsv(table, opts);
    case "json": return toJson(table, opts);
    case "json-arrays": return toJsonArrays(table, opts);
    case "jsonl": return toJsonLines(table, opts);
    case "xml": return toXml(table, opts);
    case "markdown": return toMarkdown(table, opts);
    case "html": return toHtml(table, opts);
    case "sql": return toSql(table, opts);
    case "yaml": return toYaml(table, opts);
    case "latex": return toLatex(table, opts);
    case "text": return toText(table, opts);
    case "xlsx": return toXlsx(table, opts);
    default: return toCsv(table, opts);
  }
}

export function formatMeta(format) {
  return FORMATS.find((f) => f.id === format) || FORMATS[0];
}

/** Builds a filename from the page title or caption. */
export function suggestFilename(table, format, context) {
  const meta = formatMeta(format);
  const base =
    (table.caption || context?.title || context?.host || "table")
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "table";
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}-${stamp}.${meta.ext}`;
}

/**
 * Writes to the clipboard.
 *
 * Text formats also go on as `text/html` when they are tabular, because Sheets
 * and Excel paste an HTML table into real cells while plain text lands in one.
 */
export async function copyToClipboard(table, format, opts) {
  const payload = serialise(table, format, opts);
  if (payload instanceof Blob) throw new Error("Binary formats cannot be copied; download instead.");

  const richFormats = ["csv", "tsv", "text"];
  if (richFormats.includes(format) && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const html = toHtml(table, { full: false, styled: false });
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch {
      /* fall through to plain text */
    }
  }

  await navigator.clipboard.writeText(payload);
  return true;
}
