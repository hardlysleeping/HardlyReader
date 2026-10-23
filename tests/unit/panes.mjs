import {
  MIN, GUTTER, NEEDED, effectiveMode, clampWidths, dragPane, resetPane, nudge, gridTemplate, guttersFor,
  geometricMinimum,
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
check("three-pane floor clears the geometry", NEEDED[3] >= geometricMinimum(3) && NEEDED[3] === 1000);
check("two-pane floor clears the geometry", NEEDED[2] >= geometricMinimum(2) && NEEDED[2] === 700, String(NEEDED[2]));
check("gutter count per mode", guttersFor(3) === 12 && guttersFor(2) === 6 && guttersFor(1) === 0);

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

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
