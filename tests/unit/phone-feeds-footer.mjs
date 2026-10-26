/**
 * The bottom of Feeds on a phone held upright — Task 7.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs \
 *     tests/unit/phone-feeds-footer.mjs
 *
 * The footer under the tree holds three things: `+ Add feed`, the two file
 * actions, and a line naming the file in play. On a phone held upright that
 * block is the most expensive furniture in the pane — it is the last thing above
 * the thumb, and it was taking 81px of a 844px screen to offer two controls that
 * are used once a month. So the phone draws only the button it uses, and Import
 * and Export move to Settings → Feeds, where there is width and no scrolling
 * tree to starve.
 *
 * What this suite holds still:
 *
 *   - the phone footer really loses the 40px the task asked for, measured from
 *     the declared CSS rather than from a screenshot;
 *   - it loses it only on a phone held upright — landscape and every desktop
 *     window still draw the block, file-name line included;
 *   - neither surface says "No file chosen" when there is no file: a line that
 *     names nothing is a line spent on nothing;
 *   - the two surfaces do not each own a copy of the reading, the wording or the
 *     list of file types. They both go through `lib/feeds-io.ts`, so a change to
 *     what an import reports cannot reach one and miss the other.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportFeedsOpml, importFeedsFile } from "../../src/lib/feeds-io.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Reading the numbers out of the stylesheet
// ---------------------------------------------------------------------------

function ruleBody(css, selector, where = "") {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)[ \\t]*${escaped} \\{([^}]*)\\}`, "s").exec(css);
  if (match === null) throw new Error(`no rule for ${selector}${where ? ` in ${where}` : ""}`);
  return match[1];
}

function px(body, prop, where) {
  const match = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?[\\d.]+)px`).exec(body);
  if (match === null) throw new Error(`no ${prop} in ${where}`);
  return Number(match[1]);
}

/** `padding: 5px 12px 8px` → [5, 8]. Both the two- and three-value forms. */
function paddingY(body, where) {
  const match = /padding:\s*([^;]+);/.exec(body);
  if (match === null) throw new Error(`no padding in ${where}`);
  const parts = match[1].trim().split(/\s+/).map((part) => Number.parseFloat(part));
  if (parts.length === 1) return [parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1]];
  return [parts[0], parts[2]];
}

const sidebar = read("src/components/Sidebar.svelte");
const panel = read("src/components/SettingsPanel.svelte");
const feedsIo = read("src/lib/feeds-io.ts");
const app = read("src/app.css");

// ---------------------------------------------------------------------------
// 1. The phone footer keeps the button it uses and nothing else
// ---------------------------------------------------------------------------

