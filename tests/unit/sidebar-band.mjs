/**
 * The sidebar band in its three states.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/sidebar-band.mjs
 *
 * The band is one row above the stream list: eye on the left, lock in the
 * middle, pin on the right, with the status strip at the foot of the sidebar
 * reporting the hidden count, the ENFORCED badge and the pinned count.
 *
 * Its three states are not variations of one row:
 *
 * - open — the full band, labels in the extensions' own words, and a strip that
 *   reads;
 * - locked — low-key glyphs, and nothing that says hidden content exists: no
 *   count, no badge, no word, no spoken name;
 * - collapsed — the row folded away; a fold is not a curtain, so the strip keeps
 *   reading.
 *
 * Three layers, none of which needs a browser:
 *
 * - `lib/band.ts` is the model both components draw from, so each state's facts
 *   can be asserted directly, including the rule that a lock carries nothing
 *   about hidden content.
 * - The band component is compiled for Svelte's server target and rendered to a
 *   string, so the same rule is checked against markup the app will draw rather
 *   than against the model it drew from.
 * - The sidebar's strip is read as source, because its placement at the foot of
 *   the scroll area is already `sidebar-layout.mjs`'s business.
 *
 * Interaction (focus, Escape, the pulse) stays a visual check.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compile, preprocess } from "svelte/compiler";
import { render } from "svelte/server";
import ts from "typescript";

import { parseState } from "../../src/api/hardlyread.ts";
import { bandFacts, bandState, statusFacts } from "../../src/lib/band.ts";
import { HIDDEN_VIEW_LABELS, effectiveView, enforcing, nextHiddenView } from "../../src/state/hidden.ts";
import { PIN_VIEW_LABELS, nextPinView } from "../../src/state/pins.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
/** Only this suite's own corner: siblings run in parallel and share `.gen`. */
const GEN_DIR = join(ROOT, "tests/unit/.gen/sidebar-band");

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const absolute = (relativePath) => pathToFileURL(join(ROOT, relativePath)).href;

/** Every string anywhere in a value — the scan for words a lock may not say. */
function strings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, found);
  else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) strings(entry, found);
  }
  return found;
}

/** The words a lock may not carry, anywhere in a fact or a string. */
const CURTAIN_WORDS = /hidden|reveal|enforced/i;

/* ---------------------------------------------------------------------------
 * The words.
 *
 * Both cycles use the extensions' own vocabulary. These are the three the card
 * names, and a band that invents a fourth has broken the rule it was given.
 * ------------------------------------------------------------------------- */
{
  check(
    "the eye cycles Hidden -> Revealed -> Only",
    nextHiddenView("hidden") === "revealed" && nextHiddenView("revealed") === "only" && nextHiddenView("only") === "hidden",
  );
  check(
    "and says those three",
    HIDDEN_VIEW_LABELS.hidden === "Hidden" && HIDDEN_VIEW_LABELS.revealed === "Revealed" && HIDDEN_VIEW_LABELS.only === "Only",
  );
  check(
    "the pin cycles Active -> Only -> Hidden",
    PIN_VIEW_LABELS.all === "Active" && PIN_VIEW_LABELS.only === "Only" && PIN_VIEW_LABELS.without === "Hidden",
  );
  check("...in that order", nextPinView("all") === "only" && nextPinView("only") === "without" && nextPinView("without") === "all");
  check(
    "the pin cycle still walks the extension's order",
    ["all", "only", "without"].every((view, index, list) => nextPinView(view) === list[(index + 1) % list.length]),
  );
}

