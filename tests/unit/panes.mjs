import {
  MIN, GUTTER, NEEDED, MINIMUMS, THRESHOLDS, THRESHOLD_LIMITS, effectiveMode, clampWidths, dragPane,
  resetPane, nudge, gridTemplate, tracks, guttersFor, geometricMinimum, defaultModeFor, needed, minimums,
  clampThresholds, widthFor, intentWidths, MODE_HYSTERESIS, fitTarget, thresholdLimits,
  DEFAULT_LAYOUT, layoutWidths, neededWidth, thresholdsFor, scaleLayout, settleRequirement,
  intentLayout, layoutFromWidths, extendToThree,
  STACK_GUTTER, STACK_SHARE, STACK_MIN_PANE, stackWidth, stackNeeded, clampShare,
  RAIL,
  paneSlots,
} from "../../src/lib/panes.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The usability floors sit above the hard minimums, on purpose.
check("three panes need both minimums plus gutters", geometricMinimum(3) === MIN.sidebar + MIN.list + MIN.article + GUTTER * 2, String(geometricMinimum(3)));
check("two panes need one gutter", geometricMinimum(2) === MIN.sidebar + MIN.list + GUTTER, String(geometricMinimum(2)));
check("three-pane floor clears the geometry", NEEDED.desktop[3] >= geometricMinimum(3) && NEEDED.desktop[3] === 1000);
check("two-pane floor clears the geometry", NEEDED.desktop[2] >= geometricMinimum(2) && NEEDED.desktop[2] === 700, String(NEEDED.desktop[2]));
check("gutter count per mode", guttersFor(3) === 12 && guttersFor(2) === 6 && guttersFor(1) === 0);

// Thresholds are settings now, so every one of these has to hold for values the
// user chose, not only for the defaults.
const late = { two: 900, three: 1500 };
check("custom thresholds decide the mode", effectiveMode(3, 1200, "desktop", late) === 2, String(effectiveMode(3, 1200, "desktop", late)));
check("custom thresholds still allow three when met", effectiveMode(3, 1500, "desktop", late) === 3);
check("below the custom two threshold it is one pane", effectiveMode(3, 899, "desktop", late) === 1);
check(
  "defaults when no thresholds are passed",
  effectiveMode(3, 1000) === 3 && effectiveMode(3, 999) === 2 && effectiveMode(3, 699) === 1,
);

// The owner's slider minimums: one pane from 250, two from 500, three from 750.
// They are the settings' floors, not the mode floors above — the mode still needs
// its own window, and a slider set to 500 is a window two panes appear at.
check(
  "the layout sliders bottom out where the owner said",
  THRESHOLD_LIMITS.one.min === 250 && THRESHOLD_LIMITS.two.min === 500 && THRESHOLD_LIMITS.three.min === 750,
  JSON.stringify({ one: THRESHOLD_LIMITS.one.min, two: THRESHOLD_LIMITS.two.min, three: THRESHOLD_LIMITS.three.min }),
);
check(
  "a phone keeps its own narrower slider floors",
  thresholdLimits("phone").two.min === NEEDED.phone[2] && thresholdLimits("phone").three.min === NEEDED.phone[3],
  JSON.stringify(thresholdLimits("phone")),
);
check(
  "and the desktop's are the owner's numbers themselves",
  thresholdLimits("desktop").two.min === 500 && thresholdLimits("desktop").three.min === 750,
);

check("the sliders' floor and ceiling are enforced", () => {
  const low = clampThresholds({ two: 10, three: 20 });
  const high = clampThresholds({ two: 9000, three: 9000 });
  return (
    low.two === THRESHOLD_LIMITS.two.min &&
    low.three === THRESHOLD_LIMITS.two.min + THRESHOLD_LIMITS.gap &&
    high.two === THRESHOLD_LIMITS.two.max &&
    high.three === THRESHOLD_LIMITS.three.max
  );
});
check("three always stays clear of two", () => {
  const pulled = clampThresholds({ two: 800, three: 810 });
  check("one never outgrows two", clampThresholds({ one: 900, two: 700, three: 900 }).one === 700 - THRESHOLD_LIMITS.gap);
  check("one is clamped into its own limits", clampThresholds({ one: 10 }).one === THRESHOLD_LIMITS.one.min);
  check("one defaults to the single-column floor", clampThresholds({}).one === THRESHOLDS.desktop.one);
  check("the phone keeps its own one-pane width", clampThresholds({}, "phone").one === THRESHOLDS.phone.one);
  return pulled.three === 800 + THRESHOLD_LIMITS.gap;
});
check("junk falls back to the device defaults", () => {
  const fallback = clampThresholds({ two: Number.NaN, three: "x" }, "phone");
  return fallback.two === THRESHOLDS.phone.two && fallback.three === THRESHOLDS.phone.three;
});

check("a mode's width is what the switch resizes to", () => {
  return (
    widthFor(1, "desktop", late) === NEEDED.desktop[1] &&
    widthFor(2, "desktop", late) === 900 &&
    widthFor(3, "desktop", late) === 1500 &&
    widthFor(1, "phone") === NEEDED.phone[1]
  );
});
// "1" now has a width of its own, and it is a setting like the other two.
check(
  "one pane's width is its own setting",
  widthFor(1, "desktop", { one: 420, two: 900, three: 1500 }) === 420,
);
check(
  "one pane falls back to the floor when the setting is missing",
  widthFor(1, "desktop", { two: 900, three: 1500 }) === NEEDED.desktop[1],
);

check("a window exactly on a custom threshold shows that many", effectiveMode(2, 900, "desktop", late) === 2);

