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
import assert from "node:assert/strict";
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
  THEME_MODES,
  THEME_MODE_LABELS,
  isDarkChoice,
  isHexColor,
  parseTheme,
  pinWords,
  themeVariables,
} from "../../src/lib/theme.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let checks = 0;
let failures = 0;

/**
 * A check may be a value or a thunk. The thunk form was passed here and compared
 * as a value, so every `check(name, () => { assert... })` in this file passed
 * without ever running — the assertions were prose. Call it, and treat a throw
 * as the failure it is.
 */
function check(name, ok, detail = "") {
  if (typeof ok === "function") {
    try {
      ok();
      ok = true;
    } catch (error) {
      ok = false;
      detail = detail || (error instanceof Error ? error.message.split("\n")[0] : String(error));
    }
  }
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
check("exactly the nine colour variables, the two edges, the three action names and the five background ones are written", Object.keys(vars).length === 19, String(Object.keys(vars).length));
check("no undefined values", () =>
  Object.entries(vars).every(([name, value]) =>
    typeof value === "string" &&
    value.length > 0 &&
    (name.startsWith("--edge") ||
      name.startsWith("--act") ||
      name === "--bg-image" ||
      name === "--bg-blur" ||
      name === "--bg-filter" ||
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
check("the panel lays its colours out as many to a line as it has", () => {
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
  // Three names side by side with a picker each is one row; the same three as
  // name-and-picker pairs was two, with Unlocked alone on the second.
  assert.match(panel, /grid-template-columns: repeat\(var\(--cols, 2\), minmax\(0, 1fr\)\)/);
  assert.match(panel, /stacked: true/);
  assert.match(panel, /\.swgroup\.stacked \.sw \{[^}]*flex-direction: column/);
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
  // The point of the fourth mode: the page is nothing at all.
  assert.equal(PAGE_COLOURS.oled, "#000000");
});

check("appearance offers exactly four modes, and OLED Black is the fourth", () => {
  // Order is the picker's: Auto first, the explicit choices after it.
  assert.deepEqual(THEME_MODES, ["system", "dark", "light", "oled"]);
  assert.equal(THEME_MODE_LABELS.oled, "OLED Black");
  assert.equal(THEME_MODE_LABELS.system, "Auto");
});

check("a stored OLED theme survives a reload", () => {
  assert.equal(parseTheme({ mode: "oled" }).mode, "oled");
  // ...and it is a choice, not an alias that quietly becomes dark.
  assert.notEqual(parseTheme({ mode: "oled" }).mode, "dark");
});

check("OLED counts as dark wherever the app asks", () => {
  // The day/night button would otherwise offer "dark" from inside a dark page.
  assert.equal(isDarkChoice("oled"), true);
  assert.equal(isDarkChoice("dark"), true);
  assert.equal(isDarkChoice("light"), false);
  // Auto is the OS's answer, and only the OS's.
  assert.equal(isDarkChoice("system", true), true);
  assert.equal(isDarkChoice("system", false), false);
});

check("a background picture gets out from under the page's own fill", () => {
  // The picture is a negative-z pseudo-element, and `html, body, #app` were all
  // opaque `--bg` — so the picture could not be seen at all. `apply()` publishes
  // an attribute and the stylesheet thins the two fills under it.
  const apply = readFileSync(join(root, "src", "state", "theme.svelte.ts"), "utf8");
  assert.match(apply, /if \(pictureShown\) root\.dataset\.bgPicture = "on";/);
  assert.match(apply, /else delete root\.dataset\.bgPicture;/);
  const css = readFileSync(join(root, "src", "app.css"), "utf8");
  const block = css.slice(css.indexOf(":root[data-bg-picture]"));
  assert.match(block.slice(0, 200), /:root\[data-bg-picture\] body,/);
  assert.match(block.slice(0, 200), /:root\[data-bg-picture\] #app \{/);
  // `html` keeps its fill: that is what a webview shows in its own bounce.
  assert.doesNotMatch(block.slice(0, 200), /:root\[data-bg-picture\] html/);
});

// ---------------------------------------------------------------------------
// The lock can take the photograph away
// ---------------------------------------------------------------------------

check("the picture can be swapped for the page colour while locked", () => {
  assert.equal(DEFAULT_THEME.bgHideWhenLocked, false, "the swap is opt-in");
  const on = parseTheme({ bgHideWhenLocked: true });
  assert.equal(on.bgHideWhenLocked, true);
  const junk = parseTheme({ bgHideWhenLocked: "yes please" });
  assert.equal(junk.bgHideWhenLocked, false, "only a boolean is a choice");
});

check("...and asking for it does not travel with the colours", () => {
  // The picture itself is this machine's, so the switch about the picture is
  // too: an account's colours must not decide what a phone shows behind them.
  const state = readFileSync(join(root, "src", "state", "theme.svelte.ts"), "utf8");
  const snapshot = state.slice(state.indexOf("snapshot()"), state.indexOf("adopt("));
  assert.doesNotMatch(snapshot, /bgHideWhenLocked/);
});

check("locked, the picture is not drawn and the page keeps its colour", () => {
  const state = readFileSync(join(root, "src", "state", "theme.svelte.ts"), "utf8");
  assert.match(state, /const pictureShown = theme\.bgImage !== null && !\(theme\.bgHideWhenLocked && locked\);/);
  // `--bg-image` is put back by `themeVariables` before this, so the swap has to
  // be written after it rather than folded into the variables.
  assert.match(state, /root\.style\.setProperty\("--bg-image", "none"\)/);
  assert.ok(
    state.indexOf('"--bg-image", "none"') > state.indexOf("for (const [name, value] of Object.entries(themeVariables(theme)))"),
    "the swap must land after the variables",
  );
  // Nothing about the page colour moves: the lock swaps a photograph for a plain
  // surface, it does not change the look.
  assert.doesNotMatch(state, /locked[^\n]*--bg(?!-image)/);
});

check("the reader's lock reaches the theme through one effect", () => {
  const app = readFileSync(join(root, "src", "App.svelte"), "utf8");
  assert.match(app, /\$effect\(\(\) => \{\s*theme\.setLocked\(reader\.hiddenLocked\);\s*\}\);/);
  const state = readFileSync(join(root, "src", "state", "theme.svelte.ts"), "utf8");
  assert.match(state, /setLocked\(locked: boolean\): void \{/);
  // A theme with no picture, or the switch off, is not re-applied on every lock.
  assert.match(state, /if \(this\.current\.bgImage === null \|\| !this\.current\.bgHideWhenLocked\) return;/);
});

check("the panel offers the swap under the background it belongs to", () => {
  const panel = readFileSync(join(root, "src", "components", "ThemePanel.svelte"), "utf8");
  assert.match(panel, /<span class="key">When locked<\/span>/);
  assert.match(panel, /theme\.set\("bgHideWhenLocked", true\)/);
  assert.match(panel, /theme\.set\("bgHideWhenLocked", false\)/);
  // It sits with the picture's other controls, not in a section of its own.
  const at = panel.indexOf('class="key">When locked');
  const block = panel.slice(panel.indexOf("swgroup bgsection"), panel.indexOf("{/snippet}"));
  assert.ok(at > 0 && panel.indexOf('class="key">When locked') < panel.indexOf('class="sglabel">Background')  + block.length);
});

check("a blur of zero writes no filter at all", () => {
  // `blur(0px)` still makes the picture its own composited layer, and on iOS a
  // full-screen fixed layer is rasterised coarse and scaled: the wallpaper came
  // out soft with the slider at 0. `none` is the absence, not a small blur.
  const sharp = themeVariables({ ...DEFAULT_THEME, bgImage: "data:image/jpeg;base64,AA", bgBlur: 0 });
  assert.equal(sharp["--bg-filter"], "none");
  const soft = themeVariables({ ...DEFAULT_THEME, bgImage: "data:image/jpeg;base64,AA", bgBlur: 14 });
  assert.equal(soft["--bg-filter"], "blur(14px)");
  const css = readFileSync(join(root, "src", "app.css"), "utf8");
  const block = css.slice(css.indexOf("body::before {"));
  assert.match(block.slice(0, 400), /filter: var\(--bg-filter, none\);/);
  assert.doesNotMatch(block, /filter: blur\(var\(--bg-blur/);
});

check("the stylesheet paints OLED's page and panels true black", () => {
  const css = readFileSync(join(root, "src", "app.css"), "utf8");
  const at = css.indexOf(':root[data-theme="oled"]');
  assert.ok(at > 0, "no OLED block in app.css");
  const block = css.slice(at, css.indexOf("}", at));
  assert.match(block, /--bg: #000000;/);
  // A charcoal panel on a black page is dark mode with a black margin: the
  // surfaces have to go too, and the borders carry the structure instead.
  assert.match(block, /--surface-solid: #000000;/);
  assert.match(block, /--bg-alt: #000000;/);
  assert.match(block, /color-scheme: dark;/);
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
