/**
 * Stages a copy of the extension for the CDP harness.
 *
 * The shipped manifest asks for no host permissions — everything rides on
 * `activeTab`, which is granted by a real click on the toolbar icon. A script
 * cannot produce that click: the DevTools Protocol has no way to open a browser
 * action, and the permission is deliberately gated on a genuine user gesture.
 *
 * So the harness drives a staged copy that is byte-identical except for one
 * added `host_permissions` entry scoped to the demo server. That is exactly the
 * state the browser is in after the user clicks the icon, which is the state
 * the assertions are about. The real manifest is checked separately by
 * check.mjs, which asserts it carries no host permissions at all.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Only what Chrome actually loads — no scripts, docs, dist or store assets. */
const PAYLOAD = ["manifest.json", "icons", "src"];

/**
 * @param {string[]} origins match patterns to pre-grant, e.g. ["http://localhost/*"]
 * @returns {{path: string, cleanup: () => void}} path uses forward slashes, as
 *   Extensions.loadUnpacked requires even on Windows
 */
export function stageExtension(origins) {
  const dir = mkdtempSync(join(tmpdir(), "table-grabber-staged-"));

  for (const entry of PAYLOAD) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }

  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = origins;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    path: dir.split("\\").join("/"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a temp dir Chrome still holds open is not worth failing over */
      }
    },
  };
}
