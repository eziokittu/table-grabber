/**
 * Pre-flight checks. Run `npm test` before loading the extension or zipping it.
 *
 * Chrome fails silently for most of these — a bad path in the manifest or a
 * typo'd import just makes the popup blank — so they are worth asserting.
 *
 * The second half runs the extraction and export engines against fixtures in a
 * fake DOM, because those are the parts where a regression produces plausible
 * but wrong output rather than a visible crash.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let checks = 0;

const ok = (label) => { checks++; console.log("  ✓ " + label); };
const fail = (label, detail) => {
  checks++; failures++;
  console.log("  ✗ " + label);
  if (detail) console.log("      " + String(detail).split("\n").join("\n      "));
};
const section = (t) => console.log("\n" + t);

function walk(dir, exts) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

// ── Manifest ───────────────────────────────────────────────────────────────
section("manifest.json");

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  ok("parses as JSON");
} catch (e) {
  fail("parses as JSON", e.message);
}

if (manifest) {
  manifest.manifest_version === 3 ? ok("is Manifest V3") : fail("is Manifest V3", manifest.manifest_version);

  /^\d+\.\d+\.\d+$/.test(manifest.version)
    ? ok(`version is x.y.z (${manifest.version})`)
    : fail("version is x.y.z", manifest.version);

  // The store truncates hard at these lengths.
  manifest.name.length <= 75
    ? ok(`name fits the 75-character store limit (${manifest.name.length})`)
    : fail("name fits the 75-character store limit", `${manifest.name.length} chars`);

  manifest.description.length <= 132
    ? ok(`description fits the 132-character limit (${manifest.description.length})`)
    : fail("description fits the 132-character limit", `${manifest.description.length} chars`);

  // Every file the manifest names must exist.
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...Object.values(manifest.action?.default_icon || {}),
    ...Object.values(manifest.icons || {}),
  ].filter(Boolean);

  let missing = referenced.filter((p) => !existsSync(join(ROOT, p)));
  missing.length === 0
    ? ok(`all ${referenced.length} referenced files exist`)
    : fail("all referenced files exist", missing.join("\n"));

  // The content script is injected programmatically, so it is not in the
  // manifest — but the service worker names it and it must still be there.
  existsSync(join(ROOT, "src/content/content.js"))
    ? ok("content script exists")
    : fail("content script exists", "src/content/content.js");

  // Shared modules are dynamically imported by the content script, which only
  // works if they are web-accessible.
  const war = manifest.web_accessible_resources?.[0]?.resources || [];
  war.some((r) => r.startsWith("src/shared/"))
    ? ok("shared modules are web-accessible")
    : fail("shared modules are web-accessible", "content script imports would 404");

  // Permission hygiene: this extension promises no host access.
  !manifest.host_permissions?.length
    ? ok("declares no host permissions")
    : fail("declares no host permissions", JSON.stringify(manifest.host_permissions));
}

// ── Source hygiene ─────────────────────────────────────────────────────────
section("source");

const jsFiles = walk(join(ROOT, "src"), [".js"]);
ok(`found ${jsFiles.length} JavaScript files`);

// Relative imports must resolve — a typo here blanks the whole page silently.
let badImports = [];
for (const file of jsFiles) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const target = resolve(dirname(file), m[1]);
    if (!existsSync(target)) badImports.push(`${file.replace(ROOT, ".")} -> ${m[1]}`);
  }
}
badImports.length === 0 ? ok("all relative imports resolve") : fail("all relative imports resolve", badImports.join("\n"));

// A stray network call would break the core privacy promise, so it is asserted
// rather than trusted. chrome.runtime.getURL is local and allowed.
const networkCalls = [];
for (const file of jsFiles) {
  const src = readFileSync(file, "utf8");
  for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /navigator\.sendBeacon/]) {
    if (pattern.test(src)) networkCalls.push(`${file.replace(ROOT, ".")}: ${pattern}`);
  }
}
networkCalls.length === 0
  ? ok("no network calls anywhere in the extension")
  : fail("no network calls anywhere in the extension", networkCalls.join("\n"));

// HTML files must reference files that exist.
for (const html of walk(join(ROOT, "src"), [".html"])) {
  const src = readFileSync(html, "utf8");
  const refs = [...src.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
  const bad = refs.filter((r) => !/^https?:/.test(r) && !existsSync(resolve(dirname(html), r)));
  bad.length === 0
    ? ok(`${html.replace(ROOT, ".")} references resolve`)
    : fail(`${html.replace(ROOT, ".")} references resolve`, bad.join(", "));
}

// ── Engine tests ───────────────────────────────────────────────────────────
section("engine");

/**
 * A DOM small enough to fit here and real enough to test against.
 *
 * Bringing in jsdom would mean the repo could no longer be cloned and tested
 * with zero installs, which is a property worth protecting for a tool whose
 * pitch is "read the source yourself".
 */
