/**
 * The app is a layout, not a document: what a WebView must not offer.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs native-feel.mjs
 *
 * A label that selects, a long press that opens Copy / Look Up / Share, a grey
 * flash under a tap, a picture that can be dragged onto the desktop — none of
 * those exist in a native iOS app, and each one is a tell that this is a page in
 * a WebView. They are also silent failures: every one of them looks correct in a
 * screenshot, so they are asserted against the stylesheet text instead.
 *
 *   1. the body refuses selection, the callout and the tap highlight;
 *   2. selection comes back exactly where it is the point — the article, a
 *      field, a code block, anything marked `.selectable` — and nowhere else;
 *   3. an image is not draggable;
 *   4. pinch and the double-tap zoom are refused at the layout level, and this
 *      app installs **no** global tap-pair canceller, because the reader's
 *      double tap on a picture is a feature and `touch-action: pan-x pan-y`
 *      already covers the page.
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
  console.log(`  not ok — ${name}${detail ? `: ${detail}` : ""}`);
}

const css = read("src/app.css");
const main = read("src/main.ts");

/**
 * Every top-level rule, as `{ selector, body }`.
 *
 * Split on braces at depth 0: a naive `indexOf("body {")` finds the `html, body`
 * rule instead of the `body` rule, and the two say different things.
 */
function rules() {
  const out = [];
  let depth = 0;
  let start = 0;
  let selector = null;
  let bodyStart = 0;
  // Comments would confuse a selector scan; they are dropped first.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") {
      if (depth === 0) {
        selector = text.slice(start, i).trim();
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && selector !== null) {
        out.push({ selector, body: text.slice(bodyStart, i) });
        selector = null;
        start = i + 1;
      }
    }
  }
  return out;
}

const RULES = rules();

/** The body of the first rule whose selector list is exactly `selector`. */
function rule(selector) {
  const wanted = selector.replace(/\s+/g, " ").trim();
  const found = RULES.find((item) => item.selector.replace(/\s+/g, " ").trim() === wanted);
  return found ? found.body : "";
}

/** The selector text of the rule that declares `needle`. */
function selectorDeclaring(needle) {
  const found = RULES.find((item) => item.body.includes(needle));
  return found ? found.selector : "";
}

const body = rule("body");
check("the body does not select", /-webkit-user-select:\s*none/.test(body) && /\n\s*user-select:\s*none/.test(body), body.slice(0, 80));
check("the body offers no long-press callout", /-webkit-touch-callout:\s*none/.test(body));
check("a tap draws no grey highlight", /-webkit-tap-highlight-color:\s*transparent/.test(body));

// Selection is restored by one grouped rule. It must name the article and a
// field, and it must not name a whole content surface by accident.
const restore = rule("input,\ntextarea,\nselect,\n[contenteditable=\"true\"],\n.selectable,\n.content,\n.content pre,\n.content code");
check("one rule turns selection back on", restore !== "");
check("a text field selects", /-webkit-user-select:\s*text/.test(restore) && /\n\s*user-select:\s*text/.test(restore));
const restoreSelector = selectorDeclaring("-webkit-user-select: text");
check("the article selects — quoting what you read is the app working", /\.content\b/.test(restoreSelector), restoreSelector);
check("the callout is restored with it", /-webkit-touch-callout:\s*default/.test(restore));

// A picture is part of the layout, not a file.
const img = rule("img");
check("an image cannot be dragged out", /-webkit-user-drag:\s*none/.test(img) && /\n\s*user-drag:\s*none/.test(img));

// Zoom: the layout refuses it, and the reader keeps its own double tap.
const root = rule("html,\nbody");
check("the layout refuses pinch and the double-tap zoom", /touch-action:\s*pan-x pan-y/.test(root), root.slice(0, 60));
check("text is not inflated on its own", /-webkit-text-size-adjust:\s*100%/.test(root));

const gestureFiles = ["src/lib/native-gestures.ts", "src/lib/native-gestures.js"];
const hasGlobalCanceller = gestureFiles.some((path) => {
  try {
    return read(path).includes("preventDefault");
  } catch {
    return false;
  }
});
check(
  "no global tap-pair canceller: the picture's double tap is a feature",
  !hasGlobalCanceller && !main.includes("installNativeGestures"),
);

// The viewport says it too, for the shells that honour it.
const html = read("index.html");
check(
  "the viewport asks for no zoom",
  /user-scalable=no/.test(html) && /maximum-scale=1(\.0)?/.test(html) && /viewport-fit=cover/.test(html),
);

console.log(`${checks - failures}/${checks} checks`);
if (failures > 0) process.exitCode = 1;
