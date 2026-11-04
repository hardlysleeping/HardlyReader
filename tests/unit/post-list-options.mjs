/**
 * The post list's options, where the views are chosen.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/post-list-options.mjs
 *
 * The owner's ask (2026-11-01): *"Post list options need to be accessible from
 * the view options in topic list, like where you get to pick between the 4 is
 * where the button to get a popup like our other popup for text settings (Aa)
 * but for post list options when on view 1, it shouldnt be tucked away in
 * settings for mobile, we need the visual feedback when using it."*
 *
 * So the seam this file guards is *which surface owns the knobs on a phone*,
 * and the thing that would break silently is the sheet growing a second set of
 * rows: the rows are `PostListPanel`'s, the same ones the settings section
 * draws, writing the same `reading` stores. Read as source, like
 * `phone-density.mjs` — what the sheet looks like is a measurement in the
 * running app (390×844), and it is reported there, not asserted here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const list = read("src/components/ArticleList.svelte");
const controls = read("src/components/ListControls.svelte");
const postList = read("src/components/PostListPanel.svelte");
const sheet = read("src/components/Sheet.svelte");

/* ---------------------------------------------------------------------------
 * 1. The bar grew one button, beside the four shapes, and the four are whole.
 * ------------------------------------------------------------------------- */

check(
  "the bar mounts the options control",
  /import ListControls from "\.\/ListControls\.svelte"/.test(list) &&
    /<ListControls \{view\} \/>/.test(list),
);

check(
  "it sits in the view group, after the four shapes",
  (() => {
    const from = list.indexOf('class="views"');
    const to = list.indexOf("</div>", from);
    if (from < 0 || to < 0) return false;
    const group = list.slice(from, to);
    const shapes = group.indexOf("{#each LIST_VIEWS as option (option)}");
    const eachEnd = group.indexOf("{/each}", shapes);
    const mount = group.indexOf("<ListControls {view} />");
    return shapes >= 0 && eachEnd >= 0 && mount > eachEnd;
  })(),
  "the control must be inside the view group and after the LIST_VIEWS loop",
);

