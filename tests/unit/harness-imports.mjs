/**
 * The four copies of the import-rewrite list, kept honest.
 *
 *   node tests/unit/harness-imports.mjs
 *
 * Seven suites compile `reader.svelte.ts` themselves with Svelte's
 * `compileModule` — `build-reader`, `reader-state`, `favorites`, `hidden-write`,
 * `hidden-local`, `positions` and `sync-progress` — so every relative import in
 * that source file
 * has to be rewritten to the real file, and each of them carries its own copy
 * of the list. A new relative import in either source file, added without
 * touching all four lists, fails those suites with
 * `Cannot find module .../tests/unit/lib/<name>/index.ts`, which names the
 * generated file rather than the missing list entry. That has now happened
 * twice; this suite says which specifier and which file, before the runner
 * reports ten unrelated-looking failures.
 *
 * It is a source-text check on purpose: the lists are source text, and the
 * suite has to hold even while the modules it guards do not compile.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SOURCES = ["src/state/reader.svelte.ts"];
const BUILDERS = [
  "tests/unit/build-reader.mjs",
  "tests/unit/reader-state.mjs",
  "tests/unit/favorites.mjs",
  "tests/unit/hidden-write.mjs",
  "tests/unit/hidden-local.mjs",
  "tests/unit/positions.mjs",
  "tests/unit/sync-progress.mjs",
];

/** Every relative specifier a source file imports, as written. */
function specifiers(source) {
  const text = read(source);
  const found = new Set();
  for (const match of text.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) found.add(match[1]);
  return [...found].sort();
}

/**
 * Whether a builder's list names this specifier — in either spelling.
 *
 * A rewrite target may be written as `"./hidden"` or, in the chains that rewrite
 * a string that is itself quoted, as `\\"./hidden\\"`. Both are the same import,
 * and a guard that only knew one spelling silently excused the file that used
 * the other (which is how `hidden-local.mjs` went unlisted here).
 */
const named = (text, spec) => text.includes(`"${spec}"`) || text.includes(`\\"${spec}\\"`);

const builders = BUILDERS.map((path) => ({ path, text: read(path) }));

for (const source of SOURCES) {
  const specs = specifiers(source);
  check(`${source} imports something relative at all`, specs.length > 0, String(specs.length));
  check("every suite that compiles it carries a list", builders.length === 7, String(builders.length));
  for (const builder of builders) {
    // A builder that rewrites none of this module's specifiers builds it through
    // `generated()`, which resolves every relative import on its own (that is
    // how `reading.svelte.ts` is handled in `build-reader.mjs`). One that
    // rewrites some of them is carrying the hand-written list, and then it has
    // to carry all of them.
    const listed = specs.filter((spec) => named(builder.text, spec));
    if (listed.length === 0) continue;
    const missing = specs.filter((spec) => !named(builder.text, spec));
    check(
      `${builder.path} rewrites every relative import of ${source}`,
      missing.length === 0,
      missing.length === 0 ? "" : `missing ${missing.join(", ")}`,
    );
  }
}

// And the new modules the lists were just taught about actually exist, so a
// rename cannot leave four lists pointing at a file nobody has.
for (const spec of [
  "../lib/stream-loads",
  "../lib/stream-perf",
  "../lib/stream-scroll",
  "../lib/extract-ledger",
  "../lib/full-text",
]) {
  const file = `src/${spec.replace("../", "")}.ts`;
  check(`${file} is where the lists say it is`, /export /.test(read(file)));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
