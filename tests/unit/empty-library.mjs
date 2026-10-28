/**
 * The empty library tells you what it is for — Task: empty state.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs \
 *     tests/unit/empty-library.mjs
 *
 * A brand-new install opens on the local library with nothing in it, which is
 * the right screen but used to say one thing: `No feeds yet.` next to a button
 * strip it did not explain. The empty state is the only place the panel ever
 * gets to introduce itself, so it carries the two ways in (a feed, or a set of
 * subscriptions) and names syncing as an upgrade rather than a step to clear
 * first.
 *
 * What this suite holds still:
 *
 *   - the block says the four things it has to say, in the owner's words;
 *   - it is one block, not a wizard: no second flow, no second component, and
 *     nothing drawn beside the footer it replaces;
 *   - it is gone the moment a feed exists, and the footer comes back with it;
 *   - there is still exactly one file picker: the footer's Import and the empty
 *     block's Import OPML are two labels for one control, because the footer
 *     (and its Input) is not drawn while the block is;
 *   - the sync offer opens the same connect card the account panel does, by
 *     calling the `onconnect` the view already hands down;
 *   - and the block's own CSS cannot exceed a drawer: measured from the
 *     declarations, on a 390×844 phone.
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
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const sidebar = read("src/components/Sidebar.svelte");
const main = read("src/views/Main.svelte");

/** The body of one CSS rule, from the stylesheet. */
function ruleBody(css, selector, where = "") {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)[ \\t]*${escaped} \\{([^}]*)\\}`, "s").exec(css);
  if (match === null) throw new Error(`no rule for ${selector}${where ? ` in ${where}` : ""}`);
  return match[1];
}

/** A `px` declaration's number. */
function px(body, prop, where) {
  const match = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?[\\d.]+)px`).exec(body);
  if (match === null) throw new Error(`no ${prop} in ${where}`);
  return Number.parseFloat(match[1]);
}

/** A unitless declaration's number — `line-height: 1.45` and friends. */
function num(body, prop, where) {
  const match = new RegExp(`(?:^|[;{\\s])${prop}:\\s*([\\d.]+)\\s*;`).exec(body);
  if (match === null) throw new Error(`no ${prop} in ${where}`);
  return Number.parseFloat(match[1]);
}

// The four-sided padding form `12px 14px 12px 16px` → [top, bottom].
function paddingY(body, where) {
  const match = /padding:\s*([^;]+);/.exec(body);
  if (match === null) throw new Error(`no padding in ${where}`);
  const parts = match[1].trim().split(/\s+/).map((part) => Number.parseFloat(part));
  if (parts.length === 1) return [parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1]];
  return [parts[0], parts[2]];
}

// ---------------------------------------------------------------------------
// 1. One block, in his words, with both ways in and the sync offer
// ---------------------------------------------------------------------------

const gate = sidebar.indexOf("{#if startsHere}");
const gateEnd = sidebar.indexOf("{/if}", gate + 1);
const block = gate > 0 ? sidebar.slice(gate, gateEnd) : "";

{
  check("the empty state is one gated block", gate > 0 && gateEnd > gate);
  check(
    "no second empty notice survives beside it",
    !/No feeds yet/.test(sidebar) && (sidebar.match(/class="start"/g) ?? []).length === 1,
  );

  check(
    "it opens with the lead line, in the owner's words",
    /<b>Start reading<\/b> — Add a feed or import your subscriptions\./.test(block),
  );
  check(
    "it draws the two entry points",
    /class="start-add"[^>]*>\+ Add feed<\/button>/.test(block) &&
      /class="start-import"[\s\S]{0,220}?Import OPML/.test(block),
  );
  check(
    "syncing is an offer at the end, not a first step",
    /Want feeds synced across devices\?/.test(block) &&
      /class="start-connect" onclick=\{onconnect\}>Connect a sync service<\/button>/.test(block),
  );
  check(
    "the sync offer sits below the two controls",
    block.indexOf("start-actions") < block.indexOf("start-sync"),
  );
}

// ---------------------------------------------------------------------------
// 2. No wizard: the same panel, one branch, no new surface
// ---------------------------------------------------------------------------

