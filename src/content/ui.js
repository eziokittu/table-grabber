/**
 * The in-page interface: highlight, control bar, rubber band, result sheet.
 *
 * Everything lives inside one shadow root. Page CSS is hostile — `* { }` rules,
 * `!important` on everything, z-index wars — and a shadow root is the only way
 * to be sure this looks and behaves the same on every site.
 *
 * The host is `pointer-events: none` so hovering passes straight through to the
 * page; individual controls opt back in. That combination is what lets a
 * *clickable* Cancel button coexist with a picker that needs to see what is
 * underneath it — and having that button is the whole reason this file exists.
 * The previous version drew a hint that said "press Esc", which is no help at
 * all on a page that swallows key events, and left people stuck mid-selection
 * with no way out but a reload.
 */

const HOST_ID = "__table-grabber-ui";

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }

  .hl {
    position: fixed; pointer-events: none; z-index: 1;
    border: 2px solid #0f7a72; border-radius: 3px;
    background: rgba(15, 122, 114, 0.10);
    box-shadow: 0 0 0 100000px rgba(12, 22, 28, 0.28);
    transition: left .06s ease-out, top .06s ease-out, width .06s ease-out, height .06s ease-out;
  }
  .hl.warn { border-color: #b8791d; background: rgba(184, 121, 29, 0.10); }
  .hl.plain { box-shadow: none; }

  .tag {
    position: fixed; pointer-events: none; z-index: 2;
    font: 600 11px/1.5 ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
    color: #fff; background: #0f7a72;
    padding: 3px 8px; border-radius: 4px; white-space: nowrap;
    box-shadow: 0 2px 6px rgba(0,0,0,.28);
  }
  .tag.warn { background: #b8791d; }

  .band {
    position: fixed; pointer-events: none; z-index: 3;
    border: 2px dashed #0f7a72; border-radius: 4px;
    background: rgba(15, 122, 114, 0.12);
  }
  .band-size {
    position: fixed; pointer-events: none; z-index: 4;
    font: 600 11px/1.5 ui-monospace, Menlo, monospace;
    color: #fff; background: #0f7a72; padding: 2px 7px; border-radius: 4px;
  }

  .bar {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    pointer-events: auto; z-index: 10;
    display: flex; align-items: center; gap: 10px;
    background: #ffffff; color: #101820;
    border: 1px solid #dde4ea; border-radius: 12px;
    padding: 8px 10px 8px 14px;
    box-shadow: 0 18px 44px rgba(16, 24, 32, 0.22);
    font-size: 13px; max-width: min(92vw, 720px);
  }
  .bar-text { display: flex; flex-direction: column; line-height: 1.35; }
  .bar-title { font-weight: 600; }
  .bar-hint { font-size: 11.5px; color: #6b7784; }
  .seg { display: flex; background: #eef2f5; border-radius: 8px; padding: 2px; gap: 2px; }
  .seg button { border: 0; background: transparent; color: #4c5966; font: 600 12px/1 inherit;
    padding: 6px 10px; border-radius: 6px; cursor: pointer; }
  .seg button:hover { background: #e2e8ed; color: #101820; }
  .seg button[aria-pressed="true"] { background: #0f7a72; color: #fff; }

  button.act {
    border: 1px solid #dde4ea; background: #fff; color: #101820;
    font: 600 12px/1 inherit; padding: 7px 11px; border-radius: 8px; cursor: pointer;
  }
  button.act:hover { background: #f2f5f7; border-color: #c3ced9; }
  button.act.primary { background: #0f7a72; border-color: #0f7a72; color: #fff; }
  button.act.primary:hover { background: #0c655e; }
  button.act:disabled { opacity: .5; cursor: default; }
  kbd {
    font: 600 10px/1.4 ui-monospace, Menlo, monospace; color: #4c5966;
    background: #eef2f5; border: 1px solid #dde4ea; border-radius: 4px; padding: 1px 5px;
  }

  .sheet {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    pointer-events: auto; z-index: 10;
    width: min(94vw, 640px); max-height: 62vh; overflow: auto;
    background: #ffffff; color: #101820;
    border: 1px solid #dde4ea; border-radius: 14px;
    box-shadow: 0 24px 60px rgba(16, 24, 32, 0.28);
    padding: 14px 16px 12px;
    font-size: 13px;
  }
  .sheet-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .sheet-title { font-weight: 700; font-size: 14px; }
  .sheet-sub { color: #6b7784; font-size: 12px; }
  .sheet-close {
    margin-left: auto; border: 0; background: transparent; color: #6b7784;
    font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px;
  }
  .sheet-close:hover { background: #eef2f5; color: #101820; }

  .choices { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .choice {
    border: 1px solid #dde4ea; background: #fff; border-radius: 999px;
    padding: 5px 12px; font: 500 12px/1.3 inherit; color: #4c5966; cursor: pointer; text-align: left;
  }
  .choice:hover { border-color: #c3ced9; background: #f7f9fb; }
  .choice[aria-pressed="true"] { background: #e2f2f0; border-color: #0f7a72; color: #0b5a54; font-weight: 600; }
  .choice small { display: block; font-weight: 400; color: #6b7784; font-size: 10.5px; }
  .choice[aria-pressed="true"] small { color: #0f7a72; }

  .prev { border: 1px solid #e6ebef; border-radius: 8px; overflow: auto; max-height: 200px; }
  table.grid { border-collapse: collapse; width: 100%; font-size: 12px; }
  table.grid th, table.grid td {
    border-bottom: 1px solid #eef2f5; border-right: 1px solid #eef2f5;
    padding: 5px 8px; text-align: left; white-space: nowrap;
    max-width: 220px; overflow: hidden; text-overflow: ellipsis;
  }
  table.grid th { background: #f4f7f9; font-weight: 600; position: sticky; top: 0; }
  table.grid td.empty { background: #fbfcfd; }

  .sheet-foot { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .msg { color: #6b7784; font-size: 12.5px; line-height: 1.5; }
  .msg strong { color: #101820; }
  .note { font-size: 11.5px; color: #6b7784; margin-top: 8px; }

  .toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    pointer-events: none; z-index: 20;
    background: #101820; color: #fff; border-radius: 10px;
    padding: 9px 16px; font-size: 13px; font-weight: 500;
    box-shadow: 0 12px 30px rgba(0,0,0,.3);
  }
  .toast.err { background: #b23b39; }

  @media (prefers-color-scheme: dark) {
    .bar, .sheet { background: #1b2126; color: #eef2f5; border-color: #313a44; }
    .bar-hint, .sheet-sub, .sheet-close, .msg, .note, .choice small { color: #a9b5c0; }
    .seg { background: #262e37; }
    .seg button { color: #b3bfca; }
    .seg button:hover { background: #313a44; color: #eef2f5; }
    button.act { background: #262e37; border-color: #3a444f; color: #eef2f5; }
    button.act:hover { background: #313a44; }
    button.act.primary { background: #2f9d92; border-color: #2f9d92; color: #08201e; }
    kbd { background: #262e37; border-color: #3a444f; color: #b3bfca; }
    .prev, table.grid th, table.grid td { border-color: #313a44; }
    table.grid th { background: #232a31; }
    table.grid td.empty { background: #1e242a; }
    .choice { background: #262e37; border-color: #3a444f; color: #b3bfca; }
    .choice[aria-pressed="true"] { background: #1d3733; border-color: #4fc3b6; color: #b8ece6; }
    .sheet-close:hover { background: #313a44; }
  }
`;

/**
 * Builds the overlay and returns its API. Safe to call twice — the second call
 * reuses the live host if the page has not thrown it away.
 */
export function createOverlay() {
  let host = document.getElementById(HOST_ID);
  if (host) host.remove();

  host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "false");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:0;margin:0;padding:0;background:none;color-scheme:light dark";

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.append(style);

  const hl = el("div", { class: "hl", hidden: true });
  const tag = el("div", { class: "tag", hidden: true });
  const band = el("div", { class: "band", hidden: true });
  const bandSize = el("div", { class: "band-size", hidden: true });
  shadow.append(hl, tag, band, bandSize);

  (document.body || document.documentElement).append(host);

  let bar = null;
  let sheet = null;
  let toastEl = null;
  let toastTimer = null;

  const api = {
    /** True when the element belongs to our own UI, which must never be picked. */
    isOwn(node) {
      return !!node && (node === host || node.getRootNode?.() === shadow || host.contains(node));
    },

    highlight(rect, label, tone) {
      if (!rect) {
        hl.hidden = true;
        tag.hidden = true;
        return;
      }
      hl.hidden = false;
      hl.className = "hl" + (tone === "warn" ? " warn" : "") + (tone === "plain" ? " plain" : "");
      Object.assign(hl.style, {
        left: rect.left + "px",
        top: rect.top + "px",
        width: Math.max(0, rect.right - rect.left) + "px",
        height: Math.max(0, rect.bottom - rect.top) + "px",
      });

      if (!label) {
        tag.hidden = true;
        return;
      }
      tag.hidden = false;
      tag.className = "tag" + (tone === "warn" ? " warn" : "");
      tag.textContent = label;
      const above = rect.top > 26;
      Object.assign(tag.style, {
        left: Math.max(4, Math.min(rect.left, innerWidth - 260)) + "px",
        top: (above ? rect.top - 24 : Math.min(rect.bottom + 6, innerHeight - 26)) + "px",
      });
    },

    band(rect) {
      if (!rect) {
        band.hidden = true;
        bandSize.hidden = true;
        return;
      }
      const w = Math.max(0, rect.right - rect.left);
      const h = Math.max(0, rect.bottom - rect.top);
      band.hidden = false;
      Object.assign(band.style, { left: rect.left + "px", top: rect.top + "px", width: w + "px", height: h + "px" });
      bandSize.hidden = false;
      bandSize.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      Object.assign(bandSize.style, {
        left: Math.min(rect.right + 8, innerWidth - 90) + "px",
        top: Math.min(rect.bottom + 8, innerHeight - 26) + "px",
      });
    },

    /**
     * The control bar. Always carries a Cancel button — the one thing the old
     * picker had no way to offer, because its overlay could not be clicked.
     */
    showBar({ title, hint, mode, onMode, onCancel, actions }) {
      if (bar) bar.remove();
      bar = el("div", { class: "bar" });

      const text = el("div", { class: "bar-text" });
      text.append(el("span", { class: "bar-title", text: title }));
      if (hint) {
        const hintEl = el("span", { class: "bar-hint" });
        hintEl.append(document.createTextNode(hint + " "));
        const esc = el("kbd", { text: "Esc" });
        hintEl.append(esc, document.createTextNode(" cancels"));
        text.append(hintEl);
      }
      bar.append(text);

      if (onMode) {
        const seg = el("div", { class: "seg" });
        for (const option of [
          { id: "element", label: "Click element" },
          { id: "region", label: "Drag a box" },
        ]) {
          const b = el("button", { type: "button", text: option.label });
          b.setAttribute("aria-pressed", String(mode === option.id));
          b.addEventListener("click", (e) => { stop(e); onMode(option.id); });
          seg.append(b);
        }
        bar.append(seg);
      }

      for (const action of actions || []) {
        const b = el("button", { class: "act" + (action.primary ? " primary" : ""), type: "button", text: action.label });
        b.addEventListener("click", (e) => { stop(e); action.onClick(); });
        bar.append(b);
      }

      const cancel = el("button", { class: "act", type: "button", text: "Cancel" });
      cancel.addEventListener("click", (e) => { stop(e); onCancel(); });
      bar.append(cancel);

      shadow.append(bar);
    },

    hideBar() {
      if (bar) bar.remove();
      bar = null;
    },

    /**
     * The result sheet.
     *
     * A grab always ends here, including a grab that found nothing. That is the
     * fix for the worst bug in the old picker: clicking something that was not
     * a table did nothing whatsoever, with no message and no way back, so the
     * page just sat there dimmed until you reloaded it.
     */
    showSheet({ title, subtitle, message, choices, choice, preview, actions, note, onChoice, onClose }) {
      if (sheet) sheet.remove();
      sheet = el("div", { class: "sheet", role: "dialog", "aria-label": "Table Grabber selection" });

      const head = el("div", { class: "sheet-head" });
      head.append(el("span", { class: "sheet-title", text: title }));
      if (subtitle) head.append(el("span", { class: "sheet-sub", text: subtitle }));
      const close = el("button", { class: "sheet-close", type: "button", text: "✕", title: "Close" });
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", (e) => { stop(e); onClose(); });
      head.append(close);
      sheet.append(head);

      if (message) {
        const p = el("p", { class: "msg" });
        p.style.margin = "0 0 10px";
        p.append(document.createTextNode(message));
        sheet.append(p);
      }

      if (choices && choices.length > 1) {
        const wrap = el("div", { class: "choices" });
        for (const c of choices) {
          const b = el("button", { class: "choice", type: "button" });
          b.setAttribute("aria-pressed", String(c.id === choice));
          b.append(document.createTextNode(c.label));
          if (c.note) b.append(el("small", { text: c.note }));
          b.addEventListener("click", (e) => { stop(e); onChoice(c.id); });
          wrap.append(b);
        }
        sheet.append(wrap);
      }

      if (preview) sheet.append(previewTable(preview));

      if (note) sheet.append(el("p", { class: "note", text: note }));

      const foot = el("div", { class: "sheet-foot" });
      for (const action of actions || []) {
        const b = el("button", {
          class: "act" + (action.primary ? " primary" : ""),
          type: "button",
          text: action.label,
        });
        if (action.disabled) b.disabled = true;
        b.addEventListener("click", (e) => { stop(e); action.onClick(b); });
        foot.append(b);
      }
      sheet.append(foot);

      shadow.append(sheet);
      return sheet;
    },

    hideSheet() {
      if (sheet) sheet.remove();
      sheet = null;
    },

    toast(text, kind) {
      clearTimeout(toastTimer);
      if (toastEl) toastEl.remove();
      if (!text) return;
      toastEl = el("div", { class: "toast" + (kind === "err" ? " err" : ""), text });
      // Sit above the sheet when one is open, rather than under it.
      if (sheet) toastEl.style.bottom = "calc(62vh + 34px)";
      shadow.append(toastEl);
      toastTimer = setTimeout(() => {
        toastEl?.remove();
        toastEl = null;
      }, 2400);
    },

    destroy() {
      clearTimeout(toastTimer);
      host.remove();
    },
  };

  return api;
}

// ── Building blocks ────────────────────────────────────────────────────────

function el(tag, props) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "text") node.textContent = value;
    else if (key === "hidden") node.hidden = !!value;
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  return node;
}

/** A click on our own controls must never reach the page underneath. */
function stop(e) {
  e.preventDefault();
  e.stopPropagation();
}

function previewTable(table) {
  const wrap = el("div", { class: "prev" });
  const grid = el("table", { class: "grid" });

  const cols = Math.min(table.colCount || table.headers.length, 8);
  const rows = table.rows.slice(0, 6);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (let c = 0; c < cols; c++) {
    headRow.append(el("th", { text: table.headers[c] || "" }));
  }
  if ((table.colCount || 0) > cols) headRow.append(el("th", { text: `+${table.colCount - cols}` }));
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (let c = 0; c < cols; c++) {
      const value = row[c] ?? "";
      const td = el("td", { text: value });
      if (value === "") td.className = "empty";
      tr.append(td);
    }
    if ((table.colCount || 0) > cols) tr.append(el("td", { text: "…" }));
    tbody.append(tr);
  }

  grid.append(thead, tbody);
  wrap.append(grid);
  return wrap;
}
