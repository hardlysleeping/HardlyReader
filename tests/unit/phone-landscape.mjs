/**
 * A phone in landscape that fits: proportions instead of a desktop's pair of
 * numbers, and no column spent on an article nobody has opened.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs phone-landscape.mjs
 *
 * Two halves, because there are two things that could go wrong.
 *
 * The arithmetic is checked against the library directly: the profile at a
 * landscape iPhone's 844px frame, every column against the phone's own text
 * minimum, and the row with and without an article open. The point of the change
 * is a *number* — the feeds pane used to be 168px, a fifth of that frame — so
 * the number is what is measured, as a share of the frame rather than a
 * comparison with the old constant.
 *
 * The store is checked as a store: what a fresh phone opens with, that a width
 * the user shaped still wins, that a 0.6.0 save is recognised as the old default
 * rather than as a choice, that a rotation re-asks the question and a dragged
 * edge does not, and that the mode the user chose is never rewritten. The
 * desktop frame is checked last and it is the hard boundary: its four numbers
 * and its three-column track list are exactly what they were.
 *
 * `layout.svelte.ts` is a runes module, compiled and imported from a throwaway
 * file, as the other layout suites do.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import {
  GUTTER,
  MINIMUMS,
  PHONE_PAIR_LIST,
  PHONE_SHARES,
  layoutWidths,
  minimums,
  phoneLayout,
  tracks,
  gridTemplate,
} from "../../src/lib/panes.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------------- *
 * The profile, at the frame that was wrong
 * ------------------------------------------------------------------------- */

const FRAME = 844;
const profile = phoneLayout(FRAME);
const row = tracks(3, layoutWidths(profile, 3), { available: FRAME });
const share = (px) => px / FRAME;
const percent = (px) => `${(share(px) * 100).toFixed(1)}%`;

// The exact profile, so a later change to a share has to say so here too.
check(
  "at 844 the profile is 237 / 279 / 316",
  profile.sidebar === 237 && profile.list3 === 279 && profile.article === 316,
  JSON.stringify(profile),
);

// 28–30% of the *usable* frame, which is the number the task is about: the old
// profile drew 168, a fifth of it.
check(
  "the feeds pane lands in 28–30% of the frame",
  share(row[0]) >= 0.28 && share(row[0]) <= 0.3,
  `${row[0]}px = ${percent(row[0])}`,
);
check(
  "and the posts in 33–35%",
  share(row[2]) >= 0.33 && share(row[2]) <= 0.35,
  `${row[2]}px = ${percent(row[2])}`,
);

// Every column at or above the phone's own text minimum: this is the floor the
// proportions are not allowed to round past.
const mins = minimums("phone");
check(
  "every pane is at or above its text minimum",
  row[0] >= mins.sidebar && row[2] >= mins.list && row[4] >= mins.article,
  JSON.stringify({ drawn: [row[0], row[2], row[4]], mins }),
);
// The article pays for the two wider columns — 424 before, 316 now — but it is
// not squeezed to a sliver: it keeps more than a third of the frame, which is
// still a text column's worth.
check(
  "the article keeps more than a third of a landscape frame",
  share(row[4]) > 1 / 3 && row[4] >= MINIMUMS.phone.article,
  `${row[4]}px = ${percent(row[4])}`,
);
check("and the row is exactly the frame", row.reduce((a, b) => a + b, 0) === FRAME, JSON.stringify(row));
// The two columns the complaint was about: the feeds was 168 (19.9% of this
// frame) and the posts 240. Both are wider now, and the article still clears its
// own text minimum, which is what "roughly 28 / 33 / remainder" has to mean.
check(
  "both columns that were fixed are wider than the profile they replace",
  row[0] > 168 && row[2] > 240,
  `${row[0]} / ${row[2]}`,
);

// The shares themselves are documented numbers, not "whatever worked".
check(
  "the shares are 28% feeds and 33% posts",
  PHONE_SHARES.feeds === 0.28 && PHONE_SHARES.posts === 0.33,
  JSON.stringify(PHONE_SHARES),
);