{
  check(
    "it is a branch of the sidebar, not a component of its own",
    /import \{/.test(sidebar) &&
      !/start-(wizard|onboard|steps)/.test(sidebar) &&
      !/<Start|Onboard/.test(sidebar),
  );

  const scroll = sidebar.indexOf('class="scroll"');
  const status = sidebar.indexOf('<div class="status"');
  check(
    "it is drawn inside the scrolling tree area, where a drawer shows it",
    scroll > 0 && status > scroll && gate > scroll && gate < status,
  );

  check(
    "nothing new is restyled: the block owns its own classes only",
    /\.start \{/.test(sidebar) && /\.start-lead \{/.test(sidebar),
  );
}

// ---------------------------------------------------------------------------
// 3. It leaves the moment a feed exists, and takes the footer's place
// ---------------------------------------------------------------------------

{
  check(
    "the empty library is still the same three facts the old notice used",
    /const emptyLibrary = \$derived\(\s*mode === "feeds" && reader\.subscriptions\.length === 0 && !reader\.loadingList,?\s*\)/.test(
      sidebar,
    ),
  );

  check(
    "the invitation stands aside while the add form is open, and only then",
    /const startsHere = \$derived\(emptyLibrary && !adding\)/.test(sidebar),
  );

  // The form lives in the footer, so the footer has to come back for it.
  check(
    "the footer gives way to the block, and reopens for the form",
    /\{#if !startsHere\}\s*<div class="add">\s*\{#if adding\}/.test(sidebar),
  );
  check(
    "one gate decides it, at both places",
    (sidebar.match(/\{#if !startsHere\}/g) ?? []).length === 1 &&
      (sidebar.match(/\{#if startsHere\}/g) ?? []).length === 1,
  );
  check(
    "the export and file-name line are untouched for a library with feeds",
    /class="opml-export"[\s\S]{0,400}?No file chosen/.test(sidebar),
  );
}

// ---------------------------------------------------------------------------
// 4. One file picker, two labels
// ---------------------------------------------------------------------------

{
  check(
    "there is still exactly one entrance to the file dialog",
    (sidebar.match(/type="file"/g) ?? []).length === 1,
  );
  check(
    "and it is the one control, outside both the footer and the block",
    /<input\s+id="opml-file"\s+type="file"/.test(sidebar),
  );
  check(
    "the footer's Import and the block's Import OPML both press it",
    (sidebar.match(/for="opml-file"/g) ?? []).length === 2,
  );
  check(
    "the picker is out of the layout, so neither label is shifted by it",
    /\.opml-input \{[^}]*position: absolute;/.test(sidebar),
  );
  check(
    "the phone still reaches Import through the block, where the footer is folded",
    /class="start-import"/.test(block) && !/\{!compressedFooter[\s\S]{0,40}?start-import/.test(sidebar),
  );
}

// ---------------------------------------------------------------------------
// 5. The sync link is the account panel's connect card
// ---------------------------------------------------------------------------

{
  check(
    "the panel takes the connect callback rather than building one",
    /onconnect\?: \(\) => void;/.test(sidebar) && /onclick=\{onconnect\}/.test(block),
  );
  check(
    "the view hands its own `onconnect` to the sidebar",
    /<Sidebar inlinePosts=\{mode === 1\} \{onconnect\} \/>/.test(main),
  );
  check(
    "and nothing is offered when there is no connect screen to open",
    /\{#if onconnect\}\s*<p class="start-sync">\s*Want feeds synced across devices\?/.test(sidebar),
  );
}

// ---------------------------------------------------------------------------
// 6. It fits a phone's drawer, measured from the declarations
// ---------------------------------------------------------------------------

{
  const start = ruleBody(sidebar, ".start", "Sidebar");
  const pad = paddingY(start, ".start");
  const gap = px(start, "gap", ".start");

  const lead = ruleBody(sidebar, ".start-lead", "Sidebar");
  const leadLine = Number((px(lead, "font-size", ".start-lead") * num(lead, "line-height", ".start-lead")).toFixed(1));

  const sync = ruleBody(sidebar, ".start-sync", "Sidebar");
  const syncLine = Number((px(sync, "font-size", ".start-sync") * num(sync, "line-height", ".start-sync")).toFixed(1));

  // A phone is the narrow case, and the one the block has to survive: the two
  // buttons keep their row (2 × ~96px in a 360px measure) and each sentence
  // takes two lines at worst.
  const phone = /:global\(html\[data-device="phone"\]\) \.start-add,\s*:global\(html\[data-device="phone"\]\) \.start-import \{\s*height: ([\d.]+)px/.exec(
    sidebar,
  );
  if (phone === null) throw new Error("no phone height for the block's buttons");
  const button = Number.parseFloat(phone[1]);

  const worst = pad[0] + leadLine * 2 + gap + button + gap + syncLine * 2 + pad[1];
  const drawer = Math.min(844 * 0.62, 560);

  console.log("");
  console.log("  Empty library block, 390×844, worst case (two lines per sentence)");
  console.log(`    ${pad[0]} + ${leadLine * 2} (lead) + ${gap} + ${button} (buttons) + ${gap} + ${syncLine * 2} (sync) + ${pad[1]}`);
  console.log(`            = ${worst.toFixed(1)}px of a ${drawer.toFixed(0)}px drawer`);
  console.log("");

  check("the block is short enough to sit in a phone's drawer", worst <= 200, `${worst.toFixed(1)}px`);
  check(
    "...and leaves the drawer at least half for the page behind it",
    worst < drawer / 2,
    `${worst.toFixed(1)}px of ${drawer.toFixed(1)}px`,
  );
  check(
    "the two buttons are a thumb's size on a phone",
    button >= 32,
    `${button}px`,
  );
  check(
    "the sentences wrap rather than clip",
    !/white-space: nowrap/.test(lead) && !/text-overflow/.test(start),
  );
  check(
    "the inline link carries padding, so a thumb is not aiming at 17px of text",
    /padding: 3px 0;/.test(ruleBody(sidebar, ".start-connect", "Sidebar")),
  );
}

// ---------------------------------------------------------------------------

console.log("");
if (failures > 0) {
  console.log(`${failures} failure(s) in ${checks} checks — the empty library`);
  process.exit(1);
}
console.log(`ok ${checks} checks — the empty library`);