// A narrow window does not get three panes, whichever mode was asked for.
check("3 requested, roomy window", effectiveMode(3, 1440) === 3);
check("3 requested, 1024px", effectiveMode(3, 1024) === 3, String(effectiveMode(3, 1024)));
check("3 requested, 800px falls to 2", effectiveMode(3, 800) === 2, String(effectiveMode(3, 800)));
check("3 requested, 500px falls to 1", effectiveMode(3, 500) === 1);
check("2 requested, 1440 keeps 2", effectiveMode(2, 1440) === 2);
check("1 requested stays 1", effectiveMode(1, 1440) === 1);

// The dead zone either side of a boundary. Without it a window sitting on 700
// flips between one and two panes, and a threshold slider rearranges the panes
// while the pointer is still on the track.
check("no current mode means no dead zone", effectiveMode(2, 701) === 2 && effectiveMode(2, 699) === 1);
check(
  "growing needs the window past the width by the whole band",
  effectiveMode(2, 700 + MODE_HYSTERESIS - 1, "desktop", THRESHOLDS.desktop, 1) === 1,
);
check(
  "and then it grows",
  effectiveMode(2, 700 + MODE_HYSTERESIS, "desktop", THRESHOLDS.desktop, 1) === 2,
);
check(
  "shrinking needs it past the boundary by the whole band too",
  effectiveMode(2, 700 - MODE_HYSTERESIS + 1, "desktop", THRESHOLDS.desktop, 2) === 2,
);
check(
  "and then it collapses",
  effectiveMode(2, 700 - MODE_HYSTERESIS, "desktop", THRESHOLDS.desktop, 2) === 1,
);
check(
  "the band is a dead zone, not a new threshold: inside it, nothing moves",
  [701, 720, 760, 790].every((w) => effectiveMode(3, w, "desktop", THRESHOLDS.desktop, 2) === 2),
);
check(
  "three panes get the same treatment on both edges",
  effectiveMode(3, 1000 + MODE_HYSTERESIS - 1, "desktop", THRESHOLDS.desktop, 2) === 2 &&
    effectiveMode(3, 1000 + MODE_HYSTERESIS, "desktop", THRESHOLDS.desktop, 2) === 3 &&
    effectiveMode(3, 1000 - MODE_HYSTERESIS + 1, "desktop", THRESHOLDS.desktop, 3) === 3 &&
    effectiveMode(3, 1000 - MODE_HYSTERESIS, "desktop", THRESHOLDS.desktop, 3) === 2,
);
check(
  "the band cannot exceed the room two panes need",
  700 - MODE_HYSTERESIS >= MIN.sidebar + GUTTER + MIN.list,
  `${700 - MODE_HYSTERESIS} vs ${MIN.sidebar + GUTTER + MIN.list}`,
);

// Clamping holds minimums in both directions.
const wide = clampWidths({ sidebar: 280, list: 380 }, 3, 1440);
check("sane widths survive", wide.sidebar === 280 && wide.list === 380, JSON.stringify(wide));
const tinySidebar = clampWidths({ sidebar: 20, list: 380 }, 3, 1440);
check("sidebar cannot go below its minimum", tinySidebar.sidebar === MIN.sidebar, JSON.stringify(tinySidebar));
const hugeSidebar = clampWidths({ sidebar: 2000, list: 380 }, 3, 1440);
check(
  "sidebar cannot squeeze the others out",
  hugeSidebar.sidebar === 1440 - GUTTER * 2 - MIN.list - MIN.article,
  JSON.stringify(hugeSidebar),
);
const hugeList = clampWidths({ sidebar: 280, list: 2000 }, 3, 1024);
check("list cannot squeeze the article out", hugeList.list === 1024 - GUTTER * 2 - 280 - MIN.article, JSON.stringify(hugeList));
// Mode 2: the second column is the whole content column, so it may take everything.
const listWide2 = clampWidths({ sidebar: 280, list: 2000 }, 2, 1024);
check("mode 2 list may fill the rest", listWide2.list === 1024 - GUTTER - 280, JSON.stringify(listWide2));

// A saved width from a big screen is re-clamped on a small one.
const saved = clampWidths({ sidebar: 420, list: 520 }, 3, 1000);
check("saved widths re-clamp on resize", saved.sidebar + saved.list <= 1000 - GUTTER * 2 - MIN.article, JSON.stringify(saved));

// Dragging is a delta, so it cannot drift and cannot cross a minimum.
const dragged = dragPane("sidebar", { sidebar: 280, list: 380 }, 40, 3, 1440);
check("dragging the sidebar moves it by the delta", dragged.sidebar === 320, JSON.stringify(dragged));
const overDragged = dragPane("sidebar", { sidebar: 280, list: 380 }, -400, 3, 1440);
check("dragging past the minimum stops at it", overDragged.sidebar === MIN.sidebar, JSON.stringify(overDragged));
check("double-click reset", resetPane("sidebar") === 280 && resetPane("list") === 380);
check("keyboard nudge", nudge({ sidebar: 280, list: 380 }, "sidebar", 1).sidebar === 296);
check("shift nudge", nudge({ sidebar: 280, list: 380 }, "sidebar", -1, true).sidebar === 216);

// ---------------------------------------------------------------------------
// The tracks. Five of them in every mode, all lengths, because a track list that
// changes shape cannot be interpolated — the columns would snap instead of
// sliding. Each check below pins one of the arrangements, and the property
// underneath them is that the five numbers add up to the pane container.
const widths300 = { sidebar: 300, list: 400 };
/** The tracks as numbers, in pixels: `gridTemplate` never writes `1fr`. */
const tracksOf = (template) => template.split(/\s+/).map((track) => Number(track.replace("px", "")));
const sumsTo = (template, total) =>
  tracksOf(template).length === 5 &&
  Math.abs(tracksOf(template).reduce((sum, track) => sum + track, 0) - total) < 0.02;