/* ---------------------------------------------------------------------------
 * The badge: only the plain hidden view is enforced. The other two suspend it,
 * which is what makes their rows drawable at all.
 * ------------------------------------------------------------------------- */
{
  const state = (overrides = {}) => parseState({ available: true, mode: "strict", locked: false, hiddenIds: [12], ...overrides });
  check("the hidden view is enforced", enforcing(state({ effectiveView: "hidden" })) === true);
  check("revealed is not", enforcing(state({ effectiveView: "revealed" })) === false);
  check("only is not", enforcing(state({ effectiveView: "only" })) === false);
  check("an absent extension enforces nothing", enforcing(parseState({ available: false })) === false);
  check("the lock does not change the applied view", effectiveView(state({ effectiveView: "hidden", locked: true })) === "hidden");
}

/* ---------------------------------------------------------------------------
 * The band's three states, as facts.
 * ------------------------------------------------------------------------- */
const input = (overrides = {}) => ({
  collapsed: false,
  locked: false,
  available: true,
  authority: "extension",
  view: "hidden",
  pinnedCount: 2,
  pinView: "all",
  ...overrides,
});

{
  const facts = bandFacts(input());
  check("a fold wins over everything", bandState(true, true) === "collapsed" && bandState(true, false) === "collapsed");
  check("unfolded and unlocked is the open band", bandState(false, false) === "open");
  check("unfolded and locked is the locked band", bandState(false, true) === "locked");
  check("the open band draws its row", facts.row === true && facts.state === "open");
  check("with the eye and its word", facts.hidden?.label === "Hidden" && facts.hidden?.enabled === true);
  check("saying what a press asks for", facts.hidden?.next === "Revealed");
  check("and the pin's word from the extension", facts.pinLabel === "Active" && facts.pinNext === "Only");
  check("the pin is named by its view", facts.pinName === "Active");
  check("the pinned count is known to the band", facts.pinnedCount === 2);
}

{
  const revealed = bandFacts(input({ view: "revealed" }));
  check("a revealed view names its own state", revealed.hidden?.label === "Revealed" && revealed.hidden?.next === "Only");
  const only = bandFacts(input({ view: "only" }));
  check("the only view labels the eye Only", only.hidden?.label === "Only");
}

{
  const absent = bandFacts(input({ available: false }));
  check("without the extension the eye is drawn but disabled", absent.hidden !== null && absent.hidden.enabled === false);
  check("and no count is invented for it", absent.hiddenCount === undefined);
}

/* The locked state is the one that matters: it may not say what is hidden. */
{
  const facts = bandFacts(input({ locked: true }));
  check("locked, the band still draws a row", facts.row === true && facts.state === "locked");
  check("with no eye at all", facts.hidden === null);
  check("no word under the pin", facts.pinLabel === null && facts.pinNext === null);
  check("and the pin named by the count alone", facts.pinName === "2");
  check("the pinned count survives the curtain", facts.pinnedCount === 2);

  const leaked = strings(facts).filter((word) => CURTAIN_WORDS.test(word));
  check("nothing it carries names hidden content", leaked.length === 0, leaked.join(", "));

  // Every combination, not just the one the sidebar happens to be in: the view
  // and the pin filter are both set before the lock and must not leak through it.
  const leakedAny = [];
  for (const view of ["hidden", "revealed", "only"]) {
    for (const pinView of ["all", "only", "without"]) {
      const locked = bandFacts(input({ locked: true, view, pinView }));
      for (const word of strings(locked)) {
        if (CURTAIN_WORDS.test(word)) leakedAny.push(`${view}/${pinView}: ${word}`);
      }
      if (locked.pinLabel !== null || locked.hidden !== null) leakedAny.push(`${view}/${pinView}: a hidden fact survived`);
    }
  }
  check("in any view and any pin filter", leakedAny.length === 0, leakedAny.join(", "));
}

/* Collapsed is a fold, not a curtain. */
{
  const facts = bandFacts(input({ collapsed: true }));
  check("a folded band draws no row", facts.row === false && facts.state === "collapsed");
  check("...and no controls", facts.hidden === null && facts.pinLabel === null);
  check("...and still knows the pinned count", facts.pinnedCount === 2);

  const foldedLocked = bandFacts(input({ collapsed: true, locked: true }));
  check("folded and locked, the row is still gone", foldedLocked.row === false && foldedLocked.hidden === null);
}

