import { capabilitiesFor } from "../../src/lib/platform.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// A desktop window is the only shape with a pane count to choose, edges to
// drag, thresholds to set and a window to resize. Everything else follows.
const desktopWindow = capabilitiesFor("desktop", true);
check("desktop can choose a pane count", desktopWindow.paneCount);
check("desktop can drag a pane edge", desktopWindow.paneResize);
check("desktop can set pane thresholds", desktopWindow.paneThresholds);
check("desktop in a Tauri window can resize to a mode", desktopWindow.windowFit);

// A browser tab is a desktop shape with no window API to call.
const desktopTab = capabilitiesFor("desktop", false);
check("a browser tab keeps the layout controls", desktopTab.paneThresholds);
check("a browser tab cannot resize the window", desktopTab.windowFit === false);

// The phone gets none of the layout controls: one column, as wide as the screen.
const phone = capabilitiesFor("phone", true);
check("a phone has no pane-count switch", phone.paneCount === false);
check("a phone has nothing to drag", phone.paneResize === false);
check("a phone has no pane thresholds", phone.paneThresholds === false);
check("a phone has no window to fit, even in the app", phone.windowFit === false);

// Reader view is the one thing kept everywhere: a summary-only feed on a small
// screen is exactly what extraction is for, and the flags must say so on both.
check("desktop keeps reader view", capabilitiesFor("desktop", true).articleExtract);
check("phone keeps reader view", phone.articleExtract);

// Every flag is about the shape or the host, never about a preference, so the
// same inputs must always give the same answer.
const a = JSON.stringify(capabilitiesFor("phone", false));
const b = JSON.stringify(capabilitiesFor("phone", false));
check("capabilities are stable", a === b);
check(
  "the phone set is exactly one true flag",
  Object.values(capabilitiesFor("phone", false)).filter(Boolean).length === 1,
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