check(
  "three panes carry both gutter tracks",
  gridTemplate(3, widths300, { available: 1100 }) ===
    `300px ${GUTTER}px 400px ${GUTTER}px 388px`,
  gridTemplate(3, widths300, { available: 1100 }),
);
check(
  "and the five tracks are the frame",
  sumsTo(gridTemplate(3, widths300, { available: 1100 }), 1100),
);
check(
  "one pane fills the frame a press fits it to",
  gridTemplate(1, widths300, { available: 300 }) === "300px 0px 0px 0px 0px" &&
    sumsTo(gridTemplate(1, widths300, { available: 300 }), 300),
  gridTemplate(1, widths300, { available: 300 }),
);
check(
  "two panes give the posts the rest of the frame",
  gridTemplate(2, widths300, { available: 1100 }) === `300px ${GUTTER}px 794px 0px 0px` &&
    sumsTo(gridTemplate(2, widths300, { available: 1100 }), 1100),
  gridTemplate(2, widths300, { available: 1100 }),
);
check(
  "every arrangement writes five tracks that sum to the frame",
  [1, 2, 3].every((mode) =>
    [false, true].every((collapsed) =>
      [false, true].every((stacked) =>
        [false, true].every((keepWidths) =>
          sumsTo(
            gridTemplate(mode, widths300, {
              available: 1234.5,
              collapsed,
              stacked,
              keepWidths,
            }),
            1234.5,
          ),
        ),
      ),
    ),
  ),
);

// The same geometry as numbers, which is what a sliding press hands each pane to
// lay its content out at (`--t1`…`--t5` in `Main.svelte`). The view draws the
// string and the panes are sized from the numbers, so the two cannot be allowed
// to disagree: one arrangement of each shape, both read back.
{
  const arrangements = [
    [1, { available: 700 }],
    [2, { available: 700 }],
    [2, { available: 1100, collapsed: true }],
    [3, { available: 1100 }],
    [3, { available: 1100, stacked: true }],
    [3, { available: 900, collapsed: true, stacked: true }],
  ];
  const agree = arrangements.every(([mode, options]) => {
    const numbers = tracks(mode, widths300, options);
    return (
      numbers.length === 5 &&
      numbers.every((size) => Number.isFinite(size) && size >= 0) &&
      numbers.join(" ") ===
        gridTemplate(mode, widths300, options)
          .split(" ")
          .map((size) => Number(size.replace("px", "")))
          .join(" ")
    );
  });
  check("the track numbers are the track string, to the pixel", agree);
  check(
    "and every one of them is a length, never a negative or a NaN",
    arrangements.every(([mode, options]) =>
      tracks(mode, widths300, options).every((size) => Number.isFinite(size) && size >= 0),
    ),
  );
  check(
    "a frame too narrow for the panes still gives five lengths",
    tracks(3, widths300, { available: 200 }).every((size) => Number.isFinite(size) && size >= 0) &&
      tracks(3, widths300, { available: 200 }).length === 5,
    JSON.stringify(tracks(3, widths300, { available: 200 })),
  );
}

// One column with "Keep window": the frame is the user's, and the one pane takes
// all of it. A press changes what is drawn inside the frame — one column instead
// of two or three — and never leaves a strip of nothing beside it.
const onePane = { sidebar: 280, list: 380 };
check(
  "keep window: the one pane expands to meet the frame",
  gridTemplate(1, onePane, { available: 1200, keepWidths: false }) ===
    "1200px 0px 0px 0px 0px",
  gridTemplate(1, onePane, { available: 1200, keepWidths: false }),
);
check(
  "keep widths: the pane fills the window the press fitted to it",
  gridTemplate(1, onePane, { available: 280, keepWidths: true }) === "280px 0px 0px 0px 0px",
  gridTemplate(1, onePane, { available: 280, keepWidths: true }),
);
check(
  "a window narrower than the pane still fills it",
  gridTemplate(1, onePane, { available: 240, keepWidths: false }) === "240px 0px 0px 0px 0px",
  gridTemplate(1, onePane, { available: 240, keepWidths: false }),
);
check(
  "and it is the frame's width, whatever the sidebar was shaped to",
  tracksOf(gridTemplate(1, { sidebar: 355, list: 380 }, { available: 1600, keepWidths: false }))[0] === 1600,
);

// --- phone ------------------------------------------------------------------
// An iPhone is ~390x844 in CSS pixels: portrait is one column, landscape is
// three, and the switch can still change it afterwards.
check("phone portrait opens in 1", defaultModeFor({ phone: true, width: 390, height: 844 }) === 1);
check("phone landscape opens in 3", defaultModeFor({ phone: true, width: 844, height: 390 }) === 3);
// A desktop opens in three panes whatever the width: the shape is a decision,
// not a guess about the window. `effectiveMode` still draws only what fits, so
// a narrow window shows fewer panes without the default changing.
check("desktop 1440 opens in 3", defaultModeFor({ phone: false, width: 1440, height: 900 }) === 3);
check("desktop 900 opens in 3, drawn as 2", defaultModeFor({ phone: false, width: 900, height: 800 }) === 3);
check(
  "a narrow desktop still asks for 3",
  defaultModeFor({ phone: false, width: 500, height: 800 }) === 3,
);
check("but the drawing is clamped to what fits", effectiveMode(3, 500, "desktop") === 1);
check("and at 900 it draws two of the three asked for", effectiveMode(3, 900, "desktop") === 2);
check("the phone is untouched by this", defaultModeFor({ phone: true, width: 390, height: 844 }) === 1);

