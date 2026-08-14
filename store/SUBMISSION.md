# Chrome Web Store submission — Table Grabber 1.0.0

Every field the dashboard asks for, with the value to paste. Work top to bottom.

**Upload:** `dist/table-grabber-1.0.0-webstore.zip` (manifest at the archive
root — the other ZIP is folder-wrapped for humans and the store will reject it).

Rebuild it with `npm run build` if anything changed.

---

## 0. Before you start

| | |
| --- | --- |
| Developer account | One-time **$5** registration fee at [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole) |
| Account email | Must be verified |
| Publisher name | Set it in Account settings before publishing, or the listing shows a bare email |
| Review time | Usually 1–3 days. Extensions with no host permissions and no remote code — like this one — sit in the fastest lane |

---

## 1. Package

| Field | Value |
| --- | --- |
| ZIP | `dist/table-grabber-1.0.0-webstore.zip` |
| Manifest version | 3 |
| Version | `1.0.0` |
| Minimum Chrome | 116 |

Each update needs the `version` in `manifest.json` bumped — the store rejects a
re-upload of a version it already has.

---

## 2. Store listing

### Extension name (63 / 75)
```
Table Grabber — Copy & Export Any Table to CSV, Excel, Markdown
```

### Summary — short description (109 / 132)
```
Copy any web table to CSV, Excel, Markdown, JSON, SQL and more. Unlimited rows, no account, nothing uploaded.
```

### Description
Paste the block from [`listing.md`](listing.md) → *Detailed description*.

### Category
**Developer Tools**

### Language
English (United Kingdom) — or United States; the copy uses British spelling.

---

## 3. Graphics

All generated from code in this repo — `npm run screenshots` and `npm run promo`.

| Asset | Size | File | Required |
| --- | --- | --- | --- |
| Store icon | 128×128 | `icons/icon-128.png` | **Yes** |
| Screenshot 1 | 1280×800 | `store/screenshots/01-picker.png` | **Yes** (at least one) |
| Screenshot 2 | 1280×800 | `store/screenshots/02-editor.png` | Recommended |
| Screenshot 3 | 1280×800 | `store/screenshots/03-formats.png` | Recommended |
| Screenshot 4 | 1280×800 | `store/screenshots/04-transforms.png` | Recommended |
| Screenshot 5 | 1280×800 | `store/screenshots/05-popup.png` | Recommended |
| Small promo tile | 440×280 | `store/promo-small-440x280.png` | Optional |
| Marquee promo tile | 1400×560 | `store/promo-marquee-1400x560.png` | Optional — needed for homepage features |

The store allows up to five screenshots and all five slots are filled. Upload
them in the order above; the first is the one shown on the listing card.

`store/icon-512.png` is not a store field; it is there for anywhere else that
wants a large mark.

Shot 5 is the one asset that is assembled rather than captured whole: the popup
is its own native window and refuses a size override, so a real capture of it is
placed over a real capture of the page beneath, anchored where Chrome draws it.
Both halves are genuine and the arrangement is the one a user sees, which is
what the misleading-imagery rule is about.

### Screenshot captions

The store does not have a caption field, so these are for reference if you
overlay text later:

1. **Point at any table and take it** — the picker highlighting a live table
2. **Merged cells come out aligned** — the editor showing the rowspan filled correctly
3. **Thirteen formats, none of them paid**
4. **Clean the data before you export it** — numeric values and snake_case headers
5. **Every table on the page, one click each** — the popup listing seven, badged

---

## 4. Privacy

This is the section that gets extensions rejected. Every answer below is
already true of the code.

### Single purpose
```
Extract tabular data from the page the user is viewing and export it to a file or the clipboard in a format the user selects.
```

### Permission justifications

Copy each from [`listing.md`](listing.md) → *Permission justifications*.
Summary of what you are justifying:

| Permission | One-line reason |
| --- | --- |
| `activeTab` | Read the table on the tab the user invoked it on |
| `scripting` | Inject the reader into that one tab, on demand |
| `storage` | Pass the grabbed table to the editor tab, in memory |
| `downloads` | Save the exported file |
| `contextMenus` | The single right-click entry |

There are **no host permissions** to justify — say so if asked; it is unusual
and it helps.

### Remote code
**No.** Everything ships in the package. No external scripts, stylesheets,
fonts or images are loaded at runtime.

### Data usage — tick nothing

The form lists categories (personally identifiable information, health,
financial, authentication, personal communications, location, web history,
user activity, website content). **Leave every box unticked.** The extension
transmits nothing.

Then certify all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

> If a reviewer queries the last one, the answer is that the extension has no
> network code at all — verified by an automated check that fails the build if
> `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon` appears in `src/`.

### Privacy policy URL — **required**
```
https://glitchbong.com/tools/table-grabber/privacy
```
This page must be live before you submit. It is in the sitemap and is
indexable.

---

## 5. Support and links

| Field | Value |
| --- | --- |
| Official URL / homepage | `https://glitchbong.com/tools/table-grabber` |
| Support URL | `https://glitchbong.com/tools/table-grabber#support` |
| Support email | the address on your developer account |

The support anchor is a real section: six troubleshooting entries, what to put
in a bug report, a GitHub issues link and a contact link.

---

## 6. Distribution

| Field | Value |
| --- | --- |
| Visibility | **Public** |
| Distribution | All regions |
| Pricing | Free |
| Contains ads | **No** |
| In-app purchases | **No** |

---

## 7. Before you press Submit

- [ ] `npm test` — 94 checks
- [ ] `npm run e2e` — 56 checks in a real Chrome
- [ ] `npm run build` — regenerates the ZIP and its checksum
- [ ] Load `dist/table-grabber-1.0.0-webstore.zip` unpacked once and click through it
- [ ] Privacy page is live at the URL above
- [ ] Support anchor scrolls to the right section
- [ ] Version in `manifest.json` matches this document
- [ ] GitHub repo is public: <https://github.com/eziokittu/table-grabber>

---

## 8. After it is approved

1. Set `WEB_STORE_URL` in `glitchbong/src/lib/table-grabber/content.ts` to the
   listing address. The tool page, its JSON-LD and its HowTo steps all switch
   from the load-unpacked flow to the one-click flow off that single constant.
2. Update the `Chrome Web Store` line at the top of `README.md`.
3. Redeploy the site.

---

## Things reviewers commonly reject, and where this stands

| Reason | Status |
| --- | --- |
| Requesting permissions the description does not justify | Five permissions, each justified, no host permissions |
| Remote code execution | None — no external anything |
| Missing or unreachable privacy policy | Hosted, in the sitemap, indexable |
| Description that does not match behaviour | Description written from the actual feature list |
| Misleading screenshots | All four are unedited captures of the real extension |
| Obfuscated code | Plain readable ES modules, no build step, no minification |
| Keyword stuffing in the name | Name is a plain description of function |
