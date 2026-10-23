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
import {
  DEFAULT_THEME,
  MARKER_PATH,
  THEME_KEY,
  isHexColor,
  parseTheme,
  pinWords,
  themeVariables,
} from "../../src/lib/theme.ts";

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

check("key is namespaced and versioned", THEME_KEY === "hardlyreader.theme.v1", THEME_KEY);

check("default keeps today's look", DEFAULT_THEME.accent === "#0078e0" && DEFAULT_THEME.hidden === "#e5484d" && DEFAULT_THEME.marker === "pin");
check("default follows the OS", DEFAULT_THEME.mode === "system");
check("default calls a pin a pin", DEFAULT_THEME.vocabulary === "pinned");

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
check("unknown marker falls back to pin", parseTheme({ marker: "flag" }).marker === "pin");
check("star survives", parseTheme({ marker: "star" }).marker === "star");
check("favourites wording survives", parseTheme({ vocabulary: "favourites" }).vocabulary === "favourites");
check("one bad field does not reset the others", parseTheme({ mode: "dark", accent: 42, hidden: "#123456" }).mode === "dark");
check("...and keeps the good colour next to it", parseTheme({ mode: "dark", accent: 42, hidden: "#123456" }).hidden === "#123456");

const vars = themeVariables({
  ...DEFAULT_THEME,
  accent: "#ff0000",
  hidden: "#00ff00",
  favourite: "#0000ff",
  lockOpen: "#ffff00",
  lockClosed: "#ff00ff",
});
check("accent maps to --accent", vars["--accent"] === "#ff0000");
check("hidden maps to --tone-hidden", vars["--tone-hidden"] === "#00ff00");
check("favourite maps to --tone-favourite", vars["--tone-favourite"] === "#0000ff");
check("open lock maps to --tone-lock-open", vars["--tone-lock-open"] === "#ffff00");
check("locked lock maps to --tone-lock-closed", vars["--tone-lock-closed"] === "#ff00ff");
check("sync maps to --tone-sync", vars["--tone-sync"] === DEFAULT_THEME.sync);
check("exactly the six chosen colours are written", Object.keys(vars).length === 6, String(Object.keys(vars).length));
check("no undefined values", Object.values(vars).every((v) => typeof v === "string" && v.startsWith("#")));

check("pin wording is the app's own", pinWords("pinned").add === "Pin" && pinWords("pinned").count === "Pinned");
check("favourites wording uses the extension's words", pinWords("favourites").add === "Favourite" && pinWords("favourites").count === "Favourites");
check("removal wording follows the choice", pinWords("favourites").remove === "Unfavourite" && pinWords("pinned").remove === "Unpin");

check("pin and star draw different shapes", MARKER_PATH.pin !== MARKER_PATH.star);
check("both markers are path data", [MARKER_PATH.pin, MARKER_PATH.star].every((d) => d.startsWith("M")));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
