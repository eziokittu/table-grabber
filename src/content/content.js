/**
 * The in-page half of Table Grabber.
 *
 * Injected on demand — there is no `content_scripts` block in the manifest, so
 * nothing runs anywhere until you ask for it. That is what lets the extension
 * ship with no host permissions at all.
 *
 * Its jobs: find the tables, let you point at one *or draw a box round one that
 * isn't a table at all*, read it, and for grids that lie about their size,
 * scroll or page through the rest.
 *
 * The picking flow is deliberately self-contained. It used to depend on the
 * popup staying open to receive the result — which it cannot, because the popup
 * closes the moment you click the page, so every pick was thrown away and the
 * button looked dead. Now the page finishes the job itself: it shows the result,
 * copies it, and asks the service worker to open the editor. Nothing is waiting
 * on a window that no longer exists.
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
    const [extract, transform, capture, exports, imports, region, ui] = await Promise.all([
      import(url("src/shared/extract.js")),
      import(url("src/shared/transform.js")),
      import(url("src/shared/capture.js")),
      import(url("src/shared/export.js")),
      import(url("src/shared/import.js")),
      import(url("src/shared/region.js")),
      import(url("src/content/ui.js")),
    ]);
    modules = { ...extract, ...transform, ...capture, ...exports, ...imports, ...region, ...ui };
    return modules;
  }

  /** id -> { element, table, kind, virtualised, label } for the current scan. */
  let registry = new Map();
  let counter = 0;
  let scanned = false;

  let overlay = null;
  /** The live picking session, or null. Exactly one may exist. */
  let session = null;

  // ── Scanning ─────────────────────────────────────────────────────────────

  async function scan(options) {
    const m = await load();
    registry = new Map();
    const found = m.findTables(document, options);

    for (const f of found) registry.set(f.id, { ...f, canDeepCapture: true });
    scanned = true;

    return found.map(summarise);
  }

  function summarise(entry) {
    const t = entry.table;
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      rowCount: t.rowCount,
      colCount: t.colCount,
      hasMerges: t.hasMerges,
      virtualised: entry.virtualised,
      caption: t.caption,
      headers: t.headers.slice(0, 12),
      preview: t.rows.slice(0, 3),
    };
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
        canDeepCapture: entry.canDeepCapture !== false && !!entry.element?.isConnected,
        url: location.href,
        host: location.host,
        title: document.title,
      },
    };
  }

  /** Registers a table that was picked rather than scanned, so the editor can find it again. */
  function remember(table, element, kind, label, canDeepCapture) {
    const id = `p${++counter}`;
    registry.set(id, {
      id,
      element: element || document.body,
      table,
      kind: kind || "table",
      label: label || "Picked table",
      virtualised: false,
      canDeepCapture: !!canDeepCapture,
    });
    return id;
  }

  // ── Reading an element ───────────────────────────────────────────────────

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "VIDEO", "AUDIO"]);

  const viewportBox = () => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight });

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  /**
   * Every piece of visible text under `root` that falls inside `box`, with the
   * rectangle it occupies.
   *
   * Text nodes rather than elements, measured with a Range. An element's box is
   * the wrong unit here: a cell whose content is `<b>Ada</b> Lovelace` has two
   * text nodes and one box, and a layout table's "cell" is often a bare text
   * node with no element of its own to measure at all.
   */
  function collectTextItems(root, box, limit = 4000) {
    const items = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (overlay?.isOwn(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const range = document.createRange();
    let node;
    while ((node = walker.nextNode())) {
      if (items.length >= limit) break;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      if (box && !intersectsBox(rect, box)) continue;
      if (!isVisible(node.parentElement)) continue;
      items.push({ ...rect, text: node.nodeValue.replace(/\s+/g, " ").trim() });
    }
    range.detach?.();
    return items;
  }

  function intersectsBox(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  /**
   * Turns any element into a table, trying progressively less structured
   * readings until one of them works.
   *
   * The order is the order of confidence. A real <table> needs no cleverness; a
   * container of repeating boxes needs a little; a pricing block laid out with
   * flexbox has nothing to read but positions on screen; and a <pre> full of
   * CSV is text that only looks like a layout. Each step is a worse guess than
   * the one above it, which is why the result carries `how` — the sheet says
   * out loud which reading it used, so a wrong guess is visible rather than
   * mysterious.
   *
   * @returns {{table: object, how: string, element: Element, kind: string}|null}
   */
  function elementToTable(el, m, options) {
    if (!el) return null;

    for (const [, entry] of registry) {
      if (entry.element === el) return { table: entry.table, how: "table", element: el, kind: entry.kind };
    }

    const isTableTag = el.tagName === "TABLE";
    if (isTableTag) {
      const table = m.extractTable(el, options);
      if (table.rowCount > 0) return { table, how: "table", element: el, kind: "table" };
    }

    // A wrapper around one table is what people click on far more often than
    // the table itself — the scroll container, the card, the section.
    const inner = [...el.querySelectorAll("table")].filter(isVisible);
    if (inner.length) {
      const best = inner
        .map((t) => ({ el: t, table: m.extractTable(t, options) }))
        .sort((a, b) => b.table.rowCount * b.table.colCount - a.table.rowCount * a.table.colCount)[0];
      if (best.table.rowCount > 0) {
        return { table: best.table, how: "table", element: best.el, kind: "table" };
      }
    }

    const grid = m.extractGrid(el, options);
    if (grid && grid.rowCount > 0 && grid.colCount > 1) {
      return { table: grid, how: "grid", element: el, kind: "grid" };
    }

    // Nothing structural left: read the geometry.
    const rect = el.getBoundingClientRect();
    const items = collectTextItems(el, {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    });
    if (items.length >= 4) {
      const built = m.synthesiseTable(items, options);
      if (built.cols >= 2 && built.table.rowCount >= 1) {
        return { table: built.table, how: "layout", element: el, kind: "layout", confidence: built.confidence };
      }
    }

    // Last resort: the element is one blob of delimited text.
    const text = (el.innerText || el.textContent || "").trim();
    if (text.includes("\n") && text.length < 400000) {
      try {
        const parsed = m.parseText(text, "auto");
        if (parsed.table.rowCount >= 1 && parsed.table.colCount >= 2) {
          return { table: parsed.table, how: "text", element: el, kind: "text" };
        }
      } catch {
        /* not delimited text either */
      }
    }

    return null;
  }

  const HOW_LABEL = {
    table: "Read from the page's own table markup.",
    grid: "Read from a grid built out of plain boxes.",
    layout: "No table markup here — rebuilt from where the text sits on screen.",
    text: "Read as delimited text.",
    slice: "Just the part your box covered.",
  };

  // ── Candidates for a dragged box ─────────────────────────────────────────

  /**
   * What a box could reasonably mean.
   *
   * A box drawn across half a table is genuinely ambiguous — "these rows" and
   * "this table" are both sensible readings, and which one is wanted depends
   * entirely on why the box was drawn. So both are offered, counts included, and
   * the more likely one is preselected rather than guessed at silently.
   */
  function candidatesForBox(box, m, options) {
    const out = [];

    const tables = [...document.querySelectorAll("table")]
      .filter((t) => isVisible(t) && !overlay?.isOwn(t))
      .map((t) => ({ el: t, rect: m.rectOf(t) }))
      .filter((t) => intersectsBox(t.rect, box));

    for (const [, entry] of registry) {
      if (entry.kind !== "grid" || !entry.element?.isConnected) continue;
      if (tables.some((t) => t.el === entry.element)) continue;
      const rect = m.rectOf(entry.element);
      if (intersectsBox(rect, box)) tables.push({ el: entry.element, rect, grid: true });
    }

    // Biggest overlap first: a box that clips the edge of a sidebar table while
    // covering all of the main one should be about the main one.
    tables.sort((a, b) => m.coverage(box, b.rect) - m.coverage(box, a.rect));

    for (const target of tables.slice(0, 3)) {
      const covered = m.coverage(target.rect, box);
      const whole = target.grid ? m.extractGrid(target.el, options) : m.extractTable(target.el, options);
      if (!whole || whole.rowCount === 0) continue;

      if (covered < 0.92 && !target.grid) {
        const sliced = m.sliceTable(target.el, box, { options });
        if (sliced.table.rowCount > 0 && sliced.partial) {
          out.push({
            id: `slice-${out.length}`,
            label: "Selected part",
            note: `${sliced.table.rowCount} × ${sliced.table.colCount}`,
            table: sliced.table,
            element: target.el,
            kind: "table",
            how: "slice",
            canDeepCapture: false,
          });
        }
      }

      out.push({
        id: `whole-${out.length}`,
        label: out.length === 0 ? "Whole table" : "Whole table nearby",
        note: `${whole.rowCount} × ${whole.colCount}`,
        table: whole,
        element: target.el,
        kind: target.grid ? "grid" : "table",
        how: target.grid ? "grid" : "table",
        canDeepCapture: true,
      });
    }

    // The geometric reading, which is the only one available when the box did
    // not land on a table at all.
    const items = collectTextItems(document.body, box);
    if (items.length >= 4) {
      const built = m.synthesiseTable(items, options);
      if (built.cols >= 2 && built.rows >= 1) {
        out.push({
          id: "layout",
          label: out.length === 0 ? "Selected area" : "Area as laid out",
          note: `${built.rows} × ${built.cols}`,
          table: built.table,
          element: null,
          kind: "layout",
          how: "layout",
          canDeepCapture: false,
        });
      }
    }

    return out;
  }

  // ── Picking ──────────────────────────────────────────────────────────────

  /** Ancestors of an element, innermost first, stopping at <body>. */
  function chainOf(el) {
    const chain = [];
    let node = el;
    while (node && node !== document.documentElement) {
      chain.push(node);
      node = node.parentElement;
    }
    return chain;
  }

  /** Where in that chain the interesting thing usually is. */
  function preferredIndex(chain) {
    for (let i = 0; i < chain.length; i++) {
      const el = chain[i];
      for (const [, entry] of registry) if (entry.element === el) return i;
      if (el.tagName === "TABLE") return i;
      const role = el.getAttribute?.("role");
      if (role === "table" || role === "grid") return i;
    }
    return 0;
  }

  function describeTarget(el) {
    for (const [, entry] of registry) {
      if (entry.element === el) {
        return { text: `${entry.table.rowCount} rows × ${entry.table.colCount} cols`, tone: "ok" };
      }
    }
    if (el.tagName === "TABLE") {
      const rows = el.rows?.length || 0;
      const cols = el.rows?.[0]?.cells?.length || 0;
      return { text: `table · ${rows} rows × ${cols} cols`, tone: "ok" };
    }
    const name = el.tagName.toLowerCase();
    const cls = (el.classList?.[0] || "").slice(0, 18);
    return { text: `${name}${cls ? "." + cls : ""} · will convert`, tone: "warn" };
  }

  async function startPick(mode) {
    const m = await load();
    if (session) session.cancel(true);
    // Clear any result still on screen *through closeResult*, not by dropping
    // the overlay: it also removes that sheet's Escape handler, which would
    // otherwise fire during this new pick and tear down the overlay underneath
    // it while the picker was still drawing into it.
    closeResult();
    if (!scanned) {
      try { await scan({}); } catch { /* labels degrade, picking still works */ }
    }

    overlay = m.createOverlay();

    let current = null;       // element under consideration
    let chain = [];
    let chainIndex = 0;
    let dragStart = null;     // page coordinates
    let dragBox = null;       // viewport coordinates
    let currentMode = mode === "region" ? "region" : "element";
    let done = false;

    const toViewport = (pagePoint, clientPoint) => ({
      left: Math.min(pagePoint.x - scrollX, clientPoint.x),
      top: Math.min(pagePoint.y - scrollY, clientPoint.y),
      right: Math.max(pagePoint.x - scrollX, clientPoint.x),
      bottom: Math.max(pagePoint.y - scrollY, clientPoint.y),
    });

    const paintBar = () => {
      overlay.showBar({
        title: currentMode === "region" ? "Drag a box around the data" : "Click the table you want",
        hint:
          currentMode === "region"
            ? "Anything inside the box is read, table or not."
            : "↑ ↓ widen or narrow the selection.",
        mode: currentMode,
        onMode: (next) => {
          currentMode = next;
          current = null;
          dragStart = null;
          dragBox = null;
          overlay.highlight(null);
          overlay.band(null);
          document.documentElement.style.cursor = next === "region" ? "crosshair" : "pointer";
          paintBar();
        },
        onCancel: () => finish(null),
      });
    };

    const paintHighlight = () => {
      if (currentMode !== "element" || !current) return;
      const rect = current.getBoundingClientRect();
      const info = describeTarget(current);
      overlay.highlight(rect, info.text, info.tone === "warn" ? "warn" : null);
    };

    /**
     * Events on our own controls reach these document-level capture listeners
     * first — a shadow root does not stop propagation, it only retargets — so
     * without this guard the capture-phase handler below would swallow the
     * click on the Cancel button before the button ever saw it. The bar would
     * be visible, clickable, and completely inert.
     */
    const fromUi = (e) => !!overlay && overlay.isOwn(e.target);

    const onMove = (e) => {
      if (fromUi(e)) return;
      if (currentMode === "region") {
        if (!dragStart) return;
        dragBox = toViewport(dragStart, { x: e.clientX, y: e.clientY });
        overlay.band(dragBox);
        return;
      }

      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || overlay.isOwn(el)) return;
      if (chain[chainIndex] === el) return;

      chain = chainOf(el);
      chainIndex = preferredIndex(chain);
      current = chain[chainIndex] || el;
      paintHighlight();
    };

    const onDown = (e) => {
      if (fromUi(e) || e.button !== 0) return;
      swallow(e);
      if (currentMode !== "region") return;
      dragStart = { x: e.clientX + scrollX, y: e.clientY + scrollY };
      dragBox = { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY };
      overlay.highlight(null);
      overlay.band(dragBox);
    };

    const onUp = (e) => {
      if (fromUi(e) || currentMode !== "region" || !dragStart) return;
      swallow(e);
      const box = toViewport(dragStart, { x: e.clientX, y: e.clientY });
      dragStart = null;
      overlay.band(null);

      // A box smaller than a deliberate drag is a click, and treating it as one
      // means a mis-drag picks something rather than silently doing nothing.
      if (box.right - box.left < 8 || box.bottom - box.top < 8) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && !overlay.isOwn(el)) {
          const c = chainOf(el);
          finish({ kind: "element", element: c[preferredIndex(c)] || el });
        }
        return;
      }
      finish({ kind: "region", box });
    };

    const onClick = (e) => {
      if (fromUi(e)) return;
      swallow(e);
      if (currentMode !== "element" || !current) return;
      finish({ kind: "element", element: current });
    };

    const onKey = (e) => {
      if (e.key === "Escape") { swallow(e); finish(null); return; }
      if (currentMode !== "element") return;

      if (e.key === "Enter" && current) { swallow(e); finish({ kind: "element", element: current }); return; }
      if (e.key === "ArrowUp" && chainIndex < chain.length - 1) {
        swallow(e);
        chainIndex++;
        current = chain[chainIndex];
        paintHighlight();
      }
      if (e.key === "ArrowDown" && chainIndex > 0) {
        swallow(e);
        chainIndex--;
        current = chain[chainIndex];
        paintHighlight();
      }
    };

    const onContext = (e) => { if (fromUi(e)) return; swallow(e); finish(null); };
    const onScroll = () => { if (currentMode === "element") paintHighlight(); };

    /**
     * While picking, the page must not react to the pointer at all. Without
     * this, clicking a table inside a link navigates away and the grab is lost
     * along with the page it came from.
     */
    function swallow(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    }

    const guarded = (e) => { if (!fromUi(e)) swallow(e); };

    // Note the absence of `pointerdown`. Cancelling that event suppresses the
    // compatibility mouse events Chrome derives from it, which took `mousedown`
    // with it — so a region drag never registered a starting corner and the box
    // could not be drawn at all. Swallowing `mousedown` already stops the page
    // reacting, without breaking the gesture we are trying to read.
    const listeners = [
      ["mousemove", onMove], ["mousedown", onDown], ["mouseup", onUp],
      ["click", onClick], ["contextmenu", onContext], ["keydown", onKey],
      ["auxclick", guarded], ["dblclick", guarded],
    ];
    for (const [type, fn] of listeners) document.addEventListener(type, fn, true);
    // Both targets: some pages stop key events before they reach the document.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);

    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = currentMode === "region" ? "crosshair" : "pointer";

    const teardown = () => {
      for (const [type, fn] of listeners) document.removeEventListener(type, fn, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
      document.documentElement.style.cursor = previousCursor;
      session = null;
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      teardown();
      overlay?.highlight(null);
      overlay?.band(null);
      overlay?.hideBar();
      if (!result) {
        overlay?.destroy();
        overlay = null;
        return;
      }
      showResult(result, m, currentMode);
    };

    session = {
      mode: currentMode,
      cancel: (silent) => {
        finish(null);
        if (!silent && overlay) overlay.toast("Selection cancelled");
      },
    };

    paintBar();
    return { ok: true, started: true };
  }

  // ── Result ───────────────────────────────────────────────────────────────

  /**
   * Shows what was grabbed and what can be done with it.
   *
   * Reached on *every* outcome, including "that is not a table". Silence was
   * the old failure mode and it was indistinguishable from a crash.
   */
  function showResult(result, m, mode) {
    const options = {};
    let candidates = [];

    if (result.kind === "region") {
      candidates = candidatesForBox(result.box, m, options);
    } else {
      const read = elementToTable(result.element, m, options);
      if (read) {
        candidates = [{
          id: "picked",
          label: "Selection",
          note: `${read.table.rowCount} × ${read.table.colCount}`,
          table: read.table,
          element: read.element,
          kind: read.kind,
          how: read.how,
          canDeepCapture: read.how === "table" || read.how === "grid",
        }];
      }
    }

    if (candidates.length === 0) {
      overlay.showSheet({
        title: "Nothing table-shaped there",
        message:
          mode === "region"
            ? "That box did not contain enough aligned text to make columns out of. Try a box that covers the whole block, including its headings."
            : "That element has no rows and columns in it. Try clicking a bigger container, pressing ↑ to widen the selection, or dragging a box instead.",
        actions: [
          { label: "Pick again", primary: true, onClick: () => { closeResult(); startPick("element"); } },
          { label: "Drag a box", onClick: () => { closeResult(); startPick("region"); } },
          { label: "Close", onClick: closeResult },
        ],
        onClose: closeResult,
      });
      return;
    }

    let chosen = candidates[0].id;
    const render = () => {
      const candidate = candidates.find((c) => c.id === chosen) || candidates[0];
      const table = candidate.table;

      overlay.showSheet({
        title: `${table.rowCount.toLocaleString()} rows × ${table.colCount} cols`,
        subtitle: candidate.label,
        choices: candidates,
        choice: chosen,
        preview: table,
        note: HOW_LABEL[candidate.how] || "",
        onChoice: (id) => { chosen = id; render(); },
        onClose: closeResult,
        actions: [
          {
            label: "Copy CSV",
            onClick: () => copyAs(table, "csv", m),
          },
          {
            label: "Copy for Sheets",
            onClick: () => copyAs(table, "tsv", m),
          },
          {
            label: "Open in editor",
            primary: true,
            onClick: () => openEditor(candidate, m),
          },
          {
            label: "Pick again",
            onClick: () => { closeResult(); startPick(mode); },
          },
        ],
      });
    };

    render();

    // Esc closes the result too, so the same key always means "get me out".
    // Tracked at module scope and removed in closeResult, because a leftover
    // handler from a previous grab would tear down the *next* grab's overlay.
    if (resultKeyHandler) document.removeEventListener("keydown", resultKeyHandler, true);
    resultKeyHandler = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeResult();
    };
    document.addEventListener("keydown", resultKeyHandler, true);
  }

  let resultKeyHandler = null;

  function closeResult() {
    if (resultKeyHandler) {
      document.removeEventListener("keydown", resultKeyHandler, true);
      resultKeyHandler = null;
    }
    overlay?.destroy();
    overlay = null;
  }

  async function copyAs(table, format, m) {
    const label = format === "tsv" ? "tab-separated (paste into Sheets or Excel)" : "CSV";
    try {
      await writeClipboard(m.serialise(table, format, {}), table, m);
      overlay?.toast(`${table.rowCount.toLocaleString()} rows copied as ${label}`);
    } catch (e) {
      overlay?.toast("Could not copy: " + (e?.message || e), "err");
    }
  }

  /**
   * Writes to the clipboard from inside a page.
   *
   * The async Clipboard API is the right one — it can carry both plain text and
   * an HTML table, which is what makes a paste into Sheets land in cells — but
   * it is blocked outright on pages with a restrictive permissions policy. The
   * execCommand path is deprecated and still the only thing that works there,
   * and a copy button that fails on some sites is worse than an ugly fallback.
   */
  async function writeClipboard(text, table, m) {
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const html = m.toHtml(table, { full: false, styled: false });
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
        return true;
      }
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      if (!copied) throw new Error("the page blocked clipboard access");
      return true;
    }
  }

  async function openEditor(candidate, m) {
    const id = remember(
      candidate.table,
      candidate.element,
      candidate.kind,
      candidate.label,
      candidate.canDeepCapture
    );
    const payload = {
      table: getTable(id),
      tableId: id,
      source: { url: location.href, title: document.title, host: location.host },
    };
    try {
      await chrome.runtime.sendMessage({ type: "openFromPage", payload });
      closeResult();
    } catch (e) {
      overlay?.toast("Could not open the editor: " + (e?.message || e), "err");
    }
  }

  // ── Deep capture ─────────────────────────────────────────────────────────

  let stopRequested = false;

  async function deepCapture(id, mode, options) {
    const m = await load();
    const entry = registry.get(id);
    if (!entry) return { error: "That table is no longer on the page. Re-scan and try again." };
    if (!entry.element?.isConnected) {
      return { error: "The page has replaced that table since it was grabbed. Grab it again." };
    }

    stopRequested = false;
    if (!overlay) overlay = m.createOverlay();
    const rect = m.rectOf(entry.element);
    overlay.highlight(rect, null, "plain");

    const onKey = (e) => { if (e.key === "Escape") stopRequested = true; };
    document.addEventListener("keydown", onKey, true);

    const bar = (title, hint) =>
      overlay.showBar({
        title,
        hint,
        onCancel: () => { stopRequested = true; },
        actions: [],
      });

    const cleanUp = () => {
      document.removeEventListener("keydown", onKey, true);
      overlay?.destroy();
      overlay = null;
    };

    try {
      if (mode === "paginate") {
        bar("Walking pages…", "Leave the tab alone until it finishes.");
        const result = await m.captureByPaging(
          entry,
          options,
          (p) => bar(`Page ${p.pages} · ${p.rows.toLocaleString()} rows`, "Leave the tab alone until it finishes."),
          () => stopRequested
        );
        entry.table = result.table;
        cleanUp();
        return {
          ok: true,
          rowCount: result.table.rowCount,
          complete: result.complete,
          pages: result.pages,
          stopped: stopRequested,
        };
      }

      bar("Scrolling for more rows…", "Leave the tab alone until it finishes.");
      const result = await m.captureByScrolling(
        entry,
        options,
        (p) => bar(`${p.rows.toLocaleString()} rows so far…`, "Leave the tab alone until it finishes."),
        () => stopRequested
      );
      entry.table = result.table;
      cleanUp();
      return {
        ok: true,
        rowCount: result.table.rowCount,
        complete: result.complete,
        strategy: result.strategy,
        scrolls: result.scrolls,
        gained: result.gained,
        stopped: result.stopped || stopRequested,
      };
    } catch (e) {
      cleanUp();
      return { error: String(e?.message || e) };
    }
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case "ping":
            sendResponse({ ok: true, picking: !!session });
            break;

          case "state":
            sendResponse({ ok: true, picking: !!session, mode: session?.mode || null });
            break;

          case "scan":
            sendResponse({ ok: true, tables: await scan(msg.options) });
            break;

          case "get":
            sendResponse({ ok: true, table: getTable(msg.id) });
            break;

          case "highlight": {
            const m = await load();
            const entry = registry.get(msg.id);
            if (entry?.element?.isConnected) {
              entry.element.scrollIntoView({ behavior: "smooth", block: "center" });
              if (!overlay) overlay = m.createOverlay();
              const t = entry.table;
              overlay.highlight(m.rectOf(entry.element), `${t.rowCount} rows × ${t.colCount} cols`);
              setTimeout(() => {
                // Only tear down if nothing else has claimed the overlay since.
                if (overlay && !session) { overlay.destroy(); overlay = null; }
              }, 1800);
            }
            sendResponse({ ok: true });
            break;
          }

          case "pick":
            sendResponse(await startPick(msg.mode));
            break;

          case "cancelPick":
            session?.cancel(true);
            closeResult();
            sendResponse({ ok: true });
            break;

          case "deepCapture":
            sendResponse(await deepCapture(msg.id, msg.mode, msg.options));
            break;

          case "canPaginate": {
            const m = await load();
            const entry = registry.get(msg.id);
            sendResponse({
              ok: true,
              can: !!(entry?.element?.isConnected && m.findNextControl(entry.element)),
            });
            break;
          }

          case "teardown":
            session?.cancel(true);
            closeResult();
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