// The phone gets its own floors, below the desktop ones, because a landscape
// iPhone is 844px and the desktop floor would refuse three panes there.
check("phone floors are lower than desktop", needed(3, "phone") < needed(3, "desktop"), `${needed(3, "phone")} vs ${needed(3, "desktop")}`);
check("landscape iPhone can draw 3 panes", effectiveMode(3, 844, "phone") === 3, String(effectiveMode(3, 844, "phone")));
check("the same width on desktop falls to 2", effectiveMode(3, 844, "desktop") === 2);
check("portrait phone falls to 1", effectiveMode(3, 390, "phone") === 1);
check("phone minimums are narrower", minimums("phone").sidebar < minimums("desktop").sidebar);
check(
  "phone widths clamp to phone minimums",
  clampWidths({ sidebar: 60, list: 60 }, 3, 844, "phone").sidebar === MINIMUMS.phone.sidebar,
  JSON.stringify(clampWidths({ sidebar: 60, list: 60 }, 3, 844, "phone")),
);
const phoneThree = clampWidths({ sidebar: 168, list: 240 }, 3, 844, "phone");
check(
  "a landscape iPhone keeps all three panes above their minimums",
  phoneThree.sidebar >= MINIMUMS.phone.sidebar && phoneThree.list >= MINIMUMS.phone.list &&
    844 - phoneThree.sidebar - phoneThree.list - GUTTER * 2 >= MINIMUMS.phone.article,
  JSON.stringify(phoneThree),
);

// The stored intent is not the drawn width. `intentWidths` only floors and
// rounds; it must not carry a ceiling from the window or the mode, because that
// is what let a narrow window, or a visit to one column, rewrite the layout.
check("intent keeps a width the current window cannot draw", intentWidths({ sidebar: 900, list: 900 }, "desktop").sidebar === 900);
check("intent keeps a wide list too", intentWidths({ sidebar: 900, list: 900 }, "desktop").list === 900);
check("intent floors at the hard minimum", intentWidths({ sidebar: 10, list: 10 }, "desktop").sidebar === MIN.sidebar);
check("and floors the list at its own minimum", intentWidths({ sidebar: 10, list: 10 }, "desktop").list === MIN.list);
check("phone floors use the phone minimums", intentWidths({ sidebar: 10, list: 10 }, "phone").list === MINIMUMS.phone.list);
check("intent rounds", intentWidths({ sidebar: 280.6, list: 380.4 }, "desktop").sidebar === 281);
check("intent survives nonsense without producing NaN", Number.isFinite(intentWidths({ sidebar: NaN, list: NaN }, "desktop").sidebar));

// Draw and intent are separate questions: the same intent draws differently in
// a narrow window and comes back unchanged when there is room again.
const intent = { sidebar: 320, list: 460 };
const narrow = clampWidths(intent, 3, 1000, "desktop");
check("a narrow window draws a fitted sidebar", narrow.sidebar <= 1000 - GUTTER * 2 - MIN.list - MIN.article);
check("but the intent is untouched by fitting", intent.sidebar === 320 && intent.list === 460);
check("a wide window draws the intent as asked", JSON.stringify(clampWidths(intent, 3, 1600, "desktop")) === JSON.stringify(intent));

// One column used to force the list to its minimum, which is why a round trip
// through one pane came back with a 260px list.
check("one column does not rewrite the list", clampWidths(intent, 1, 1600, "desktop").list === MIN.list);
check("the intent still holds it", intentWidths(intent, "desktop").list === 460);

// The panes are the source of truth: the thresholds are their sum, so a drag
// and a slider can never disagree about where the columns are.
{
  const shaped = { sidebar: 520, list2: 380, list3: 300, article: 460 };
  check("two panes need the sidebar and the posts", neededWidth(shaped, 2) === 520 + GUTTER + 380);
  check("three panes need all three", neededWidth(shaped, 3) === 520 + GUTTER + 300 + GUTTER + 460);
  check("one pane needs its own floor", neededWidth(shaped, 1) === NEEDED.desktop[1]);
  // A layout dragged down to slivers still needs a window that holds three
  // usable columns; the mode floor wins over the arithmetic.
  check(
    "the mode floor beats a layout smaller than it",
    neededWidth({ sidebar: 240, list2: 260, list3: 260, article: 320 }, 3) === NEEDED.desktop[3],
  );
  const t = thresholdsFor(shaped, "desktop", 320);
  check("the two slider is the two-pane sum", t.two === neededWidth(shaped, 2), String(t.two));
  check("the three slider is the three-pane sum", t.three === neededWidth(shaped, 3), String(t.three));
  check("the one width is carried through, not derived", t.one === 320);
  // Widening the sidebar moves both numbers: pressing 2 afterwards asks for a
  // window that keeps the sidebar, which is the whole complaint this replaces.
  const wider = thresholdsFor({ ...shaped, sidebar: 620 }, "desktop", 320);
  check("a wider sidebar raises both thresholds", wider.two > t.two && wider.three > t.three);
  check(
    "and pressing 2 then asks for the wider window",
    widthFor(2, "desktop", wider) === wider.two && wider.two === 620 + GUTTER + 380,
  );
}

