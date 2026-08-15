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

_8816 characters. The store cap is 16,000._

_Rewritten after the 2026-08-14 rejection for keyword spam (ref: Yellow Argon).
The reviewer cited the opening format list and the thirteen-bullet format
section. Format names now appear roughly ten times across the whole
description rather than sixty-six, and each format is described by what it is
for rather than by its name plus a technical gloss. Keep it that way: the
screenshots and the website carry the enumerated list instead._

```
Table Grabber copies any table on any web page into the format you actually need.

Every format is free. Every row is included. There is no account, no row limit, no watermark, no trial, and no upload — the extension contains no network code at all.

Click the toolbar icon and it lists every table it can find on the page, with the row and column count of each. Copy one straight away, or open it in the editor to clean it up first.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDS THE TABLES OTHER TOOLS MISS

• Ordinary HTML tables, including ones nested inside other tables
• Tables inside open shadow roots and same-origin iframes, which a plain search of the page never sees
• Grids built out of plain boxes — the kind modern web apps draw with CSS and JavaScript, which contain no table markup whatsoever. These are found by their repeating structure rather than by hardcoding any particular grid library's class names, so it works on hand-rolled grids and the popular libraries alike
• Virtualised grids that keep only the visible rows loaded and swap them as you scroll. Table Grabber scrolls the grid in steps and accumulates the rest, placing each row by the grid's own row numbering where it publishes one
• Paginated tables: it finds the Next control, clicks it, waits for the table to actually change rather than guessing at a delay, and merges every page into a single export. It stops at the last page, and you can stop it sooner

Cross-origin frames are skipped. The browser correctly forbids reading them, and no extension should be trying.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GETS THE SHAPE RIGHT

MERGED CELLS

This is the reason most table extractors quietly produce misaligned data. When one cell spans two rows, a reader that walks the cells in order shifts every column after it — so your numbers end up filed under the wrong headings, and nothing warns you. You find out later, in the spreadsheet, if you find out at all.

Table Grabber lays every cell onto a coordinate grid before reading anything, so a merged cell still occupies the positions it visually occupies. You choose what happens in those positions: repeat the value down, leave them blank, or mark them explicitly.

MULTI-ROW HEADERS

A grouped header — one "Region" cell sitting above "Country" and "City" — is two header rows. Take only the first and you lose the columns; take only the second and you lose the group. Header rows are detected and stacked into one name per column, so you get "Region – Country" instead of half the information.

NUMBERS THAT STAY NUMBERS

$1,234.00 pasted into a spreadsheet is text, and SUM() over a column of text returns zero. Table Grabber detects each column's type — number, currency, percent, date, boolean, URL, text — and can rewrite the values so the destination reads them as numbers.

It understands both 1,234.56 and the European 1.234,56. It handles accounting negatives written as (1,234). And it survives placeholder values: a column of prices with a few N/A entries is still recognised as numeric, rather than being written off as text because of them.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OUTPUT FORMATS

Thirteen of them, covering spreadsheets, structured data, databases and documents. The screenshots below show the full list, and the guide linked at the end describes each one.

Each one is written properly rather than approximated. The spreadsheet export is a real workbook with numeric cells, a frozen header row and columns sized to their contents — so formulas and charts work the moment it opens, with no import wizard and no re-typing. Delimited text is quoted to the standard and carries a byte order mark, so accented characters arrive intact instead of as mojibake. The structured formats keep genuine numbers and booleans instead of quoting everything, and turn the headers into usable keys. The database export infers a column type per field and batches its inserts. The document formats come out aligned in the source, with the special characters escaped.

PASTE THAT LANDS IN CELLS

Copying to the clipboard puts table markup there alongside the plain text. Google Sheets and Excel pick that up and give you real cells, instead of dumping the whole table into A1 as one long string.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CLEAN IT UP BEFORE YOU EXPORT

The editor shows a live preview and never alters the original page.

• Rename, hide and reorder columns
• Filter rows by a search term
• Sort numerically, so 9 comes before 100 rather than after it
• Remove duplicate rows and empty rows or columns
• Fill blank cells from the value above
• Find and replace across every cell, with optional regular expressions and case sensitivity
• Trim whitespace and strip footnote markers, so "Population[a]" comes out as "Population"
• Rewrite headers to snake_case, camelCase, Title Case or UPPER, to match wherever the data is going
• Skip leading junk rows, and pad ragged rows to a consistent width
• Transpose the entire table

KNOW WHAT YOU GRABBED

Every column reports its detected type, how many cells are filled, how many values are distinct, and for numeric columns the minimum, maximum, sum and mean. This is how you notice that a capture came up short, or that a column you assumed was unique has duplicates in it.

WORKS IN BOTH DIRECTIONS

It reads pasted data too, not just web pages. Paste delimited text, structured data or a table written in Markdown; the format is detected automatically and the delimiter is sniffed from the content. Anything it can read it can write back out, so conversion works between any two of the supported formats, not only out of a page.

SPREADSHEET FORMULA INJECTION IS NEUTRALISED

A scraped cell containing =cmd|'/c calc'!A1 is a live formula the moment your file opens in a spreadsheet. Values beginning with =, +, - or @ are neutralised on export. This matters more than it sounds when the data came from a page you do not control.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRIVACY, STATED PRECISELY

Table Grabber installs with access to no websites at all. There is no host permission in its manifest, which means adding it grants nothing, nothing runs in the background, and no page is touched until you ask.

It reads a page only when you click the toolbar icon, press Alt+Shift+T, or choose the right-click menu item — and only that one tab, in that one moment.

It contains no network code whatsoever. No fetch, no XMLHttpRequest, no WebSocket, no beacons, no analytics, no telemetry, no accounts, no identifiers, no error reporting. This is not a promise about intentions: it is enforced by an automated check that fails the build if any network call appears anywhere in the source.

Grabbed tables are held in memory and cleared when the browser closes. Exports are generated inside your browser and handed straight to Chrome's download manager. Your settings stay on your machine.

It is MIT licensed and the entire source is public, so none of the above has to be taken on trust — you can read every line before you run it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HOW TO USE IT

1. Open any page with a table on it
2. Click the Table Grabber icon, or press Alt+Shift+T
3. Copy it immediately — or click Open to reshape it first

If a page has fifteen tables and you want a specific one, use "Pick one" and click it directly. The highlight is drawn inside a shadow root, so it looks the same on every site regardless of how aggressive the page's own CSS is.

In the editor: Ctrl+S downloads, Ctrl+Shift+C copies.

WHO IT IS FOR

• Analysts pulling a reference table into a spreadsheet with the numbers already numeric
• Writers copying a table into a README or a blog post with the columns already aligned
• Developers turning reference data into a seed script or a test fixture without writing a one-off parser
• Researchers and students getting a typeset table out of a web page without rebuilding it by hand

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHY IT IS FREE

Reading a table out of a page, expanding its merged cells, working out which columns are numbers, and writing the result as CSV or a spreadsheet is arithmetic. It happens on your machine, in your browser, on data your browser has already downloaded. There is no server involved, so there is no running cost, so there is nothing to recover from you.

A row limit would exist for exactly one reason: to sell you the absence of a row limit. So there isn't one, and there won't be.

REQUIREMENTS

Chrome 116 or newer. Also runs on Edge, Brave, Opera, Arc and Vivaldi.

LINKS

Guide, troubleshooting and a browser-based version that needs no install:
https://glitchbong.com/tools/table-grabber

Source code, issue tracker and licence:
https://github.com/eziokittu/table-grabber

Privacy policy:
https://glitchbong.com/tools/table-grabber/privacy
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
Saves the exported file that the user explicitly asked for, in the format the user selected. Files are generated locally in the browser.
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

All five generated by `npm run screenshots`, in upload order:

1. `01-picker.png` — picker overlay highlighting a live table
2. `02-editor.png` — the editor, merged header resolved and columns aligned
3. `03-formats.png` — the format list open, all thirteen visible
4. `04-transforms.png` — cleaning on: real numbers, snake_case headers
5. `05-popup.png` — the popup listing every table on the page, badged

## Promotional tiles

Both generated by `npm run promo`:

- Small 440×280 — `promo-small-440x280.png`: mark, wordmark, "Any table, any
  format. Unlimited rows, nothing uploaded.", five format chips
- Marquee 1400×560 — `promo-marquee-1400x560.png`: the same mark and strapline
  beside a miniature of the merged-header result, plus a FREE · NO ROW LIMIT
  badge

## Single purpose

```
Extract tabular data from the page the user is viewing and export it to a file or the clipboard in a format the user selects.
```
