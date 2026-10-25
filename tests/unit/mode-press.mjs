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
// The desktop shell, which can resize its own window (see `press-frame.mjs` for
// the shell that cannot).
globalThis.window = {
  innerWidth: 1100,
  innerHeight: 720,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
  __TAURI_INTERNALS__: {},
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

  // --- 3 → 2 → 3, and 3 before 2 has landed ----------------------------------
  {
    const layout = await start(generated);
    layout.load();
    layout.setAvailable(1600);
    await layout.chooseMode(3);
    layout.setAvailable(layout.widthFor(3));
    check(
      "three columns at the width they need",
      layout.mode === 3 && layout.stacked === false,
      `mode ${layout.mode}, stacked ${layout.stacked} at ${layout.available}`,
    );

    await layout.chooseMode(2);
    layout.setAvailable(layout.widthFor(2));
    check("two panes, and the window keeps two panes' width", layout.mode === 2, `mode ${layout.mode}`);

    await layout.chooseMode(3);
    const want = layout.widthFor(3);
    check(
      "the press back to three asks for the columns' width",
      want === layout.stackNeed,
      `wanted ${want}, columns need ${layout.stackNeed}`,
    );
    layout.setAvailable(want);
    check(
      "and 3 after 2 is three columns, not a stack",
      layout.mode === 3 && layout.stacked === false,
      `mode ${layout.mode}, stacked ${layout.stacked} at ${layout.available} (need ${layout.stackNeed})`,
    );

    // The same press without waiting for the shrinking window to report: the ask
    // is made from where the window is heading, not from where it still is.
    await layout.chooseMode(2);
    await layout.chooseMode(3);
    layout.setAvailable(layout.stackNeed);
    check(
      "and pressing 3 before 2 has landed still lands on three",
      layout.mode === 3 && layout.stacked === false,
      `mode ${layout.mode}, stacked ${layout.stacked} at ${layout.available}`,
    );
  }

  // --- the band protects a resize nobody asked for, on the way out ----------
  {
    const layout = await start(generated);
    layout.load();
    layout.setAvailable(layout.widthFor(1));
    check("a narrow window shows one pane", layout.mode === 1, `mode ${layout.mode}`);
    // No press behind this: a window dragged to exactly three panes' width. The
    // band is charged on the way out of a mode, never on the way in — otherwise
    // "resize until it fits" lands 120px late and reads as a window that never
    // gives you the layout you made room for.
    layout.setAvailable(layout.widthFor(3));
    check(
      "a dragged-to-fit window is fitted",
      layout.mode === 3,
      `mode ${layout.mode} at ${layout.available}, wanted ${layout.widthFor(3)}`,
    );
    // Coming back in is the jiggle the band exists for.
    const three = layout.widthFor(3);
    layout.setAvailable(three - 40);
    check("a jiggle inside the band keeps three", layout.mode === 3, `mode ${layout.mode} at ${three - 40}`);
    layout.setAvailable(three - 200);
    check(
      "past it, the third column becomes the stack",
      layout.mode === 3 && layout.stacked === true,
      `mode ${layout.mode}, stacked ${layout.stacked} at ${three - 200}`,
    );
  }

  // --- a stack may be as narrow as two panes, and no narrower ----------------
  {
    // Keeping widths, a stacked three is a two-pane window: feeds beside one
    // content column. It used to be demoted to two the moment the window passed
    // the pair's own column arithmetic (813 in the owner's layout), which read as
    // a third pane that would not stay stacked. The floor it must hold is the
    // two-pane one, because that is the layout it is imitating.
    // Keep widths and shaped columns are saved, and every later block loads
    // what the one before it wrote — so this one puts the store back as it
    // found it rather than leaving its own layout behind for them.
    stored.clear();
    const layout = await start(generated);
    layout.load();
    layout.setKeepWidths(true);
    layout.setAvailable(1600);
    await layout.chooseMode(3);
    layout.setAvailable(1314);
    layout.setThreshold("three", 1314);
    layout.setAvailable(1314);
    const two = layout.thresholds.two;
    layout.setAvailable(1314);
    check(
      "a wide window with Keep widths draws three columns",
      layout.mode === 3 && layout.stacked === false,
      `mode ${layout.mode}, stacked ${layout.stacked} at ${layout.available}`,
    );
    layout.setAvailable(two + 100);
    check(
      "narrowed into the stack, the third pane stays",
      layout.mode === 3 && layout.stacked === true,
      `mode ${layout.mode}, stacked ${layout.stacked} at ${layout.available}`,
    );
    layout.setAvailable(two);
    check(
      "and it holds down to the two-pane minimum itself",
      layout.mode === 3 && layout.stacked === true,
      `mode ${layout.mode}, stacked ${layout.stacked} at ${layout.available} (two ${two})`,
    );
    layout.setAvailable(two - 120);
    check(
      "below two panes' worth, the stack gives way",
      layout.mode !== 3,
      `mode ${layout.mode} at ${layout.available}`,
    );
    stored.clear();
  }

  // --- shrinking a chosen three goes through every arrangement, in order -----
  {
    // Side by side, three panes, and the window narrowing: the columns fold to
    // the stacked pair, then the pair folds to two panes, then to one. It used to
    // jump from the stack straight to a single column, because the stack and the
    // pair were refused at the same pixel — the owner saw "pane 1 only long
    // before I get to 240px". The choice itself must never be switched off: the
    // window rearranges what is drawn, it does not undo the setting.
    for (const keep of [true, false]) {
      stored.clear();
      const layout = await start(generated);
      layout.load();
      layout.setKeepWidths(keep);
      layout.setAvailable(1600);
      await layout.chooseMode(3);
      layout.setAvailable(1314);
      if (keep) {
        layout.setThreshold("three", 1314);
        layout.setAvailable(1314);
      }
      check(
        `Side by side is the choice before shrinking (keep ${keep})`,
        layout.stackChosen === false,
        `chosen ${layout.stackChosen}`,
      );

      const seen = [];
      for (const width of [1314, 1100, 900, 800, 700, 620, 560, 520, 470, 400, 300]) {
        layout.setAvailable(width);
        // Only three panes have an arrangement to report: two and one are drawn
        // the same however the pair would have stacked.
        const step = layout.mode === 3 ? (layout.stacked ? "3s" : "3") : String(layout.mode);
        if (seen[seen.length - 1] !== step) seen.push(step);
        check(
          `the choice survives ${width}px (keep ${keep})`,
          layout.stackChosen === false,
          `chosen ${layout.stackChosen} at ${width}`,
        );
      }
      check(
        `the panes tuck away one at a time (keep ${keep})`,
        seen.join(" ") === "3 3s 2 1",
        `saw ${seen.join(" ")}`,
      );
      stored.clear();
    }
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
    // Keeping widths: the frame follows the panes, so the press can shrink the
    // window by the article's width and leave the posts column where it is.
    stored.clear();
    const layout = await start(generated);
    layout.load();
    layout.setKeepWidths(true);
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