// Each mode keeps its own posts column, and the sidebar is shared, so a width
// made once is not remade per mode.
{
  const l = { sidebar: 300, list2: 420, list3: 560, article: 400 };
  check("two panes draw list2", layoutWidths(l, 2).list === 420);
  check("three panes draw list3", layoutWidths(l, 3).list === 560);
  check("the sidebar is the same column in both", layoutWidths(l, 2).sidebar === layoutWidths(l, 3).sidebar);
}

// A slider is a request about a window; the flexible panes take the difference.
{
  const base = { sidebar: 280, list2: 380, list3: 340, article: 340 };
  const two = scaleLayout(base, 2, 900);
  check("the two slider resizes the posts column", two.list2 === 900 - GUTTER - 280, String(two.list2));
  check("and leaves the sidebar alone", two.sidebar === 280);
  const three = scaleLayout(base, 3, 1200);
  check("the three slider splits the difference in proportion", Math.abs(three.list3 - three.article) <= 1, JSON.stringify(three));
  check("and comes to the width asked for", three.sidebar + GUTTER + three.list3 + GUTTER + three.article === 1200);
  const floored = scaleLayout(base, 3, 700);
  check("it cannot squeeze a pane under its floor", floored.list3 >= MIN.list && floored.article >= MIN.article, JSON.stringify(floored));
}

// A requirement may not outgrow the window it was dragged in, or the layout
// would demote itself to one column mid drag.
{
  const base = { sidebar: 280, list2: 380, list3: 380, article: 320 };
  const squeezed = settleRequirement({ ...base, sidebar: 434 }, 2, 700);
  check("dragging the sidebar wide trims the posts requirement", neededWidth(squeezed, 2) <= 700, JSON.stringify(squeezed));
  check("and the posts column stops at its floor", squeezed.list2 === MIN.list);
  const tight = settleRequirement({ sidebar: 300, list3: 600, article: 500 }, 3, 1100);
  check("three panes give up article before posts", neededWidth(tight, 3) <= 1100, JSON.stringify(tight));
  check(
    "a requirement that fits is left alone",
    JSON.stringify(settleRequirement(base, 3, 1600)) === JSON.stringify(base),
    JSON.stringify(settleRequirement(base, 3, 1600)),
  );
}

// Storage: floors only, and a save from before the panes remembered themselves
// keeps the window the user had already chosen as the article's width.
{
  const old = layoutFromWidths({ sidebar: 280, list: 380 }, 1000);
  check("an old save keeps its three-pane window", old.article === 1000 - 280 - 380 - GUTTER * 2, String(old.article));
  check("and gives two panes the same posts width", old.list2 === 380 && old.list3 === 380);
  const junk = intentLayout({ sidebar: 3, list2: 0, list3: 1e9, article: -5 }, "desktop");
  check("a corrupt layout is floored", junk.sidebar === MIN.sidebar && junk.list2 === MIN.list && junk.article === MIN.article);
  check("and a huge one is bounded", junk.list3 <= Math.max(MIN.sidebar, MIN.list) * 8);
  const shipped = thresholdsFor(DEFAULT_LAYOUT, "desktop", 320);
  check("the shipped layout still asks for a sane window", shipped.three === NEEDED.desktop[3], String(shipped.three));
}

// What a mode button asks the window for: the width that mode's panes come to,
// and never past the screen. `keepWidths` — the "On a switch" setting — decides
// whether that number is asked for in both directions or only when growing.
{
  const t = { one: 320, two: 700, three: 1000 };
  check("3 in a narrow window asks to grow", fitTarget(3, 900, "desktop", t) === 1000);
  check(
    "3 in a wide window asks for the panes' width",
    fitTarget(3, 1440, "desktop", t) === 1000,
  );
  check("2 in a one-pane window asks to grow", fitTarget(2, 500, "desktop", t) === 700);
  check("2 takes the third pane's width away with it", fitTarget(2, 1440, "desktop", t) === 700);
  check("1 collapses to its own width", fitTarget(1, 1440, "desktop", t) === 320);
  check("1 in a narrow window grows to its width", fitTarget(1, 300, "desktop", t) === 320);
  check("1 asks for nothing when it is already there", fitTarget(1, 320, "desktop", t) === null);
  // Sharing the window: only growth is asked for, so a wide window keeps its width
  // and the flexible pane takes the difference.
  check("sharing keeps a wide window", fitTarget(3, 1440, "desktop", t, null, false) === null);
  check("sharing keeps two panes wide too", fitTarget(2, 1440, "desktop", t, null, false) === null);
  check("sharing still grows a narrow window", fitTarget(2, 500, "desktop", t, null, false) === 700);
  // Sharing the window means the window is the user's: pressing 1 used to be
  // forced into the fitting branch even here, which shrank a window the setting
  // promised to leave alone. Only a window too narrow for one pane grows.
  check("sharing keeps a wide window for 1 too", fitTarget(1, 1440, "desktop", t, null, false) === null);
  // One column fits anywhere: with the room shared, a narrow window keeps its
  // size and the pane squeezes into it, so nothing is asked for.
  check("sharing never grows the window for 1", fitTarget(1, 200, "desktop", t, null, false) === null);
  // The monitor is the ceiling: a 1366 screen cannot be asked to show 1600.
  check("the screen caps the ask", fitTarget(3, 900, "desktop", t, 1366) === 1000);
  check("a small screen caps a big ask", fitTarget(2, 600, "desktop", { one: 320, two: 1600, three: 2000 }, 1366) === 1366);
  check("no monitor means no cap", fitTarget(2, 600, "desktop", { one: 320, two: 1600, three: 2000 }, null) === 1600);
  check("a capped ask that changes nothing is nothing", fitTarget(2, 1366, "desktop", { one: 320, two: 1600, three: 2000 }, 1366) === null);
  // Found in the browser: a monitor narrower than the window must not turn
  // "grow to fit two panes" into "shrink to the screen".
  check("a small screen never shrinks for 2", fitTarget(2, 1500, "desktop", t, 800, false) === null);
  check("a small screen never shrinks for 3", fitTarget(3, 1500, "desktop", t, 800, false) === null);
  // Keeping pane widths, that window is the panes' sum whatever the screen says:
  // the cap limits growing, it is not a reason to take room away.
  check("kept widths go to the panes' sum on a small screen", fitTarget(2, 1500, "desktop", t, 800) === 700);
  check("but 1 still collapses on a small screen", fitTarget(1, 1500, "desktop", t, 800) === 320);
  check("the phone asks in its own terms", fitTarget(3, 400, "phone", THRESHOLDS.phone, 844) === THRESHOLDS.phone.three);
}

