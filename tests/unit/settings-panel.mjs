/**
 * The settings panel, rendered without a browser.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/settings-panel.mjs
 *
 * There is no DOM here and no GUI launch: the panel and everything it mounts is
 * compiled for Svelte's server target and rendered to a string. That is enough
 * to prove the two things this panel is *for*, which are both structural:
 *
 *   1. every section is a disclosure with real content inside it, so opening it
 *      shows a control rather than an empty box;
 *   2. no control appears twice. The panel mounts the components that already
 *      own these settings — the theme's rows, the Aa's rows, the account's — so
 *      a duplicate in the markup would mean a second copy was written here.
 *
 * What it cannot prove: that the sheet looks like a sheet, that the slide happens
 * or that a thumb hits it at 390px. Those are visual checks in the running app.
 *
 * The state modules are runes, so each is type-stripped with the project's
 * TypeScript and compiled with `compileModule` — the same treatment
 * `mobile-nav.mjs` gives the layout. Nothing is stubbed: the rows read the real
 * `layout`, `theme`, `reading` and `chrome` singletons, which is why the rendered
 * values (the one-pane width, the chosen interval) are the app's own.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compile, compileModule, preprocess } from "svelte/compiler";
import { render } from "svelte/server";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN = join(ROOT, "tests/unit/.gen-settings");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
const absolute = (relative) => pathToFileURL(join(ROOT, relative)).href;

/** `svelte/compiler` does not strip TypeScript, so the build's first step is done here. */
const typescript = {
  script: ({ content, attributes }) => {
    if (attributes.lang !== "ts") return undefined;
    return {
      code: ts.transpileModule(content, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          // A component's imports are used in its *markup*, which TypeScript
          // cannot see: without this it elides them and the compiled component
          // renders nothing it asked for.
          verbatimModuleSyntax: true,
        },
        fileName: "component.ts",
      }).outputText,
    };
  },
};

/** Every module built from source, keyed by the real file it came from. */
const built = new Map();