/* ---------------------------------------------------------------------------
 * The strip at the foot of the sidebar.
 *
 * One strip, in the sidebar rather than a second copy under the band: it reports
 * the same three facts and obeys the same curtain.
 * ------------------------------------------------------------------------- */
const stripInput = (overrides = {}) => ({
  locked: false,
  available: true,
  authority: "extension",
  hiddenCount: 1009,
  enforced: true,
  pinnedCount: 2,
  ...overrides,
});

{
  const strip = statusFacts(stripInput());
  check("open, the strip carries the hidden count", strip.hiddenCount === 1009);
  check("...wears the ENFORCED badge", strip.enforced === true);
  check("...and the pinned count", strip.pinnedCount === 2);

  const revealed = statusFacts(stripInput({ enforced: false }));
  check("a suspended view drops the badge", revealed.enforced === false);
  check("...and keeps the count", revealed.hiddenCount === 1009);

  const absent = statusFacts(stripInput({ available: false, hiddenCount: 0 }));
  check("without the extension the hidden half is not drawn", absent.hiddenCount === null && absent.enforced === false);
  check("...and the pins still are", absent.pinnedCount === 2);
}

{
  const strip = statusFacts(stripInput({ locked: true }));
  check("locked, the count is gone", strip.hiddenCount === null);
  check("...the badge is gone", strip.enforced === false);
  check("...only the pinned count remains", strip.pinnedCount === 2);
  const leaked = strings(strip).filter((word) => CURTAIN_WORDS.test(word));
  check("and nothing it carries names hidden content", leaked.length === 0, leaked.join(", "));
  check(
    "no view can leak through the lock",
    ["hidden", "revealed", "only"].every((view) => statusFacts(stripInput({ locked: true, enforced: view === "hidden" })).enforced === false),
  );
}

/* ---------------------------------------------------------------------------
 * The band component, read.
 *
 * The passcode surface, its place, and the keyboard contract that must survive
 * any restyle of the band.
 * ------------------------------------------------------------------------- */
