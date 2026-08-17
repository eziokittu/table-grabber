# Changelog

All notable changes to Table Grabber are recorded here.
This project follows [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-08-17

A rebuild of everything you touch. The engine underneath is the same one, with
its sorting and scroll capture repaired; the picker, the popup, the editor and
the look are new.

### Fixed — the picker, which did not work

- **Picking a table now does something.** The popup asked the page to start the
  picker and then waited for the answer — but the popup closes the instant you
  click the page, so every pick was resolved into a window that no longer
  existed. The button looked dead because it was. The page now finishes the job
  itself: it shows what it grabbed, copies it, and opens the editor.
- **A selection can be cancelled.** There is a Cancel button on the control bar,
  `Esc` on both `document` and `window`, right-click, and a Cancel in the popup
  if you reopen it mid-pick. Previously the only hint was "press Esc", which is
  no help on a page that swallows key events, and there was no way out.
- **Clicking something that is not a table no longer hangs the picker.** It used
  to do nothing at all — no message, no highlight, no exit — leaving the page
  dimmed until you reloaded it. Every pick now ends in a result panel, including
  the ones that fail, and says why it failed.
- **Clicking a table inside a link no longer navigates away**, taking the grab
  with it. Pointer events are swallowed while picking.
- The overlay's own controls are clickable. They sit in a shadow root inside the
  page, so the capture-phase listeners that block page clicks were eating them
  first.

### Fixed — capture and sorting

- **"Collect all rows" works on div grids.** The scroll capture only ever ran the
  `<table>` extractor, which returns nothing for a grid built out of boxes — so
  scrolling an AG Grid collected zero rows and then replaced a good twenty-row
  capture with an empty one. It now re-reads the grid on every step, and never
  returns fewer rows than it started with.
- The scroll loop gives up on a scroller that refuses to move, instead of
  grinding through 400 no-op steps.
- **Sorting is stable**, so ties keep their order and sorting by one column then
  another behaves.
- **Blanks sort last** in both directions rather than filling the top of a
  descending sort.
- **Dates sort chronologically** rather than alphabetically.
- **A sort survives hiding, renaming and reordering other columns** — it is
  pinned to the original column, not to a position that shifts underneath it.
- Pagination controls belonging to a different table on the same page are no
  longer offered as this table's.

### Added

- **Region capture.** Drag a box over anything — a price list in flexbox, a
  dashboard of tiles, a receipt in a `<pre>` — and it is rebuilt as a table from
  where the text sits on screen. Right-aligned columns, uneven row heights and
  missing values are all handled.
- **Partial selections ask.** A box across half a table offers both readings,
  with row and column counts: the part you covered, or the whole table.
- **Paste and drop.** CSV, TSV, JSON, JSON Lines, Markdown or an HTML table,
  pasted or dropped as a file into the editor. Copying a table and pasting it
  keeps the markup, so the columns survive.
- **Sort by clicking a column header** — ascending, descending, off.
- **Drag to reorder columns.**
- Selection widening and narrowing with `↑` and `↓` while picking.
- Copy straight from the in-page result panel, as CSV or for Sheets.
- `Alt+Shift+G` starts a click-pick, `Alt+Shift+B` a box-drag.
- A "Reset every setting" button, and per-column reset.
- Ctrl/Cmd+F focuses the row filter.

### Changed

- **New look.** Light by default with a dark variant that follows the OS, a teal
  accent, and a new mark. It no longer borrows glitchbong.com's neon palette:
  this is a tool that sits next to a spreadsheet for twenty minutes, and the
  contrast belongs to the data.
- The editor grid has a sticky header and row numbers, and states plainly that
  the preview cap is not an export cap.
- The popup leads with the three ways in — click, box, paste — rather than
  burying the picker behind the table list.
- Context menu entries for each way in.

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
