/**
 * The slide between layouts: how long the columns take, and what is allowed to
 * start one.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/pane-motion.mjs
 *
 * The panes are one mounted grid, so a mode press is a change of track widths
 * rather than a rebuild — and a change of widths is something CSS can draw. This
 * suite pins the three pieces that have to agree for that to be true rather than
 * decorative: the model in `lib/panes.ts` (three feels, one table), the state
 * class (a press bumps `pressSeq`; a resize, a drag and a slider do not), and
 * the view (`sliding` is armed by that counter, never by a measurement).
 *
 * It also pins the precondition the whole idea rests on: both templates have the
 * same number of tracks in every arrangement, because a track list of a
 * different length cannot be interpolated. That is checked by counting, not by
 * trusting the comment.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MOTION,
  FLAT_ROWS,
  PANE_MOTIONS,
  PANE_MOTION,
  clampShare,
  gridTemplate,
  isPaneMotion,
  motionEase,
  motionMs,
  stackTemplate,
} from "../../src/lib/panes.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const layout = read("src/state/layout.svelte.ts");
const main = read("src/views/Main.svelte");
const panel = read("src/components/ThemePanel.svelte");

/** The tracks of a grid-template string, splitting only outside `calc()`. */
function tracksOf(template) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const char of template) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === " " && depth === 0) {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// Three feels, one table, and the numbers the text promises.
check("three feels are offered", PANE_MOTIONS.length === 3 && PANE_MOTIONS.join(",") === "off,quick,smooth", PANE_MOTIONS.join(","));
check(
  "each has a duration and a curve",
  PANE_MOTIONS.every((feel) => typeof PANE_MOTION[feel].ms === "number" && typeof PANE_MOTION[feel].ease === "string"),
);
check("instant is no movement at all", PANE_MOTION.off.ms === 0 && PANE_MOTION.off.ease === "linear", JSON.stringify(PANE_MOTION.off));
check(
  "the two that move are inside the 160–250ms a press is allowed",
  PANE_MOTIONS.filter((feel) => feel !== "off").every((feel) => PANE_MOTION[feel].ms >= 160 && PANE_MOTION[feel].ms <= 250),
  JSON.stringify(PANE_MOTION),
);
// The content of a pane is laid out once per press rather than once per frame
// (see the view below), so a slide costs what it looks like rather than what it
// relayouts — which is what buys the longer durations.
check(
  "and a little longer than they were, now that a slide is not a relayout per frame",
  PANE_MOTION.quick.ms > 150 && PANE_MOTION.smooth.ms > 195,
  `${PANE_MOTION.quick.ms}/${PANE_MOTION.smooth.ms}`,
);
check(
  "and they are not the same delay with two names",
  new Set(PANE_MOTIONS.map((feel) => PANE_MOTION[feel].ms)).size === 3,
  PANE_MOTIONS.map((feel) => PANE_MOTION[feel].ms).join(","),
);
check(
  "each moving feel has a four-point cubic-bezier, and they differ",
  PANE_MOTIONS.filter((feel) => feel !== "off").every((feel) =>
    /^cubic-bezier\((-?[\d.]+, ){3}-?[\d.]+\)$/.test(PANE_MOTION[feel].ease),
  ) && PANE_MOTION.quick.ease !== PANE_MOTION.smooth.ease,
  `${PANE_MOTION.quick.ease} vs ${PANE_MOTION.smooth.ease}`,
);
{
  // A curve that overshoots its target pushes the track past the width the
  // content inside it was laid out at (`max(var(--tN), 100%)` in the view), so
  // the last frames of the slide either stretch the rows or open a strip of the
  // pane's background beside them. Both feels must decelerate into the target
  // instead: control points that never pass 1, and a first control point that
  // already means "moving" so the press answers immediately.
  const points = (ease) =>
    ease
      .replace(/^cubic-bezier\(|\)$/g, "")
      .split(",")
      .map((part) => Number(part.trim()));
  const moving = PANE_MOTIONS.filter((feel) => feel !== "off");
  check(
    "no feel overshoots the width the panes are laid out at",
    moving.every((feel) => {
      const [, y1, , y2] = points(PANE_MOTION[feel].ease);
      return y1 <= 1 && y2 <= 1;
    }),
    moving.map((feel) => PANE_MOTION[feel].ease).join(" / "),
  );
  check(
    "and both leave at once and settle, rather than easing in and out",
    moving.every((feel) => {
      const [x1, y1] = points(PANE_MOTION[feel].ease);
      return x1 > 0 && y1 > 0 && y1 / x1 > 1.5;
    }),
  );
  check(
    "the longer of the two settles instead of bouncing",
    PANE_MOTION.smooth.ms > PANE_MOTION.quick.ms &&
      points(PANE_MOTION.smooth.ease)[3] === 1 &&
      points(PANE_MOTION.quick.ease)[3] === 1,
  );
}
check(
  "the model answers for the duration and the curve",
  PANE_MOTIONS.every((feel) => motionMs(feel) === PANE_MOTION[feel].ms && motionEase(feel) === PANE_MOTION[feel].ease),
);
check("a stored value is validated, not trusted", isPaneMotion("quick") && !isPaneMotion("fast") && !isPaneMotion(null) && !isPaneMotion(0));
check("and the default is one of the three that move", isPaneMotion(DEFAULT_MOTION) && DEFAULT_MOTION !== "off", DEFAULT_MOTION);

// ---------------------------------------------------------------------------
// The precondition: both templates are the same length in every arrangement, so
// the split can slide open and shut instead of snapping. A track list that
// changes length, or a `1fr` at one end and a length at the other, cannot be
// interpolated at all.
{
  const widths = { sidebar: 280, list: 380 };
  const frames = [
    gridTemplate(1, widths, { available: 900 }),
    gridTemplate(2, widths, { available: 900 }),
    gridTemplate(3, widths, { available: 1100 }),
    gridTemplate(3, widths, { available: 1100, stacked: true }),
    gridTemplate(3, widths, { available: 1100, collapsed: true }),
  ];
  check(
    "every arrangement draws five column tracks",
    frames.every((template) => tracksOf(template).length === 5),
    frames.map((template) => tracksOf(template).length).join(","),
  );
  check(
    "and every one of them is a length, never a fr or a keyword",
    frames.every((template) =>
      tracksOf(template).every((track) => /^-?[\d.]+px$/.test(track) || /^calc\(/.test(track)),
    ),
    frames.join(" | "),
  );
  const rows = [stackTemplate(0.5), stackTemplate(clampShare(0.7, 900)), FLAT_ROWS];
  check(
    "and the rows are four tracks whether split or flat",
    rows.every((template) => tracksOf(template).length === 4),
    rows.map((template) => tracksOf(template).length).join(","),
  );
}

// ---------------------------------------------------------------------------
// The state: a press bumps the counter, a measurement does not.
check("the feel is state, saved with the layout", /motion = \$state<PaneMotion>\(DEFAULT_MOTION\);/.test(layout));
check("the counter is state too, starting at nothing", /pressSeq = \$state\(0\);/.test(layout));
check("one place bumps it", /private press\(\): void \{\s*this\.pressSeq \+= 1;\s*\}/.test(layout));
check(
  "a mode press is one of them, and it changes the mode first",
  /setMode\(mode: PaneMode\): void \{[\s\S]{0,600}this\.settle\(false\);[\s\S]{0,300}this\.press\(\);/.test(layout),
);
check(
  "so is an arrangement press and the fold",
  /setStacked\(on: boolean\): void \{[\s\S]{0,320}this\.press\(\);/.test(layout) &&
    /toggleSidebar\(\): void \{\s*this\.sidebarCollapsed = !this\.sidebarCollapsed;\s*this\.press\(\);/.test(layout),
);
// The sizing toggle is a press too, and for the same reason: switching between
// keeping the pane widths and sharing the window changes the frame, so the tracks
// must move rather than snap — once, not once per resize tick.
check(
  "and the sizing toggle, which names the frame it is entering",
  /setKeepWidths\(value: boolean\): void \{[\s\S]{0,1100}this\.press\(\);/.test(layout) &&
    /setKeepWidths\(value: boolean\): void \{[\s\S]{0,2200}fitWindowTo\(target\)/.test(layout),
);
check(
  "it asks for that frame through the same queue a mode press uses",
  /setKeepWidths\(value: boolean\): void \{[\s\S]{0,1200}const ask = this\.resizing\.then\(\(\) => fitWindowTo\(target\)\);/.test(layout),
);
check(
  "and nothing else — not a resize, not a drag, not a slider",
  (() => {
    /** The body of one method: from its brace to the brace at method indent. */
    const body = (name) => {
      const start = layout.indexOf(`\n  ${name}(`);
      if (start < 0) return null;
      const open = layout.indexOf("{", start);
      return layout.slice(open, layout.indexOf("\n  }", open));
    };
    const quiet = [
      "setAvailable",
      "setThreshold",
      "dragTo",
      "commit",
      "dragShare",
      "commitShare",
      "nudgeShare",
      "resetShare",
      "nudge",
      "reset",
      "resetWidths",
      "resetThresholds",
      "setMotion",
      "collapseOne",
    ];
    const reachable = quiet.filter((name) => body(name) === null);
    const pressing = quiet.filter((name) => body(name)?.includes("this.press("));
    return reachable.length === 0 && pressing.length === 0;
  })(),
);
check(
  "a change of feel does not re-animate anything",
  /setMotion\(next: PaneMotion\): void \{\s*if \(!isPaneMotion\(next\) \|\| this\.motion === next\) return;\s*this\.motion = next;\s*this\.save\(\);\s*\}/.test(
    layout,
  ),
);
check("the feel is written back", /motion: this\.motion,/.test(layout));
check(
  "and read back only if it is a real one",
  /if \(isPaneMotion\(saved\.motion\)\) this\.motion = saved\.motion;/.test(layout),
);
check(
  "with reduced motion as the starting feel, not as a hidden fallback",
  /this\.motion = prefersReducedMotion\(\) \? "off" : DEFAULT_MOTION;/.test(layout),
);
check(
  "the system's preference is only the default: a saved choice still wins",
  layout.indexOf("prefersReducedMotion() ? \"off\"") < layout.indexOf("if (isPaneMotion(saved.motion)) this.motion = saved.motion;"),
);
check("and the panel is offered either way", /setMotion\("off"\)/.test(panel) && /setMotion\("smooth"\)/.test(panel));

// ---------------------------------------------------------------------------
// The view: armed by a press, never by a measurement.
check(
  "the first paint does not animate",
  /let animatedPress = 0;/.test(main) &&
    /if \(press === animatedPress\) return;\s*animatedPress = press;\s*if \(press === 0\) return;/.test(main),
);
check(
  "a change of content is not a press, so it is drawn at once",
  /Opening a post swaps the posts for the article without a press/.test(main),
);
check(
  "instant means the class is never added",
  /sliding = ms > 0;/.test(main) && /let sliding = \$state\(false\);/.test(main),
);
check(
  "and it comes off a little after the columns land",
  /const timer = setTimeout\(\(\) => \(sliding = false\), ms \+ 70\);/.test(main),
);
check(
  "the class is the transition, on both the columns and the rows",
  /\.panes\.sliding \{[\s\S]{0,260}grid-template-columns var\(--slide-ms, 0ms\) var\(--slide-ease, ease\),\s*grid-template-rows var\(--slide-ms, 0ms\) var\(--slide-ease, ease\);/.test(
    main,
  ),
);
check(
  "the duration and the curve are the model's, written inline",
  /style:--slide-ms=\{`\$\{motionMs\(layout\.motion\)\}ms`\}/.test(main) &&
    /style:--slide-ease=\{motionEase\(layout\.motion\)\}/.test(main) &&
    /import \{ arriveKeyframes, gridTemplate, motionEase, motionMs, paneSlots, tracks \} from "\.\.\/lib\/panes";/.test(main),
);
// ---------------------------------------------------------------------------
// The elastic. It is a transform on the pane that arrives, never a wider track:
// a track past its target re-lays out the text inside it in the last frames.
const { ARRIVE, arriveKeyframes } = await import("../../src/lib/panes.ts");
check("an arriving pane travels in from its side", arriveKeyframes(1)[0].transform === "translateX(14px)");
check("and from the other side going the other way", arriveKeyframes(-1)[0].transform === "translateX(-14px)");
check("it passes its home a little, the other way", arriveKeyframes(1)[1].transform.startsWith("translateX(-"));
check("by a fraction of its travel, not a jump", Math.abs(parseFloat(arriveKeyframes(1)[1].transform.slice(11))) < ARRIVE.offset * 0.25);
check("and settles exactly home", arriveKeyframes(1)[2].transform === "translateX(0px)");
check("a wild overshoot is clamped", Math.abs(parseFloat(arriveKeyframes(1, 10, 9)[1].transform.slice(11))) <= 4);
check(
  "the view bounces only what arrived",
  /now\.feeds && before !== null && !before\.feeds/.test(main) &&
    /now\.posts && before !== null && !before\.posts/.test(main) &&
    /now\.article && before !== null && !before\.article/.test(main),
);
check(
  "with the model's duration, and nothing when the feel is off",
  /const frames: Keyframe\[\] = arriveKeyframes\(from\)/.test(main) &&
    /element\.animate\(frames, \{\s*duration: ms,/.test(main) &&
    /if \(!sliding\) return;/.test(main),
);
check(
  "and the transform is on the slot, not the track",
  /bind:this=\{feedsSlot\}/.test(main) && /bind:this=\{postsSlot\}/.test(main) && /bind:this=\{articleSlot\}/.test(main),
);

check(
  "and only a press carries the class",
  /class:sliding/.test(main) && !/class:sliding=\{layout\./.test(main),
);

// ---------------------------------------------------------------------------
// What the slide does to the panes while it runs.
//
// A track that moves over content that is being laid out again every frame is
// not a slide, it is a relayout per frame: measured in WebKitGTK, one relayout of
// a two-hundred-row posts list at a new width is 16–20ms, and a zero-width one is
// worse. So the width a pane's content is laid out at comes from the track list
// — `max(final, the track right now)` — which lays an opening column out once, at
// the width it will end at, and lets a closing one follow its track down. A pane
// that is leaving keeps the width it was drawn at instead, because its track is
// on its way to nothing.
check(
  "the track list is written for the panes as well as for the grid",
  /style:--t1=\{`\$\{trackList\[0\]\}px`\}/.test(main) && /style:--t5=\{`\$\{trackList\[4\]\}px`\}/.test(main),
);
check(
  "and it is the same arithmetic the grid string is written from",
  /const trackList = \$derived\(\s*tracks\(mode, layout\.shown, \{/.test(main) &&
    /available: layout\.drawn,/.test(main),
);
check(
  "a pane that stays is laid out at the width the slide ends at",
  /\.panes\.sliding \.slot\.posts:not\(\.away\) > :global\(\*\) \{\s*flex: 0 0 auto;\s*width: max\(var\(--t3\), 100%\);/.test(
    main,
  ),
  main.slice(main.indexOf(".panes.sliding .slot.posts"), main.indexOf(".panes.sliding .slot.posts") + 160),
);
check(
  "so a closing column squeezes rather than being laid out at nothing",
  /width: max\(var\(--t1\), 100%\)/.test(main) && /width: max\(var\(--t5\), 100%\)/.test(main),
);
check(
  "and a pane that is leaving keeps the width it has",
  /\.panes\.sliding \.slot\.away > :global\(\*\) \{\s*flex: 0 0 auto;\s*width: var\(--from, 100%\);/.test(main),
);
check(
  "...measured before the tracks are written, not after",
  /\$effect\.pre\(\(\) => \{\s*if \(layout\.pressSeq === 0 \|\| panes === null\) return;[\s\S]{0,240}getBoundingClientRect\(\)\.width[\s\S]{0,120}setProperty\("--from"/.test(
    main,
  ),
);
check(
  "a pane being drawn paints over one that is leaving the same track",
  /\.panes\.sliding \.slot:not\(\.away\) \{\s*z-index: 1;/.test(main) &&
    /\.panes\.sliding \.slot\.seam-x,\s*\.panes\.sliding \.slot\.seam-y \{\s*z-index: 2;/.test(main),
);
/**
 * The entries are there when the column is drawn.
 *
 * Measured in WebKitGTK with the real list (two hundred rows, thumbnails on a
 * seven-hundred-millisecond origin, window travelling in five steps): the first
 * row of the posts column has a box at 51–78ms after the click in every one of
 * eight configurations — one pane to two, three to two with an article open, two
 * to one, Keep widths and Keep window, forty rows and two hundred — and there is
 * no frame in any of them where the column is wider than 60px with nothing
 * painted in it.
 *
 * What makes that true is the pair of rules below: the panes are hidden rather
 * than unmounted, so the rows are laid out before their column appears, and a
 * pane being drawn is laid out at the width it will end at rather than at the
 * track's width on each frame — so nothing re-measures itself into place after
 * the column has already opened.
 */
check(
  "a pane that is not drawn is hidden, never unmounted",
  /\.slot\.away \{[\s\S]{0,120}visibility: hidden;/.test(main) &&
    !/\.slot\.away \{[\s\S]{0,120}display: none;/.test(main) &&
    /class:away=/.test(main),
);
check(
  "and the press that opens a track is the only thing that pins one",
  !/\.panes:not\(\.sliding\)[\s\S]{0,80}width: max\(/.test(main),
);

// ---------------------------------------------------------------------------
// The row on the panel: three named feelings, one press each, reachable on a
// phone — which means outside the gate on the pixel sliders, like the stack row.
{
  const gate = panel.indexOf("{#if layout.caps.paneThresholds}");
  const close = panel.indexOf("{/if}", gate);
  const row = panel.indexOf('<span class="key">Pane slide</span>');
  check("the layout tab offers the slide", row > 0);
  check("outside the threshold gate, so a phone can reach it", gate > 0 && row > close, `row at ${row}, gate closes at ${close}`);
  check(
    "three buttons, each naming its own feel",
    /layout\.setMotion\("off"\)\}>Instant<\/button>/.test(panel) &&
      /layout\.setMotion\("quick"\)\}>Quick<\/button>/.test(panel) &&
      /layout\.setMotion\("smooth"\)\}>Smooth<\/button>/.test(panel),
  );
  check(
    "each says whether it is the one in force",
    (panel.match(/aria-pressed=\{layout\.motion === "(?:off|quick|smooth)"\}/g) ?? []).length === 3,
  );
  check(
    "and the row is a choice, not a switch: no checkbox in it",
    /aria-label="How the panes move when the layout changes"/.test(panel) && !/Pane slide[\s\S]{0,600}type="checkbox"/.test(panel),
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
