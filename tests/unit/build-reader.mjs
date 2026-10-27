/**
 * Builds `reader.svelte.ts` into plain ESM for the headless tests.
 *
 * NOTE: `favorites.mjs`, `hidden-write.mjs` and `reader-state.mjs` each carry
 * their own copy of the import-rewrite lists below, because they build extra
 * modules of their own. A new relative import in `reader.svelte.ts` or
 * `reading.svelte.ts` has to be added to all four copies, or those three suites
 * fail with `Cannot find module .../tests/unit/lib/<name>/index.ts` — which is
 * what happens when a specifier is left relative and Node resolves it from the
 * generated directory.
 *
 * A runes module cannot be imported by Node: it is type-stripped with the
 * project's TypeScript, compiled with Svelte's `compileModule`, and rewritten so
 * every import points at the real source file. Shared by the suites that drive
 * the reader state directly, so the rewriting lives in one place.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const GEN_DIR = join(ROOT, "tests/unit/.gen");

export function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

function compileRunes(file, name) {
  const source = readFileSync(join(ROOT, file), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  return compileModule(outputText, { generate: "client", filename: file }).js.code;
}

/** Compiles one runes module to a file under .gen and returns its URL. */
function generated(file, name, rewrites = []) {
  mkdirSync(GEN_DIR, { recursive: true });
  let code = compileRunes(file, name);
  for (const [from, to] of rewrites) code = code.replaceAll(from, JSON.stringify(to));
  code = absolutise(code);
  const out = join(GEN_DIR, `${name}.mjs`);
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

const readingModule = () =>
  generated("src/state/reading.svelte.ts", "reading", [
    ['"../lib/list-view"', absolute("src/lib/list-view.ts")],
  ]);
const themeModule = () => generated("src/state/theme.svelte.ts", "theme");
const floodsModule = () => generated("src/state/floods.svelte.ts", "floods");

/** Any relative import is rewritten to the real file, wherever it points. */
function absolutise(code) {
  return code.replace(/"(\.{1,2}\/[^"]+)"/g, (whole, spec) => {
    if (spec.startsWith("./") && spec.includes(".svelte")) return whole;
    const bare = spec.replace(/^\.\.\//, "").replace(/^\.\//, "state/");
    const file = bare.startsWith("src/") ? bare : `src/${bare}`;
    return JSON.stringify(absolute(file.endsWith(".ts") ? file : `${file}.ts`));
  });
}

export function buildReaderModule() {
  mkdirSync(GEN_DIR, { recursive: true });
  return compileRunes("src/state/reader.svelte.ts", "reader")
    .replaceAll('"../api/freshrss"', JSON.stringify(absolute("src/api/freshrss.ts")))
    .replaceAll('"../api/hardlyread"', JSON.stringify(absolute("src/api/hardlyread.ts")))
    .replaceAll('"../api/transport"', JSON.stringify(absolute("src/api/transport.ts")))
    .replaceAll('"../lib/reading-order"', JSON.stringify(absolute("src/lib/reading-order.ts")))
    .replaceAll('"../lib/feed-order"', JSON.stringify(absolute("src/lib/feed-order.ts")))
    .replaceAll('"../lib/indent"', JSON.stringify(absolute("src/lib/indent.ts")))
    .replaceAll('"../lib/article-filter"', JSON.stringify(absolute("src/lib/article-filter.ts")))
    .replaceAll('"../lib/list-view"', JSON.stringify(absolute("src/lib/list-view.ts")))
    .replaceAll('"../lib/stream-cycle"', JSON.stringify(absolute("src/lib/stream-cycle.ts")))
    .replaceAll('"../lib/dwell"', JSON.stringify(absolute("src/lib/dwell.ts")))
    .replaceAll('"../lib/contextmenu"', JSON.stringify(absolute("src/lib/contextmenu.ts")))
    .replaceAll('"../lib/sync-progress"', JSON.stringify(absolute("src/lib/sync-progress.ts")))
    .replaceAll('"../lib/place"', JSON.stringify(absolute("src/lib/place.ts")))
    .replaceAll('"../lib/account-key"', JSON.stringify(absolute("src/lib/account-key.ts")))
    .replaceAll('"../lib/add-feeds"', JSON.stringify(absolute("src/lib/add-feeds.ts")))
    .replaceAll('"../lib/opml"', JSON.stringify(absolute("src/lib/opml.ts")))
    .replaceAll('"../lib/extract-ledger"', JSON.stringify(absolute("src/lib/extract-ledger.ts")))
    .replaceAll('"../lib/full-text"', JSON.stringify(absolute("src/lib/full-text.ts")))
    .replaceAll('"./reading.svelte"', JSON.stringify(readingModule()))
    .replaceAll('"./theme.svelte"', JSON.stringify(themeModule()))
    .replaceAll('"./floods.svelte"', JSON.stringify(floodsModule()))
    .replaceAll('"./hidden-write"', JSON.stringify(absolute("src/state/hidden-write.ts")))
    .replaceAll('"./hidden"', JSON.stringify(absolute("src/state/hidden.ts")))
    .replaceAll('"./favorites"', JSON.stringify(absolute("src/state/favorites.ts")))
    .replaceAll('"./write"', JSON.stringify(absolute("src/state/write.ts")))
    .replaceAll('"./stream-cache"', JSON.stringify(absolute("src/state/stream-cache.ts")))
    .replaceAll('"./pins"', JSON.stringify(absolute("src/state/pins.ts")))
    .replaceAll('"./persist"', JSON.stringify(absolute("src/state/persist.ts")))
    .replaceAll('"../lib/api-snapshot"', JSON.stringify(absolute("src/lib/api-snapshot.ts")))
    .replaceAll('"../lib/stream-loads"', JSON.stringify(absolute("src/lib/stream-loads.ts")))
    .replaceAll('"../lib/stream-perf"', JSON.stringify(absolute("src/lib/stream-perf.ts")))
    .replaceAll('"../lib/stream-scroll"', JSON.stringify(absolute("src/lib/stream-scroll.ts")));
}
