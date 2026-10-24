import {
  MIN, GUTTER, NEEDED, MINIMUMS, THRESHOLDS, THRESHOLD_LIMITS, effectiveMode, clampWidths, dragPane,
  resetPane, nudge, gridTemplate, guttersFor, geometricMinimum, defaultModeFor, needed, minimums,
  clampThresholds, widthFor, intentWidths, MODE_HYSTERESIS, fitTarget,
  DEFAULT_LAYOUT, layoutWidths, neededWidth, thresholdsFor, scaleLayout, settleRequirement,
  intentLayout, layoutFromWidths, extendToThree,
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
check(
  "grid template carries gutter tracks",
  gridTemplate(3, { sidebar: 300, list: 400 }) === `300px ${GUTTER}px 400px ${GUTTER}px minmax(0, 1fr)`,
  gridTemplate(3, { sidebar: 300, list: 400 }),
);
check("one pane is a single flexible track", gridTemplate(1, { sidebar: 300, list: 400 }) === "minmax(0, 1fr)");

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
  check("sharing still collapses for 1", fitTarget(1, 1440, "desktop", t, null, false) === 320);
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

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);