// ---------------------------------------------------------------------------
// Two panes to three: an extension, not a re-division. In two panes the posts
// column is the elastic one, so a third pane used to give it a remembered width
// and crush the article into the remainder — rearranging a layout the user had
// shaped by hand.
const shaped = { sidebar: 420, list2: 380, list3: 380, article: 320 };
const extended = extendToThree(shaped, 900);
check("the sidebar keeps the width it is drawing", extended.sidebar === 420, String(extended.sidebar));
check("the posts column keeps the width the window gave it", extended.list3 === 474, String(extended.list3));
check("the article keeps its own width", extended.article === 320, String(extended.article));
check(
  "so the window it needs is that sum, and three panes do not move a pixel",
  thresholdsFor(extended, "desktop", 320).three === 420 + 474 + 320 + GUTTER * 2,
  String(thresholdsFor(extended, "desktop", 320).three),
);
const squeezedByScreen = extendToThree(shaped, 900, "desktop", 1100);
check("a screen too small takes it from the posts column", squeezedByScreen.list3 === 348, String(squeezedByScreen.list3));
check("and never from the article", squeezedByScreen.article === 320);
check("nor below the posts floor", extendToThree(shaped, 900, "desktop", 700).list3 >= MIN.list);

// ---------------------------------------------------------------------------
// Stacked: three panes drawn as a feed column and one right-hand column, posts
// above the article. Not a fourth mode — the mode, the widths and `keepWidths`
// keep their meaning; only the grid and the width three panes need change.
const stackW = { sidebar: 280, list: 380 };
check(
  "a stacked three panes is two columns, not three",
  gridTemplate(3, stackW, { available: 1100, stacked: true }) ===
    `280px ${GUTTER}px 814px 0px 0px`,
  gridTemplate(3, stackW, { available: 1100, stacked: true }),
);
check(
  "side by side is unchanged when stacked is off",
  gridTemplate(3, stackW, { available: 1100, stacked: false }) ===
    `280px ${GUTTER}px 380px ${GUTTER}px 428px`,
  gridTemplate(3, stackW, { available: 1100, stacked: false }),
);
check(
  "stacked with the feeds folded is the stack alone",
  gridTemplate(3, stackW, { available: 1100, stacked: true, collapsed: true }) ===
    "0px 0px 1100px 0px 0px",
  gridTemplate(3, stackW, { available: 1100, stacked: true, collapsed: true }),
);
check(
  "stacked does not touch two panes",
  gridTemplate(2, stackW, { available: 1100, stacked: true }) ===
    gridTemplate(2, stackW, { available: 1100, stacked: false }),
);
check("the stack is as wide as the wider of its two panes", stackWidth(stackW, 320) === 380, String(stackWidth(stackW, 320)));
check(
  "and it is the article when the article is the wider one",
  stackWidth({ sidebar: 280, list: 300 }, 340) === 340,
  String(stackWidth({ sidebar: 280, list: 300 }, 340)),
);
check("the seam between the stacked panes is a gutter", STACK_GUTTER === GUTTER);
check("the stack costs the feeds, one seam and one column", stackNeeded(stackW, 320) === 280 + GUTTER + 380, String(stackNeeded(stackW, 320)));
check(
  "so a stacked three fits in less width than three columns",
  stackNeeded(stackW, 320) < widthFor(3, "desktop", THRESHOLDS.desktop),
  `${stackNeeded(stackW, 320)} vs ${widthFor(3, "desktop", THRESHOLDS.desktop)}`,
);

// The window three panes need, stacked: no third column, so no third column's
// price. It still may not claim less than two panes do — stacked three are the
// feeds beside one content column, which is what two panes are.
{
  const shipped = { sidebar: 280, list2: 380, list3: 380, article: 320 };
  check("side by side three need the three-column floor", neededWidth(shipped, 3, "desktop") === NEEDED.desktop[3]);
  check(
    "stacked three need what two panes need, not what three columns do",
    neededWidth(shipped, 3, "desktop", true) === NEEDED.desktop[2],
    String(neededWidth(shipped, 3, "desktop", true)),
  );
  const wideList = { sidebar: 280, list2: 380, list3: 500, article: 320 };
  check(
    "a wider posts column raises the stacked requirement past that floor",
    neededWidth(wideList, 3, "desktop", true) === 280 + GUTTER + 500,
    String(neededWidth(wideList, 3, "desktop", true)),
  );
  check(
    "two panes are untouched by the flag",
    neededWidth(wideList, 2, "desktop", true) === neededWidth(wideList, 2, "desktop"),
  );
  const stackedThresholds = thresholdsFor(shipped, "desktop", 280, true);
  check(
    "and the three-pane threshold is that window, ordered after two",
    stackedThresholds.three === stackedThresholds.two + THRESHOLD_LIMITS.gap,
    JSON.stringify(stackedThresholds),
  );
  check(
    "which is well under the three-column one",
    stackedThresholds.three < thresholdsFor(shipped, "desktop", 280).three,
    `${stackedThresholds.three} vs ${thresholdsFor(shipped, "desktop", 280).three}`,
  );
  // The gain, in one line: a window too narrow for three columns draws three
  // stacked panes.
  check(
    "an 800px window draws two side by side",
    effectiveMode(3, 800, "desktop") === 2,
    String(effectiveMode(3, 800, "desktop")),
  );
  check(
    "and three when they are stacked",
    effectiveMode(3, 800, "desktop", stackedThresholds) === 3,
    String(effectiveMode(3, 800, "desktop", stackedThresholds)),
  );
  const phoneStacked = thresholdsFor({ sidebar: 168, list2: 240, list3: 240, article: 240 }, "phone", 168, true);
  check(
    "the phone gains it too, in its own numbers",
    phoneStacked.three < THRESHOLDS.phone.three && effectiveMode(3, 560, "phone", phoneStacked) === 3,
    JSON.stringify(phoneStacked),
  );
}