// The profile has to be legal wherever a phone can honestly draw three columns,
// not only at the one width that was measured by hand.
for (const px of [660, 700, 780, 844, 900, 932]) {
  const drawn = tracks(3, layoutWidths(phoneLayout(px), 3), { available: px });
  const feeds = drawn[0] / px;
  check(
    `at ${px} the feeds are 28–30% and nothing is under its minimum`,
    feeds >= 0.28 && feeds <= 0.3 && drawn[0] >= mins.sidebar && drawn[2] >= mins.list && drawn[4] >= mins.article,
    JSON.stringify({ px, drawn, feeds: `${(feeds * 100).toFixed(1)}%` }),
  );
}

/* ------------------------------------------------------------------------- *
 * Nothing selected: the article's share goes to the posts
 * ------------------------------------------------------------------------- */

const spare = tracks(3, layoutWidths(profile, 3), { available: FRAME, articleless: true });
check(
  "with no article the posts take the remainder",
  spare[2] === FRAME - row[0] - GUTTER && spare[0] === row[0],
  JSON.stringify(spare),
);
check(
  "and the article's column and its seam are gone, not left as a gap",
  spare[3] === 0 && spare[4] === 0,
  JSON.stringify(spare),
);
check("the spare row is the frame too", spare.reduce((a, b) => a + b, 0) === FRAME, JSON.stringify(spare));
check(
  "the posts pane is the width the article used to hold, and then some",
  spare[2] > row[2] + row[4] - GUTTER,
  `${spare[2]} vs ${row[2]}+${row[4]}`,
);
// Two states of the same five tracks: that is what makes opening a post a move
// in the grid (interpolatable) instead of a re-layout.
check(
  "both states are five tracks, so the third column can slide back in",
  row.length === 5 && spare.length === 5,
  JSON.stringify({ row, spare }),
);

// One and two panes are untouched by the flag. Mode 2 has no third column to
// spare and mode 1 has one track; a desktop never sets it, and neither does a
// stacked three, where the article is a row rather than a column.
const widths = layoutWidths(profile, 3);
for (const [mode, template] of [
  [1, { available: FRAME }],
  [2, { available: FRAME }],
  [3, { available: FRAME, stacked: true }],
]) {
  check(
    `mode ${mode}${template.stacked ? " stacked" : ""} ignores the empty article`,
    gridTemplate(mode, widths, template) === gridTemplate(mode, widths, { ...template, articleless: true }),
    gridTemplate(mode, widths, { ...template, articleless: true }),
  );
}
check(
  "two panes still draw the feeds and one elastic column",
  gridTemplate(2, widths, { available: FRAME }) === `${profile.sidebar}px 6px ${FRAME - profile.sidebar - 6}px 0px 0px`,
  gridTemplate(2, widths, { available: FRAME }),
);
check(
  "and a phone's two-pane posts width is the one it shipped with",
  profile.list2 === PHONE_PAIR_LIST,
  String(profile.list2),
);

/* ------------------------------------------------------------------------- *
 * The store: what a phone opens with, and what it refuses to overwrite
 * ------------------------------------------------------------------------- */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GEN_DIR = join(ROOT, "tests/unit/.gen");
const STORAGE_KEY = "hardlyreader.layout.v1";

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

/**
 * A frame, as the two devices report it.
 *
 * `coarse` is what `detectShape()` reads for the pointer and `shortest` is its
 * other half, so a phone is a phone here for the same reason it is one in the
 * app rather than because the suite said so.
 */
