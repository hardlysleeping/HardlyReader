/**
 * Renders the menu component without a browser.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/menu-render.mjs
 *
 * There is no DOM here and no GUI launch: the component is compiled for Svelte's
 * server target and rendered to a string. That exercises the markup the app will
 * actually draw — labels, disabled items, the ticked view, the note, escaping —
 * but not the interaction around it (focus, pointer events, clamping on real
 * layout), which stays a visual check.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compile, preprocess } from "svelte/compiler";
import { render } from "svelte/server";
import ts from "typescript";
import { parseState } from "../../src/api/hardlyread.ts";
import { categoryMenu, feedMenu } from "../../src/lib/contextmenu.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, `tests/unit/.gen-${process.pid}`);

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const absolute = (relativePath) => pathToFileURL(join(ROOT, relativePath)).href;

/** `svelte/compiler` does not strip TypeScript, so the build's first step is done here. */
const typescript = {
  script: ({ content, attributes }) => {
    if (attributes.lang !== "ts") return undefined;
    return {
      code: ts.transpileModule(content, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: "CategoryMenu.ts",
      }).outputText,
    };
  },
};

mkdirSync(GEN_DIR, { recursive: true });
const generated = join(GEN_DIR, "CategoryMenu.mjs");

let CategoryMenu;
try {
  const source = readFileSync(join(ROOT, "src/components/CategoryMenu.svelte"), "utf8");
  const preprocessed = await preprocess(source, typescript, { filename: "CategoryMenu.svelte" });
  const compiled = compile(preprocessed.code, {
    generate: "server",
    filename: "CategoryMenu.svelte",
    dev: false,
  });

  writeFileSync(
    generated,
    compiled.js.code.replaceAll('"../lib/contextmenu"', JSON.stringify(absolute("src/lib/contextmenu.ts"))),
  );
  ({ default: CategoryMenu } = await import(pathToFileURL(generated).href));

  const state = (overrides = {}) =>
    parseState({
      available: true,
      mode: "strict",
      view: "hidden",
      effectiveView: "hidden",
      hiddenIds: [12],
      locked: false,
      categories: [
        { id: 12, name: "Technology", hidden: true },
        { id: 7, name: "Art", hidden: false },
      ],
      ...overrides,
    });

  const draw = (model, extra = {}) =>
    render(CategoryMenu, {
      props: { x: 10, y: 20, model, busy: false, onselect: () => {}, onclose: () => {}, ...extra },
    }).body;

  const count = (haystack, needle) => haystack.split(needle).length - 1;

  {
    const body = draw(categoryMenu(state(), "Technology", false));
    check("the menu is rendered as a menu", body.includes('role="menu"'));
    check("it is named after the category", body.includes('aria-label="Actions for Technology"'));
    check("it is positioned at the anchor", body.includes("left: 10px; top: 20px"), body.match(/style="[^"]*left[^"]*"/)?.[0] ?? "no style");
    check("the title is drawn", body.includes(">Technology<"));
    check("a hidden category offers Show", body.includes(">Show<") && !body.includes(">Hide<"));
    check("the toggle is a menu item", body.includes('role="menuitem"'));
    check("the toggle is enabled", !/<button[^>]*role="menuitem"[^>]*disabled/.test(body));
    check("no view radios are drawn", count(body, 'role="menuitemradio"') === 0, String(count(body, 'role="menuitemradio"')));
    check("Pin is drawn", body.includes(">Pin<"));
    check("exactly two items: hide/show and pin", count(body, 'role="menuitem"') === 2, String(count(body, 'role="menuitem"')));
  }

  {
    const body = draw(categoryMenu(state(), "Art", true));
    check("a shown category offers Hide", body.includes(">Hide<"));
    check("a pinned category offers Unpin", body.includes(">Unpin<"));
  }

  {
    const body = draw(categoryMenu(state(), "Uncategorized", false));
    check("an unknown category renders a disabled toggle", /<button[^>]*role="menuitem"[^>]*disabled/.test(body));
    check("...with the reason as a note", body.includes("This category has no id on the server"));
    check("...and pin stays usable", count(body, "disabled") === 1, String(count(body, "disabled")));
  }

  {
    const body = draw(categoryMenu(parseState({ available: false }), "Technology", false));
    check("without Hidden Categories both rows are drawn", count(body, 'role="menuitem"') === 2 && body.includes(">Pin<"));
    check("...Hide is the disabled one", count(body, "disabled") === 1, String(count(body, "disabled")));
    check("...and the note explains it", /not answering/.test(body), "no note");
  }

  {
    const busy = draw(categoryMenu(state(), "Technology", false), { busy: true });
    check("a write in flight disables the items", count(busy, "disabled") === 2, String(count(busy, "disabled")));
  }

  {
    const body = draw(categoryMenu(state(), "<b>Art</b>", false));
    check("a category name cannot open a tag", body.includes("&lt;b>Art&lt;/b>"));
    check("...and no raw tag survives", !body.includes("<b>Art"));
    check("...and it is escaped in the aria-label too", body.includes('aria-label="Actions for &lt;b>Art&lt;/b>"'));
  }

  {
    const asked = draw(feedMenu("Ars Technica", false));
    check("a feed menu is titled with the feed", asked.includes(">Ars Technica<"));
    check("...offering removal", asked.includes("Remove feed…"));
    // The three answers are radios in their own group: a feed is not a category,
    // so there is still no hide/view item anywhere in this menu.
    check("...and no view item", !asked.includes(">Hide<") && !asked.includes(">Show<"));
    check("...but a feed can be pinned", asked.includes(">Pin<"));
    // Indent is a sidebar setting with its own strip; it has no business in a
    // right-click menu, where a mis-drag would change every feed's indent.
    check("...and no indent control", !asked.includes("Indent") && !asked.includes('type="range"'));
  }

  {
    // Where a feed's text comes from: three answers, all three drawn, the feed's
    // own answer ticked, and the headings say what the group is.
    const body = draw(feedMenu("Ars Technica", false, false, "auto"));
    check("the full-text answers are three radios", count(body, 'role="menuitemradio"') === 3, String(count(body, 'role="menuitemradio"')));
    check("...named in the order they are offered", body.indexOf(">Auto<") < body.indexOf(">Feed<") && body.indexOf(">Feed<") < body.indexOf(">Full webpage<"));
    check("...grouped under their own name", body.includes('role="group" aria-label="Full text"') && body.includes(">Full text<"));
    // Which of the three is ticked: the tick has to be the one on that label,
    // so the assertions are positional rather than counted.
    const ticked = body.indexOf('aria-checked="true"');
    check("...with Auto ticked on a fresh feed", ticked > 0 && ticked < body.indexOf(">Auto<"));
    check("...and the other two not", count(body, 'aria-checked="true"') === 1, String(count(body, 'aria-checked="true"')));

    const article = draw(feedMenu("Ars Technica", false, false, "article"));
    const tickedArticle = article.indexOf('aria-checked="true"');
    check(
      "a feed told Full webpage has that one ticked",
      tickedArticle > article.indexOf(">Feed<") && tickedArticle < article.indexOf(">Full webpage<"),
    );
    check("...and Auto is not", article.indexOf('aria-checked="false"') < article.indexOf(">Auto<"));

    // What Auto will do next is the one thing a list of three words cannot say,
    // so it is carried as a tooltip on the item rather than as a fourth row.
    check("Auto says what it will do for a feed that truncates", /title="This feed cuts its posts short/.test(draw(feedMenu("Ars Technica", false, false, "auto", true))));
    check("...and for one that does not", /title="Fetch the page when the feed&#39;s text stops short"/.test(body) || /title="Fetch the page when the feed's text stops short"/.test(body));
  }

  {
    const confirming = draw(feedMenu("Ars Technica", true));
    check("the confirmation replaces the ask", !confirming.includes("Remove feed…"));
    check("...offering both answers", confirming.includes(">Remove feed<") && confirming.includes(">Cancel<"));
    check("...marking the destructive one", /class="item[^"]*danger[^"]*"[^>]*>Remove feed</.test(confirming));
    check("...saying what it costs", confirming.includes("removes the feed"));
    check("...and asking nothing else while it is up", count(confirming, 'role="menuitemradio"') === 0);
  }

  {
    const body = draw(feedMenu("<i>Ars</i>", false));
    check("a feed title cannot open a tag", body.includes("&lt;i>Ars&lt;/i>"));
    check("...and is escaped in the aria-label", body.includes('aria-label="Actions for &lt;i>Ars&lt;/i>"'));
  }
} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