// Drawing rules: stacked, the feeds may take everything the stack does not need,
// because there is no longer an article column to reserve beside the posts.
{
  const drawn = clampWidths({ sidebar: 500, list: 380 }, 3, 900, "desktop", true);
  check("a stacked 500px sidebar is allowed in a 900px window", drawn.sidebar === 500, JSON.stringify(drawn));
  check("and the stack keeps the rest", drawn.list === 380, JSON.stringify(drawn));
  check(
    "while side by side it would have been held back by the article's column",
    clampWidths({ sidebar: 500, list: 380 }, 3, 900).sidebar === 900 - GUTTER * 2 - MIN.list - MIN.article,
    JSON.stringify(clampWidths({ sidebar: 500, list: 380 }, 3, 900)),
  );
  check(
    "the stack itself cannot be squeezed to nothing",
    clampWidths({ sidebar: 700, list: 380 }, 3, 900, "desktop", true).list === MIN.list,
    JSON.stringify(clampWidths({ sidebar: 700, list: 380 }, 3, 900, "desktop", true)),
  );
}

// The split: a fraction, floored in pixels so a short window cannot leave
// either pane a sliver.
{
  check("half is the shipped split", STACK_SHARE.fallback === 0.5);
  check("a tall column allows the full range", clampShare(0.1, 900) === STACK_SHARE.min && clampShare(0.9, 900) === STACK_SHARE.max);
  check("a middle drag is left alone", clampShare(0.62, 900) === 0.62);
  const room = 400 - STACK_GUTTER;
  const tight = clampShare(0.1, 400);
  check(
    "a 400px column keeps 160px of posts",
    Math.abs(tight * room - STACK_MIN_PANE) < 0.01,
    `${tight} of ${room}`,
  );
  check(
    "and 160px of article at the other end",
    Math.abs((1 - clampShare(0.9, 400)) * room - STACK_MIN_PANE) < 0.01,
    String(clampShare(0.9, 400)),
  );
  check("a window too short for both floors is split in half", clampShare(0.1, 300) === 0.5 && clampShare(0.9, 300) === 0.5);
  check("an unmeasured column cannot produce nonsense", clampShare(Number.NaN, 900) === 0.5 && clampShare(0.5, 0) === 0.5);
}

// A requirement may not outgrow the window, and stacked what gives way is the
// stack's width — the article is a share of a column, not a column to trim.
{
  const base = { sidebar: 500, list2: 380, list3: 380, article: 320 };
  const kept = settleRequirement(base, 3, 900, "desktop", true);
  check("stacked, a requirement that fits is left alone", JSON.stringify(kept) === JSON.stringify(base), JSON.stringify(kept));
  const squeezed = settleRequirement(base, 3, 900);
  check(
    "while side by side it would have narrowed the posts column",
    squeezed.list3 === MIN.list,
    JSON.stringify(squeezed),
  );
  const tight = settleRequirement({ sidebar: 600, list2: 380, list3: 380, article: 320 }, 3, 900, "desktop", true);
  check("a stacked requirement still trims to the window", tight.list3 === 900 - GUTTER - 600, JSON.stringify(tight));
  check("and never below the posts floor", settleRequirement({ sidebar: 880, list2: 380, list3: 380, article: 320 }, 3, 900, "desktop", true).list3 === MIN.list);
}

// Two panes to three, stacked: the posts column is already filling the column it
// will share, so there is nothing to make room for and nothing to take from the
// screen.
{
  const shaped3 = { sidebar: 420, list2: 380, list3: 380, article: 320 };
  check(
    "stacked, a 2 -> 3 press keeps the width on screen",
    extendToThree(shaped3, 900, "desktop", 700, true).list3 === 474,
    String(extendToThree(shaped3, 900, "desktop", 700, true).list3),
  );
  check(
    "while side by side the screen takes it from the posts",
    extendToThree(shaped3, 900, "desktop", 700).list3 === MIN.list,
    String(extendToThree(shaped3, 900, "desktop", 700).list3),
  );
  check("and the article is untouched either way", extendToThree(shaped3, 900, "desktop", 700, true).article === 320);
}

