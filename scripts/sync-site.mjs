/**
 * Copies the shared engine into the glitchbong website.
 *
 * The website runs the identical extraction, transform, import and export code
 * that the extension does — that is the whole reason the `src/shared` modules
 * contain no `chrome.*` calls. Copying beats reimplementing in TypeScript
 * because there is then exactly one place a table-parsing bug can live.
 *
 * Run after changing anything in src/shared:
 *   npm run sync
 *
 * Pass --check to verify the copies are current without writing (used by the
 * test suite, so a drifted copy fails the build rather than shipping).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = resolve(ROOT, "..", "glitchbong", "src", "lib", "table-grabber");

/** Engine modules only — nothing that touches chrome.* or the extension UI. */
const MODULES = ["extract.js", "transform.js", "export.js", "import.js"];

const header = (name) => `/* eslint-disable */
// SYNCED COPY — do not edit here.
//
// Source of truth: the Table Grabber extension repo, src/shared/${name}
// Copied verbatim so the website and the extension cannot drift apart: the
// same engine produces the same output in both places, and there is only one
// implementation to fix when a table breaks it.
//
// To update: run \`npm run sync\` in the extension repo, which also re-runs the
// engine tests that live alongside the source.

`;

const checkOnly = process.argv.includes("--check");
let drifted = 0;

if (!existsSync(SITE)) {
  if (checkOnly) {
    console.log("  site copy not found — skipping (the website is not checked out here)");
    process.exit(0);
  }
  mkdirSync(SITE, { recursive: true });
}

for (const name of MODULES) {
  const source = readFileSync(join(ROOT, "src", "shared", name), "utf8");
  const wanted = header(name) + source;
  const target = join(SITE, name);

  const current = existsSync(target) ? readFileSync(target, "utf8") : null;

  if (current === wanted) {
    console.log(`  in sync   ${name}`);
    continue;
  }

  if (checkOnly) {
    drifted++;
    console.log(`  DRIFTED   ${name}`);
    continue;
  }

  writeFileSync(target, wanted, "utf8");
  console.log(`  updated   ${name}`);
}

if (checkOnly && drifted > 0) {
  console.log(`\n${drifted} module(s) drifted. Run \`npm run sync\`.`);
  process.exit(1);
}
