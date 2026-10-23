/**
 * Headless checks for the ReaderState wiring of hidden-categories state.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/reader-state.mjs
 *
 * `reader.svelte.ts` is a runes module, so Node cannot import it directly: it
 * is type-stripped with the project's TypeScript, compiled with Svelte's
 * `compileModule`, and imported from a throwaway directory inside the project
 * (so `svelte/reactivity` still resolves). Nothing here touches a network or a
 * GUI; the API layer is replaced by assigning state directly.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, "tests/unit/.gen");

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

/**
 * Renders the runes module into plain ESM.
 *
 * Relative specifiers are rewritten to absolute file URLs, because the generated
 * file does not sit next to the original. `svelte/reactivity` stays bare and
 * resolves from the project's node_modules.
 */
function buildReaderModule() {
  const source = readFileSync(join(ROOT, "src/state/reader.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "reader.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "reader.svelte.ts" });

  return compiled.js.code
    .replaceAll('"../api/freshrss"', JSON.stringify(absolute("src/api/freshrss.ts")))
    .replaceAll('"../api/hardlyread"', JSON.stringify(absolute("src/api/hardlyread.ts")))
    .replaceAll('"../api/transport"', JSON.stringify(absolute("src/api/transport.ts")))
    .replaceAll('"../lib/contextmenu"', JSON.stringify(absolute("src/lib/contextmenu.ts")))
    .replaceAll('"./hidden-write"', JSON.stringify(absolute("src/state/hidden-write.ts")))
    .replaceAll('"./hidden"', JSON.stringify(absolute("src/state/hidden.ts")))
    .replaceAll('"./favorites"', JSON.stringify(absolute("src/state/favorites.ts")))
    .replaceAll('"./write"', JSON.stringify(absolute("src/state/write.ts")))
    .replaceAll('"./stream-cache"', JSON.stringify(absolute("src/state/stream-cache.ts")));
}

function subscription(id, title, label) {
  return {
    id,
    title,
    url: `https://example.invalid/${id}`,
    categories: label === null ? [] : [{ id: `user/-/label/${label}`, label }],
  };
}

const { parseState } = await import(absolute("src/api/hardlyread.ts"));

const state = (overrides = {}) =>
  parseState({
    available: true,
    mode: "strict",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [12],
    locked: false,
    categories: [
      { id: 12, name: "Technology", hidden: true },
      { id: 7, name: "Art", hidden: false },
    ],
    ...overrides,
  });

mkdirSync(GEN_DIR, { recursive: true });
const generated = join(GEN_DIR, "reader.mjs");
writeFileSync(generated, buildReaderModule());

try {
  const { ReaderState } = await import(pathToFileURL(generated).href);
  const labels = (groups) => groups.map((group) => group.label).join(",");

  const reader = new ReaderState();
  reader.subscriptions = [
    subscription("feed/1", "Ars Technica", "Technology"),
    subscription("feed/2", "MoMA", "Art"),
    subscription("feed/3", "Untagged", null),
  ];

  check("allCategories lists every group", labels(reader.allCategories) === "Art,Technology,Uncategorized", labels(reader.allCategories));
  check("an install without the extension filters nothing", labels(reader.categories) === "Art,Technology,Uncategorized");
  check("no extension means hiddenAvailable is false", reader.hiddenAvailable === false);
  check("no extension means the default view", reader.hiddenView === "hidden");
  check("a feed without categories lands in Uncategorized", reader.allCategories.some((group) => group.label === "Uncategorized"));

  reader.hiddenCategories = state();
  check("hidden view drops the hidden category", labels(reader.categories) === "Art,Uncategorized", labels(reader.categories));
  check("allCategories still knows about it", reader.allCategories.length === 3);
  check("hiddenAvailable is true once the server says so", reader.hiddenAvailable === true);
  check("categoryId maps a GReader label to the numeric id", reader.categoryId("user/-/label/Technology") === 12);
  check("categoryId maps a bare label", reader.categoryId("Art") === 7);
  check("categoryId is null for Uncategorized", reader.categoryId("user/-/label/Uncategorized") === null);

  reader.hiddenCategories = state({ view: "revealed", effectiveView: "revealed" });
  check("revealed view keeps everything", labels(reader.categories) === "Art,Technology,Uncategorized", labels(reader.categories));

  reader.hiddenCategories = state({ view: "only", effectiveView: "only" });
  check("only view keeps just the hidden category", labels(reader.categories) === "Technology", labels(reader.categories));

  reader.hiddenCategories = state({ view: "revealed", effectiveView: "hidden", locked: true });
  check("locked state uses effectiveView, not the stored view", labels(reader.categories) === "Art,Uncategorized", labels(reader.categories));
  check("hiddenView reports effectiveView", reader.hiddenView === "hidden");

  reader.hiddenCategories = parseState({ available: false });
  check("a server that reports the extension gone filters nothing again", labels(reader.categories) === "Art,Technology,Uncategorized");


  // Stream cache: returning to a stream you just visited must not hit the network.
  // This is the behaviour behind "switching categories feels slow" — it is
  // measured here as a request count, not as a feeling.
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ items: [], continuation: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  reader.session = { serverUrl: "https://example.invalid", token: "token", username: "user" };

  await reader.openStream("feed/1", "Ars Technica");
  check("a cold stream costs one request", calls.length === 1, `calls=${calls.length}`);
  await reader.openStream("feed/2", "MoMA");
  check("switching to a different stream costs one more", calls.length === 2, `calls=${calls.length}`);
  await reader.openStream("feed/1", "Ars Technica");
  check("returning to a cached stream costs nothing", calls.length === 2, `calls=${calls.length}`);
  check("and is reported as a cache hit", reader.lastStreamSource === "cache", reader.lastStreamSource);


  // A slow stream must not leave the previous stream's articles on screen: that
  // reads as "the click did nothing".
  let releasePending;
  globalThis.fetch = () => new Promise((resolve) => { releasePending = resolve; });
  const pending = reader.openStream("feed/3", "Untagged");
  await Promise.resolve();
  check("switching drops the previous stream's items immediately", reader.items.length === 0, `items=${reader.items.length}`);
  check("and says it is loading", reader.loadingList === true);
  releasePending(new Response(JSON.stringify({ items: [], continuation: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  await pending;
  check("the pending load settles", reader.loadingList === false);

  reader.stop();
  check("stop() resets hidden state", reader.hiddenAvailable === false && reader.hiddenError === null);
} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
