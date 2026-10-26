/**
 * The navigation material on a phone: three surfaces, one recipe, and both
 * fallbacks.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs phone-glass.mjs
 *
 * Glass is the one part of this layer whose failure is silent. A translucent
 * bar over a blurred backdrop looks right on the phone it was written on; the
 * same bar on a WebKit that cannot blur is 72% of a surface with the list
 * showing through it, and a system set to reduce transparency gets a bar it
 * asked not to get. Neither shows up in a screenshot taken on the test device,
 * so both are asserted here instead:
 *
 *   1. the recipe is exactly the one the plan names, declared once;
 *   2. every surface carrying it is navigation — the bar, the ••• pill, the
 *      settings sheet — and no content surface (a row, a card, a feed, an
 *      article) is anywhere near it;
 *   3. every selector that carries glass, including the fallbacks, starts with
 *      `html[data-device="phone"]`, so nothing can reach a 1440x900 or a
 *      1024x768 desktop frame;
 *   4. the `@supports not (...)` and `prefers-reduced-transparency` blocks exist,
 *      name the same three surfaces, go solid, and come after the material in
 *      the file so they win on equal specificity.
 *
 * The CSS is read, not rendered: this suite has no browser, and the thing that
 * would break is the text of a rule, which is exactly what can be read.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const app = read("src/app.css");
const header = read("src/components/PhoneHeader.svelte");
const settings = read("src/components/SettingsPanel.svelte");
const changelog = read("CHANGELOG.md");

// ---------------------------------------------------------------------------
// A stylesheet, as rules with the at-rules they sit inside
// ---------------------------------------------------------------------------

/** Comments are prose; drop them before anything is matched. */
const bare = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every rule in a stylesheet, flattened: `selector`, `body`, and the at-rule
 * preludes it is nested in (`at`). Nested at-rules are walked, keyframes are
 * not — a `from { ... }` inside `@keyframes` is not a selector anybody can
 * match and would only add noise to the counts below.
 */
function rules(css) {
  const out = [];
  const walk = (text, at) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      if (prelude === "") return;
      let depth = 0;
      let close = open;
      for (; close < text.length; close += 1) {
        if (text[close] === "{") depth += 1;
        else if (text[close] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const body = text.slice(open + 1, close);
      if (prelude.startsWith("@keyframes") || prelude.startsWith("@font-face")) {
        // Not selectors; skip the whole block.
      } else if (prelude.startsWith("@media") || prelude.startsWith("@supports")) {
        walk(body, [...at, prelude]);
      } else if (prelude.startsWith("@")) {
        out.push({ selector: prelude, body, at });
      } else {
        out.push({ selector: prelude, body, at });
      }
      i = close + 1;
    }
  };
  walk(bare(css), []);
  return out;
}

const APP = rules(app);

/** Whether a body declares the property (with any value, or one the test names). */
function declares(body, property, value = null) {
  const pattern =
    value === null
      ? new RegExp(`(?:^|[;\\s])${property.replace(/[()[\]]/g, "\\$&")}\\s*:`)
      : new RegExp(`(?:^|[;\\s])${property.replace(/[()[\]]/g, "\\$&")}\\s*:\\s*${value}\\s*(?:;|$)`);
  return pattern.test(body);
}

/** The rules whose body carries the material itself (not `none`). */
const carrying = APP.filter(
  (rule) =>
    declares(rule.body, "-webkit-backdrop-filter", "var\\(--glass-blur\\)") ||
    declares(rule.body, "backdrop-filter", "var\\(--glass-blur\\)"),
);

