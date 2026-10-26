/**
 * 44×44 hit boxes that do not grow the design — and do not steal a neighbour's
 * taps.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/tap-targets.mjs
 *
 * The rule is one rule in `src/app.css`: under `html[data-device="phone"]`, a
 * control marked `.tap44` lays a centred `::after` over itself and keeps its
 * glyph, its padding and its place. Two things can go wrong with that and both
 * are invisible in a screenshot, so both are checked here:
 *
 *   1. the box is not the phone's, i.e. some part of it reaches a desktop
 *      window. Every `.tap44` selector in the tree is required to start with the
 *      root device switch, so there is no such thing as a hit box that leaks;
 *   2. the box is bigger than the space between two controls, so the later one
 *      covers its neighbour and a tap meant for the star stars the read mark.
 *
 * There is no browser in this suite. The probe below is `elementFromPoint`'s own
 * rule — the topmost box that holds the point wins, and among siblings the later
 * one paints on top — run over boxes built from the *declared* CSS: the control
 * sizes and gaps are read out of the components, and the box sizes out of the
 * `.tap44` rules. If a size changes in a component without its box changing
 * here, the probe goes red, which is the point.
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

// ---------------------------------------------------------------------------
// Reading the numbers out of the stylesheets
// ---------------------------------------------------------------------------

/** Every body a selector has in a stylesheet, in source order. */
function ruleBodies(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|\\n)[ \\t]*${escaped} \\{([^}]*)\\}`, "g"))].map(
    (match) => match[1],
  );
}

/**
 * The body of a rule, by its exact selector. Throws rather than guessing.
 *
 * A selector can be declared twice in this app — the card's action pill sets its
 * depth in one rule and its geometry in another — so `withProp` picks the half
 * that carries the declaration being read.
 */
function ruleBody(css, selector, where = "", withProp = null) {
  const bodies = ruleBodies(css, selector);
  const found =
    withProp === null ? bodies[0] : bodies.find((body) => new RegExp(`(^|[;\\s])${withProp}:`).test(body));
  if (found === undefined) throw new Error(`no rule for ${selector}${where ? ` in ${where}` : ""}`);
  return found;
}

/** The body of the first `@media (pointer: coarse)` block in a stylesheet. */
function coarseBlock(css, where) {
  const at = css.indexOf("@media (pointer: coarse)");
  if (at < 0) throw new Error(`no coarse-pointer block in ${where}`);
  let depth = 0;
  let index = css.indexOf("{", at);
  const start = index + 1;
  for (; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index);
    }
  }
  throw new Error(`unclosed coarse-pointer block in ${where}`);
}

/** A declared length, in pixels. Only the plain `Npx` form is read. */
function px(body, prop, where) {
  const match = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?[\\d.]+)px`).exec(body);
  if (match === null) throw new Error(`no ${prop} in ${where}`);
  return Number(match[1]);
}

const app = read("src/app.css");
const header = read("src/components/Header.svelte");
const main = read("src/views/Main.svelte");
const stack = read("src/components/MobilePaneStack.svelte");
const list = read("src/components/ArticleList.svelte");
const sidebar = read("src/components/Sidebar.svelte");
const panel = read("src/components/SettingsPanel.svelte");

// ---------------------------------------------------------------------------
// One rule, and it is the phone's
// ---------------------------------------------------------------------------

