import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { capabilitiesFor, iosHost } from "../../src/lib/platform.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// A desktop window is the only shape with edges to drag, thresholds to set and a
// window to resize. The pane count is different: a phone draws the feeds and the
// list side by side in portrait and the stacked three in landscape, so it has a
// count to choose as well.
const desktopWindow = capabilitiesFor("desktop", true);
check("desktop can choose a pane count", desktopWindow.paneCount);
check("desktop can drag a pane edge", desktopWindow.paneResize);
check("desktop can set pane thresholds", desktopWindow.paneThresholds);
check("desktop in a Tauri window can resize to a mode", desktopWindow.windowFit);

// A browser tab is a desktop shape with no window API to call.
const desktopTab = capabilitiesFor("desktop", false);
check("a browser tab keeps the layout controls", desktopTab.paneThresholds);
check("a browser tab cannot resize the window", desktopTab.windowFit === false);

// The phone keeps the pane count and loses everything that needs a window.
const phone = capabilitiesFor("phone", true);
check("a phone can choose a pane count, because it draws more than one", phone.paneCount === true);
check("a phone has no split view", phone.splitView === false);
check("a window does", desktopWindow.splitView === true);
check("a phone has nothing to drag", phone.paneResize === false);
check("a phone has no pane thresholds", phone.paneThresholds === false);
check("a phone has no window to fit, even in the app", phone.windowFit === false);

// Reader view is the one thing kept everywhere: a summary-only feed on a small
// screen is exactly what extraction is for, and the flags must say so on both.
check("desktop keeps reader view", capabilitiesFor("desktop", true).articleExtract);
check("phone keeps reader view", phone.articleExtract);

// Sharing belongs to the phone: the desktop window is the finished layout, and a
// fourth act in every row would change the shape the owner signed off. The flag
// is the shape's, not the API's — a phone with no Web Share still gets the copy
// fallback — so both phone hosts answer the same.
check("a phone offers the share sheet", phone.share);
check("a phone in a browser tab offers it too", capabilitiesFor("phone", false).share);
check("desktop does not", capabilitiesFor("desktop", true).share === false);
check("nor does a desktop browser tab", capabilitiesFor("desktop", false).share === false);

// iOS is the one host with a native sheet to call, and the app is the one place
// it can be called from: the packaged app's page is served from a custom scheme,
// which takes Web Share away. The rule reads the user agent, so it is provable
// here — iPhone, iPad, and iPadOS's desktop user agent, which only the touch
// points give away.
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const APPLE_LAPTOP = IPAD_DESKTOP_UA;
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";

check("an iPhone is iOS", iosHost(IPHONE));
check("an iPad is iOS", iosHost(IPAD));
check("an iPad reporting a Mac user agent is iOS when it has touch points", iosHost(IPAD_DESKTOP_UA, 5));
check("and a Mac is not", iosHost(APPLE_LAPTOP, 0) === false);
check("an Android phone is not", iosHost(ANDROID, 5) === false);
check("nor is a desktop browser", iosHost("Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0") === false);

// Every flag is about the shape or the host, never about a preference, so the
// same inputs must always give the same answer.
const a = JSON.stringify(capabilitiesFor("phone", false));
const b = JSON.stringify(capabilitiesFor("phone", false));
check("capabilities are stable", a === b);
check(
  "the phone set is exactly the flags a phone has",
  JSON.stringify(
    Object.entries(capabilitiesFor("phone", false))
      .filter(([, on]) => on)
      .map(([name]) => name),
  ) === JSON.stringify(["paneCount", "articleExtract", "share"]),
);

// The app is a layout, not a document: a pinch zoomed the header and the panes
// independently of the reading size the app already offers, and on Android every
// zoom step arrives as a `visualViewport` resize.
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "src/app.css"), "utf8");
check("the viewport refuses zoom", /user-scalable=no/.test(html) && /maximum-scale=1(\.0)?\b/.test(html));
check("and still asks for the whole screen", /viewport-fit=cover/.test(html));
check(
  "a finger pans and drags, it does not pinch",
  /touch-action: pan-x pan-y;/.test(css) && /-webkit-text-size-adjust: 100%;/.test(css),
);

// The shape is the app's one platform switch, and every phone-only rule in the
// stylesheet hangs off it, so CSS has to be able to see the answer. `App.svelte`
// copies `layout.device` onto `<html>` as `data-device`; a refactor that drops
// that effect would leave every `html[data-device="phone"]` rule dead, and
// nothing would look broken until the app was opened on a phone.
const app = readFileSync(join(root, "src/App.svelte"), "utf8");
check(
  "the device shape is published on <html>",
  /document\.documentElement\.dataset\.device\s*=\s*device/.test(app),
);
check(
  "read from the layout store inside one effect, so a recompute re-publishes it",
  /\$effect\(\(\) => \{\s*const device = layout\.device;[\s\S]{0,200}?document\.documentElement\.dataset\.device = device;/
    .test(app),
);
check(
  "and the phone rules are keyed on that attribute",
  /html\[data-device="phone"\] \.phone-header \{/.test(css),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
