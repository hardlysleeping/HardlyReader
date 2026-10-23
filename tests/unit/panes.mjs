import {
  MIN, GUTTER, NEEDED, MINIMUMS, THRESHOLDS, THRESHOLD_LIMITS, effectiveMode, clampWidths, dragPane,
  resetPane, nudge, gridTemplate, guttersFor, geometricMinimum, defaultModeFor, needed, minimums,
  clampThresholds, widthFor,
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
check("one pane's width is fixed, not tunable", widthFor(1, "desktop", { two: 400, three: 500 }) === NEEDED.desktop[1]);

check("a window exactly on a custom threshold shows that many", effectiveMode(2, 900, "desktop", late) === 2);

// A narrow window does not get three panes, whichever mode was asked for.
check("3 requested, roomy window", effectiveMode(3, 1440) === 3);
check("3 requested, 1024px", effectiveMode(3, 1024) === 3, String(effectiveMode(3, 1024)));
check("3 requested, 800px falls to 2", effectiveMode(3, 800) === 2, String(effectiveMode(3, 800)));
check("3 requested, 500px falls to 1", effectiveMode(3, 500) === 1);
check("2 requested, 1440 keeps 2", effectiveMode(2, 1440) === 2);
check("1 requested stays 1", effectiveMode(1, 1440) === 1);

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
check("desktop 1440 opens in 3", defaultModeFor({ phone: false, width: 1440, height: 900 }) === 3);
check("desktop 900 opens in 2", defaultModeFor({ phone: false, width: 900, height: 800 }) === 2);
check("desktop 500 opens in 1", defaultModeFor({ phone: false, width: 500, height: 800 }) === 1);

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

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
