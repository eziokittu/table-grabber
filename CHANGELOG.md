# Changelog

All notable changes to Table Grabber are recorded here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-08-14

First release.

### Added — input

- **Importers** for CSV, TSV, JSON, JSON Lines and Markdown tables, with format
  detection and delimiter sniffing that scores candidates on consistency rather
  than raw frequency. Combined with the exporters this converts in every
  direction, not just out of a web page.
- RFC 4180 CSV parsing as a character-level state machine, so quoted delimiters,
  doubled quotes and newlines inside fields survive.

### Added — reshaping

- Transpose, fill-down into blank cells, find and replace (literal or regex),
  whitespace trimming, leading-row skip and row caps.
- Column reordering, and header rewriting to `snake_case`, `camelCase`,
  `Title Case`, upper or lower.
- Per-column statistics: type, fill rate, distinct count, and min/max/sum/mean
  for numeric columns.
- Editor preferences persist between grabs.

### Added

- **Table discovery** across real `<table>` elements, open shadow roots and
  same-origin iframes.
- **Div-grid detection** — tables built from plain boxes are found by repeating
  structure rather than hardcoded library class names.
- **Correct `rowspan` / `colspan` handling.** Cells are laid onto a coordinate
  grid before reading, so merged cells no longer shift every column after them.
  Three fill policies: repeat, blank, or `↳` marker.
- **Stacked multi-row headers**, joined as `Group – Column`.
- **Deep capture** for virtualised grids (scroll and accumulate, keyed on the
  grid's own row indices where available) and for paginated tables (walk every
  page and merge).
- **Thirteen export formats**: CSV, TSV, Excel `.xlsx`, JSON (objects), JSON
  (arrays), JSON Lines, XML, Markdown, HTML, SQL, YAML, LaTeX and plain text.
  All free, no row cap.
- **Real `.xlsx` writer** with numeric cells, frozen header and sized columns,
  built on a dependency-free ZIP writer.
- **Column typing** — number, currency, percent, date, boolean, URL — tolerant
  of placeholder values such as `N/A`.
- **Value cleaning**: currency and thousands separators stripped for
  spreadsheets, optional ISO dates, optional percents as fractions.
- **Editor**: rename/hide columns, filter rows, numeric-aware sort, de-duplicate,
  drop empty rows and columns, live preview.
- **Picker overlay** for pointing at a specific table, drawn inside a shadow root
  so hostile page CSS cannot affect it.
- **Quick copy** as CSV, TSV or Markdown straight from the popup.
- Clipboard writes carry `text/html` alongside plain text, so pastes into Sheets
  and Excel land in real cells.
- CSV export neutralises leading-`=` formula injection.
- Context-menu entry and `Alt+Shift+T` shortcut.

### Security & privacy

- Ships with **no host permissions**; the content script is injected only on
  explicit invocation.
- **No network code.** Enforced by a build check that fails if `fetch`,
  `XMLHttpRequest`, `WebSocket` or `sendBeacon` appears anywhere in `src/`.
- Grabbed tables are held in `chrome.storage.session` (memory only) and deleted
  as soon as the editor reads them.
