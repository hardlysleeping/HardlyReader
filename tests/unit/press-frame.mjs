/**
 * The width a press draws at, while the window is still on its way.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/press-frame.mjs
 *
 * A press that keeps the pane widths asks the window for their sum, and the
 * frame takes several ticks to get there — one per step the window manager
 * takes. Drawn from the live measurement, every one of those ticks rewrote the
 * track list and restarted the transition it was in the middle of, so the
 * columns flew at the frame they were leaving and then turned round: measured in
 * WebKitGTK, pressing two from one column took the posts track 302px → 898px →
 * 534px → 414px over one press.
 *
 * What is asserted here, and nothing more:
 *   - a press draws the frame it asked for from the first frame, before any
 *     measurement arrives;
 *   - the tracks are the same list at every step of the window's travel, so the
 *     slide has one geometry to aim at;
 *   - once the window lands, a resize the user makes is followed again at once;
 *   - a press that resizes nothing (a fold), a drag and a slider never hold a
 *     width at all.
 *
 * `layout.svelte.ts` is a runes module, so it is compiled and imported from a
 * throwaway file, as the other layout suites do. `fitWindowTo()` reports failure
 * here because a Node process cannot resize a window — which is also the case
 * that has to correct itself rather than hold a frame that never arrives.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GEN_DIR = join(ROOT, "tests/unit/.gen");

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

globalThis.window = {
  innerWidth: 1200,
  innerHeight: 900,
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
  const out = join(GEN_DIR, "layout-frame.mjs");
  writeFileSync(out, code);
  return out;
}

let starts = 0;
/** A fresh module, i.e. a fresh app start: the singleton knows nothing yet. */
async function start(out, saved) {
  starts += 1;
  stored.clear();
  if (saved !== undefined) stored.set("hardlyreader.layout.v1", JSON.stringify(saved));
  const { layout } = await import(`${pathToFileURL(out).href}?start=${starts}`);
  return layout;
}

const generated = buildLayoutModule();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

try {
  // --- a Keep-widths press draws the frame it asked for ---------------------
  {
    // Opening at two panes in a 1200px window, with Keep widths on.
    const layout = await start(generated, { mode: 2, keepWidths: true, chosen: true });
    layout.setAvailable(1200);
    const twoWidth = layout.widthFor(2);
    check("two panes in a wide window", layout.mode === 2, `mode ${layout.mode} at ${layout.available}`);

    // Press one: it asks the window for 320, and nothing has reported it yet.
    const before = layout.pressSeq;
    const asked = layout.chooseMode(1);
    check("a press changes the mode at once", layout.mode === 1, `mode ${layout.mode}`);
    check(
      "and the frame it draws is the one it asked for, not the one it is in",
      layout.drawn === layout.widthFor(1) && layout.available === 1200,
      `drawn ${layout.drawn}, available ${layout.available}, wanted ${layout.widthFor(1)}`,
    );
    check(
      "which is one column of that width",
      layout.columns() === `${layout.widthFor(1)}px 0px 0px 0px 0px`,
      layout.columns(),
    );
    await asked;
    await settle();
    check("one press, one slide", layout.pressSeq === before + 1, `${before} → ${layout.pressSeq}`);
    check(
      "a refused resize corrects the frame at once rather than holding it",
      layout.drawn === layout.available,
      `drawn ${layout.drawn}, available ${layout.available}`,
    );
  }

  // --- the tracks do not move while the window travels ----------------------
  {
    const layout = await start(generated, { mode: 1, keepWidths: true, chosen: true });
    layout.setAvailable(1200);
    const target = layout.widthFor(2);
    void layout.chooseMode(2);
    const drawnOnce = layout.columns();
    check(
      "two panes, drawn at the width the press asked for",
      drawnOnce === `280px 6px ${target - 286}px 0px 0px`,
      drawnOnce,
    );
    // The window takes the trip in five steps, as a window manager does.
    const seen = [];
    for (const width of [1150, 1100, 1000, 900, 800, target]) {
      layout.setAvailable(width);
      seen.push(layout.columns());
    }
    check(
      "every step of the resize draws the same track list",
      seen.every((columns) => columns === drawnOnce),
      [...new Set(seen)].join(" | "),
    );
    check(
      "so the slide has one geometry to aim at, not one per tick",
      new Set(seen).size === 1,
      `${new Set(seen).size} different track lists`,
    );
    // The frame has arrived, so the hold is over: a resize the user makes is
    // theirs again, and the panes fit it.
    layout.setAvailable(1000);
    check(
      "a resize after the press is followed at once",
      layout.columns() === `280px 6px ${1000 - 286}px 0px 0px`,
      layout.columns(),
    );
  }

  // --- Keep window holds nothing: the panes fit the frame they are in --------
  {
    const layout = await start(generated, { mode: 1, keepWidths: false, chosen: true });
    layout.setAvailable(1400);
    void layout.chooseMode(2);
    check(
      "sharing the window, a press asks for no frame at all",
      layout.drawn === 1400 && layout.columns() === `280px 6px ${1400 - 286}px 0px 0px`,
      `drawn ${layout.drawn}, ${layout.columns()}`,
    );
    layout.setAvailable(1000);
    check(
      "and a resize is drawn at once, with no width held over it",
      layout.drawn === 1000 && layout.columns() === `280px 6px ${1000 - 286}px 0px 0px`,
      `drawn ${layout.drawn}, ${layout.columns()}`,
    );
  }

  // --- nothing that is not a resize holds a width ---------------------------
  {
    const layout = await start(generated, { mode: 2, keepWidths: true, chosen: true });
    layout.setAvailable(1200);
    const press = layout.pressSeq;
    layout.toggleSidebar();
    check("a fold is a press", layout.pressSeq === press + 1, `${press} → ${layout.pressSeq}`);
    check(
      "but it holds no width: it moves the panes inside the frame it has",
      layout.drawn === 1200,
      `drawn ${layout.drawn}`,
    );

    const held = [];
    layout.dragTo("sidebar", 360);
    held.push(layout.drawn);
    layout.dragTo("sidebar", 300);
    held.push(layout.drawn);
    layout.commit();
    check(
      "and a drag holds nothing either",
      held.every((drawn) => drawn === 1200) && layout.drawn === 1200,
      held.join(", "),
    );
    layout.setThreshold("one", 400);
    check("nor does a slider", layout.drawn === 1200, `drawn ${layout.drawn}`);
    // None of the three may arm the slide: `pressSeq` is what the view turns into
    // the transition, so a resize, a dragged divider and a settings slider all
    // have to land in one frame.
    check(
      "and none of them arms a slide",
      layout.pressSeq === press + 1,
      `${press} → ${layout.pressSeq}`,
    );
    layout.setAvailable(1200);
    check("nor does a resize", layout.pressSeq === press + 1, `${press} → ${layout.pressSeq}`);
  }

  // --- a stale hold cannot outlive the press that made it -------------------
  {
    const layout = await start(generated, { mode: 1, keepWidths: true, chosen: true });
    layout.setAvailable(1200);
    // A press with no measurement behind it and no frame in flight, then a
    // second press that does not resize. The second one must draw the frame it
    // is in, not the width of the first.
    void layout.chooseMode(2);
    layout.setAvailable(700);
    void layout.chooseMode(2);
    check(
      "a press that resizes nothing draws from the frame it is in",
      layout.drawn === 700,
      `drawn ${layout.drawn}, available ${layout.available}`,
    );
  }
} finally {
  // Nothing to clean up: the generated module lives in the suite's own scratch
  // directory, which the runner owns.
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