const onPhone = (selector) => /^(?::global\()?html\[data-device="phone"\]/.test(selector);

// ---------------------------------------------------------------------------
// One recipe
// ---------------------------------------------------------------------------

{
  const root = APP.filter((rule) => rule.selector === 'html[data-device="phone"]');
  const tokens = root.map((rule) => rule.body).join("\n");
  check(
    "the fill is the surface at 72%, mixed in srgb",
    /--glass-fill:\s*color-mix\(in srgb, var\(--surface\) 72%, transparent\)/.test(tokens),
    tokens.replace(/\s+/g, " ").slice(0, 120),
  );
  check(
    "the blur is 20px and saturate 180%",
    /--glass-blur:\s*blur\(20px\) saturate\(180%\)/.test(tokens),
  );
  check(
    "the recipe is declared once, on the phone root",
    (bare(app).match(/--glass-blur:\s*blur\(20px\) saturate\(180%\)/g) ?? []).length === 1 &&
      (bare(app).match(/--glass-fill:/g) ?? []).length === 1,
  );
  check(
    "every surface reads the same three values rather than repeating them",
    carrying.length >= 3 &&
      carrying.every((rule) => declares(rule.body, "background", "var\\(--glass-fill\\)")),
    carrying.map((rule) => rule.selector).join(" · "),
  );
  check(
    "WebKit gets the prefixed property too — a WKWebView may want it",
    carrying.every((rule) => declares(rule.body, "-webkit-backdrop-filter", "var\\(--glass-blur\\)")),
  );
}

// ---------------------------------------------------------------------------
// Three surfaces, and only navigation among them
// ---------------------------------------------------------------------------

{
  const selectors = carrying.map((rule) => rule.selector);
  const expected = [
    'html[data-device="phone"] .phone-header',
    'html[data-device="phone"] .phone-header .more',
    'html[data-device="phone"] .sheet[role="dialog"]',
  ];
  check(
    "exactly three surfaces carry it: the bar, the ••• pill, the sheet",
    selectors.length === expected.length && expected.every((selector) => selectors.includes(selector)),
    selectors.join(" · "),
  );
  check(
    "the header is one of them, in full",
    selectors.includes('html[data-device="phone"] .phone-header'),
  );
  check(
    "the ••• control is a surface of its own",
    /class="more"/.test(header) && selectors.some((selector) => /\.phone-header \.more$/.test(selector)),
  );
  check(
    "and the sheet is the settings dialog, which is the •••'s own",
    /class="sheet"[\s\S]{0,80}?role="dialog"/.test(settings) &&
      selectors.some((selector) => /\.sheet\[role="dialog"\]$/.test(selector)),
  );

  // Nothing that is content: a row, a card, a feed, an article, a category.
  const content = /\b(row|card|feed|article|category|item|post|text|body|crumbs|pane|layer)\b/;
  check(
    "no content surface is translucent",
    selectors.every((selector) => !content.test(selector.replace(/\.phone-header|\.more/g, ""))),
    selectors.filter((selector) => content.test(selector)).join(" · "),
  );

  // The whole tree, not just this file: a component that grew its own glass
  // would be a second material with no fallbacks and no phone switch.
  const offenders = [];
  for (const [file, source] of [
    ["src/app.css", app],
    ["src/components/PhoneHeader.svelte", header],
    ["src/components/SettingsPanel.svelte", settings],
    ["src/components/MobilePaneStack.svelte", read("src/components/MobilePaneStack.svelte")],
    ["src/components/ArticleList.svelte", read("src/components/ArticleList.svelte")],
    ["src/components/Sidebar.svelte", read("src/components/Sidebar.svelte")],
    ["src/components/Header.svelte", read("src/components/Header.svelte")],
    ["src/components/ReaderPane.svelte", read("src/components/ReaderPane.svelte")],
    ["src/components/ReadingPanel.svelte", read("src/components/ReadingPanel.svelte")],
  ]) {
    // This file is the one place the property is allowed to appear.
    if (file === "src/app.css") continue;
    for (const match of bare(source).matchAll(/backdrop-filter\s*:/g)) {
      offenders.push(`${file} at ${match.index}`);
    }
  }
  check("no component declares a material of its own", offenders.length === 0, offenders.join(" · "));
}

// ---------------------------------------------------------------------------
// Nothing reaches a desktop frame
// ---------------------------------------------------------------------------

{
  const escaped = carrying.filter((rule) => !onPhone(rule.selector));
  check(
    "every glass selector starts with the phone switch",
    escaped.length === 0,
    escaped.map((rule) => rule.selector).join(" · "),
  );
  // Including the fallbacks: a solid surface applied without the switch would be
  // a desktop rule, which is the boundary this work must not cross.
  const inBlocks = APP.filter(
    (rule) =>
      rule.at.some((at) => at.startsWith("@supports not") || at.includes("prefers-reduced-transparency")),
  );
  const unscoped = inBlocks.filter((rule) => !onPhone(rule.selector));
  check(
    "and so does every rule inside a fallback block",
    inBlocks.length > 0 && unscoped.length === 0,
    unscoped.map((rule) => rule.selector).join(" · "),
  );
}

// ---------------------------------------------------------------------------
// Both fallbacks
// ---------------------------------------------------------------------------

{
  const supports = APP.filter((rule) =>
    rule.at.some((at) =>
      at.includes("@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))"),
    ),
  );
  const reduce = APP.filter((rule) => rule.at.some((at) => at.includes("@media (prefers-reduced-transparency: reduce)")));

  // The plan's exact condition, as one string: a `@supports` that asked about
  // one prefix and not the other would pass on a WebKit that only has the other.
  check(
    "the @supports fallback asks about both spellings",
    bare(app).includes(
      "@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))",
    ),
  );
  check("...and it exists as a block with rules in it", supports.length > 0, String(supports.length));
  check(
    "...and every surface it names goes solid",
    supports.length > 0 && supports.every((rule) => declares(rule.body, "background", "var\\(--surface\\)")),
    supports.map((rule) => rule.selector).join(" · "),
  );

  check(
    "the reduced-transparency fallback exists",
    bare(app).includes("@media (prefers-reduced-transparency: reduce)") && reduce.length > 0,
    String(reduce.length),
  );
  check(
    "...and every surface it names goes solid and loses the blur",
    reduce.length > 0 &&
      reduce.every(
        (rule) =>
          declares(rule.body, "background", "var\\(--surface\\)") &&
          declares(rule.body, "backdrop-filter", "none") &&
          declares(rule.body, "-webkit-backdrop-filter", "none"),
      ),
    reduce.map((rule) => rule.selector).join(" · "),
  );

  // Both blocks must name all three surfaces, or one of them ships half done:
  // a solid bar next to a translucent pill is the state nobody screenshots.
  const expected = [
    'html[data-device="phone"] .phone-header',
    'html[data-device="phone"] .phone-header .more',
    'html[data-device="phone"] .sheet[role="dialog"]',
  ];
  const listing = APP.filter((rule) => declares(rule.body, "background", "var\\(--surface\\)"));
  for (const selector of expected) {
    check(
      `${selector.replace('html[data-device="phone"] ', "")} has a solid fallback`,
      listing.some((rule) => rule.selector.split(",").map((s) => s.trim()).includes(selector)),
    );
  }

  // Cascade order: same specificity, so the later block wins. A fallback placed
  // above the material would be overwritten by the very rule it exists for.
  const materialAt = bare(app).indexOf("--glass-blur: blur(20px)");
  const supportsAt = bare(app).indexOf("@supports not ((backdrop-filter: blur(1px))");
  const reduceAt = bare(app).indexOf("@media (prefers-reduced-transparency: reduce)");
  check(
    "both fallbacks come after the material",
    materialAt >= 0 && supportsAt > materialAt && reduceAt > materialAt,
    `${materialAt} / ${supportsAt} / ${reduceAt}`,
  );
}

// ---------------------------------------------------------------------------
// The divider, and the honest note
// ---------------------------------------------------------------------------

{
  const bar = carrying.find((rule) => rule.selector === 'html[data-device="phone"] .phone-header');
  check("the bar carries the material", bar !== undefined);
  const body = bar?.body ?? "";
  check(
    "the bar has exactly one hairline, and it is the soft one",
    /border-bottom:\s*1px solid var\(--glass-edge\)/.test(body) &&
      !/border-bottom:\s*1px solid var\(--edge\)/.test(body) &&
      !/border(-top|-left|-right)?:\s*1px solid/.test(body.replace(/border-bottom:[^;]*;/, "")),
    body.replace(/\s+/g, " ").trim(),
  );
  check(
    "the hard surface fill is gone from the bar — the material owns it",
    !declares(body, "background", "var\\(--surface\\)"),
  );
  check(
    "and it is lifted off the content rather than sitting on a seam",
    /box-shadow:\s*var\(--glass-shadow\)/.test(body),
  );
  // The 3px activity seam was the second line under the bar on a phone.
  const aura = APP.find((rule) => rule.selector === 'html[data-device="phone"] .aura');
  check(
    "the activity seam under it no longer paints a line",
    aura !== undefined && declares(aura.body, "background", "transparent"),
  );
  check(
    "the component no longer draws its own divider",
    !/border-bottom: 1px solid var\(--edge\)/.test(header),
  );
  check(
    "the note says what this is not: a UIVisualEffectView a webview cannot have",
    /UIVisualEffectView/.test(app) && /not the material|not Liquid Glass/i.test(app),
  );
  check(
    "and the changelog says the same thing, in the newest section",
    // Once the note ships, "Unreleased" becomes the version it shipped in; both
    // are the same claim, so the check reads the newest section either way.
    /## \[(Unreleased|\d+\.\d+\.\d+)\]/.test(changelog) &&
      /UIVisualEffectView/.test(changelog.slice(0, changelog.indexOf("## [0.6.1]"))),
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
