/**
 * A mode press must survive the width it asks the window for.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/mode-press.mjs
 *
 * Pressing 1 collapses the window to the one-pane width, and pressing 3 then
 * asks for the three-pane width. The ResizeObserver reports that width while the
 * resize call is still in flight, so the measurement is the one that decides —
 * and a banded one sees the old mode and keeps it, which is how the window ended
 * up wide with one stretched pane in it.
 *
 * What is asserted, and nothing more:
 *   - 3 → 1 → 3 lands in three panes, with the measurements arriving inside the
 *     press's grace window and no other help;
 *   - the same measurement arriving with no press behind it stays banded, so an
 *     accidental resize still cannot flip the layout;
 *   - two presses in flight resolve to the last one, whatever the measurements
 *     report in between.
 *
 * `layout.svelte.ts` is a runes module, so it is type-stripped, compiled with
 * Svelte's `compileModule` and imported from a throwaway file, as the other
 * layout suites do. `localStorage` and `window` are stubs; `fitWindowTo()`
 * reports failure here because a Node process cannot resize a window, which is
 * exactly what makes the observer's report the deciding event.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GEN_DIR = join(ROOT, "tests/unit/.gen");
const STORAGE_KEY = "hardlyreader.layout.v1";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
  clear: () => stored.clear(),
  key: (index) => [...stored.keys()][index] ?? null,
  get length() {
    return stored.size;
  },
};

/** A desktop: a fine pointer, a 1920×1080 screen, and no window it can resize. */
globalThis.window = {
  innerWidth: 1100,
  innerHeight: 720,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
};
globalThis.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});

/**
 * The module, compiled and written where Node can import it.
 *
 * Its relative imports are rewritten to absolute file URLs: the generated file
 * lives outside `src/state`, and every relative specifier in the source is
 * relative to that directory.
 */
function buildLayoutModule() {
  const source = readFileSync(join(ROOT, "src/state/layout.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "layout.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "layout.svelte.ts" });
  const code = compiled.js.code.replace(/from\s+"(\.[^"]*)"/g, (whole, specifier) => {
    const target = join(ROOT, "src/state", `${specifier}.ts`);
    if (!existsSync(target)) throw new Error(`unresolved import ${specifier} from layout.svelte.ts`);
    return `from ${JSON.stringify(pathToFileURL(target).href)}`;
  });
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "layout-press.mjs");
  writeFileSync(out, code);
  return out;
}

let starts = 0;
/** A fresh module, i.e. a fresh app start: the singleton knows nothing yet. */
async function start(out) {
  starts += 1;
  const { layout } = await import(`${pathToFileURL(out).href}?start=${starts}`);
  return layout;
}

const generated = buildLayoutModule();