const source = readFileSync(join(ROOT, "src/components/SidebarBand.svelte"), "utf8");
{
  check("the passcode opens in place, not as a modal", source.includes('id="band-passcode"') && !/role="dialog"/.test(source));
  check(
    "...inside the band, under its row",
    source.indexOf('class="passcode"') > source.indexOf('class="band"') && source.indexOf('class="passcode"') > source.indexOf('class="reveal"'),
  );
  check("the lock says whether it is open", /aria-expanded=\{lockOpen\}/.test(source));
  check("...and points at the surface", /aria-controls=\{lockOpen \? "band-passcode" : undefined\}/.test(source));
  check("Escape closes it from the field and from the pad", /event\.key !== "Escape"/.test(source) && /closePasscode\(true\)/.test(source));
  check("closing hands focus back to the lock", /if \(back\) lockBtn\?\.focus\(\)/.test(source));
  check(
    "a 423 from the adapter opens the same surface",
    /outcome\?\.kind === "reconciled" && outcome\.status === 423/.test(source) && source.includes("openPasscode()"),
  );
  check("the folded band still has its toggle", /aria-expanded=\{!chrome\.bandCollapsed\}/.test(source));
  check("the band is drawn from the one model", /bandFacts\(\{/.test(source));
  // The ring is removed on `animationend`, so under reduced motion it must not be
  // drawn at all — otherwise it stays on the band.
  check("a reduced-motion window gets no pulse", /prefers-reduced-motion: reduce/.test(source) && /mayPulse\(\)/.test(source));
}

/* The sidebar's strip draws from the same model; the sidebar places it. */
const sidebar = readFileSync(join(ROOT, "src/components/Sidebar.svelte"), "utf8");
{
  check("the sidebar strip uses the band's model", /statusFacts\(\{/.test(sidebar));
  check("...and not a rule of its own", !/hiddenCategories\.mode === "strict"/.test(sidebar));
  // The badge names the authority that is enforcing it (a title), so the class
  // word is no longer immediately followed by the text.
  check("the badge says ENFORCED", /class="badge"[^>]*>ENFORCED</.test(sidebar));
  check("the hidden half is drawn only when the model allows it", /strip\.hiddenCount !== null/.test(sidebar));
  check("the pinned count comes from the model too", /strip\.pinnedCount/.test(sidebar));
}

/* ---------------------------------------------------------------------------
 * The component, rendered.
 *
 * `reader` and `chrome` are the app's singletons; here they are two small stubs
 * read through one mutable object, so the same compiled component can be drawn
 * in each state. Everything else — the model, the vocabulary, the option lists —
 * is the real source.
 * ------------------------------------------------------------------------- */
const component = join(GEN_DIR, "SidebarBand.mjs");
const stub = (name, body) => {
  const path = join(GEN_DIR, `${name}.mjs`);
  writeFileSync(path, body);
  return pathToFileURL(path).href;
};

mkdirSync(GEN_DIR, { recursive: true });

let Band;
try {
  const readerStub = stub(
    "reader",
    `export const reader = {
  get hiddenLocked() { return globalThis.__band.locked; },
  get hiddenAvailable() { return globalThis.__band.available; },
  get hiddenAuthority() { return globalThis.__band.authority ?? "extension"; },
  get hiddenView() { return globalThis.__band.view; },
  get hiddenHasPasscode() { return true; },
  get hiddenBusy() { return false; },
  get lockNotice() { return null; },
  get pinnedCount() { return globalThis.__band.pinnedCount; },
  get pinView() { return globalThis.__band.pinView; },
  favorites: { available: true },
  async setHiddenView() { return null; },
  cyclePinView() {},
  async lockHidden() {},
  async unlockHidden() { return false; },
  async setHiddenPasscode() { return false; },
  async loadHiddenState() {},
};
`,
  );
  const chromeStub = stub(
    "chrome",
    `export const chrome = {
  get bandCollapsed() { return globalThis.__band.collapsed; },
  get pinPad() { return false; },
  toggleBand() {},
};
`,
  );
  const pinPadStub = stub("PinPad", "export default function PinPad() {}\n");

  const typescript = {
    script: ({ content, attributes }) => {
      if (attributes.lang !== "ts") return undefined;
      return {
        code: ts.transpileModule(content, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: "SidebarBand.ts",
        }).outputText,
      };
    },
  };

  const preprocessed = await preprocess(source, typescript, { filename: "SidebarBand.svelte" });
  const compiled = compile(preprocessed.code, {
    generate: "server",
    filename: "SidebarBand.svelte",
    dev: false,
  });

  writeFileSync(
    component,
    compiled.js.code
      .replaceAll('"../lib/band"', JSON.stringify(absolute("src/lib/band.ts")))
      .replaceAll('"../lib/pinpad"', JSON.stringify(absolute("src/lib/pinpad.ts")))
      .replaceAll('"../lib/lock-title"', JSON.stringify(absolute("src/lib/lock-title.ts")))
      .replaceAll('"../state/hidden"', JSON.stringify(absolute("src/state/hidden.ts")))
      .replaceAll('"../state/chrome.svelte"', JSON.stringify(chromeStub))
      .replaceAll('"../state/reader.svelte"', JSON.stringify(readerStub))
      .replaceAll('"./PinPad.svelte"', JSON.stringify(pinPadStub)),
  );
  ({ default: Band } = await import(pathToFileURL(component).href));

  const draw = (overrides = {}) => {
    globalThis.__band = {
      collapsed: false,
      locked: false,
      available: true,
      view: "hidden",
      pinnedCount: 2,
      pinView: "all",
      ...overrides,
    };
    return render(Band, {}).body;
  };

  {
    const body = draw();
    check("open: the eye is drawn", body.includes("Hidden categories: Hidden"));
    check("open: ...on the left", body.indexOf('class="ctl hidden') !== -1);
    check("open: the lock is next", body.indexOf('class="ctl lock') > body.indexOf('class="ctl hidden'));
    check("open: ...and the pin on the right", body.indexOf('class="ctl pin') > body.indexOf('class="ctl lock'));
    check("open: the words are drawn", body.includes(">Hidden<") && body.includes(">Active<"));
    check("open: the pin is named by its view", body.includes('aria-label="Pinned: Active"'));
    check("open: the lock offers to lock", body.includes('aria-label="Lock hidden categories"'));
  }

  {
    const body = draw({ view: "revealed" });
    check("revealed: the eye says so", body.includes("Hidden categories: Revealed"));
    check("revealed: ...and offers the next view", body.includes("click for Only"));
  }

  {
    const body = draw({ locked: true });
    check("locked: the row is drawn", /class="band[ "]/.test(body));
    check("locked: ...compacted", body.includes("compact"));
    check("locked: the lock is the way back in", body.includes('aria-label="Unlock"'));
    check("locked: the pin is still there", body.includes('class="ctl pin'));
    check("locked: the pin is named by its count", body.includes('aria-label="Pinned: 2"'));
    check("locked: no eye", !body.includes('class="ctl hidden'));
    check("locked: no count of hidden things", !body.includes("1009"));
    check("locked: no ENFORCED badge", !body.toLowerCase().includes("enforced"));
    check("locked: no label naming hidden content", !/aria-label="[^"]*hidden/i.test(body));
    // `aria-hidden` is a property name, not a word about content: take those off
    // before asking whether anything left says hidden.
    const withoutAriaHidden = body.replace(/aria-hidden="true"/g, "");
    check(
      "locked: nothing on the band says hidden",
      !/hidden/i.test(withoutAriaHidden),
      (withoutAriaHidden.match(/[^<>"]*hidden[^<>"]*/gi) ?? []).join(" | "),
    );
  }

  {
    const body = draw({ collapsed: true });
    check("collapsed: no band row", !/class="band[ "]/.test(body));
    check("collapsed: ...but the way to bring it back", body.includes("Expand sidebar controls"));
    check("collapsed: no controls and nothing to count", !body.includes('class="ctl') && !body.includes("1009"));
  }

  {
    const body = draw({ collapsed: true, locked: true });
    check("collapsed and locked: no band row", !/class="band[ "]/.test(body));
    check("collapsed and locked: no hidden count", !body.includes("1009"));
    check("collapsed and locked: no badge", !body.toLowerCase().includes("enforced"));
  }

  {
    const body = draw({ available: false });
    check("no extension: the eye is drawn but disabled", body.includes('class="ctl hidden') && body.includes("disabled"));
    check("no extension: no badge", !body.includes("ENFORCED"));
  }

  // Without the extension the eye is not a dead control: this device's set is
  // the whole store, so the same three views answer, and the title says where.
  {
    const body = draw({ available: false, authority: "local" });
    const eye = /<button[^>]*class="ctl hidden[^"]*"[^>]*>/.exec(body)?.[0] ?? "";
    check("no extension: the eye still answers, from this device", eye !== "" && !eye.includes("disabled"));
    check("no extension: ...and says so", body.includes("Hidden on this device"));
    check("no extension: the lock offers nothing to lock with", body.includes("disabled"));
  }

  // The starred row is fed by a stream the server's unread-count never mentions,
  // so the number is drawn only when there is one to draw.
  {
    const sidebar = readFileSync(join(ROOT, "src/components/Sidebar.svelte"), "utf8");
    check(
      "the Starred row prints no count the server did not report",
      sidebar.includes("{#if reader.countIfKnown(STATE_STARRED) !== null}"),
    );
  }
} finally {
  rmSync(GEN_DIR, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