class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.childNodes = [];
    this.nodeType = 1;
    this.style = {};
    // Iterable, like the real DOMTokenList — the div-grid signature spreads it.
    const classes = (attrs.class || "").split(/\s+/).filter(Boolean);
    this.classList = Object.assign(classes.slice(), {
      contains: (c) => classes.includes(c),
    });
    for (const c of children) this.append(c);
  }
  append(child) {
    const node = typeof child === "string" ? { nodeType: 3, nodeValue: child } : child;
    node.parentElement = this;
    this.childNodes.push(node);
    return this;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  getAttribute(n) { return this.attrs[n] ?? null; }
  hasAttribute(n) { return n in this.attrs; }
  get textContent() {
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join("");
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
}

const text = (s) => s;
const td = (v, attrs = {}) => new El("td", attrs, [text(v)]);
const th = (v, attrs = {}) => new El("th", attrs, [text(v)]);
const tr = (cells) => new El("tr", {}, cells);

// pathToFileURL matters on Windows: a bare "C:\..." is not a valid ESM specifier.
const mod = (p) => import(pathToFileURL(join(ROOT, p)).href);

const { extractTable, SPAN_POLICY } = await mod("src/shared/extract.js");
const { applyState, parseNumber, inferColumnTypes, TYPES } = await mod("src/shared/transform.js");
const { toCsv, toTsv, toMarkdown, toJson, toSql, suggestFilename: suggestFilenameFn } = await mod("src/shared/export.js");

// A table with a colspan header and a rowspan body cell — the shape that
// misaligns every naive scraper.
const spanTable = new El("table", {}, [
  new El("thead", {}, [
    tr([th("Region", { colspan: "2" }), th("Total")]),
    tr([th("Country"), th("City"), th("Sales")]),
  ]),
  new El("tbody", {}, [
    tr([td("UK", { rowspan: "2" }), td("London"), td("$1,200")]),
    tr([td("Leeds"), td("$800")]),
    tr([td("France"), td("Paris"), td("$2,400")]),
  ]),
]);

{
  const t = extractTable(spanTable, { spanPolicy: SPAN_POLICY.FILL });
  t.colCount === 3 ? ok("colspan header keeps 3 columns") : fail("colspan header keeps 3 columns", t.colCount);
  t.rowCount === 3 ? ok("rowspan body keeps 3 rows") : fail("rowspan body keeps 3 rows", t.rowCount);

  const leeds = t.rows[1];
  leeds[0] === "UK"
    ? ok("rowspan fills the covered cell (Leeds row starts with UK)")
    : fail("rowspan fills the covered cell", JSON.stringify(leeds));
  leeds[1] === "Leeds" && leeds[2] === "$800"
    ? ok("columns stay aligned under a rowspan")
    : fail("columns stay aligned under a rowspan", JSON.stringify(leeds));

  t.headers[0] === "Region – Country"
    ? ok("stacked headers merge group and column")
    : fail("stacked headers merge group and column", t.headers[0]);
}

{
  const t = extractTable(spanTable, { spanPolicy: SPAN_POLICY.BLANK });
  t.rows[1][0] === ""
    ? ok("blank span policy leaves covered cells empty")
    : fail("blank span policy leaves covered cells empty", JSON.stringify(t.rows[1]));
}

// Number parsing across the conventions people actually paste.
{
  const cases = [
    ["1,234.56", 1234.56], ["1.234,56", 1234.56], ["$1,200", 1200],
    ["(1,234)", -1234], ["45%", 45], ["-3.5", -3.5], ["1 234,5", 1234.5],
    ["abc", null], ["", null], ["12", 12],
  ];
  const bad = cases.filter(([input, want]) => parseNumber(input) !== want);
  bad.length === 0
    ? ok(`parseNumber handles ${cases.length} formats`)
    : fail("parseNumber handles all formats", bad.map(([i, w]) => `${i} -> ${parseNumber(i)}, want ${w}`).join("\n"));
}

// Type inference must survive a stray non-numeric value.
{
  const table = {
    headers: ["Name", "Sales", "Share"],
    rows: [["A", "$1,200", "45%"], ["B", "$800", "30%"], ["C", "N/A", "25%"]],
  };
  const types = inferColumnTypes(table);
  types[0] === TYPES.TEXT ? ok("text column typed as text") : fail("text column typed as text", types[0]);
  types[1] === TYPES.CURRENCY ? ok("currency column survives one N/A") : fail("currency column survives one N/A", types[1]);
  types[2] === TYPES.PERCENT ? ok("percent column typed as percent") : fail("percent column typed as percent", types[2]);
}

// CSV quoting and the formula guard.
{
  const table = { headers: ["a", "b"], rows: [['say "hi"', "x,y"], ["=1+1", "plain"]] };
  const csv = toCsv(table);
  csv.includes('"say ""hi"""') ? ok("CSV doubles embedded quotes") : fail("CSV doubles embedded quotes", csv);
  csv.includes('"x,y"') ? ok("CSV quotes values containing the delimiter") : fail("CSV quotes delimiters", csv);
  csv.includes('"\t=1+1"') || csv.includes("\t=1+1")
    ? ok("CSV neutralises leading-formula injection")
    : fail("CSV neutralises leading-formula injection", csv);
}

// Markdown escaping and alignment.
{
  const table = { headers: ["a|b", "n"], rows: [["x", "5"]], types: [TYPES.TEXT, TYPES.NUMBER] };
  const md = toMarkdown(table);
  md.includes("a\\|b") ? ok("Markdown escapes pipes") : fail("Markdown escapes pipes", md);
  md.includes("-:") ? ok("Markdown right-aligns numeric columns") : fail("Markdown right-aligns numeric columns", md);
}

// JSON emits real numbers, not numeric strings.
{
  const table = { headers: ["n"], rows: [["1,234"]], types: [TYPES.NUMBER] };
  const parsed = JSON.parse(toJson(table));
  parsed[0].n === 1234 ? ok("JSON emits typed numbers") : fail("JSON emits typed numbers", JSON.stringify(parsed));
}

// SQL identifier sanitising and literal escaping.
{
  const table = { headers: ["First Name", "n"], rows: [["O'Brien", "5"]], types: [TYPES.TEXT, TYPES.NUMBER] };
  const sql = toSql(table, { dialect: "postgres", tableName: "t" });
  sql.includes('"first_name"') ? ok("SQL sanitises identifiers") : fail("SQL sanitises identifiers", sql);
  sql.includes("'O''Brien'") ? ok("SQL escapes quotes in literals") : fail("SQL escapes quotes", sql);
}

// Reshaping: hide, rename, filter, dedupe.
{
  const table = { headers: ["a", "b", "c"], rows: [["1", "x", "p"], ["2", "y", "q"], ["1", "x", "p"]] };
  const out = applyState(table, { hiddenColumns: [2], renames: { 0: "id" }, dedupe: true, dropEmpty: false });
  out.colCount === 2 ? ok("hidden columns are dropped") : fail("hidden columns are dropped", out.colCount);
  out.headers[0] === "id" ? ok("renames apply to the right column") : fail("renames apply to the right column", out.headers.join(","));
  out.rowCount === 2 ? ok("duplicate rows are removed") : fail("duplicate rows are removed", out.rowCount);

  const filtered = applyState(table, { search: "y", dropEmpty: false });
  filtered.rowCount === 1 ? ok("search filters rows") : fail("search filters rows", filtered.rowCount);
}

// Sorting a currency column must sort numerically, not lexically.
{
  const table = { headers: ["v"], rows: [["$9"], ["$100"], ["$20"]] };
  const out = applyState(table, { sort: { column: 0, direction: "asc" }, dropEmpty: false });
  out.rows[0][0] === "$9" && out.rows[2][0] === "$100"
    ? ok("numeric sort beats lexical on currency")
    : fail("numeric sort beats lexical on currency", JSON.stringify(out.rows));
}

// ── Importers ──────────────────────────────────────────────────────────────
section("importers");

const { parseText, detectFormat, sniffDelimiter, parseDelimited, parseJson, parseMarkdown } =
  await mod("src/shared/import.js");
const { toJsonLines, toXml } = await mod("src/shared/export.js");
const { columnStats, applyHeaderCase, HEADER_CASE } = await mod("src/shared/transform.js");

{
  const cases = [
    ["a,b\n1,2", "csv"],
    ["a\tb\n1\t2", "tsv"],
    ['[{"a":1}]', "json"],
    ['{"a":1}\n{"a":2}', "jsonl"],
    ["| a | b |\n|---|---|\n| 1 | 2 |", "markdown"],
    ["<table><tr><td>1</td></tr></table>", "html"],
  ];
  const bad = cases.filter(([input, want]) => detectFormat(input) !== want);
  bad.length === 0
    ? ok(`format detection handles ${cases.length} inputs`)
    : fail("format detection", bad.map(([i, w]) => `${JSON.stringify(i.slice(0, 20))} -> ${detectFormat(i)}, want ${w}`).join("\n"));
}

{
  // Quoted fields containing the delimiter, doubled quotes and a raw newline —
  // the three things every split()-based CSV reader gets wrong.
  const csv = 'name,note\n"Smith, John","He said ""hi"""\n"multi\nline",plain';
  const t = parseDelimited(csv);
  t.colCount === 2 ? ok("CSV keeps 2 columns despite a delimiter inside quotes") : fail("CSV column count", t.colCount);
  t.rowCount === 2 ? ok("CSV keeps 2 rows despite a newline inside quotes") : fail("CSV row count", t.rowCount);
  t.rows[0][0] === "Smith, John" ? ok("CSV preserves a quoted delimiter") : fail("quoted delimiter", JSON.stringify(t.rows[0][0]));
  t.rows[0][1] === 'He said "hi"' ? ok("CSV unescapes doubled quotes") : fail("doubled quotes", JSON.stringify(t.rows[0][1]));
  t.rows[1][0] === "multi\nline" ? ok("CSV preserves a newline inside quotes") : fail("quoted newline", JSON.stringify(t.rows[1][0]));
  t.headers[0] === "name" ? ok("CSV detects the header row") : fail("CSV header row", JSON.stringify(t.headers));
}

{
  const semi = "a;b;c\n1;2;3\n4;5;6";
  sniffDelimiter(semi) === ";" ? ok("delimiter sniffing finds semicolons") : fail("semicolon sniffing", sniffDelimiter(semi));
  // Prose with many commas but a consistent tab structure must not pick comma.
  const tabbed = "title\tnote\nA, B, C\tone, two\nD, E, F\tthree, four";
  sniffDelimiter(tabbed) === "\t" ? ok("delimiter sniffing prefers consistency over frequency") : fail("tab sniffing", JSON.stringify(sniffDelimiter(tabbed)));
}

{
  // Records with differing keys must still line up.
  const t = parseJson('[{"a":1,"b":2},{"b":3,"c":4}]');
  t.headers.join(",") === "a,b,c" ? ok("JSON unions keys across records") : fail("JSON key union", JSON.stringify(t.headers));
  t.rows[1][0] === "" ? ok("JSON leaves a missing field empty") : fail("JSON missing field", JSON.stringify(t.rows[1]));

  const wrapped = parseJson('{"data":[{"x":1},{"x":2}]}');
  wrapped.rowCount === 2 ? ok("JSON unwraps a {data:[...]} envelope") : fail("JSON envelope", wrapped.rowCount);
}

{
  const md = "| Name | Qty |\n| --- | ---: |\n| Bolt \\| big | 5 |\n| Nut | 7 |";
  const t = parseMarkdown(md);
  t.rowCount === 2 ? ok("Markdown import reads 2 rows") : fail("markdown rows", t.rowCount);
  t.headers[0] === "Name" ? ok("Markdown import reads the header row") : fail("markdown headers", JSON.stringify(t.headers));
  t.rows[0][0] === "Bolt | big" ? ok("Markdown import unescapes pipes") : fail("markdown escape", JSON.stringify(t.rows[0][0]));
}

{
  // The full round trip: every exporter's output should re-import to the same grid.
  const original = { headers: ["name", "qty"], rows: [["Bolt", "5"], ["Nut", "7"]] };
  for (const [format, text] of [
    ["csv", toCsv(original)],
    ["tsv", toTsv(original)],
    ["markdown", toMarkdown(original)],
    ["json", toJson(original)],
    ["jsonl", toJsonLines(original)],
  ]) {
    const back = parseText(text, format).table;
    const same =
      back.rowCount === 2 &&
      back.headers.join(",") === "name,qty" &&
      back.rows[0][0] === "Bolt" &&
      String(back.rows[1][1]) === "7";
    same ? ok(`${format} round-trips back to the same table`) : fail(`${format} round trip`, JSON.stringify(back));
  }
}

// ── New transforms ─────────────────────────────────────────────────────────
section("transforms");

{
  const cases = [
    ["First Name", HEADER_CASE.SNAKE, "first_name"],
    ["first_name", HEADER_CASE.CAMEL, "firstName"],
    ["FIRST NAME", HEADER_CASE.TITLE, "First Name"],
    ["totalSales2024", HEADER_CASE.SNAKE, "total_sales_2024"],
    ["Region – Country", HEADER_CASE.SNAKE, "region_country"],
  ];
  const bad = cases.filter(([input, style, want]) => applyHeaderCase(input, style) !== want);
  bad.length === 0
    ? ok(`header case conversion handles ${cases.length} shapes`)
    : fail("header case", bad.map(([i, s, w]) => `${i} (${s}) -> ${applyHeaderCase(i, s)}, want ${w}`).join("\n"));
}

{
  // Fill-down: a group label written once must reach the rest of its run.
  const table = { headers: ["region", "city"], rows: [["UK", "London"], ["", "Leeds"], ["FR", "Paris"], ["", "Lyon"]] };
  const out = applyState(table, { fillDown: true, dropEmpty: false });
  out.rows[1][0] === "UK" && out.rows[3][0] === "FR"
    ? ok("fill-down carries a group label down its run")
    : fail("fill-down", JSON.stringify(out.rows));
}

{
  const table = { headers: ["a", "b", "c"], rows: [["1", "2", "3"]] };
  const out = applyState(table, { columnOrder: [2, 0, 1], dropEmpty: false });
  out.headers.join(",") === "c,a,b" ? ok("column reorder applies") : fail("column reorder", out.headers.join(","));
  out.rows[0].join(",") === "3,1,2" ? ok("column reorder moves the data with the header") : fail("reorder data", out.rows[0].join(","));

  // A reorder that forgets a column must append it, never drop it.
  const partial = applyState(table, { columnOrder: [2], dropEmpty: false });
  partial.colCount === 3 ? ok("an incomplete reorder keeps every column") : fail("incomplete reorder", partial.colCount);
}

{
  const table = { headers: ["a", "b"], rows: [["x1", "y"], ["x2", "z"]] };
  const out = applyState(table, { replace: { find: "x", replaceWith: "Q" }, dropEmpty: false });
  out.rows[0][0] === "Q1" ? ok("find and replace rewrites cells") : fail("replace", JSON.stringify(out.rows));

  // A literal search must not be treated as a pattern.
  const dots = applyState({ headers: ["v"], rows: [["1.5"], ["125"]] }, { replace: { find: "1.5", replaceWith: "X" }, dropEmpty: false });
  dots.rows[0][0] === "X" && dots.rows[1][0] === "125"
    ? ok("literal replace does not match as a regex")
    : fail("literal replace", JSON.stringify(dots.rows));

  // An invalid regex must not blank the table.
  const broken = applyState(table, { replace: { find: "[", replaceWith: "", regex: true }, dropEmpty: false });
  broken.rowCount === 2 ? ok("an invalid regex leaves the data intact") : fail("invalid regex", broken.rowCount);
}

{
  const table = { headers: ["q1", "q2"], rows: [["1", "2"], ["3", "4"]] };
  const out = applyState(table, { transpose: true, dropEmpty: false });
  out.headers.join(",") === "q1,1,3" ? ok("transpose turns the first column into headers") : fail("transpose headers", out.headers.join(","));
  out.rows[0].join(",") === "q2,2,4" ? ok("transpose flips rows into columns") : fail("transpose rows", JSON.stringify(out.rows));
}

{
  const table = { headers: ["a"], rows: [["x"], ["y"], ["z"]] };
  applyState(table, { skipRows: 2, dropEmpty: false }).rowCount === 1
    ? ok("skipRows drops leading rows") : fail("skipRows");
}

{
  const stats = columnStats({ headers: ["n", "s"], rows: [["10", "a"], ["20", "a"], ["", "b"]] });
  stats[0].sum === 30 ? ok("column stats sum numerics") : fail("stats sum", stats[0].sum);
  stats[0].min === 10 && stats[0].max === 20 ? ok("column stats find min and max") : fail("stats min/max", JSON.stringify(stats[0]));
  stats[0].empty === 1 ? ok("column stats count empties") : fail("stats empty", stats[0].empty);
  stats[1].unique === 2 ? ok("column stats count distinct values") : fail("stats unique", stats[1].unique);
}

// ── New exporters ──────────────────────────────────────────────────────────
section("new exporters");

{
  const table = { headers: ["First Name", "n"], rows: [["A & B", "5"]], types: [TYPES.TEXT, TYPES.NUMBER] };
  const xml = toXml(table);
  xml.includes("<First_Name>") ? ok("XML sanitises header names into legal tags") : fail("xml tag", xml);
  xml.includes("A &amp; B") ? ok("XML escapes entities") : fail("xml escape", xml);

  const numericTag = toXml({ headers: ["2024"], rows: [["1"]], types: [TYPES.NUMBER] });
  numericTag.includes("<field_1>") ? ok("XML renames a tag that would start with a digit") : fail("xml numeric tag", numericTag);
}

{
  const lines = toJsonLines({ headers: ["a"], rows: [["1"], ["2"]], types: [TYPES.NUMBER] }).trim().split("\n");
  lines.length === 2 && JSON.parse(lines[0]).a === 1
    ? ok("JSON Lines writes one typed record per line")
    : fail("jsonl", JSON.stringify(lines));
}

// ── Security ───────────────────────────────────────────────────────────────
//
// Each of these was a real finding, confirmed by probing the shipped modules
// before it was fixed.
section("security");

{
  // A column named __proto__ used to vanish from JSON exports: on a normal
  // object literal the assignment goes through the inherited accessor instead
  // of creating a property. Silent data loss on any page that produces that
  // header.
  const table = { headers: ["__proto__", "safe"], rows: [["danger", "ok"]] };
  const parsed = JSON.parse(toJson(table));
  Object.prototype.hasOwnProperty.call(parsed[0], "__proto__") && parsed[0]["__proto__"] === "danger"
    ? ok("a __proto__ column survives JSON export")
    : fail("a __proto__ column survives JSON export", toJson(table));

  const line = JSON.parse(toJsonLines(table).trim());
  Object.prototype.hasOwnProperty.call(line, "__proto__")
    ? ok("a __proto__ column survives JSON Lines export")
    : fail("a __proto__ column survives JSON Lines export", toJsonLines(table));

  // And the export must not touch the real prototype on the way through.
  const sentinel = ({}).tgPolluted;
  toJson({ headers: ["__proto__"], rows: [['{"tgPolluted":1}']] });
  ({}).tgPolluted === sentinel
    ? ok("JSON export does not pollute Object.prototype")
    : fail("JSON export does not pollute Object.prototype");
}

{
  // Catastrophic backtracking. Before the guard, this pattern over 300 rows
  // never returned at all — the tab was gone. JavaScript cannot interrupt a
  // running regex, so the pattern has to be refused before it is used.
  const { compilePattern } = await mod("src/shared/transform.js");

  const evil = compilePattern("(a+)+$", true, false);
  evil.pattern === null && /freeze|backtrack/i.test(evil.error || "")
    ? ok("a catastrophic regex is refused with an explanation")
    : fail("a catastrophic regex is refused", JSON.stringify(evil.error));

  const alsoEvil = compilePattern("(a|a)*$", true, false);
  alsoEvil.pattern === null
    ? ok("an alternation-overlap regex is refused")
    : fail("an alternation-overlap regex is refused");

  const fine = compilePattern("^\\d{4}-\\d{2}-\\d{2}$", true, false);
  fine.pattern !== null && fine.error === null
    ? ok("an ordinary regex is still accepted")
    : fail("an ordinary regex is still accepted", JSON.stringify(fine.error));

  const broken = compilePattern("[", true, false);
  broken.pattern === null && /valid/i.test(broken.error || "")
    ? ok("an invalid regex reports why")
    : fail("an invalid regex reports why", JSON.stringify(broken.error));

  // The whole point: applying it must now finish quickly rather than hang.
  const rows = Array.from({ length: 300 }, () => ["a".repeat(40) + "!"]);
  const started = Date.now();
  const out = applyState({ headers: ["v"], rows }, {
    replace: { find: "(a+)+$", replaceWith: "x", regex: true },
    dropEmpty: false,
  });
  const ms = Date.now() - started;
  ms < 2000
    ? ok(`a catastrophic pattern no longer hangs the table (${ms}ms)`)
    : fail("a catastrophic pattern no longer hangs the table", ms + "ms");
  out.patternError
    ? ok("the refused pattern is reported back to the UI")
    : fail("the refused pattern is reported back to the UI");
  out.rowCount === 300
    ? ok("data is left untouched when a pattern is refused")
    : fail("data is left untouched when a pattern is refused", out.rowCount);
}

{
  // A literal search must never be interpreted as a pattern, however it looks.
  const { compilePattern } = await mod("src/shared/transform.js");
  const literal = compilePattern("(a+)+$", false, false);
  literal.pattern !== null && !literal.pattern.test("aaaa")
    ? ok("a literal search of regex-looking text is not compiled as a regex")
    : fail("literal search escaping", String(literal.pattern));
}

{
  // Exports must not be able to smuggle markup or formulas out.
  const xml = toXml({ headers: ["a><script>x</script><b"], rows: [["</a><script>y</script>"]] });
  !xml.includes("<script>")
    ? ok("XML escapes both tag names and values")
    : fail("XML escapes both tag names and values", xml);

  const csv = toCsv({ headers: ["v"], rows: [["=cmd|'/c calc'!A1"], ["@SUM(A1)"], ["+1+1"]] });
  csv.includes("\t=") && csv.includes("\t@") && csv.includes("\t+")
    ? ok("every dangerous CSV leader is neutralised")
    : fail("CSV formula guard", csv);
}

{
  // A caption is attacker-controlled and becomes a download filename.
  const name = suggestFilenameFn(
    { headers: ["a"], rows: [["1"]], caption: "../../../Windows/System32/evil" },
    "csv",
    {}
  );
  !name.includes("/") && !name.includes("\\") && !name.includes("..")
    ? ok("a hostile caption cannot escape the download filename")
    : fail("filename sanitising", name);
}

// ── Regressions found by the browser harness ───────────────────────────────
//
// Each of these shipped a bug that only a real page exposed. They are asserted
// here too so the next break costs a second, not a Chrome launch.
section("regressions");

{
  // A div grid whose header row carries an extra class. Anchoring the "rows
  // look alike" test on children[0] made the header the reference shape, so
  // every body row was judged an outlier and the grid was never found.
  // findDivGrids is internal, so it is exercised through findTables.
  const row = (cls, cells) => new El("div", cls ? { class: cls } : {}, cells.map((c) => new El("span", {}, [text(c)])));
  const grid = new El("div", { class: "grid" }, [
    row("hd", ["Name", "Role", "Since"]),
    row(null, ["Ada", "Engineer", "2019"]),
    row(null, ["Grace", "Architect", "2020"]),
    row(null, ["Alan", "Researcher", "2021"]),
  ]);
  const root = new El("body", {}, [grid]);
  // Minimal querySelectorAll good enough for the div-grid path.
  root.querySelectorAll = (sel) => (sel.includes("div") ? [grid] : []);
  grid.querySelectorAll = () => [];

  const { findTables } = await mod("src/shared/extract.js");
  const found = findTables(root, {});
  const g = found.find((f) => f.kind === "grid");
  g ? ok("div grid with a differently-classed header row is found") : fail("div grid with a differently-classed header row is found", JSON.stringify(found.map((f) => f.kind)));
  if (g) {
    g.table.rowCount === 3
      ? ok("div grid header row is not counted as data")
      : fail("div grid header row is not counted as data", g.table.rowCount);
    g.table.headers[0] === "Name"
      ? ok("div grid header text is used for column names")
      : fail("div grid header text is used", JSON.stringify(g.table.headers));
  }
}

{
  // Real pagination controls read "Next ›", not "next". The anchored pattern
  // matched neither the word nor the arrow when they appeared together.
  const { __testables } = await mod("src/shared/capture.js");
  if (!__testables) {
    fail("capture.js exposes its label matcher for testing", "no __testables export");
  } else {
    const cases = [
      ["Next ›", true], ["next", true], ["Next page →", true], ["›", true],
      ["»", true], ["Load more…", true], ["Show more", true],
      ["Previous", false], ["‹ Prev", false], ["Page 2 of 3", false], ["", false],
    ];
    const bad = cases.filter(([input, want]) => __testables.looksLikeNext(input) !== want);
    bad.length === 0
      ? ok(`next-control matcher handles ${cases.length} real-world labels`)
      : fail("next-control matcher handles real-world labels", bad.map(([i, w]) => `${JSON.stringify(i)} -> ${__testables.looksLikeNext(i)}, want ${w}`).join("\n"));
  }
}

// ── Result ─────────────────────────────────────────────────────────────────
console.log("\n" + (failures === 0 ? `All ${checks} checks passed.` : `${failures} of ${checks} checks FAILED.`));
process.exit(failures === 0 ? 0 : 1);
