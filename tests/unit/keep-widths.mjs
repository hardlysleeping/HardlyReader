/**
 * "Keep widths" and "Keep window" each remember their own frame.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/keep-widths.mjs
 *
 * The two sizing modes want different windows for the same layout: keeping the
 * panes fits the window to their sum, sharing it fits the panes into whatever
 * frame there is. The toggle used to flip the flag and nothing else, so the
 * first frame after it belonged to the mode being left — the reported "pane one
 * doesn't make sense on keep widths right after swapping from keep window, it
 * eventually corrects itself" — and only a later press or resize put the layout
 * right.
 *
 * What is asserted here:
 *   - switching on asks for the tuned sum and draws it from the first frame;
 *   - switching off asks for the frame that sizing mode last had, and that frame
 *     is remembered across a save and a relaunch;
 *   - a toggle with no remembered frame resizes nothing;
 *   - the tracks change once per toggle, with the fit, and never on their own or
 *     once per resize tick.
 *
 * `layout.svelte.ts` is a runes module, compiled and imported from a throwaway
 * file, as the other layout suites do.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const out = join(GEN_DIR, "layout-keep.mjs");
  writeFileSync(out, code);
  return out;
}

let starts = 0;
async function start(out, saved) {
  starts += 1;
  stored.clear();
  if (saved !== undefined) stored.set(STORAGE_KEY, JSON.stringify(saved));
  const { layout } = await import(`${pathToFileURL(out).href}?start=${starts}`);
  return layout;
}

const generated = buildLayoutModule();

try {
  // --- switching Keep widths on asks for the tuned sum ----------------------
  {
    const layout = await start(generated, { mode: 2, keepWidths: false, chosen: true });
    layout.setAvailable(1200);
    check("opening in a shared window", layout.mode === 2 && layout.keepWidths === false, `mode ${layout.mode}`);
    // The panes fitted into that window, which is what the frame shows.
    check(
      "the panes fill the shared frame",
      layout.columns() === "280px 6px 914px 0px 0px",
      layout.columns(),
    );

    const pressed = layout.pressSeq;
    const tuned = layout.widthFor(layout.desired);
    layout.setKeepWidths(true);
    check("the setting is on", layout.keepWidths === true);
    check(
      "the frame it was in is remembered, not derived",
      layout.keepWindowWidth === 1200,
      String(layout.keepWindowWidth),
    );
    check(
      "and it asks for the tuned sum, drawing it before the window arrives",
      layout.drawn === tuned && layout.available === 1200,
      `drawn ${layout.drawn}, available ${layout.available}, tuned ${tuned}`,
    );
    check(
      "so the panes are the tuned widths, not the shared frame's proportions",
      layout.columns() === `280px 6px ${tuned - 286}px 0px 0px`,
      layout.columns(),
    );
    check("one toggle, one slide", layout.pressSeq === pressed + 1, `${pressed} → ${layout.pressSeq}`);

    // The frame travels in steps, as a window manager takes them. One track list
    // for the whole trip: the fit and the tracks change together, once.
    const drawnOnce = layout.columns();
    const seen = [];
    for (const width of [1150, 1050, 950, 850, tuned]) {
      layout.setAvailable(width);
      seen.push(layout.columns());
    }
    check(
      "the tracks are the same list at every step of the resize",
      seen.every((columns) => columns === drawnOnce),
      [...new Set(seen)].join(" | "),
    );
    check(
      "and the slide is one per toggle, not one per tick",
      layout.pressSeq === pressed + 1,
      `${pressed} → ${layout.pressSeq}`,
    );
    check(
      "the tuned sum is the frame the window ended at",
      layout.available === tuned,
      `available ${layout.available}, tuned ${tuned}`,
    );
    check(
      "and the width of the other sizing mode is in the save",
      JSON.parse(stored.get(STORAGE_KEY)).keepWindowWidth === 1200,
      stored.get(STORAGE_KEY),
    );

    // --- switching it off asks for the frame Keep window last had ----------
    const tunedFrame = layout.available;
    layout.setKeepWidths(false);
    check("the setting is off", layout.keepWidths === false);
    check(
      "and the frame being entered is the remembered one",
      layout.drawn === 1200 && layout.available === tunedFrame,
      `drawn ${layout.drawn}, available ${layout.available}`,
    );
    check(
      "the panes fit that frame, so pane one is as wide as it was",
      layout.columns() === "280px 6px 914px 0px 0px",
      layout.columns(),
    );
    check("one toggle, one slide", layout.pressSeq === pressed + 2, `${pressed} → ${layout.pressSeq}`);
    for (const width of [800, 900, 1000, 1100, 1200]) layout.setAvailable(width);
    check(
      "a resize after it is followed at once",
      layout.available === 1200 && layout.columns() === "280px 6px 914px 0px 0px",
      `${layout.available}: ${layout.columns()}`,
    );
    // And it is stable: the frame does not creep on the next measurement.
    layout.setAvailable(1200);
    check("nothing moves on the next measurement", layout.drawn === 1200, `drawn ${layout.drawn}`);
  }

  // --- a toggle with no remembered frame does not resize --------------------
  {
    const layout = await start(generated, { mode: 2, keepWidths: true, chosen: true });
    layout.setAvailable(1200);
    check("opening in a kept-widths window", layout.keepWidths === true && layout.mode === 2);
    check("with nothing remembered yet", layout.keepWindowWidth === null, String(layout.keepWindowWidth));
    const pressed = layout.pressSeq;
    layout.setKeepWidths(false);
    check("the toggle still slides once", layout.pressSeq === pressed + 1, `${pressed} → ${layout.pressSeq}`);
    check(
      "but it asks for no frame, because there is none to go back to",
      layout.drawn === 1200 && layout.available === 1200,
      `drawn ${layout.drawn}, available ${layout.available}`,
    );
    check(
      "and the panes fit the frame they are already in",
      layout.columns() === "280px 6px 914px 0px 0px",
      layout.columns(),
    );
  }

  // --- the two shapes keep two answers --------------------------------------
  // The screen decides the shape, not the window: holding a phone upright is
  // portrait, the same phone turned is landscape, a monitor is landscape — and
  // a window the app resized itself never changes which setting is in force.
  {
    const landscapeScreen = { width: 1920, height: 1080 };
    const portraitScreen = { width: 1080, height: 1920 };
    const layout = await start(generated, { mode: 2, keepWidths: true, chosen: true });
    layout.setAvailable(700);
    check("a wide screen keeps the setting", layout.keepWidths === true);
    check(
      "...even when the window itself is taller than it is wide",
      layout.keepWidthsInLandscape === true && layout.keepWidthsInPortrait === false,
      `${layout.keepWidthsInLandscape}/${layout.keepWidthsInPortrait}`,
    );

    // Upright: its own answer, which ships as Keep window.
    globalThis.window.screen = portraitScreen;
    check("upright starts keeping the window", layout.keepWidths === false);
    layout.setKeepWidthsFor("portrait", true);
    check("upright can be set to keep widths", layout.keepWidths === true);

    // Turned: the other answer is untouched by that.
    globalThis.window.screen = landscapeScreen;
    check("turning back is the landscape answer", layout.keepWidths === true);
    layout.setKeepWidthsFor("landscape", false);
    check("landscape can be set on its own", layout.keepWidths === false);

    globalThis.window.screen = portraitScreen;
    check("and upright still holds its own", layout.keepWidths === true);
    globalThis.window.screen = landscapeScreen;
  }

  // --- the memory survives a save and a relaunch ---------------------------
  {
    const layout = await start(generated, { mode: 2, keepWidths: false, chosen: true });
    layout.setAvailable(1440);
    layout.setKeepWidths(true);
    layout.setAvailable(layout.widthFor(2));
    const saved = stored.get(STORAGE_KEY);
    check("the save carries the frame", JSON.parse(saved).keepWindowWidth === 1440, saved);

    // A relaunch: the same save, a window the OS sized (the stub's 1200).
    const relaunched = await start(generated, JSON.parse(saved));
    check(
      "the memory comes back with the layout",
      relaunched.keepWindowWidth === 1440,
      String(relaunched.keepWindowWidth),
    );
    check(
      "and launch does not resize the window to it",
      relaunched.available === 1200 && relaunched.drawn === 1200,
      `available ${relaunched.available}, drawn ${relaunched.drawn}`,
    );
    // ...but the toggle still uses it.
    relaunched.setKeepWidths(false);
    check(
      "the toggle after a relaunch puts the remembered frame back",
      relaunched.drawn === 1440,
      `drawn ${relaunched.drawn}`,
    );
  }

  // --- a stored frame is clamped, not trusted ------------------------------
  {
    const high = await start(generated, { mode: 2, keepWidths: false, keepWindowWidth: 40000 });
    check("an absurd stored frame is clamped", high.keepWindowWidth === 8192, String(high.keepWindowWidth));
    const low = await start(generated, { mode: 2, keepWidths: false, keepWindowWidth: 40 });
    check("and so is one narrower than a pane can be", low.keepWindowWidth === 240, String(low.keepWindowWidth));
    const nonsense = await start(generated, { mode: 2, keepWidths: false, keepWindowWidth: "wide" });
    check("a stored value that is not a number is ignored", nonsense.keepWindowWidth === null, String(nonsense.keepWindowWidth));
  }
} finally {
  // The generated module lives in the suite's own scratch directory.
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