try {
  // --- 3 → 1 → 3, the reported sequence --------------------------------------
  {
    const layout = await start(generated);
    layout.load();
    layout.setAvailable(1600);
    await layout.chooseMode(3);
    check("a wide window opens in three panes", layout.mode === 3, `mode ${layout.mode}`);

    await layout.chooseMode(1);
    // Pressing 1 asks for the one-pane width; the window obeys and reports it.
    const oneWidth = layout.widthFor(1);
    layout.setAvailable(oneWidth);
    check(
      "pressing 1 collapses the window to one pane",
      layout.mode === 1 && layout.available === oneWidth,
      `mode ${layout.mode}, available ${layout.available}`,
    );

    await layout.chooseMode(3);
    // The press asked for the three-pane width. The observer reports it while
    // the resize call is still in flight — the case that used to undo the press.
    layout.setAvailable(layout.widthFor(3));
    check(
      "pressing 3 after 1 shows three panes",
      layout.mode === 3,
      `mode ${layout.mode}, available ${layout.available}, desired ${layout.desired}`,
    );
    check(
      "the measurement it asked for is the one it got",
      layout.available === layout.widthFor(3),
      `available ${layout.available}, wanted ${layout.widthFor(3)}`,
    );
  }

  // --- the band still protects a resize nobody asked for --------------------
  {
    const layout = await start(generated);
    layout.load();
    layout.setAvailable(layout.widthFor(1));
    check("a narrow window shows one pane", layout.mode === 1, `mode ${layout.mode}`);
    // No press behind this: a window dragged to exactly three panes' width.
    layout.setAvailable(layout.widthFor(3));
    check(
      "a dragged-to-fit window keeps the band",
      layout.mode === 1,
      `mode ${layout.mode} after an unasked-for measurement`,
    );
  }

  // --- two presses in flight resolve to the last one ------------------------
  {
    const layout = await start(generated);
    layout.load();
    layout.setAvailable(1600);
    // Both presses are made before either window resize has landed.
    const first = layout.chooseMode(3);
    const second = layout.chooseMode(1);
    await Promise.all([first, second]);
    layout.setAvailable(layout.widthFor(1));
    check(
      "the last press decides the mode",
      layout.desired === 1 && layout.mode === 1,
      `desired ${layout.desired}, mode ${layout.mode}`,
    );
    // And a measurement from the superseded press cannot promote it back.
    layout.setAvailable(layout.widthFor(3));
    check(
      "a superseded press cannot promote the mode",
      layout.mode === 1,
      `mode ${layout.mode} at ${layout.available}px`,
    );
  }

  // --- pane one keeps the width the user gave it ----------------------------
  {
    const layout = await start(generated);
    layout.load();
    layout.setAvailable(1600);
    await layout.chooseMode(3);
    layout.dragTo("sidebar", 420);
    layout.commit();
    check("a dragged divider sets pane one", layout.panes.sidebar === 420, `sidebar ${layout.panes.sidebar}`);
    check(
      "the one-pane width is pane one's width",
      layout.widthFor(1) === 420,
      `widthFor(1) ${layout.widthFor(1)}`,
    );

    for (const mode of [2, 1, 3, 2, 1]) {
      await layout.chooseMode(mode);
      layout.setAvailable(Math.max(layout.available, layout.widthFor(mode)));
      check(
        `pressing ${mode} leaves pane one alone`,
        layout.panes.sidebar === 420,
        `sidebar ${layout.panes.sidebar} after ${mode}`,
      );
    }
    check(
      "pressing 1 asks the window for pane one's width",
      layout.widthFor(1) === 420,
      `widthFor(1) ${layout.widthFor(1)}`,
    );

    // The settings slider writes the same number a drag does.
    layout.setThreshold("one", 360);
    check("the slider moves pane one", layout.panes.sidebar === 360, `sidebar ${layout.panes.sidebar}`);
    check(
      "the read-out agrees with the pane",
      layout.thresholds.one === 360,
      `thresholds.one ${layout.thresholds.one}`,
    );
    check("the slider asks for what it set", layout.widthFor(1) === 360, `widthFor(1) ${layout.widthFor(1)}`);

    // A window dragged narrow and back again does not rewrite the setting.
    layout.setAvailable(500);
    layout.setAvailable(1600);
    check(
      "a dragged window leaves pane one alone",
      layout.panes.sidebar === 360,
      `sidebar ${layout.panes.sidebar}`,
    );
  }

  // --- 3 → 2: the article leaves and takes its width with it ---------------
  {
    const layout = await start(generated);
    layout.load();
    layout.setAvailable(1600);
    await layout.chooseMode(3);
    layout.dragTo("sidebar", 300);
    layout.commit();
    // The window is at the panes' own width for three.
    const three = layout.widthFor(3);
    const two = layout.widthFor(2);
    layout.setAvailable(three);
    const twoPanePosts = layout.panes.list3;

    await layout.chooseMode(2);
    layout.setAvailable(two);
    check(
      "pressing 2 leaves with the third pane's width",
      layout.available === two,
      `available ${layout.available}, two wants ${two}`,
    );
    check(
      "and the posts pane keeps its width",
      layout.shown.list === twoPanePosts,
      `list ${layout.shown.list}, was ${twoPanePosts}`,
    );
    check("and the feeds pane keeps its width", layout.shown.sidebar === 300, `sidebar ${layout.shown.sidebar}`);

    // Back to three: the article returns at its own width, the posts pane again.
    await layout.chooseMode(3);
    layout.setAvailable(three);
    check(
      "pressing 3 brings the window and the posts pane back unchanged",
      layout.available === three && layout.shown.list === twoPanePosts,
      `available ${layout.available}, list ${layout.shown.list}`,
    );

    // The other answer: the window stays and the posts pane takes the space.
    layout.setKeepWidths(false);
    layout.setAvailable(three);
    await layout.chooseMode(2);
    const kept = layout.available;
    layout.setAvailable(kept);
    // The posts pane is `1fr` in two panes, so the room it takes is the layout's
    // job, not a number here: what this side owns is the window staying put.
    check(
      "sharing keeps the window and leaves the posts pane to take the room",
      layout.available === three && layout.mode === 2,
      `available ${layout.available} (was ${three}), mode ${layout.mode}`,
    );
  }

  // --- the stored layout is still a layout --------------------------------
  {
    const layout = await start(generated);
    layout.load();
    layout.setAvailable(1400);
    await layout.chooseMode(2);
    layout.setAvailable(1200);
    const saved = JSON.parse(stored.get(STORAGE_KEY));
    check("a press is written", saved.mode === 2, `saved mode ${saved?.mode}`);
  }
} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
