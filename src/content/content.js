/**
 * The in-page half of Table Grabber.
 *
 * Injected on demand — there is no `content_scripts` block in the manifest, so
 * nothing runs anywhere until you click the toolbar icon. That is what lets the
 * extension ship with no host permissions at all.
 *
 * Its jobs: find the tables, let you point at one, read it, and for grids that
 * lie about their size, scroll or page through the rest.
 *
 * All UI it draws lives inside a shadow root. Page CSS is hostile — `* { }`
 * rules, `!important` everywhere, z-index wars — and a shadow root is the only
 * way to be sure the picker looks the same on every site.
 */

(() => {
  // Injected twice (two clicks of the icon) would double every listener.
  if (window.__tableGrabberLoaded) return;
  window.__tableGrabberLoaded = true;

  const url = (p) => chrome.runtime.getURL(p);
  let modules = null;

  /** Shared modules load lazily so a scan pays for them only once. */
  async function load() {
    if (modules) return modules;
    const [extract, transform, capture] = await Promise.all([
      import(url("src/shared/extract.js")),
      import(url("src/shared/transform.js")),
      import(url("src/shared/capture.js")),
    ]);
    modules = { ...extract, ...transform, ...capture };
    return modules;
  }

  /** id -> { element, table, kind, virtualised } for the current scan. */
  let registry = new Map();
  let picker = null;

  // ── Highlighting ─────────────────────────────────────────────────────────

  let host = null;
  let shadow = null;

  function ensureOverlay() {
    if (host && host.isConnected) return shadow;
    host = document.createElement("div");
    host.id = "__table-grabber-overlay";
    // Fixed, non-interactive and above everything the page is likely to use.
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:0;margin:0;padding:0;background:none";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box {
          position: fixed; pointer-events: none; border-radius: 4px;
          border: 2px solid #39ff14;
          background: rgba(57, 255, 20, 0.10);
          box-shadow: 0 0 0 2000px rgba(6, 3, 11, 0.30);
          transition: all .08s ease-out;
        }
        .box.pick { border-color: #a855f7; background: rgba(168, 85, 247, 0.12); }
        .tag {
          position: fixed; pointer-events: none;
          font: 600 12px/1.4 ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
          color: #06030b; background: #39ff14;
          padding: 3px 8px; border-radius: 4px; white-space: nowrap;
          box-shadow: 0 2px 8px rgba(0,0,0,.4);
        }
        .tag.pick { background: #a855f7; color: #fff; }
        .hud {
          position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
          pointer-events: none;
          font: 500 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
          color: #f2eafc; background: rgba(19, 10, 31, .96);
          border: 1px solid rgba(168, 100, 255, .4);
          padding: 10px 16px; border-radius: 10px;
          box-shadow: 0 10px 30px rgba(0,0,0,.5);
          display: flex; gap: 10px; align-items: center;
        }
        .hud kbd {
          font: 600 11px ui-monospace, Menlo, monospace; color: #b9a6d4;
          background: rgba(168,100,255,.16); border: 1px solid rgba(168,100,255,.3);
          border-radius: 4px; padding: 2px 6px;
        }
        .hud .dot { width: 7px; height: 7px; border-radius: 50%; background: #39ff14; }
        .hud.busy .dot { background: #ffd700; animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
      </style>
      <div class="box" hidden></div>
      <div class="tag" hidden></div>
      <div class="hud" hidden></div>
    `;
    (document.body || document.documentElement).appendChild(host);
    return shadow;
  }

  function drawBox(el, label, mode) {
    const s = ensureOverlay();
    const box = s.querySelector(".box");
    const tag = s.querySelector(".tag");
    if (!el) {
      box.hidden = true;
      tag.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    box.hidden = false;
    box.className = "box" + (mode === "pick" ? " pick" : "");
    box.style.cssText += `;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;

    if (label) {
      tag.hidden = false;
      tag.className = "tag" + (mode === "pick" ? " pick" : "");
      tag.textContent = label;
      // Sit above the box, or below it when there is no room.
      const top = r.top > 26 ? r.top - 24 : Math.min(r.bottom + 4, innerHeight - 24);
      tag.style.cssText += `;left:${Math.max(4, Math.min(r.left, innerWidth - 220))}px;top:${top}px`;
    } else {
      tag.hidden = true;
    }
  }

  function hud(text, busy) {
    const s = ensureOverlay();
    const el = s.querySelector(".hud");
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.className = "hud" + (busy ? " busy" : "");
    el.innerHTML = `<span class="dot"></span><span>${text}</span>`;
  }

  function clearOverlay() {
    if (host && host.isConnected) host.remove();
    host = null;
    shadow = null;
  }

  // ── Scanning ─────────────────────────────────────────────────────────────

  async function scan(options) {
    const m = await load();
    registry = new Map();
    const found = m.findTables(document, options);

    for (const f of found) registry.set(f.id, f);

    return found.map((f) => ({
      id: f.id,
      kind: f.kind,
      label: f.label,
      rowCount: f.table.rowCount,
      colCount: f.table.colCount,
      hasMerges: f.table.hasMerges,
      virtualised: f.virtualised,
      caption: f.table.caption,
      headers: f.table.headers.slice(0, 12),
      preview: f.table.rows.slice(0, 3),
    }));
  }

  function getTable(id) {
    const entry = registry.get(id);
    if (!entry) return null;
    return {
      ...entry.table,
      meta: {
        kind: entry.kind,
        virtualised: entry.virtualised,
        label: entry.label,
        url: location.href,
        host: location.host,
        title: document.title,
      },
    };
  }

  // ── Picker ───────────────────────────────────────────────────────────────

  /**
   * Point-and-click selection.
   *
   * Hovering highlights the nearest thing that looks like a table; clicking
   * takes it. If the pointer is not over a known table we walk up to the
   * nearest <table> or grid container, so clicking a single cell still selects
   * the whole thing — which is what people actually mean.
   */
  function startPicker() {
    return new Promise((resolve) => {
      if (picker) picker.cancel();

      let current = null;

      const resolveTarget = (el) => {
        if (!el) return null;
        for (const [, entry] of registry) {
          if (entry.element === el || entry.element.contains(el)) return entry;
        }
        const table = el.closest?.("table, [role='table'], [role='grid']");
        if (table) {
          for (const [, entry] of registry) if (entry.element === table) return entry;
          return { id: "adhoc", element: table, kind: "table", virtualised: false, table: null };
        }
        return null;
      };

      const onMove = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const entry = resolveTarget(el);
        current = entry;
        if (entry) {
          const t = entry.table;
          drawBox(entry.element, t ? `${t.rowCount} rows × ${t.colCount} cols` : "Table", "pick");
        } else {
          drawBox(null);
        }
      };

      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!current) return;
        finish(current);
      };

      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); finish(null); }
      };

      const cleanup = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("scroll", onScroll, true);
        drawBox(null);
        hud(null);
        picker = null;
      };

      const onScroll = () => { if (current) drawBox(current.element, null, "pick"); };

      const finish = async (entry) => {
        cleanup();
        if (!entry) { resolve(null); return; }

        // An ad-hoc pick was never scanned, so extract it now.
        if (!entry.table) {
          const m = await load();
          const table = m.extractTable(entry.element, {});
          const id = `p${registry.size + 1}`;
          registry.set(id, { id, element: entry.element, table, kind: "table", virtualised: false });
          resolve({ id, rowCount: table.rowCount, colCount: table.colCount, label: "Picked table" });
          return;
        }
        resolve({ id: entry.id, rowCount: entry.table.rowCount, colCount: entry.table.colCount, label: entry.label });
      };

      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", onScroll, true);

      hud('Click a table to grab it &nbsp;<kbd>Esc</kbd> to cancel');
      picker = { cancel: () => { cleanup(); resolve(null); } };
    });
  }

  // ── Deep capture ─────────────────────────────────────────────────────────

  let stopRequested = false;

  async function deepCapture(id, mode, options) {
    const m = await load();
    const entry = registry.get(id);
    if (!entry) return { error: "That table is no longer on the page. Re-scan and try again." };

    stopRequested = false;
    drawBox(entry.element, null, "pick");

    try {
      if (mode === "paginate") {
        hud("Walking pages… <kbd>Esc</kbd> to stop", true);
        const onKey = (e) => { if (e.key === "Escape") stopRequested = true; };
        document.addEventListener("keydown", onKey, true);

        const result = await m.captureByPaging(
          entry,
          options,
          (p) => hud(`Page ${p.pages} · ${p.rows} rows… <kbd>Esc</kbd> to stop`, true),
          () => stopRequested
        );

        document.removeEventListener("keydown", onKey, true);
        entry.table = result.table;
        hud(null);
        drawBox(null);
        return {
          ok: true,
          rowCount: result.table.rowCount,
          complete: result.complete,
          pages: result.pages,
          stopped: stopRequested,
        };
      }

      hud("Scrolling for more rows…", true);
      const result = await m.captureByScrolling(entry, options, (p) =>
        hud(`${p.rows} rows so far…`, true)
      );
      entry.table = result.table;
      hud(null);
      drawBox(null);
      return {
        ok: true,
        rowCount: result.table.rowCount,
        complete: result.complete,
        strategy: result.strategy,
        scrolls: result.scrolls,
      };
    } catch (e) {
      hud(null);
      drawBox(null);
      return { error: String(e?.message || e) };
    }
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case "ping":
            sendResponse({ ok: true });
            break;
          case "scan":
            sendResponse({ ok: true, tables: await scan(msg.options) });
            break;
          case "get":
            sendResponse({ ok: true, table: getTable(msg.id) });
            break;
          case "highlight": {
            const entry = registry.get(msg.id);
            if (entry) {
              entry.element.scrollIntoView({ behavior: "smooth", block: "center" });
              const t = entry.table;
              drawBox(entry.element, `${t.rowCount} rows × ${t.colCount} cols`);
              setTimeout(() => drawBox(null), 2000);
            }
            sendResponse({ ok: true });
            break;
          }
          case "unhighlight":
            drawBox(null);
            sendResponse({ ok: true });
            break;
          case "pick":
            sendResponse({ ok: true, picked: await startPicker() });
            break;
          case "deepCapture":
            sendResponse(await deepCapture(msg.id, msg.mode, msg.options));
            break;
          case "canPaginate": {
            const m = await load();
            const entry = registry.get(msg.id);
            sendResponse({ ok: true, can: !!(entry && m.findNextControl(entry.element)) });
            break;
          }
          case "teardown":
            clearOverlay();
            sendResponse({ ok: true });
            break;
          default:
            sendResponse({ error: "Unknown message" });
        }
      } catch (e) {
        sendResponse({ error: String(e?.message || e) });
      }
    })();
    return true; // keeps the channel open for the async reply
  });
})();