{
  const host = ruleBody(app, 'html[data-device="phone"] .tap44', "app.css");
  const box = ruleBody(app, 'html[data-device="phone"] .tap44::after', "app.css");
  check("the hit box is one rule, on the root phone switch", host.length > 0 && box.length > 0);
  check(
    "...anchored to the control it belongs to",
    /position: relative/.test(host),
    host.trim(),
  );
  check(
    "...and a double tap cannot zoom the control",
    /touch-action: manipulation/.test(host),
    host.trim(),
  );
  check(
    "the box is 44×44 unless the control narrows it",
    /width: var\(--tap44-w, 44px\)/.test(box) && /height: var\(--tap44-h, 44px\)/.test(box),
    box.replace(/\s+/g, " ").trim(),
  );
  check(
    "it is centred on the control rather than grown out of one corner",
    /left: 50%/.test(box) && /top: 50%/.test(box) && /translate: -50% -50%/.test(box),
    box.replace(/\s+/g, " ").trim(),
  );
  check("it is drawn, not styled: no colour, border or shadow of its own", !/@media|background|border|box-shadow/.test(box));

  // Nothing in the tree may touch the class or its variables outside the phone
  // scope. A rule that sized the box without the switch is a 44px target in a
  // desktop window, and that is the one thing this work must not do.
  const onPhone = (selector) => /^(?::global\()?html\[data-device="phone"\]/.test(selector);
  const offenders = [];
  for (const [file, source] of [
    ["src/app.css", app],
    ["src/components/Header.svelte", header],
    ["src/views/Main.svelte", main],
    ["src/components/MobilePaneStack.svelte", stack],
    ["src/components/ArticleList.svelte", list],
    ["src/components/Sidebar.svelte", sidebar],
  ]) {
    // Comments are prose about the rules, not rules: drop them first so a
    // sentence naming the variable is not mistaken for a declaration of it.
    const text = source.replace(/\/\*[\s\S]*?\*\//g, "");

    for (const match of text.matchAll(/(?:^|\n)[ \t]*([^{}\n]*\.tap44[^{}\n]*)\{/g)) {
      const selector = match[1].trim();
      if (!onPhone(selector)) offenders.push(`${file}: ${selector}`);
    }

    // A declaration is judged by the rule that holds it: walk back to the brace
    // that opens its body, then back past the previous rule to the selector.
    for (const match of text.matchAll(/--tap44-(?:w|h|gap):/g)) {
      const before = text.slice(0, match.index);
      const open = before.lastIndexOf("{");
      const previous = Math.max(before.lastIndexOf("}", open), before.lastIndexOf(";", open));
      const selector = before.slice(previous + 1, open).trim();
      if (open < 0 || !onPhone(selector)) offenders.push(`${file}: --tap44 in "${selector}"`);
    }
  }
  check("every .tap44 rule and variable is under the phone switch", offenders.length === 0, offenders.join(" · "));
}

// ---------------------------------------------------------------------------
// The controls that carry it, and only on a phone
// ---------------------------------------------------------------------------

{
  const gated = (text, needle) => new RegExp(`${needle}[\\s\\S]{0,200}?class:tap44=\\{layout\\.device === "phone"\\}`);

  check(
    "Sync carries it, on a phone",
    gated(header, '<button\\s+class="sync"').test(header),
  );
  check(
    "the stack's back step carries it",
    gated(stack, '<button\\s+type="button"\\s+class="step"').test(stack),
  );
  check(
    "both crumb steps carry it, back and home alike",
    (main.match(/class="step"\s*\n\s*class:tap44=\{layout\.device === "phone"\}/g) ?? []).length === 2,
  );
  check(
    "the star, the read mark and the link out carry it",
    ["act star", "act mark", "act open"].every((token) =>
      new RegExp(`class="${token}"\\s*\\n\\s*class:tap44=\\{layout\\.device === "phone"\\}`).test(list),
    ),
  );
  check(
    "the category arrow carries it inside its row",
    /<span class="fold-hit" class:tap44=\{layout\.device === "phone"\}>/.test(sidebar),
  );
  check(
    "the arrow's wrapper is the glyph's own size, so the row does not move",
    /\.fold-hit \{[^}]*display: inline-flex;[^}]*flex: none;/.test(sidebar),
    ruleBody(sidebar, ".fold-hit", "Sidebar.svelte").replace(/\s+/g, " ").trim(),
  );
  // `PhoneHeader.svelte` is another task's file: the ••• it will draw is not in
  // this tree. What is here is the ☰ that opens the same menu, and it carries the
  // class so that a phone's way into Settings is a thumb's target today.
  check(
    "the menu that stands in for the phone's ••• carries it, capped at the bar",
    /class="icon menu"\s*\n\s*class:tap44=\{layout\.device === "phone"\}/.test(header) &&
      /:global\(html\[data-device="phone"\]\) \.icon\.menu\.tap44 \{\s*--tap44-h: 42px;\s*\}/.test(header),
  );
  check(
    "the menu is the smallest thing it has to grow: 28 in a 42 bar",
    px(ruleBody(header, ".icon", "Header"), "width", "icon") === 28,
  );
  check(
    "PhoneHeader is not in this tree, so nothing here pretends to be it",
    !/PhoneHeader/.test(panel + sidebar + header),
  );
}

// ---------------------------------------------------------------------------
// elementFromPoint, without a browser
// ---------------------------------------------------------------------------

const holds = (box, x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
const centreOf = (box) => [(box.left + box.right) / 2, (box.top + box.bottom) / 2];

/** The topmost control whose box holds the point: later siblings paint on top. */
function elementFromPoint(controls, x, y) {
  let hit = null;
  for (const control of controls) if (holds(control.tap, x, y)) hit = control;
  return hit?.name ?? null;
}

/** A control and the box a thumb gets, both from the size and the space it has. */
function control(name, { x, y, w, h, tapW = 44, tapH = 44 }) {
  return {
    name,
    visible: { left: x, top: y, right: x + w, bottom: y + h },
    tap: {
      left: x + (w - tapW) / 2,
      top: y + (h - tapH) / 2,
      right: x + (w + tapW) / 2,
      bottom: y + (h + tapH) / 2,
    },
  };
}

/** Controls laid out left to right, the way `.acts` and `.crumbs` lay them out. */
function inARow(names, { w, h, gap, tapW, tapH = 44, y = 0 }) {
  return names.map((name, index) => control(name, { x: index * (w + gap), y, w, h, tapW, tapH }));
}

/**
 * The points a control has to win: its centre, the four corners of the glyph it
 * draws, and the four corners of the box a thumb is given. The corners are taken
 * a half-pixel inside, because two boxes are allowed to *touch* — what they may
 * not do is overlap, and the seam between them belongs to no one.
 */
function probesFor(controls) {
  const probes = [];
  const inset = 0.5;
  for (const control of controls) {
    const [cx, cy] = centreOf(control.visible);
    probes.push({ name: `${control.name} centre`, at: [cx, cy], expect: control.name });
    const v = control.visible;
    const t = control.tap;
    for (const [x, y] of [
      [v.left + inset, v.top + inset],
      [v.right - inset, v.top + inset],
      [v.left + inset, v.bottom - inset],
      [v.right - inset, v.bottom - inset],
      [t.left + inset, t.top + inset],
      [t.right - inset, t.top + inset],
      [t.left + inset, t.bottom - inset],
      [t.right - inset, t.bottom - inset],
    ]) {
      probes.push({ name: `${control.name} at ${x.toFixed(1)},${y.toFixed(1)}`, at: [x, y], expect: control.name });
    }
  }
  return probes;
}

function probeAll(label, controls) {
  const wrong = probesFor(controls)
    .map((probe) => ({ ...probe, got: elementFromPoint(controls, probe.at[0], probe.at[1]) }))
    .filter((probe) => probe.got !== probe.expect);
  check(
    `${label}: every probe lands on the control it aimed at`,
    wrong.length === 0,
    wrong.map((probe) => `${probe.name} → ${probe.got}`).join(" · "),
  );
}

/** Two boxes in the same row may touch; they may not share an area. */
function overlap(a, b) {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > 0.001 && y > 0.001;
}

function noOverlaps(label, controls) {
  const collisions = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      if (overlap(controls[i].tap, controls[j].tap)) {
        collisions.push(`${controls[i].name}/${controls[j].name}`);
      }
    }
  }
  check(`${label}: no two hit boxes share an area`, collisions.length === 0, collisions.join(" · "));
}

// ---------------------------------------------------------------------------
// The three marks at the end of a post
// ---------------------------------------------------------------------------

{
  const coarse = coarseBlock(list, "ArticleList.svelte");
  const act = { w: px(ruleBody(coarse, ".act", "ArticleList coarse"), "width", "act"), h: px(ruleBody(coarse, ".act", "ArticleList coarse"), "height", "act") };
  const treeAct = {
    w: px(ruleBody(coarse, ".compact .act", "ArticleList coarse"), "width", "compact act"),
    h: px(ruleBody(coarse, ".compact .act", "ArticleList coarse"), "height", "compact act"),
  };
  const gap = px(ruleBody(list, ".acts", "ArticleList"), "gap", "acts gap");
  const treeGap = px(ruleBody(list, ".compact .acts", "ArticleList"), "gap", "compact acts gap");
  const gridGap = px(ruleBody(list, ".grid .acts", "ArticleList"), "gap", "grid acts gap");

  const declared = /:global\(html\[data-device="phone"\]\) \.acts \{\s*--tap44-gap: 8px;/.test(list);
  const cap = /--tap44-w: calc\(100% \+ var\(--tap44-gap, 0px\)\)/.test(list);
  const treeCap = /--tap44-h: calc\(100% \+ 4px\)/.test(list);
  check("a row's marks grow to the middle of their own gap", cap && declared);
  check("the tree's marks stop at the pill instead, because the next post is a row away", treeCap);

  // Every view has to be told the gap it is actually drawn with, or the box is
  // sized for a spacing the view is not using: too small and the thumb misses
  // it, too large and it covers the neighbour. Both numbers are read from the
  // stylesheet and compared, so re-spacing a pill without re-sizing its boxes
  // is a red check rather than a subtle drift on a phone.
  const phoneRule = (selector) => ruleBody(list, `:global(html[data-device="phone"]) ${selector}`, "ArticleList");
  for (const [selector, where, expected] of [
    [".acts", "list", gap],
    [".items.compact .acts", "list's tree", gap],
    [".compact .acts", "tree", treeGap],
    [".grid .acts", "grid", gridGap],
  ]) {
    const body = phoneRule(selector);
    check(
      `the ${where} view's hit boxes are told its ${expected}px gap`,
      new RegExp(`--tap44-gap:\\s*${expected}px`).test(body),
      body.replace(/\s+/g, " ").trim(),
    );
  }
  check(
    "a card's gap is scaled, and its hit boxes scale with it",
    /--tap44-gap: calc\(8px \* var\(--row-scale, 1\)\)/.test(phoneRule(" .cards .acts".trim()))
      && /gap: calc\(8px \* var\(--row-scale, 1\)\)/.test(ruleBody(list, ".cards .acts", "ArticleList", "gap")),
  );

  const names = ["star", "read", "open"];

  // The row: 34px marks, 8px apart, so each box reaches 42 and the two meet.
  const row = inARow(names, { w: act.w, h: act.h, gap, tapW: act.w + gap });
  probeAll("a row's marks", row);
  noOverlaps("a row's marks", row);
  check(
    "a row's marks are 44 tall and reach 21px out",
    row.every((c) => Math.abs(c.tap.bottom - c.tap.top - 44) < 0.001 && Math.abs(c.tap.right - c.tap.left - 42) < 0.001),
    row.map((c) => `${c.name} ${c.tap.right - c.tap.left}×${c.tap.bottom - c.tap.top}`).join(", "),
  );

  // And the failure this exists for: the same row with an uncapped 44px box.
  const uncapped = inARow(names, { w: act.w, h: act.h, gap });
  const star = uncapped[0];
  const stolenAt = [star.tap.right - 0.5, (star.tap.top + star.tap.bottom) / 2];
  check(
    "an uncapped 44px box would take the neighbour's taps — so the cap is load-bearing",
    elementFromPoint(uncapped, ...stolenAt) === "read",
    `the star's own corner answers ${elementFromPoint(uncapped, ...stolenAt)}`,
  );
  const keptAt = [row[0].tap.right - 0.5, (row[0].tap.top + row[0].tap.bottom) / 2];
  check(
    "...and the capped one keeps them",
    elementFromPoint(row, ...keptAt) === "star",
    `the star's own corner answers ${elementFromPoint(row, ...keptAt)}`,
  );

  // The tree: 30px marks, 4px apart, one line tall — both axes capped.
  const tree = inARow(names, { w: treeAct.w, h: treeAct.h, gap: treeGap, tapW: treeAct.w + treeGap, tapH: treeAct.h + 4 });
  probeAll("a tree's marks", tree);
  noOverlaps("a tree's marks", tree);
  check(
    "a tree's marks stay inside the pill they are drawn in",
    tree.every((c) => c.tap.bottom - c.tap.top === treeAct.h + 4),
    tree.map((c) => `${c.name} ${c.tap.right - c.tap.left}×${c.tap.bottom - c.tap.top}`).join(", "),
  );

  // A grid is the tightest of the three: 3px between the marks.
  const grid = inARow(names, { w: act.w, h: act.h, gap: gridGap, tapW: act.w + gridGap });
  probeAll("a grid's marks", grid);
  noOverlaps("a grid's marks", grid);
}

// ---------------------------------------------------------------------------
// Two steps side by side in the crumb strip
// ---------------------------------------------------------------------------

{
  const coarse = coarseBlock(main, "Main.svelte");
  const step = {
    w: px(ruleBody(coarse, ".step", "Main coarse"), "width", "crumb step"),
    h: px(ruleBody(coarse, ".step", "Main coarse"), "height", "crumb step"),
  };
  const gap = px(ruleBody(main, ".crumbs", "Main"), "gap", "crumbs gap");
  const bar = px(ruleBody(coarse, ".crumbs", "Main coarse"), "height", "crumb strip");
  check(
    "the strip's steps grow to the middle of their gap and no further than the strip",
    /:global\(html\[data-device="phone"\]\) \.step\.tap44 \{\s*--tap44-w: calc\(100% \+ 4px\);\s*--tap44-h: 42px;/.test(main),
  );
  check("...which is the gap and the height the strip actually declares", gap === 4 && bar === 42, `gap ${gap}, strip ${bar}`);

  const crumbs = inARow(["back", "home"], { w: step.w, h: step.h, gap, tapW: step.w + gap, tapH: bar });
  probeAll("the crumb strip", crumbs);
  noOverlaps("the crumb strip", crumbs);
  check(
    "back and home keep every pixel of their own box",
    Math.abs(crumbs[0].tap.right - crumbs[1].tap.left) < 0.001,
    `${crumbs[0].tap.right} against ${crumbs[1].tap.left}`,
  );
}

// ---------------------------------------------------------------------------
// A bar with one control in it
// ---------------------------------------------------------------------------

{
  const sync = {
    w: px(ruleBody(header, ".sync", "Header"), "width", "sync"),
    h: px(ruleBody(header, ".sync", "Header"), "height", "sync"),
  };
  const menu = { w: px(ruleBody(header, ".icon", "Header"), "width", "menu"), h: 28 };
  const bar = px(ruleBody(header, ".bar", "Header"), "height", "bar");
  check("Sync is 34 in a 42 bar", sync.w === 34 && sync.h === 34 && bar === 42, `${sync.w}×${sync.h} in ${bar}`);
  check(
    "and its box stops at the bar's edges",
    /:global\(html\[data-device="phone"\]\) \.sync\.tap44 \{\s*--tap44-h: 42px;\s*\}/.test(header),
  );

  const step = {
    w: px(ruleBody(coarseBlock(stack, "MobilePaneStack.svelte"), ".step", "stack coarse"), "width", "stack step"),
    h: px(ruleBody(coarseBlock(stack, "MobilePaneStack.svelte"), ".step", "stack coarse"), "height", "stack step"),
  };
  const strip = px(ruleBody(coarseBlock(stack, "MobilePaneStack.svelte"), ".bar", "stack coarse"), "height", "stack strip");
  check(
    "the stack's back step is the same control in the same strip",
    step.w === 34 && strip === 42 && /:global\(html\[data-device="phone"\]\) \.step\.tap44 \{\s*--tap44-h: 42px;\s*\}/.test(stack),
    `${step.w}×${step.h} in ${strip}`,
  );

  // Both are alone in their bar: the box is 44 wide and stops at the bar's top
  // and bottom, so the strip's own edges are the only thing it can reach.
  for (const [label, control34] of [["Sync", sync], ["the menu", menu], ["the stack's back step", step]]) {
    const alone = [control("control", { x: 0, y: 0, w: control34.w, h: control34.h, tapW: 44, tapH: bar })];
    check(
      `${label}: 44 wide, and inside the strip's height`,
      alone[0].tap.right - alone[0].tap.left === 44 && alone[0].tap.bottom - alone[0].tap.top === bar,
    );
    probeAll(`the bar holding ${label}`, alone);
  }
}

// ---------------------------------------------------------------------------
// One arrow per category, and the rows are the neighbours
// ---------------------------------------------------------------------------

{
  // The sidebar has no coarse-pointer block of its own: a row is the same size
  // for a pointer and a thumb, which is why only the arrow's box had to grow.
  const arrow = {
    w: px(ruleBody(sidebar, ".fold", "Sidebar"), "width", "fold"),
    h: px(ruleBody(sidebar, ".fold", "Sidebar"), "height", "fold"),
  };
  const row = px(ruleBody(sidebar, ".row", "Sidebar"), "padding", "row padding");
  const cap = /:global\(html\[data-device="phone"\]\) \.fold-hit\.tap44 \{\s*--tap44-h: 30px;\s*\}/.test(sidebar);
  check("the arrow's box stops at the row's own height", cap);
  check("...and 30px is that row: 7px of padding, a 16px line, 7px again", row === 7 && arrow.h === 13, `${arrow.w}×${arrow.h}, ${row}px padding`);

  // Three rows of a category list, stacked, the arrow centred in each of them.
  // The row is 30px (the cap above), so that is the pitch as well: the arrow's
  // box may fill its own row and may not cross the seam into the next one.
  const rowHeight = 30;
  const arrows = [0, 1, 2].map((index) =>
    control(`arrow ${index}`, {
      x: 16 - arrow.w / 2,
      y: index * rowHeight + (rowHeight - arrow.h) / 2,
      w: arrow.w,
      h: arrow.h,
      tapW: 44,
      tapH: rowHeight,
    }),
  );
  probeAll("the category arrows", arrows);
  noOverlaps("the category arrows", arrows);

  // The row *is* the button the arrow sits in, and the arrow's box is inside it:
  // the neighbouring category's row is a whole row away from anything it can
  // reach, so folding a category cannot fold the one above it.
  check(
    "the box never leaves its row, so the next category keeps its edge",
    arrows.every(
      (a, index) =>
        a.tap.top >= index * rowHeight - 0.001 && a.tap.bottom <= (index + 1) * rowHeight + 0.001,
    ),
    arrows.map((a) => `${a.tap.top}–${a.tap.bottom}`).join(", "),
  );

  // And the failure mode, made visible: a 44px box on a 30px row.
  const uncapped = [0, 1, 2].map((index) =>
    control(`arrow ${index}`, {
      x: 16 - arrow.w / 2,
      y: index * rowHeight + (rowHeight - arrow.h) / 2,
      w: arrow.w,
      h: arrow.h,
      tapW: 44,
      tapH: 44,
    }),
  );
  check(
    "an uncapped box on a 30px row would reach into the row above — which is why it is capped",
    overlap(uncapped[1].tap, uncapped[0].tap) && overlap(uncapped[1].tap, uncapped[2].tap),
    `${uncapped[1].tap.top}–${uncapped[1].tap.bottom} against rows of ${rowHeight}`,
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