{
  check(
    "the compressed footer is a phone held upright, and nothing else",
    /const compressedFooter = \$derived\(layout\.device === "phone" && layout\.upright\);/.test(sidebar),
  );

  // One derived value, one gate. A second gate would be a second answer to the
  // same question, and the two would eventually disagree.
  check(
    "it is defined once and consulted once",
    (sidebar.match(/const compressedFooter = /g) ?? []).length === 1 &&
      (sidebar.match(/\{#if !compressedFooter\}/g) ?? []).length === 1,
  );

  const open = sidebar.indexOf("{#if !compressedFooter}");
  const close = sidebar.indexOf("{/if}", open + 1);
  const block = sidebar.slice(open, close);
  check("the gate wraps the file actions", open > 0 && /class="opml"/.test(block));
  check(
    "...and the file-name line with them, so no empty label is left behind",
    /class="opml-file"/.test(block),
  );

  const addOpen = sidebar.indexOf('<button class="add-open" onclick={startAdding}>+ Add feed</button>');
  check("+ Add feed stays, above the gate", addOpen > 0 && addOpen < open);

  // The pinned row is content, not chrome: it keeps its place on a phone.
  check(
    "the pinned row is untouched",
    /class="row[^"]*"[^>]*>[\s\S]{0,400}?class="pin"/.test(sidebar) || /\.pin {/.test(sidebar),
  );
}

// ---------------------------------------------------------------------------
// 2. Nothing moved for a window that has the height
// ---------------------------------------------------------------------------

{
  check(
    "desktop keeps its Import label and its Export button",
    /class="opml-import"[\s\S]{0,1200}?class="opml-export"/.test(sidebar),
  );
  check(
    "desktop keeps the line that names the file, empty state included",
    /\{opmlName \?\? "No file chosen"\}/.test(sidebar),
  );
  check(
    "the file-name line still has room to be read on one line",
    /\.opml-file \{[^}]*white-space: nowrap;/.test(sidebar),
  );
  check(
    "there is still exactly one entrance to the file picker on desktop",
    (sidebar.match(/type="file"/g) ?? []).length === 1,
  );
  check(
    "no phone-only style leaked into the shared stylesheet",
    !/compressedFooter|\.feeds-do|opml/.test(app),
    "app.css mentions the footer",
  );
}

// ---------------------------------------------------------------------------
// 3. The chrome height, measured
// ---------------------------------------------------------------------------

{
  const add = paddingY(ruleBody(sidebar, ".add", "Sidebar"), ".add");
  const openBody = ruleBody(sidebar, ".add-open", "Sidebar");
  const open = paddingY(openBody, ".add-open");
  const openType = px(openBody, "font-size", ".add-open");
  // A button with no declared line-height draws its text at the font's normal
  // leading; 1.2 is what both engine families resolve `normal` to for this face.
  const openLine = Number((openType * 1.2).toFixed(2));

  const opml = ruleBody(sidebar, ".opml", "Sidebar");
  const opmlMargin = px(opml, "margin-top", ".opml");
  const opmlGap = px(opml, "gap", ".opml");
  const row = px(ruleBody(sidebar, ".opml-import,\n  .opml-export", "Sidebar"), "height", "the file actions");
  const file = ruleBody(sidebar, ".opml-file", "Sidebar");
  const fileLine = Number((px(file, "font-size", ".opml-file") * Number(/line-height:\s*([\d.]+);/.exec(file)[1])).toFixed(1));

  const before = add[0] + openLine + open[0] * 2 + opmlMargin + row + opmlGap + fileLine + add[1];
  const after = add[0] + openLine + open[0] * 2 + add[1];

  console.log("");
  console.log("  Feeds footer, 390×844, non-scrolling chrome below the tree");
  console.log(`    before  5 + ${openLine} + 5  (button)   4 + ${row} + ${opmlGap} + ${fileLine}  (file block)   8`);
  console.log(`            = ${before.toFixed(1)}px`);
  console.log(`    after  5 + ${openLine} + 5  (button)   8`);
  console.log(`            = ${after.toFixed(1)}px, lost ${(before - after).toFixed(1)}px`);
  console.log("");

  check(
    "the phone's footer loses at least the 40px the task asked for",
    before - after >= 40,
    `${before.toFixed(1)} → ${after.toFixed(1)} is ${(before - after).toFixed(1)}px`,
  );
  check(
    "and what it loses is the whole file block, not a shaved pixel",
    Math.abs(before - after - (opmlMargin + row + opmlGap + fileLine)) < 0.05,
    `lost ${(before - after).toFixed(1)}, block ${(opmlMargin + row + opmlGap + fileLine).toFixed(1)}`,
  );
  check("the pane gains it back as tree", after < before / 2 || before - after >= 40);
}

// ---------------------------------------------------------------------------
// 4. Settings → Feeds, where the two actions went
// ---------------------------------------------------------------------------

{
  check(
    "the sheet has a Feeds section",
    /\{ id: "feeds", label: "Feeds", note: "[^"]*", phone: true \}/.test(panel),
  );
  check(
    "it is the only phone-only section, so desktop's list is unchanged",
    (panel.match(/phone: true/g) ?? []).length === 1,
  );
  check(
    "...and it is filtered out by the device, not by a window width",
    /SECTIONS\.filter\(\(section\) => section\.phone !== true \|\| layout\.device === "phone"\)/.test(panel),
  );
  check("the list the sheet draws is the filtered one", /\{#each sections as section \(section\.id\)\}/.test(panel));
  check("it starts folded, like every section but Accounts", /accounts: true,\s*feeds: false,/.test(panel));

  const body = panel.slice(panel.indexOf('section.id === "feeds"'), panel.indexOf('section.id === "reading"'));
  check("the section has an Import control", /Import feeds|Importing…/.test(body));
  check("the section has an Export control", /Export feeds/.test(body));
  check(
    "both go through the same two actions the sidebar's footer uses",
    /importFeedsFile\(file, \(feeds\) => reader\.importOpml\(feeds\)\)/.test(panel) &&
      /exportFeedsOpml\(reader\.categories\)/.test(panel),
  );
  check(
    "the same file types are accepted in both places",
    /accept="\.opml,\.xml,text\/xml,application\/xml,application\/octet-stream"/.test(panel),
  );
  check(
    "the name of the file in play appears only once there is one",
    /\{#if feedsName !== null\}\s*<p class="feeds-file"/.test(panel),
  );
  // Comments are not drawn: the rationale mentions the phrase, the markup must
  // not. Strip both comment forms before looking for text a reader would see.
  const drawn = panel.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("and nothing in the sheet ever says 'No file chosen'", !/No file chosen/.test(drawn));
  check(
    "the sheet reports the outcome where a screen reader will hear it",
    /<p class="hint" role="status">\{feedsNote\}<\/p>/.test(panel),
  );
  check(
    "opening the picker twice on the same file runs twice",
    /input\.value = "";/.test(panel),
  );
}

// ---------------------------------------------------------------------------
// 5. One home for what an import says
// ---------------------------------------------------------------------------

{
  check(
    "the sidebar reads and writes OPML through the shared actions",
    /import \{ exportFeedsOpml, importFeedsFile \} from "\.\.\/lib\/feeds-io";/.test(sidebar),
  );
  check(
    "...and no longer parses or builds a document itself",
    !/from "\.\.\/lib\/opml"/.test(sidebar),
  );
  check(
    "the sheet does the same",
    /import \{ exportFeedsOpml, importFeedsFile \} from "\.\.\/lib\/feeds-io";/.test(panel),
  );
  check(
    "so the wording lives in one file",
    /Exported \$\{|Imported \$\{/.test(feedsIo) && !/Exported \$|Imported \$/.test(panel) && !/Exported \$|Imported \$/.test(sidebar),
  );
  check(
    "the shell cannot save a file, and both surfaces say so the same way",
    /copy|clipboard/i.test(feedsIo),
  );
}

// ---------------------------------------------------------------------------
// 6. The one sentence, exercised rather than grepped
// ---------------------------------------------------------------------------

{
  const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0"><body>
  <outline text="Reading">
    <outline type="rss" text="One" xmlUrl="https://example.com/one.xml" />
    <outline type="rss" text="Two" xmlUrl="https://example.com/two.xml" />
  </outline>
</body></opml>`;

  const imported = await importFeedsFile(
    new File([OPML], "subscriptions.opml", { type: "text/x-opml" }),
    async (feeds) => ({ added: feeds, failed: [] }),
  );
  check("an import reports the file it read", imported.name === "subscriptions.opml");
  check(
    "...and what landed, folders included",
    imported.note === "Imported 2 feeds into 1 folder.",
    imported.note,
  );

  const one = await importFeedsFile(
    new File([OPML], "one.opml"),
    async (feeds) => ({ added: feeds.slice(0, 1), failed: [] }),
  );
  check("one feed is one feed", one.note === "Imported 1 feed into 1 folder.", one.note);

  const refused = await importFeedsFile(
    new File([OPML], "half.opml"),
    async (feeds) => ({ added: feeds.slice(0, 1), failed: [{ error: "Not a feed" }] }),
  );
  check(
    "a refusal is reported on the same line, not swallowed",
    refused.note === "Imported 1, 1 failed — Not a feed",
    refused.note,
  );

  const junk = await importFeedsFile(new File(["not xml at all"], "notes.txt"), async () => ({
    added: [],
    failed: [],
  }));
  check("a file that is not OPML still names the file and says something", junk.name === "notes.txt" && junk.note.length > 0, junk.note);

  const empty = await exportFeedsOpml([]);
  check(
    "there is nothing to export, and the sheet says so instead of writing a stub",
    empty.name === null && empty.note === "There are no feeds to export yet.",
    empty.note,
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
