/**
 * Serves test-page/ on http://localhost:4322 so the fixtures can be opened over
 * http rather than file:// — shadow DOM and module behaviour differ under
 * file://, and the extension should be tested the way it will actually run.
 *
 * Node's own http module only; nothing to install.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test-page");
// The e2e harness picks a random port so repeated runs cannot collide.
const PORT = Number(process.env.PORT) || 4322;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // normalize() before joining, so ../ cannot escape the fixture directory.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
    const path = join(ROOT, rel || "index.html");
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}).listen(PORT, () => {
  console.log(`\n  Test fixtures:  http://localhost:${PORT}\n`);
  console.log("  Load the extension, open that page, and click the toolbar icon.\n");
});