function frame({ width, height, coarse = true }) {
  globalThis.window = {
    innerWidth: width,
    innerHeight: height,
    screen: { width, height, availWidth: width, availHeight: height },
  };
  globalThis.matchMedia = (query) => ({
    matches: coarse && query.includes("coarse"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
}

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
  const out = join(GEN_DIR, "layout-phone.mjs");
  writeFileSync(out, code);
  return out;
}

const generated = buildLayoutModule();

let starts = 0;
/** A fresh store for one frame, with whatever a previous install left behind. */
async function start(size, saved) {
  starts += 1;
  stored.clear();
  if (saved !== undefined) stored.set(STORAGE_KEY, JSON.stringify(saved));
  frame(size);
  const { layout } = await import(`${pathToFileURL(generated).href}?start=${starts}`);
  return layout;
}

const landscape = { width: 844, height: 390 };
const portrait = { width: 390, height: 844 };

try {
  // --- a fresh landscape phone ------------------------------------------
  {
    const layout = await start(landscape);
    check("a landscape phone is a phone", layout.device === "phone", layout.device);
    check(
      "it opens in one column, by nobody's choice",
      layout.desired === 1 && layout.mode === 1 && layout.chosen === false,
      `desired ${layout.desired}, mode ${layout.mode}, chosen ${layout.chosen}`,
    );
    check(
      "its panes are the profile, not 168 + 240",
      layout.panes.sidebar === 237 &&
        layout.panes.list3 === 279 &&
        layout.panes.article === 316 &&
        layout.panes.list2 === 240,
      JSON.stringify(layout.panes),
    );
    check(
      "which is one pane across the whole landscape frame",
      layout.columns() === "844px 0px 0px 0px 0px",
      layout.columns(),
    );
    check(
      "the widths behind it are the phone profile's, ready for a second pane",
      layout.shown.sidebar === 237 && layout.shown.list === 210,
      JSON.stringify(layout.shown),
    );

    // --- the choice is the user's ---------------------------------------
    layout.setMode(2);
    check(
      "pressing 2 is recorded and nothing else moves",
      layout.desired === 2 && layout.chosen === true && layout.panes.sidebar === 237 && layout.panes.list3 === 279,
      `desired ${layout.desired}, panes ${JSON.stringify(layout.panes)}`,
    );
    check(
      "two panes draw what two panes always drew",
      layout.columns() === "237px 6px 601px 0px 0px",
      layout.columns(),
    );
    layout.setMode(1);
    check(
      "and one pane is the whole frame",
      layout.mode === 1 && layout.columns() === "844px 0px 0px 0px 0px",
      layout.columns(),
    );
    // A narrow measurement must not answer a mode the user named: this is the
    // one branch that used to rewrite `desired` on every rotation.
    layout.setAvailable(700);
    check(
      "an explicit choice survives a resize",
      layout.desired === 1 && layout.mode === 1,
      `desired ${layout.desired}, mode ${layout.mode}`,
    );
  }

  // --- a phone that has shaped its own panes ----------------------------
  {
    // Only the drawer differs from the landscape profile's 237 — and that is
    // enough for these to be the user's numbers rather than the app's, so they
    // are drawn as they are and not re-profiled.
    const layout = await start(landscape, {
      mode: 3,
      chosen: true,
      panes: { sidebar: 260, list2: 240, list3: 279, article: 316 },
    });
    check(
      "stored widths win over the profile",
      layout.panes.sidebar === 260 && layout.panes.list3 === 279 && layout.panes.article === 316,
      JSON.stringify(layout.panes),
    );
    check(
      "and the row is drawn from them",
      layout.columns() === "260px 6px 279px 6px 293px",
      layout.columns(),
    );
  }

  // --- a phone put down in portrait, opened in landscape ----------------
  {
    // The profile of a 390px portrait frame is a legal save — a mode press made
    // it — but it is the app's answer, not the user's, and 150px is the fifth of
    // the screen this whole change is about. Opening in landscape re-asks it.
    const layout = await start(landscape, {
      mode: 1,
      chosen: false,
      panes: { sidebar: 150, list2: 240, list3: 210, article: 240 },
    });
    check(
      "a saved portrait profile is re-asked in the frame it is opened in",
      layout.panes.sidebar === 237 && layout.panes.list3 === 279 && layout.panes.article === 316,
      JSON.stringify(layout.panes),
    );
  }

  // --- a phone upgrading from 0.6.0 -------------------------------------
  {
    const layout = await start(landscape, {
      mode: 3,
      chosen: true,
      panes: { sidebar: 168, list2: 240, list3: 240, article: 320 },
    });
    check(
      "a save that is still the old fixed profile is answered with the new one",
      layout.panes.sidebar === 237 && layout.panes.list3 === 279 && layout.panes.article === 316,
      JSON.stringify(layout.panes),
    );
    check("and it is still the user's mode", layout.desired === 3 && layout.chosen === true);
    const dragged = await start(landscape, {
      mode: 3,
      chosen: true,
      panes: { sidebar: 210, list2: 240, list3: 240, article: 320 },
    });
    check(
      "one edge that differs is the user's, and is left alone",
      dragged.panes.sidebar === 210 && dragged.panes.list3 === 240,
      JSON.stringify(dragged.panes),
    );
  }

  // --- a rotation --------------------------------------------------------
  {
    const layout = await start(portrait);
    check(
      "a portrait phone's profile is its own frame's",
      layout.panes.sidebar === 150 && layout.panes.list3 === 210 && layout.panes.article === 240,
      JSON.stringify(layout.panes),
    );
    // Turned sideways: same phone, new frame, and the profile is a proportion of
    // it rather than a number frozen at launch.
    frame(landscape);
    layout.setAvailable(844);
    check(
      "turning it recomputes the profile for the frame it is now in",
      layout.panes.sidebar === 237 && layout.panes.list3 === 279 && layout.panes.article === 316,
      JSON.stringify(layout.panes),
    );
    check(
      "and it stays one column in landscape, so the list keeps its height",
      layout.mode === 1 && layout.desired === 1,
      `mode ${layout.mode}, desired ${layout.desired}`,
    );
  }
  {
    const layout = await start(portrait);
    // The user drags the drawer wide in portrait. That is theirs: a rotation is
    // not a reason to move an edge they placed.
    layout.dragTo("sidebar", 300);
    layout.commit();
    frame(landscape);
    layout.setAvailable(844);
    check(
      "a rotation leaves a dragged edge where the user put it",
      layout.panes.sidebar === 300,
      JSON.stringify(layout.panes),
    );
  }

  // --- the desktop frame is the hard boundary ---------------------------
  {
    const layout = await start({ width: 1440, height: 900, coarse: false });
    check("a 1440×900 window is a desktop", layout.device === "desktop", layout.device);
    check(
      "its panes are exactly the ones it shipped with",
      layout.panes.sidebar === 240 &&
        layout.panes.list2 === 260 &&
        layout.panes.list3 === 366 &&
        layout.panes.article === 320,
      JSON.stringify(layout.panes),
    );
    check(
      "and its three columns are exactly the pixels they were",
      layout.columns() === "240px 6px 366px 6px 822px",
      layout.columns(),
    );
    // The profile is a phone's, so a desktop never sees it — including the
    // legacy-quartet rule, which is gated on the device. A 168px drawer on a
    // desktop is simply clamped to its own floor (240), not replaced by a
    // proportion of 1440.
    const legacy = await start(
      { width: 1440, height: 900, coarse: false },
      { mode: 3, chosen: true, panes: { sidebar: 168, list2: 240, list3: 240, article: 320 } },
    );
    check(
      "a desktop save is never mistaken for a phone's old default",
      legacy.panes.sidebar === 240 && legacy.panes.list3 === 260,
      JSON.stringify(legacy.panes),
    );
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL threw — ${error && error.stack ? error.stack : String(error)}`);
}

/* ------------------------------------------------------------------------- *
 * The view: a phone only
 * ------------------------------------------------------------------------- */

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const main = read("src/views/Main.svelte");

check(
  "the empty article is a phone's answer, behind the device check",
  /const articleSpare = \$derived\(\s*layout\.device === "phone" && mode === 3 && !stackDrawn && reader\.selectedId === null,?\s*\)/.test(
    main,
  ),
  "articleSpare",
);
check(
  "and both the track list and the panes' own widths are told about it",
  (main.match(/articleless: articleSpare,/g) ?? []).length === 2,
  String((main.match(/articleless: articleSpare,/g) ?? []).length),
);
check(
  "the phone profile is the default, and it is a proportion of the frame",
  /function defaultPanes\(device: Device, available: number\): PaneLayout \{\s*return device === "phone" \? phoneLayout\(available\) : \{ \.\.\.DEFAULT_LAYOUT \};/.test(
    read("src/state/layout.svelte.ts"),
  ),
);
// With the column gone the posts are the outermost pane on the right, so they
// have to carry the notch's inset the article used to.
check(
  "the grid is marked when the article's column is spared",
  /class:articleless=\{articleSpare\}/.test(main),
  "class:articleless",
);
check(
  "and the posts take the right edge's inset while they hold it",
  /html\[data-device="phone"\] \.panes\.articleless > \.slot\.posts \{\s*padding-right: var\(--safe-right\);\s*\}/.test(
    read("src/app.css"),
  ),
  "articleless inset",
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