check(
  "the four shapes are still drawn from LIST_VIEWS, one button each",
  /\{#each LIST_VIEWS as option \(option\)\}/.test(list) &&
    (list.match(/class="viewicon"/g) ?? []).length === 1,
  "one shape button inside the loop; the extras carry their own class",
);

check(
  "the bar's own knob buttons are still a window's only",
  /\{#if layout\.device !== "phone"\}[\s\S]{0,200}class="viewicon end"/.test(list),
  "the phone bar did not quietly grow the controls the sheet exists for",
);

/* ---------------------------------------------------------------------------
 * 2. The control: a phone's, for the views that have knobs, opening a sheet.
 * ------------------------------------------------------------------------- */

check(
  "it is drawn on a phone, and only where the rows have something to say",
  /const offers = \$derived\(\s*layout\.device === "phone" && \(view === "regular" \|\| view === "grid"\),?\s*\)/.test(
    controls,
  ),
  "Rows and Grid are the two views whose knobs left the phone bar",
);

/*
 * The pitfall this file exists for, in one place: the sheet's node is moved
 * into `body` by `Sheet` itself, so any `{#if}` block that shares a parent with
 * the sheet's own block stops being re-inserted — the trigger came back only
 * after a reload, and the second open had no scrim. The trigger therefore hides
 * itself instead of being a block, and exactly one block remains: the sheet's.
 */
check(
  "the trigger hides itself rather than being a block",
  /hidden=\{!offers\}/.test(controls) && !/\{#if offers\}/.test(controls),
  "a second block in this fragment shares an anchor with the portalled sheet",
);

check(
  "exactly one conditional remains, and it is the sheet's",
  (controls.match(/\{#if /g) ?? []).length === 1 &&
    /\{#if open\}[\s\S]{0,120}<Sheet label="Post list options"/.test(controls),
);

check(
  "the trigger says what it opens, and that it opens a dialog",
  /aria-haspopup="dialog"/.test(controls) &&
    /aria-label="Post list options"/.test(controls) &&
    /aria-expanded=\{open\}/.test(controls),
);

check(
  "it opens the sheet, and the sheet closes on its own gesture",
  /<Sheet label="Post list options" onclose=\{close\}>/.test(controls) &&
    /\{#if open\}/.test(controls),
);

check(
  "the sheet holds the panel's own rows, with a way out",
  /<PostListPanel ondone=\{close\} \/>/.test(controls),
);

check(
  "the control keeps no state but whether it is open",
  (controls.match(/= \$state/g) ?? []).length === 1 &&
    !/localStorage|writePrefs|savePrefs/.test(controls) &&
    !/reading\.set/.test(controls),
  "a second copy of the store's writes is how two surfaces drift apart",
);

check(
  "and it dismisses itself when the view loses its knobs",
  /\$effect\(\(\) => \{\s*if \(!offers\) open = false;\s*\}\);/.test(controls),
);

check(
  "it is styled by its own file, not by the bar's scope",
  /class="options"/.test(controls) && /\.options \{/.test(controls) && /\.options svg \{/.test(controls),
  "a component's styles do not reach into another component's markup",
);

check(
  "its pressed colour and its thumb size match the shapes beside it",
  /\.options\.on \{[\s\S]{0,160}color-mix\(in srgb, var\(--accent\) 30%, transparent\)/.test(controls) &&
    /@media \(pointer: coarse\) \{[\s\S]{0,120}\.options \{[\s\S]{0,80}width: 32px/.test(controls),
);

/* ---------------------------------------------------------------------------
 * 3. One set of rows, two frames: the panel gained a Done and nothing else.
 * ------------------------------------------------------------------------- */

check(
  "the panel takes an optional way out",
  /let \{ ondone \}: \{ ondone\?: \(\) => void \} = \$props\(\)/.test(postList),
);

check(
  "the way out only exists where the rows came up from the bar",
  /\{#if ondone\}[\s\S]{0,200}<button class="done" onclick=\{ondone\}>Done<\/button>/.test(postList),
);

check(
  "the settings section still mounts the same panel, with no way out",
  /<PostListPanel\s*\/>/.test(read("src/components/SettingsPanel.svelte")),
  "the section is not a popover, so it passes no ondone",
);

check(
  "the panel still invents no state of its own",
  !/= \$state/.test(postList) && !/localStorage|writePrefs|savePrefs/.test(postList),
);

check(
  "every knob still writes the reading store the bar's control wrote",
  /reading\.setRowsEnd\("pill"\)/.test(postList) &&
    /reading\.setRowsEnd\("half"\)/.test(postList) &&
    /reading\.setCurve\(footed \? "half" : "pill"/.test(postList) &&
    /reading\.toggleFlushThumb\(\)/.test(postList) &&
    /reading\.setGridColumns\(Number\(event\.currentTarget\.value\)\)/.test(postList),
);

check(
  "and it still follows the view: fill for Rows, the ruler for Grid",
  /\{#if reading\.listView === "regular"\}[\s\S]{0,400}Picture fill/.test(postList) &&
    /\{#if reading\.listView === "grid"\}[\s\S]{0,600}Tiles across/.test(postList),
);

/* ---------------------------------------------------------------------------
 * 4. The sheet it borrows is the app's one sheet, not a second sheet.
 * ------------------------------------------------------------------------- */

check(
  "the sheet is the shared component, with the gesture it always had",
  /role="dialog"/.test(sheet) && /onpointerdown=\{grab\}/.test(sheet) && /class="scrim"/.test(sheet),
);

check(
  "and it moves one node, so the scrim travels with the sheet",
  /const box = shell;/.test(sheet) &&
    /document\.body\.appendChild\(box\)/.test(sheet) &&
    /class="shell"[\s\S]{0,80}class="scrim"/.test(sheet) &&
    /\.shell \{\s*display: contents;/.test(sheet),
  "moving only the section left the scrim behind, and lost it on the next open",
);

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