/** The file a specifier points at, or null when it is a bare package name. */
function sourceOf(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.svelte`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Point a generated module's imports at what it actually needs.
 *
 * A generated file does not sit next to the module it came from, so `./theme`
 * would resolve to nothing. Built modules get their generated URL; plain `.ts`
 * libraries are imported in place, which Node's type stripping handles.
 */
function rewrite(code, fromFile) {
  // Svelte's generated code quotes with single quotes; this file's own imports
  // are not touched, only the strings a generated module imports from.
  return code.replace(/(from\s*)(["'])([^"']+)\2/g, (whole, before, quote, specifier) => {
    const source = sourceOf(fromFile, specifier);
    if (source === null) return whole;
    const target = built.get(source) ?? pathToFileURL(source).href;
    return `${before}${quote}${target}${quote}`;
  });
}

function buildRunes(relative) {
  const file = join(ROOT, relative);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: relative });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${relative.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewrite(compiled.js.code, file));
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

function buildComponent(relative) {
  const file = join(ROOT, relative);
  return preprocess(readFileSync(file, "utf8"), typescript, { filename: relative }).then((pre) => {
    const compiled = compile(pre.code, { generate: "server", filename: relative, dev: false });
    const out = join(GEN, `${relative.split("/").pop().replace(/\.svelte$/, "")}.mjs`);
    mkdirSync(GEN, { recursive: true });
    writeFileSync(out, rewrite(compiled.js.code, file));
    built.set(file, pathToFileURL(out).href);
    return pathToFileURL(out).href;
  });
}

/**
 * The account roster, without the network.
 *
 * `AccountsBody` reads the real store, which reaches `api/session` -> `api/freshrss`
 * and, under Node, an extensionless specifier Node cannot resolve. The rows this
 * panel draws are a list, so the harness hands the component a list: two accounts,
 * one of them in use, which is the shape the duplication check cares about.
 */
function stubAccounts() {
  const file = join(GEN, "accounts-stub.mjs");
  const code = `
const rows = [
  { slug: "a1", email: "ada@example.test", serverUrl: "https://rss.example.test", active: true },
  { slug: "b2", email: "grace@example.test", serverUrl: "https://other.example.test", active: false },
];
export const accounts = {
  rows,
  busy: null,
  notice: "",
  async switchTo() {},
  async remove() {},
};
`;
  writeFileSync(file, code);
  built.set(join(ROOT, "src/state/accounts.svelte.ts"), pathToFileURL(file).href);
}

/**
 * The preferences store, without the network.
 *
 * `PrefsSync` reaches `api/freshrss` for the server's copy of the settings
 * document. Device sync asks it for this device's document and hands a merged
 * one back, so the sheet only needs those two doors.
 */
function stubPrefs() {
  const file = join(GEN, "prefs-stub.mjs");
  writeFileSync(
    file,
    `export const prefs = {
  deviceDoc() { return { version: 1, updatedAt: 0, entries: {} }; },
  adoptFromDevice() {},
};
`,
  );
  built.set(join(ROOT, "src/state/prefs.svelte.ts"), pathToFileURL(file).href);
}

let SettingsPanel;

try {
  // State first: the components import them by the names the compiler rewrites.
  // Libraries first: a `.ts` module Node loads in place cannot resolve its own
  // extensionless imports, so anything below them is built and rewritten too.
  for (const lib of ["src/lib/article-filter.ts", "src/lib/version.ts", "src/lib/list-view.ts", "src/lib/sync-setup.ts", "src/lib/prefs-sync.ts"]) {
    buildRunes(lib);
  }

  for (const state of [
    "src/state/mobile-nav.svelte.ts",
    "src/state/layout.svelte.ts",
    "src/state/theme.svelte.ts",
    "src/state/chrome.svelte.ts",
    "src/state/reading.svelte.ts",
    "src/state/lan.svelte.ts",
    "src/state/floods.svelte.ts",
    "src/state/entitlements.svelte.ts",
    "src/state/device-sync.svelte.ts",
  ]) {
    buildRunes(state);
  }

  // The Sync section's last row reads the reader's own answer about the server's
  // add-on, so the reader store is built here too — after the modules it imports,
  // which is what lets its rewritten imports point at their generated copies.
  buildRunes("src/state/reader.svelte.ts");

  // The roster is a list; the harness supplies it rather than pulling the network in.
  mkdirSync(GEN, { recursive: true });
  stubAccounts();
  stubPrefs();

  // Then the components, children before the panel that mounts them.
  await buildComponent("src/components/AccountsBody.svelte");
  await buildComponent("src/components/DeviceSyncPanel.svelte");
  await buildComponent("src/components/IndentControl.svelte");
  await buildComponent("src/components/PostListPanel.svelte");
  await buildComponent("src/components/ReadingPanel.svelte");
  await buildComponent("src/components/ThemePanel.svelte");
  ({ default: SettingsPanel } = await import(await buildComponent("src/components/SettingsPanel.svelte")));

  const { layout } = await import(built.get(join(ROOT, "src/state/layout.svelte.ts")));
  const { APP_VERSION } = await import(absolute("src/lib/version.ts"));

  const props = { open: true, name: "ada", server: "https://rss.example.test", onsignout: () => {} };
  const draw = () => render(SettingsPanel, { props }).body;

  const count = (haystack, needle) => haystack.split(needle).length - 1;

  /**
   * Where a class token is, in markup Svelte has stamped with its own scope hash
   * (`class="label svelte-182y78p"`). An exact attribute match would fail on
   * every element, so the tests below count the token, not the attribute.
   */
  const classAt = (body, token) => new RegExp(`class="${token}(?:[\\s"]|$)`, "g");
  const hasClass = (body, token) => new RegExp(`class="${token}(?:[\\s"]|$)`).test(body);

  /** The markup of one section, from its summary to the next section's. */
  function section(body, label) {
    const at = body.search(new RegExp(`<span class="label[^"]*">${label}</span>`));
    if (at < 0) return "";
    // The next *section*, not the next `<details>`: a section's own content may
    // hold a disclosure of its own (Accounts holds the pairing block), and
    // cutting at that one truncated the section before its closing tag.
    const next = body.indexOf('<details class="sec', at);
    return body.slice(at, next < 0 ? body.length : next);
  }

  // -------------------------------------------------------------------------
  // The frame: a dialog, with one way out and nothing behind it left reachable.
  // -------------------------------------------------------------------------
  {
    const body = draw();
    check("the panel is a dialog", count(body, 'role="dialog"') === 1);
    check("it says it is modal", /role="dialog"[^>]*aria-modal="true"/.test(body));
    check("and is named by its heading", /aria-labelledby="settings-title"/.test(body) && /<h2 id="settings-title"[^>]*>Settings<\/h2>/.test(body));
    check("closing is one named control", count(body, 'aria-label="Close settings"') === 1);
    check("the scrim is there to be pressed", (body.match(classAt(body, "scrim")) ?? []).length === 1);
    check("the sheet can take focus itself", /class="sheet[^"]*"[^>]*tabindex="-1"/.test(body) || /tabindex="-1"[^>]*class="sheet/.test(body));
  }

  // -------------------------------------------------------------------------
  // The sections: six disclosures, each with its own rows inside it.
  // -------------------------------------------------------------------------
  const SECTIONS = ["Accounts", "Appearance", "Reading", "Layout", "Refreshing", "About"];
  {
    const body = draw();
    // Sections carry `class="sec"`. Counted by that class, not by every
    // `<details>` in the panel: a section's own content may hold a disclosure of
    // its own (Accounts holds the pairing block), and the question here is how
    // many *sections* there are.
    const sections = (markup) => (markup.match(/<details[^>]*class="sec/g) ?? []).length;
    check("there are six sections", sections(body) === 6, String(sections(body)));
    check("every one is a disclosure with a summary", count(body, 'class="sum') === 6, String(count(body, 'class="sum')));
    check("every section is named", SECTIONS.every((label) => new RegExp(`<span class="label[^"]*">${label}</span>`).test(body)));
    check("and says what is in it", SECTIONS.every((label) => hasClass(section(body, label), "note")));
    // Native `<details>` is the mechanism: the content is inside the disclosure,
    // so "open" is the browser's own answer and a keyboard can give it.
    check(
      "each section's rows are inside its own disclosure",
      SECTIONS.every((label) => {
        const part = section(body, label);
        return hasClass(part, "content") && part.includes("</details>");
      }),
    );
    check(
      "the first one is open, the rest are shut",
      (body.match(/<details[^>]*\sopen(?:=""|=''|\s|>)/g) ?? []).length === 1 &&
        /<details[^>]*\sopen[^>]*>\s*<summary[^>]*>\s*<span class="label[^"]*">Accounts</.test(body),
    );
  }

  // Every section shows the control it promises — read inside that section, so a
  // row drawn in the wrong place cannot pass for one drawn in the right place.
  {
    const body = draw();
    const prose = (haystack) => haystack.replace(/<[^>]*>/g, " ");

    // The roster, as the bar's own panel draws it: each account's address, the
    // one in use marked, and the one sign-out. The body is shared, so this is
    // also the check that the settings sheet did not grow a second account UI.
    check("Accounts is the roster: who, where, and the way out", (() => {
      const part = prose(section(body, "Accounts"));
      return (
        part.includes("ada@example.test") &&
        part.includes("grace@example.test") &&
        part.includes("rss.example.test") &&
        part.includes("Sign out")
      );
    })(), prose(section(body, "Accounts")).slice(0, 140));

    check("Appearance is the theme's rows", (() => {
      const part = section(body, "Appearance");
      return part.includes('aria-label="Appearance"') && part.includes('aria-label="Page colour"') && part.includes('aria-label="Accent colour"');
    })());

    check("Reading is the Aa panel's rows", (() => {
      const part = section(body, "Reading");
      return part.includes('aria-label="Text size"') && part.includes('aria-label="Line spacing"') && part.includes('aria-label="Text alignment"');
    })());

    check("Layout is the pane widths, including the one-pane width", (() => {
      const part = section(body, "Layout");
      return part.includes('aria-label="Two-pane threshold in pixels"') && part.includes('aria-label="One-pane window width in pixels"') && part.includes('aria-label="Width the one-pane button collapses the window to"');
    })());

    check("Sync is the interval", (() => {
      const part = section(body, "Refreshing");
      return part.includes('aria-label="Sync automatically"') && part.includes('aria-label="How often to sync automatically"') && /\d+h</.test(part);
    })());

    check("About is the version, and it is the build's", (() => {
      const manifest = JSON.parse(read("package.json"));
      return new RegExp(`<span class="value[^"]*">${manifest.version}</span>`).test(section(body, "About")) && APP_VERSION === manifest.version;
    })());
  }

  // -------------------------------------------------------------------------
  // One control per setting: the panel borrows, it never writes its own.
  // -------------------------------------------------------------------------
  {
    const body = draw();

    const labels = [...body.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
    const seen = new Map();
    for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1);
    const twice = [...seen.entries()].filter(([, times]) => times > 1).map(([label]) => label);
    check("no labelled control is drawn twice", twice.length === 0, twice.join(", "));

    // The explicit names as well as the generic sweep, because a swatch's label
    // is a span rather than an aria-label and would slip past the check above.
    const once = [
      'aria-label="Accent colour"',
      'aria-label="Page colour"',
      'aria-label="Two-pane threshold in pixels"',
      'aria-label="Three-pane threshold in pixels"',
      'aria-label="One-pane window width in pixels"',
      'aria-label="Width the one-pane button collapses the window to"',
      'aria-label="Text size"',
      'aria-label="Sync automatically"',
      'aria-label="Close settings"',
    ];
    check("the named settings appear exactly once each", once.every((needle) => count(body, needle) === 1), once.filter((needle) => count(body, needle) !== 1).join(", "));

    // A trigger is not a setting: the gear and the Aa stay in the bar, and the
    // sheet is not a second place to press them.
    check("no gear in the sheet", !body.includes('aria-label="Settings"'));
    check("no Aa in the sheet", !body.includes('aria-label="Reading options"'));
    check("no second Done", !hasClass(body, "done"));

    // The whole point: the panel is a frame. Anything that writes a preference
    // here would be a second control for a setting that already has one.
    const source = read("src/components/SettingsPanel.svelte");
    check(
      "the panel defines no control of its own",
      !/(?:theme|reading|chrome|layout)\.(?:set|toggle|step)[A-Za-z]*\(/.test(source) && !/type="range"|type="color"|type="number"/.test(source),
    );
    check("it mounts the components that own the rows", ["ThemePanel", "ReadingPanel", "AccountsBody"].every((name) => new RegExp(`from "\\./${name}\\.svelte"`).test(source)));
    check("the layout rows are mounted whole, phone rows and all", /<ThemePanel part="layout" \/>/.test(source));
  }

  // -------------------------------------------------------------------------
  // Device sync: the section the word Sync now means, and the two halves the
  // entitlement decides between.
  // -------------------------------------------------------------------------
  {
    const { reader } = await import(built.get(join(ROOT, "src/state/reader.svelte.ts")));
    const { entitlement } = await import(built.get(join(ROOT, "src/state/entitlements.svelte.ts")));

    // First launch: a library on this device with nothing in it. The section is
    // not drawn at all, so nobody is sold anything before they have a feed.
    check("an empty library is not offered device sync", !draw().includes("Device sync"));

    // The same window with one feed in it is.
    reader.profile = { kind: "local", slug: "local0000", label: "On this device", session: null };
    reader.subscriptions = [
      { id: "feed/1", title: "A", url: "https://a.test/rss", category: { id: "user/-/label/Art", label: "Art" } },
    ];
    check("a library with a feed is", (() => {
      const body = draw();
      return /<span class="label[^"]*">Device sync<\/span>/.test(body) && /Your own folder, both devices/.test(body);
    })());

    // ...and the word Sync means one thing: the interval row is Refreshing.
    const named = draw();
    check("the interval row is called Refreshing", /<span class="label[^"]*">Refreshing<\/span>/.test(named));
    check("and no section is called Sync", !/<span class="label[^"]*">Sync<\/span>/.test(named));

    // Free half: what it is and what it costs, inside its own section.
    entitlement.cloudSync = false;
    const free = section(draw(), "Device sync");
    const freeWords = free.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    check("the free half says what syncing is for", freeWords.includes("Sync across your devices"), freeWords.slice(0, 160));
    check("...offers both prices", freeWords.includes("$0.99 / month") && freeWords.includes("$9.99 / year"));
    check("...and both ways in", freeWords.includes("Start HardlyReader Sync") && freeWords.includes("Restore Purchase"));
    check("...and no provider, because none is bought yet", !freeWords.includes("Provider"));

    // Entitled half: the four providers, the folder and the run — same section,
    // same window, only the capability moved.
    entitlement.cloudSync = true;
    const paid = section(draw(), "Device sync");
    const paidWords = paid.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    check("the entitled half says the subscription is live", paidWords.includes("HardlyReader Sync") && paidWords.includes("active"));
    check(
      "it offers the four providers, once each",
      ["iCloud Drive", "Google Drive", "Dropbox", "OneDrive"].every((label) => count(paid, `aria-label="${label}"`) === 1),
      paidWords.slice(0, 200),
    );
    check("it has a folder row and a run", paidWords.includes("Folder") && paid.includes('aria-label="Sync now"'));
    check("and it does not ask for money again", !paidWords.includes("Start HardlyReader Sync"));

    reader.profile = null;
    reader.subscriptions = [];
    entitlement.cloudSync = false;
    check("and the section goes when the library does", !draw().includes("Device sync"));
  }

  // -------------------------------------------------------------------------
  // A phone's answer: the rows that only make sense on a phone are the same ones
  // the popover draws, and they are still gated to a phone.
  // -------------------------------------------------------------------------
  {
    const desktop = draw();
    check("a desktop is not offered the phone's held-upright row", !desktop.includes('aria-label="How a phone held upright shows its panes"'));

    layout.device = "phone";
    const phone = draw();
    check("a phone is, once", count(phone, 'aria-label="How a phone held upright shows its panes"') === 1);
    check("and both answers are there to press", phone.includes(">One pane</button>") && phone.includes(">Sliding</button>"));

    // The two sections a phone's own chrome hands over: the sidebar's indent
    // row, and the posts bar's four shape controls. Each is a second *home*, so
    // every row in them is one the app already had — the same slider, the same
    // `reading` writes.
    const sectionsOn = (body) => (body.match(/<details[^>]*class="sec/g) ?? []).length;
    check("a phone is offered both sections its chrome gives up", sectionsOn(phone) === 8, String(sectionsOn(phone)));

    const feeds = section(phone, "Feeds");
    check(
      "Feeds holds the feed indent, the sidebar's own slider",
      hasClass(feeds, "indent-row") && count(feeds, 'type="range"') === 1,
    );
    check("...beside the two file actions", /Import feeds/.test(feeds) && /Export feeds/.test(feeds));

    const rows = section(phone, "Post list");
    check(
      "Post list holds how a row ends and how far it turns",
      rows.includes(">Pill</button>") && rows.includes(">Foot</button>") && count(rows, 'type="range"') === 1,
    );
    check("...and the picture fill, because the view is Rows", /Picture fill/.test(rows));
    check("...and no ruler, because Rows has no tiles to count", !/Tiles across/.test(rows));

    // View for view, like the bar it replaces: the ruler is there in Grid.
    const { reading } = await import(built.get(join(ROOT, "src/state/reading.svelte.ts")));
    reading.listView = "grid";
    const gridRows = section(draw(), "Post list");
    check("in Grid the ruler is there instead", /Tiles across/.test(gridRows) && !/Picture fill/.test(gridRows));
    reading.listView = "regular";

    layout.device = "desktop";
  }

  // -------------------------------------------------------------------------
  // The behaviour the markup cannot show: Escape, the breakpoint, less motion.
  // -------------------------------------------------------------------------
  {
    const source = read("src/components/SettingsPanel.svelte");
    check(
      "Escape closes the sheet",
      /function onkeydown\(event: KeyboardEvent\)/.test(source) &&
        /if \(event\.key === "Escape"\) \{\s*event\.stopPropagation\(\);\s*close\(\);/.test(source),
    );
    // The sheet is drawn over the app, so the keyboard is kept inside it: the
    // rows behind the scrim cannot be reached by pointer.
    check("Tab stays inside it", /if \(event\.key !== "Tab" \|\| sheetEl === null\) return;/.test(source));
    check("a section's own press writes its open state", /ontoggle=\{\(event\) => \(opened\[section\.id\] = event\.currentTarget\.open\)\}/.test(source));
    check("the header owns the flag, so the bar and the sheet agree", /open = \$bindable\(false\)/.test(read("src/components/SettingsPanel.svelte")) && /bind:open=\{settingsOpen\}/.test(read("src/components/Header.svelte")));
    check("a full-screen sheet under 700px", /@media \(max-width: 699px\)\s*\{\s*\.sheet \{\s*inset: 0;/.test(source));
    check("and a wide panel above it", /width: min\(560px, calc\(100vw - 24px\)\)/.test(source));
    check("a phone's sheet clears the status bar", /max\(12px, var\(--safe-top\)\)/.test(source));
    check("less motion means the sheet arrives instead of sliding", /@media \(prefers-reduced-motion: reduce\)/.test(source) && /animation: none/.test(source));
    check("the sheet scrolls, and its heading stays put", /\.head \{[\s\S]{0,400}?flex: 0 0 auto/.test(source) && /\.body \{[\s\S]{0,200}?overflow-y: auto/.test(source));
  }
} finally {
  rmSync(GEN, { recursive: true, force: true });
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
