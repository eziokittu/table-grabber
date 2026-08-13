# Table Grabber

Copy any table on any web page to **CSV, Excel, Markdown, JSON, JSON Lines,
XML, SQL, YAML, LaTeX, HTML or plain text**. Unlimited rows, every format
free, nothing uploaded.

A Chrome extension, MIT licensed, with no server, no account and no network
code of any kind.

- **Tool page:** <https://glitchbong.com/tools/table-grabber>
- **Chrome Web Store:** *(pending review)*

---

## Why this exists

Copying a table out of a web page is arithmetic. It needs no server, so it can
have no running cost — yet the popular extensions cap the free tier at a few
hundred rows and put Markdown, direct CSV download and multi-page capture behind
a subscription. One reviewer of the market leader put it better than I can:

> "Needing a subscription to copy as Markdown is lame. It's not like that
> requires a backend to do the processing, so there's no continuous operating
> cost associated with that feature."

They are right. So everything here is free, and it always will be, because
keeping it free costs nothing.

## What it does

**Reads any input, writes any output**

Paste a table copied from a web page, or CSV, TSV, JSON, JSON Lines or a
Markdown table — the format is detected and the delimiter sniffed. Write it back
out as any of thirteen formats. So it converts in every direction: a web table
to SQL, CSV to Markdown, JSON to a spreadsheet.

**Finds tables other tools miss**

- Real `<table>` elements, including inside **shadow DOM** and **same-origin
  iframes**.
- **Div grids** — tables built out of plain boxes (AG Grid, TanStack, CSS grid),
  found by repeating structure rather than by hardcoded class names.
- **Virtualised grids**, where the page keeps only the visible ~20 rows in the
  DOM. Table Grabber scrolls and accumulates the rest, keyed on the grid's own
  row indices when it exposes them so the result is exact.
- **Paginated tables** — it can walk every page and merge them.

**Gets the shape right**

`rowspan` and `colspan` are the reason most scrapers silently produce misaligned
columns: one `<td>` occupies several visual positions, so a naive `row.cells`
walk shifts everything after it. Table Grabber lays cells onto a coordinate grid
first, then fills merged positions using a policy you choose (repeat the value,
leave blank, or mark with `↳`).

Multi-row headers are stacked into one name, so a grouped header reads
`Region – Country` rather than losing the group.

**Makes the data usable**

- Column types are detected (number, currency, percent, date, boolean, URL) and
  survive stray `N/A` placeholders.
- Optionally rewrites `$1,234.00` → `1234` and `45%` → `45` so spreadsheets
  treat them as numbers rather than text.
- Rename, reorder and hide columns; filter rows; sort numerically; drop
  duplicates and empty rows.
- Reshape: transpose, fill blank cells from the value above, find and replace
  across every cell, trim whitespace, skip leading rows, cap the row count.
- Rewrite headers to `snake_case`, `camelCase`, `Title Case`, upper or lower, to
  match wherever the data is going.
- Every column reports its type, fill rate, distinct count and — for numbers —
  min, max, sum and mean.
- `.xlsx` export writes **real numeric cells**, so `SUM()` works on open — the
  main reason to prefer it over CSV.
- CSV export neutralises leading-`=` formula injection, which matters when the
  source is a page you do not control.

## Install

### From the Chrome Web Store

*(link pending review)*

### From source

```bash
git clone https://github.com/eziokittu/table-grabber
cd table-grabber
npm test        # 80 checks, no dependencies to install
```

Then load it:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → choose this folder

### From the packaged ZIP

`npm run build` writes two archives and their SHA-256 checksums to `dist/`:

| File | For |
| --- | --- |
| `table-grabber-<v>-webstore.zip` | Chrome Web Store upload (manifest at root) |
| `table-grabber-<v>.zip` | Humans — everything in one folder, plus `INSTALL.txt` |

## Using it

| Action | How |
| --- | --- |
| List every table on the page | Click the toolbar icon, or `Alt+Shift+T` |
| Copy one straight away | `CSV` / `TSV` / `MD` buttons on any table in the popup |
| Point at a specific table | **Pick one**, then click it on the page |
| Everything else | **Open →** for the editor |
| Right-click route | **Grab tables on this page** |

In the editor: `Ctrl/Cmd+S` downloads, `Ctrl/Cmd+Shift+C` copies.

TSV is usually what you want for pasting into Sheets or Excel — the clipboard
also carries an HTML table, so it lands in real cells rather than one.

## Privacy

The extension **installs with access to no sites at all** — there is no
`host_permissions` entry, so nothing runs anywhere until you click the icon.

There is no network code in the source. That is enforced, not promised: `npm
test` fails the build if `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon`
appears anywhere in `src/`.

Grabbed tables live in `chrome.storage.session` (memory only, cleared when the
browser closes) and the copy is deleted the moment the editor reads it.

Full detail in [PRIVACY.md](PRIVACY.md).

## How it is put together

```
src/
  shared/       the engine — no chrome.* APIs, so the identical code runs
    extract.js    finding tables; rowspan/colspan; div grids; shadow DOM
    import.js     CSV/TSV/JSON/JSONL/Markdown parsing, format + delimiter sniffing
    transform.js  typing, cleaning, reshaping, filtering, column statistics
    export.js     every output format, including a dependency-free .xlsx writer
    capture.js    scroll-and-accumulate, and pagination walking
    theme.css     design tokens shared with the rest of the GlitchBong tools
  content/      injected on demand; picker overlay lives in a shadow root
  popup/        the table list and quick copy
  dashboard/    the editor
  background/   injection, handoff, context menu
scripts/
  check.mjs     80 assertions, engine tests against a hand-rolled fake DOM
  e2e.mjs       56 assertions against a real Chrome, over the DevTools Protocol
  probe.mjs     diagnostic harness for "why did that not work in the browser"
  sync-site.mjs copies the engine to the website; --check fails on drift
  build.mjs     zero-dependency ZIP packer
  make-icons.mjs  icons drawn from signed-distance functions, no binaries in git
```

### Testing

`npm test` runs 80 assertions with no browser and no dependencies. `npm run
e2e` drives a real Chrome over the DevTools Protocol and asserts 56 more:
that Chrome accepts the manifest, that the content script injects, that a
merged-cell table comes out aligned, that scrolling a virtualised grid really
does collect all 500 rows, that pagination walks all three pages, and that the
`.xlsx` writer emits a valid ZIP inside the browser.

Three bugs in this repo were found only by that second suite — a div grid whose
header row carried a different class, a "Next ›" button the matcher would not
recognise, and a scroll capture that stalled whenever the tab stopped painting.
All three now have unit tests too.

`src/shared/` deliberately contains no `chrome.*` calls. That is what lets the
same engine run inside the extension and on the
[web version](https://glitchbong.com/tools/table-grabber) with no second
implementation to keep in sync.

The test suite includes a small hand-written DOM rather than pulling in jsdom,
so the repo can be cloned and tested with **zero installs** — a property worth
protecting for a tool whose pitch is "read the source yourself".

## Development

```bash
npm test     # checks + engine tests
npm run icons  # regenerate PNGs from code
npm run build  # package to dist/
npm run demo   # serve test-page/ — tables designed to break extractors
```

`test-page/` has the nasty cases: merged headers, rowspan bodies, a div grid,
European number formats, a table inside a shadow root.

## Licence

MIT — see [LICENSE](LICENSE).