// ---------------------------------------------------------------------------
// Two panes with the feeds folded. Folding the feeds away there must not leave
// one stretched column — that is what one-pane mode is — so the frame keeps two
// panes: the rail takes the seam's place at the far left, the posts keep the
// width they were shaped to, and the article takes what is left over. Still five
// lengths, still the frame: the fold is a change inside it, never a resize.
{
  const pair = { sidebar: 300, list: 400 };
  const folded = gridTemplate(2, pair, { available: 1100, collapsed: true });
  check(
    "folded two panes are a rail, the posts, a seam and the article",
    folded === `0px ${RAIL}px 400px ${GUTTER}px 688px`,
    folded,
  );
  check("the rail is exactly the seam's 6px", RAIL === 6 && GUTTER === 6, `${RAIL} / ${GUTTER}`);
  check("the folded five are the whole frame", sumsTo(folded, 1100));
  check("the posts keep the width they were shaped to", tracksOf(folded)[2] === 400, folded);
  check(
    "and the article takes the remainder, not the frame",
    tracksOf(folded)[4] === 1100 - RAIL - 400 - GUTTER,
    String(tracksOf(folded)[4]),
  );
  check(
    "unfolded two panes are untouched",
    gridTemplate(2, pair, { available: 1100 }) === `300px ${GUTTER}px 794px 0px 0px`,
    gridTemplate(2, pair, { available: 1100 }),
  );
  check(
    "the fold left the sidebar's track at zero rather than the seam's",
    tracksOf(folded)[0] === 0 && tracksOf(folded)[1] === RAIL,
  );
  check(
    "one column ignores the fold entirely",
    gridTemplate(1, pair, { available: 1100, collapsed: true }) ===
      gridTemplate(1, pair, { available: 1100, collapsed: false }) &&
      gridTemplate(1, pair, { available: 1100, collapsed: true }) === "1100px 0px 0px 0px 0px",
    gridTemplate(1, pair, { available: 1100, collapsed: true }),
  );
  check(
    "and three panes are unchanged by the two-pane rail",
    gridTemplate(3, pair, { available: 1100, collapsed: true }) ===
      `0px 0px 400px ${GUTTER}px ${1100 - 400 - GUTTER}px` &&
      gridTemplate(3, pair, { available: 1100 }) === `300px ${GUTTER}px 400px ${GUTTER}px 388px`,
    `${gridTemplate(3, pair, { available: 1100, collapsed: true })} | ${gridTemplate(3, pair, { available: 1100 })}`,
  );
  check(
    "three panes stacked are unchanged too",
    gridTemplate(3, pair, { available: 1100, stacked: true, collapsed: true }) === "0px 0px 1100px 0px 0px" &&
      tracksOf(gridTemplate(3, pair, { available: 1100, stacked: true }))[2] === 794,
    `${gridTemplate(3, pair, { available: 1100, stacked: true, collapsed: true })} | ${gridTemplate(3, pair, { available: 1100, stacked: true })}`,
  );
  check(
    "a folded pair sums to the frame at every width, awkward ones included",
    [700, 661, 900, 1100, 1234.5, 1920.5].every((width) =>
      sumsTo(gridTemplate(2, pair, { available: width, collapsed: true }), width),
    ),
  );
  check(
    "a frame narrower than the panes still has no negative track",
    (() => {
      const tiny = gridTemplate(2, pair, { available: 20, collapsed: true });
      return tracksOf(tiny).every((value) => value >= 0) && sumsTo(tiny, 20);
    })(),
  );
  check(
    "junk in place of a width cannot produce a broken template",
    (() => {
      const junk = gridTemplate(2, { sidebar: 300, list: Number.NaN }, { available: 1100, collapsed: true });
      return tracksOf(junk).every((value) => Number.isFinite(value)) && sumsTo(junk, 1100);
    })(),
  );
}

// The slot map for the folded pair, against the three states around it.
{
  const at = (level, collapsed) =>
    paneSlots({ mode: 2, level, stacked: false, collapsed, tuck: null, swapped: false });
  const folded = at("feeds", true);
  check(
    "folded two panes draw the posts and the article, and no feeds",
    folded.posts === true &&
      folded.article === true &&
      folded.seamPosts === true &&
      folded.sidebar === false &&
      folded.seam === false,
  );
  check(
    "with the rail where the feeds' seam was, and no stack",
    folded.rail === true && folded.seamStack === false,
  );
  check(
    "an open post does not change the folded pair",
    JSON.stringify(at("article", true)) === JSON.stringify(folded),
  );
  check(
    "unfolded two panes are exactly what they were: feeds and posts",
    (() => {
      const open = at("feeds", false);
      return open.sidebar && open.seam && open.posts && !open.article && !open.seamPosts && !open.rail;
    })(),
  );
  check(
    "and with a post open, feeds and article — never drawn together",
    (() => {
      const open = at("article", false);
      return open.sidebar && open.seam && open.article && !open.posts && !open.rail && !open.seamPosts;
    })(),
  );
  check(
    "one column never draws a rail, folded or not",
    [true, false].every((collapsed) =>
      ["feeds", "article"].every(
        (level) =>
          paneSlots({ mode: 1, level, stacked: false, collapsed, tuck: null, swapped: false }).rail === false,
      ),
    ),
  );
  check(
    "three panes keep their own fold and gain no rail",
    (() => {
      const three = paneSlots({ mode: 3, level: "article", stacked: false, collapsed: true, tuck: null, swapped: false });
      return (
        three.sidebar === false &&
        three.seam === false &&
        three.rail === false &&
        three.posts &&
        three.article &&
        three.seamPosts
      );
    })(),
  );
  check(
    "and a stacked three still has the feeds pane beside the pair",
    (() => {
      const stack = paneSlots({ mode: 3, level: "article", stacked: true, collapsed: false, tuck: null, swapped: false });
      return stack.sidebar === true && stack.seam === true && stack.rail === false && stack.seamStack === true;
    })(),
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);