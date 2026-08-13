/**
 * Background service worker.
 *
 * Deliberately thin. It exists to do the three things a page cannot: inject the
 * content script when you ask for it, hand a captured table to the editor tab,
 * and drive the context menu.
 *
 * It holds no data of its own beyond a short-lived handoff, and it never talks
 * to the network — there is nothing here to talk to.
 */

const CONTENT_SCRIPT = "src/content/content.js";
const DASHBOARD = "src/dashboard/dashboard.html";

// ── Injection ──────────────────────────────────────────────────────────────

/**
 * Makes sure the content script is live in a tab.
 *
 * Pings first: re-injecting is harmless (the script guards against it) but a
 * ping is cheaper and tells us whether the page is injectable at all. Chrome
 * blocks injection into its own pages and the Web Store, and the error message
 * for that is unhelpful, so we translate it.
 */
async function ensureInjected(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (pong?.ok) return { ok: true };
  } catch {
    /* not injected yet */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [CONTENT_SCRIPT],
    });
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|Cannot access|extension manifest/i.test(msg)) {
      return {
        ok: false,
        error:
          "Chrome does not allow extensions to run on this page. Open a normal website and try again.",
      };
    }
    return { ok: false, error: msg };
  }
}

async function send(tabId, message) {
  const ready = await ensureInjected(tabId);
  if (!ready.ok) return { error: ready.error };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// ── Handoff to the editor ──────────────────────────────────────────────────

/**
 * Tables move to the editor through `storage.session`, which lives in memory
 * and is cleared when the browser closes — scraped data never touches disk.
 *
 * Very large tables can exceed the session quota, so the editor is also told
 * where the table came from and can re-fetch it from the tab if the handoff is
 * missing. One of the two always works.
 */
async function handoff(payload) {
  const key = `handoff:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    await chrome.storage.session.set({ [key]: payload });
  } catch {
    // Over quota. The editor will fall back to fetching from the source tab.
    return { key: null, ...payload };
  }
  return { key };
}

async function openDashboard(payload) {
  const { key } = await handoff(payload);
  const params = new URLSearchParams();
  if (key) params.set("k", key);
  if (payload.sourceTabId) params.set("tab", String(payload.sourceTabId));
  if (payload.tableId) params.set("id", payload.tableId);

  await chrome.tabs.create({ url: chrome.runtime.getURL(`${DASHBOARD}?${params}`) });
}

// ── Messages ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "relay":
        sendResponse(await send(msg.tabId, msg.message));
        break;

      case "ensure":
        sendResponse(await ensureInjected(msg.tabId));
        break;

      case "openDashboard":
        await openDashboard(msg.payload);
        sendResponse({ ok: true });
        break;

      case "fetchHandoff": {
        const got = await chrome.storage.session.get(msg.key);
        // One-shot: drop it as soon as the editor has it.
        if (got?.[msg.key]) await chrome.storage.session.remove(msg.key);
        sendResponse({ ok: true, payload: got?.[msg.key] ?? null });
        break;
      }

      default:
        sendResponse({ error: "Unknown message" });
    }
  })();
  return true;
});

// ── Context menu ───────────────────────────────────────────────────────────

const MENU_ID = "table-grabber-grab";

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Grab tables on this page",
      contexts: ["page", "selection", "link", "image"],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  createMenu();
  // Send first-time users to the guide rather than leaving them staring at an
  // empty popup wondering what to do.
  if (details.reason === "install") {
    chrome.tabs.create({ url: "https://glitchbong.com/tools/table-grabber?installed=1" });
  }
});
chrome.runtime.onStartup.addListener(createMenu);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  const res = await send(tab.id, { type: "scan", options: {} });
  if (res?.error || !res?.tables?.length) return;

  // Open the biggest table — on a page with several, that is almost always the
  // one someone right-clicked to get.
  const biggest = res.tables.reduce((a, b) => (b.rowCount > a.rowCount ? b : a));
  const full = await send(tab.id, { type: "get", id: biggest.id });
  if (full?.error || !full?.table) return;

  await openDashboard({
    table: full.table,
    tableId: biggest.id,
    sourceTabId: tab.id,
    source: { url: tab.url, title: tab.title },
  });
});
