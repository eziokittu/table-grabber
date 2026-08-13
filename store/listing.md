# Chrome Web Store listing

Copy-paste source for the listing fields. Deliberately makes no comparison to
named competitors — store policy discourages it, and the website carries that
comparison instead.

---

## Name (63 / 75)

```
Table Grabber — Copy & Export Any Table to CSV, Excel, Markdown
```

## Short description (109 / 132)

```
Copy any web table to CSV, Excel, Markdown, JSON, SQL and more. Unlimited rows, no account, nothing uploaded.
```

## Category

Developer Tools

## Detailed description

```
Table Grabber copies any table on any web page into the format you actually need — CSV, Excel, Markdown, JSON, SQL, YAML, LaTeX, HTML or plain text.

Every format is free. Every row is included. There is no account, no row limit, and no upload — the extension has no network code in it at all.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDS TABLES OTHER TOOLS MISS

• Real HTML tables, including ones inside shadow DOM and same-origin iframes
• Grids built out of plain boxes — the kind modern web apps draw with CSS grid and JavaScript, which have no table markup at all
• Virtualised grids that keep only the visible rows loaded: Table Grabber scrolls and collects the rest
• Paginated tables: it can walk every page and merge them into one export

GETS THE SHAPE RIGHT

Merged cells are the reason most table extractors quietly produce misaligned columns. When one cell spans two rows, a naive reader shifts every column after it and you do not notice until the data is already in your spreadsheet.

Table Grabber lays every cell onto a coordinate grid before reading it, so merged cells stay where they belong. You choose how merged positions are filled: repeat the value, leave blank, or mark them.

Multi-row headers are combined into one name, so a grouped header reads "Region – Country" instead of losing the group entirely.

MAKES THE DATA USABLE

• Detects column types: number, currency, percent, date, boolean, URL
• Optionally rewrites $1,234.00 into 1234 and 45% into 45, so spreadsheets treat them as numbers instead of text
• Understands both 1,234.56 and 1.234,56
• Survives placeholder values like N/A without giving up on a numeric column
• Rename, hide and reorder columns; filter rows; sort numerically; remove duplicates and empty rows

EXCEL THAT ACTUALLY WORKS

The .xlsx export writes real numeric cells with a frozen header row and sized columns, so SUM() works the moment you open it — no re-import dance.

Copying as TSV puts an HTML table on the clipboard too, so pasting into Google Sheets or Excel lands in real cells rather than one.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRIVACY

Table Grabber installs with access to no websites at all. There is no host permission in its manifest, so adding it approves nothing and nothing runs in the background. It reads a page only when you click the toolbar icon, press Alt+Shift+T, or use the right-click menu — and only that one tab.

It contains no network code whatsoever. No fetch, no XMLHttpRequest, no WebSocket, no analytics, no telemetry, no account, no identifiers. This is enforced by an automated check that fails the build if any network call appears in the source.

Tables you grab are held in memory and cleared when the browser closes. Exports are generated in your browser and handed straight to Chrome's download manager.

It is MIT licensed and the full source is public — read every line before you run it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HOW TO USE IT

1. Open any page with a table
2. Click the Table Grabber icon (or press Alt+Shift+T)
3. Copy straight away as CSV, TSV or Markdown — or open the editor for everything else

In the editor: Ctrl+S downloads, Ctrl+Shift+C copies.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Free, open source, and free of charge permanently. Turning a table into a CSV is arithmetic — it needs no server, so it has no running cost, so there is nothing to charge for.

Guide and web version: https://glitchbong.com/tools/table-grabber
Source: https://github.com/bodhisattabhattacharjee/table-grabber
```

## Permission justifications

Store review asks for one per permission. Keep these tight and literal.

**activeTab**
```
Reads the table content of the tab the user is actively looking at, only after the user clicks the extension icon, presses the keyboard shortcut, or chooses the context-menu item. This is what allows the extension to ship with no host permissions.
```

**scripting**
```
Injects the table-reading code into the active tab on demand. The extension declares no content_scripts, so nothing runs on any page until the user explicitly invokes it.
```

**storage**
```
Passes a grabbed table from the popup to the editor tab using chrome.storage.session, which is held in memory and cleared when the browser closes. The stored copy is deleted as soon as the editor reads it. No user data is persisted to disk.
```

**downloads**
```
Saves the exported file (CSV, Excel, Markdown, JSON, etc.) that the user explicitly asked for. Files are generated locally in the browser.
```

**contextMenus**
```
Adds a single "Grab tables on this page" right-click item as an alternative way to invoke the extension.
```

**Remote code**
```
No. All code ships inside the extension package. No external scripts, stylesheets, fonts or images are loaded at runtime.
```

**Data usage disclosures**

Tick nothing. The extension collects and transmits no user data. Certify:
- Not being sold to third parties
- Not being used or transferred for purposes unrelated to the item's core functionality
- Not being used or transferred to determine creditworthiness or for lending purposes

## Screenshots (1280×800)

1. `01-popup.png` — popup listing several tables on a real page, badges visible
2. `02-editor.png` — editor with the preview grid and column panel
3. `03-merged.png` — a merged-header table beside the correctly aligned output
4. `04-formats.png` — the format dropdown open, all ten visible
5. `05-picker.png` — picker overlay highlighting a table on a page

## Promotional tiles

- Small: 440×280 — mark plus "Any table. Any format. Free."
- Marquee: 1400×560 — before/after: messy merged table on the left, clean CSV on the right

## Single purpose

```
Extract tabular data from the page the user is viewing and export it to a file or the clipboard in a format the user selects.
```
