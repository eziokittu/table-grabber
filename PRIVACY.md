# Privacy Policy — Table Grabber

**Last updated: 14 August 2026**

The short version: Table Grabber collects nothing, because there is nothing in
it capable of collecting anything.

## What is collected

Nothing. Not anonymised, not aggregated, not "for product improvement". None.

- **No network code at all.** The extension makes no `fetch`, `XMLHttpRequest`,
  `WebSocket` or `sendBeacon` calls. There is no server behind it and no
  endpoint to send anything to. This is asserted by an automated check that
  fails the build if any network call appears in the source
  (`npm test`, "no network calls anywhere in the extension").
- **No analytics, telemetry or crash reporting.**
- **No account, sign-in or identifier.** There is no way to tell one user from
  another, even in principle.
- **No remote code.** Everything it runs ships inside the extension. It loads no
  external scripts, fonts, stylesheets or images.

## What it stores

- **Table data lives in memory only.** A table you grab is held in
  `chrome.storage.session`, which the browser keeps in RAM and clears when the
  browser closes. Scraped data is never written to disk by the extension.
- **The handoff is deleted on read.** When the editor tab loads a table, the
  stored copy is removed immediately.
- **Exports are local.** CSV, Excel, Markdown, JSON, SQL and the rest are
  generated in your browser and handed straight to Chrome's download manager.

## Permissions, and why each exists

| Permission | Why |
| --- | --- |
| `activeTab` | Read the page you are looking at, only when you click the icon. Access ends when you leave that page. |
| `scripting` | Inject the table-reading code into that one tab, on demand. |
| `storage` | Pass a grabbed table to the editor tab, in memory (`storage.session`). |
| `downloads` | Save the file you asked for. |
| `contextMenus` | Add the "Grab tables on this page" right-click item. |

**It installs with access to no sites at all.** There is no `host_permissions`
entry in the manifest, so adding the extension approves nothing and nothing runs
in the background. The content script is injected only when you click the
toolbar icon, use the keyboard shortcut, or choose the context-menu item — and
only into that one tab.

You can confirm this at `chrome://extensions` — site access reads "On click".

## What the extension can see when you use it

When you invoke it on a page, it reads that page's rendered content in order to
find tables. That content stays in the tab and in the editor tab you opened. It
is not transmitted, and it is not retained after the browser closes.

Be aware that a grabbed table contains whatever the page contained. If you
export a table from a logged-in page, the file may hold personal or
account-specific data. Treat exported files as you would any other download.

## Third parties

There are none. No SDKs, no libraries loaded at runtime, no bundled
dependencies, no ad networks, no payment processor.

## Changes

Material changes to this policy will be noted in `CHANGELOG.md` and reflected in
the version published with the extension.

## Contact

Questions or a security report: <https://glitchbong.com/contact>

Source: <https://github.com/eziokittu/table-grabber>
