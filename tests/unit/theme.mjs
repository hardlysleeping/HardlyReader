/**
 * Headless checks for the theme: stored-value validation, the CSS variables it
 * produces, and the two wording sets.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/theme.mjs
 *
 * The point of these is that a half-written or hand-edited theme cannot reach
 * CSS: `undefined` there is silently dropped, which would leave a control with
 * no colour at all rather than a wrong one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_THEME,
  MARKER_PATH,
  MAX_BG_BLUR,
  MAX_BG_DIM,
  PAGE_COLOURS,
  THEME_KEY,
  isHexColor,
  parseTheme,
  pinWords,
  themeVariables,
} from "../../src/lib/theme.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

check("key is namespaced and versioned", THEME_KEY === "hardlyreader.theme.v1", THEME_KEY);

check(
  "default keeps today's look",
  // A new install opens with the owner's accent, not the blank-canvas blue.
  DEFAULT_THEME.accent === "#613583" && DEFAULT_THEME.hidden === "#e5484d",
  DEFAULT_THEME.accent,
);
check("default follows the OS", DEFAULT_THEME.mode === "system");
check("the pin has one colour", DEFAULT_THEME.pinned === "#0078e0");
check("there is no second way to draw it", !("marker" in DEFAULT_THEME) && !("vocabulary" in DEFAULT_THEME));

check("hex #rgb accepted", isHexColor("#fff"));
check("hex #rrggbb accepted", isHexColor("#0078E0"));
check("short hex rejected", !isHexColor("#07"));
check("named colour rejected", !isHexColor("blue"));
check("rgb() rejected", !isHexColor("rgb(0,0,0)"));
check("non-string rejected", !isHexColor(null));

check("missing theme yields defaults", parseTheme(null).accent === DEFAULT_THEME.accent);
check("string payload yields defaults", parseTheme("nope").hidden === DEFAULT_THEME.hidden);
check("unknown mode falls back to auto", parseTheme({ mode: "sepia" }).mode === "system");
check("valid mode survives", parseTheme({ mode: "light" }).mode === "light");
check("bad colour keeps default", parseTheme({ accent: "teal" }).accent === DEFAULT_THEME.accent);
check("valid colour is normalised", parseTheme({ accent: "#ABCDEF" }).accent === "#abcdef");
check("a stored star is not carried over", !("marker" in parseTheme({ marker: "star" })));
check("a stored vocabulary is not carried over", !("vocabulary" in parseTheme({ vocabulary: "favourites" })));
check("an old favourite colour becomes the pin colour", parseTheme({ favourite: "#123456" }).pinned === "#123456");
check("...and a new one wins over it", parseTheme({ favourite: "#123456", pinned: "#654321" }).pinned === "#654321");
check("a bad pin colour keeps the default", parseTheme({ pinned: "blue" }).pinned === DEFAULT_THEME.pinned);
check("one bad field does not reset the others", parseTheme({ mode: "dark", accent: 42, hidden: "#123456" }).mode === "dark");
check("...and keeps the good colour next to it", parseTheme({ mode: "dark", accent: 42, hidden: "#123456" }).hidden === "#123456");

const vars = themeVariables({
  ...DEFAULT_THEME,
  accent: "#ff0000",
  hidden: "#00ff00",
  pinned: "#0000ff",
  lockOpen: "#ffff00",
  lockClosed: "#ff00ff",
});
check("accent maps to --accent", vars["--accent"] === "#ff0000");
check("hidden maps to --tone-hidden", vars["--tone-hidden"] === "#00ff00");
check("pinned maps to --tone-pinned", vars["--tone-pinned"] === "#0000ff");
check("the old favourite variable is gone", vars["--tone-favourite"] === undefined);
check("app.css declares the variable the theme now sets", /--tone-pinned:/.test(readFileSync(join(root, "src/app.css"), "utf8")));
check("open lock maps to --tone-lock-open", vars["--tone-lock-open"] === "#ffff00");
check("locked lock maps to --tone-lock-closed", vars["--tone-lock-closed"] === "#ff00ff");
check("unlock maps to --tone-unlock", vars["--tone-unlock"] === DEFAULT_THEME.unlock);
check("sync maps to --tone-sync", vars["--tone-sync"] === DEFAULT_THEME.sync);
// Green is the unlock colour, and it is green by default: it answers the red
// that hides things, so a theme that never touched it must still not be yellow.
check("the default unlock tone is green", DEFAULT_THEME.unlock === "#3fbf6f", DEFAULT_THEME.unlock);
check("the pane lines are the accent mixed into the border", () => {
  assert.match(vars["--edge"], /color-mix/);
  assert.match(vars["--edge"], /var\(--accent\)/);
  assert.match(vars["--edge-soft"], /var\(--accent\)/);
});
check("turning them off leaves the plain borders", () => {
  const plain = themeVariables({ ...DEFAULT_THEME, accentEdges: false });
  assert.equal(plain["--edge"], "var(--border)");
  assert.equal(plain["--edge-soft"], "var(--border-soft)");
});
check("accent separators are on unless turned off", () => {
  assert.equal(DEFAULT_THEME.accentEdges, true);
  assert.equal(parseTheme({}).accentEdges, true);
  assert.equal(parseTheme({ accentEdges: false }).accentEdges, false);
  assert.equal(parseTheme({ accentEdges: "no" }).accentEdges, true, "junk keeps the default");
});
check("exactly the nine colour variables, the two edges, the three action names and the four background ones are written", Object.keys(vars).length === 18, String(Object.keys(vars).length));
check("no undefined values", () =>
  Object.entries(vars).every(([name, value]) =>
    typeof value === "string" &&
    value.length > 0 &&
    (name.startsWith("--edge") ||
      name.startsWith("--act") ||
      name === "--bg-image" ||
      name === "--bg-blur" ||
      name === "--bg-dim" ||
      name === "--glass" ||
      value.startsWith("#")),
  ));

// The three row actions are the one place a theme chooses a colour that is not
// only decoration: gold for a star, the trim for read, its own blue for a link.
check("the star has a colour of its own, gold by default", () => {
  assert.equal(DEFAULT_THEME.star, "#e8b93c");
  assert.equal(parseTheme({ star: "#ffffff" }).star, "#ffffff");
  assert.equal(parseTheme({ star: "gold" }).star, DEFAULT_THEME.star);
});
check("trim and link are their own colours", vars["--tone-trim"] === DEFAULT_THEME.trim && vars["--tone-link"] === DEFAULT_THEME.link);
check("the actions are drawn in colour by default", () => {
  assert.equal(DEFAULT_THEME.monotoneActions, false);
  assert.equal(vars["--act-star"], DEFAULT_THEME.star);
  assert.equal(vars["--act-read"], DEFAULT_THEME.trim);
  assert.equal(vars["--act-link"], DEFAULT_THEME.link);
});
check("monotone is one quiet ink for all three", () => {
  const mono = themeVariables({ ...DEFAULT_THEME, monotoneActions: true });
  assert.equal(mono["--act-star"], "var(--muted)");
  assert.equal(mono["--act-read"], "var(--muted)");
  assert.equal(mono["--act-link"], "var(--muted)");
});
check("a stored monotone choice survives, junk does not", () => {
  assert.equal(parseTheme({ monotoneActions: true }).monotoneActions, true);
  assert.equal(parseTheme({ monotoneActions: "yes" }).monotoneActions, false);
  assert.equal(parseTheme({}).trim, DEFAULT_THEME.trim);
  assert.equal(parseTheme({ trim: "nope" }).trim, DEFAULT_THEME.trim);
  assert.equal(parseTheme({ link: "#123456" }).link, "#123456");
});

// The colours are only usable if the panel offers them: trim and link in the
// swatch list, and one row that turns all three row actions monotone.
check("the panel lays its colours out two to a line", () => {
  const panel = readFileSync(join(root, "src/components/ThemePanel.svelte"), "utf8");
  assert.match(panel, /class="swatches"/);
  assert.match(panel, /gap: 1px 12px/);
  assert.match(panel, /\.sw code \{\s*display: none;/);
  // Sections, each with its own rule: the heading carries the word, so the
  // colours under Lock are called Open and Locked rather than repeating it.
  assert.match(panel, /label: "Lock"/);
  assert.match(panel, /\{ key: "lockOpen", label: "Open" \}/);
  assert.match(panel, /\{ key: "lockClosed", label: "Locked" \}/);
  assert.match(panel, /\.swgroup \+ \.swgroup \{/);
});

// The panel is capped by the room the window has, not by a fixed slice of it:
// a tall window with a short tab should show the tab, not a scrollbar.
check("the panel scrolls only when the window cannot hold it", () => {
  const panel = readFileSync(join(root, "src/components/ThemePanel.svelte"), "utf8");
  assert.match(panel, /max-height: calc\(100vh - 68px\);/);
  assert.ok(!/max-height: min\(72vh/.test(panel), "no fixed slice of the viewport");
});

check("the panel offers trim, link and the monotone switch", () => {
  const panel = readFileSync(join(root, "src/components/ThemePanel.svelte"), "utf8");
  assert.match(panel, /key: "trim", label: "Trim"/);
  assert.match(panel, /key: "star", label: "Star"/);
  assert.match(panel, /key: "link", label: "Link"/);
  assert.match(panel, /theme\.set\("monotoneActions", true\)/);
  assert.match(panel, /theme\.set\("monotoneActions", false\)/);
});

// The page: a colour the theme chose, or none at all — and "none" has to be
// representable, because clearing the choice is how dark and light each keep
// their own page.
check("the page colour is optional, and cleared means follow the mode", () => {
  assert.equal(DEFAULT_THEME.bg, null);
  assert.equal(themeVariables(DEFAULT_THEME)["--bg"], undefined, "no override when unset");
  const set = themeVariables({ ...DEFAULT_THEME, bg: "#101820" });
  assert.equal(set["--bg"], "#101820");
  assert.equal(parseTheme({ bg: "#101820" }).bg, "#101820");
  assert.equal(parseTheme({ bg: "red" }).bg, null);
  assert.equal(parseTheme({ bg: 42 }).bg, null);
  assert.equal(PAGE_COLOURS.dark, "#0c0c0e");
  assert.equal(PAGE_COLOURS.light, "#fdfdfd");
});

check("a background picture is a data URL or nothing", () => {
  const png = "data:image/jpeg;base64,AAAA";
  assert.equal(themeVariables({ ...DEFAULT_THEME, bgImage: png })["--bg-image"], `url("${png}")`);
  assert.equal(themeVariables(DEFAULT_THEME)["--bg-image"], "none");
  assert.equal(parseTheme({ bgImage: png }).bgImage, png);
  // A path would point at a file that can move, and an http URL would be a
  // request per launch: neither is a background this app stores.
  assert.equal(parseTheme({ bgImage: "/home/me/wall.png" }).bgImage, null);
  assert.equal(parseTheme({ bgImage: "https://example.com/wall.png" }).bgImage, null);
});

check("blur and dim are clamped to what the controls offer", () => {
  assert.equal(parseTheme({ bgBlur: 10 }).bgBlur, 10);
  assert.equal(parseTheme({ bgBlur: 999 }).bgBlur, MAX_BG_BLUR);
  assert.equal(parseTheme({ bgBlur: -5 }).bgBlur, 0);
  assert.equal(parseTheme({ bgBlur: "nope" }).bgBlur, 0);
  assert.equal(parseTheme({ bgDim: 999 }).bgDim, MAX_BG_DIM);
  assert.equal(themeVariables({ ...DEFAULT_THEME, bgBlur: 8, bgDim: 25 })["--bg-blur"], "8px");
  assert.equal(themeVariables({ ...DEFAULT_THEME, bgDim: 25 })["--bg-dim"], "0.25");
});

check("glass thins the panels, solid leaves them whole", () => {
  assert.equal(themeVariables(DEFAULT_THEME)["--glass"], "100%");
  assert.equal(themeVariables({ ...DEFAULT_THEME, bgGlass: true })["--glass"], "82%");
  assert.equal(parseTheme({ bgGlass: true }).bgGlass, true);
  assert.equal(parseTheme({ bgGlass: "yes" }).bgGlass, false);
});

check("the words are pinned's", pinWords().add === "Pin" && pinWords().count === "Pinned" && pinWords().remove === "Unpin");
check("there is no favourites wording left", !/avour/.test(JSON.stringify(pinWords())));

check("the pin is drawable path data", typeof MARKER_PATH === "string" && MARKER_PATH.startsWith("M"));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
