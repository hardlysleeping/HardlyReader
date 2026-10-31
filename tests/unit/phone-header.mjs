// The phone's bar: three depths, one step out, and one door to everything else.
//
//   node --experimental-strip-types --import ./register-ts.mjs phone-header.mjs
//
// `.svelte` files are checked by what their markup and their script say, the way
// `header-compact.mjs` checks the desktop bar: the component is compiled by Vite
// in the app and by nothing here, so a check that renders it would be a second
// toolchain rather than a test of this one. What is asserted is the part that
// would silently break — which control sits at which depth, that the step out is
// the *shared* `mobileNav.back()` rather than a local answer, that Sync is the
// reader's own `refresh()`, and that every pixel of the safe area lands on an
// edge of a phone and on nothing else.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/** The slice of `source` from `start` to the next `end`, or "" if either is gone. */
function between(source, start, end) {
  const from = source.indexOf(start);
  if (from < 0) return "";
  const to = source.indexOf(end, from + start.length);
  return to < 0 ? "" : source.slice(from, to);
}

const header = read("src/components/PhoneHeader.svelte");
const desktopHeader = read("src/components/Header.svelte");
const main = read("src/views/Main.svelte");
const app = read("src/app.css");
const stack = read("src/components/MobilePaneStack.svelte");
const settings = read("src/components/SettingsPanel.svelte");
const pinPad = read("src/components/PinPad.svelte");

/* ---------------------------------------------------------------- *
 * One navigation authority
 * ---------------------------------------------------------------- */

// The bar is a view of the stores, not a second copy of them: the same nav
// module, the same reader, and no state of its own about where you are.
check(
  "the bar reads the one nav store",
  /import \{ mobileNav, slidesInPortrait \} from "\.\.\/state\/mobile-nav\.svelte"/.test(header),
);
check("and the one reader store", /import \{ reader \} from "\.\.\/state\/reader\.svelte"/.test(header));
check(
  "the step out is the shared back(), not a local decision",
  /function back\(\): void \{[\s\S]{0,600}?const step = mobileNav\.back\(\);/.test(header),
);
check("and the article is closed by the reader, as everywhere else", /step === "article"[\s\S]{0,80}?reader\.closeReader\(\)/.test(header));
check("the left control calls that one function", /onclick=\{back\}/.test(header));
// At the root of the stack `back()` says `app`; the step outward there is the
// pane behind, which is the right-swipe's own move — so the header asks for it
// rather than doing nothing or inventing a second path.
check(
  "the root of a depth opens the pane behind",
  /step === "app"\) mobileNav\.openPrevious\(\)/.test(header),
);
check(
  "the bar keeps no navigation state of its own",
  !/\$state<(1|2|3|BasePane|OverlayPane)/.test(header) && !/basePane\s*=(?!=)/.test(header),
);
// One instance, one module: the header and the stack are looking at the same
// object, so "identity-equal handlers" is a property of the imports rather than
// a promise in a comment.
check(
  "the header and the stack hold the same nav object",
  /from "\.\.\/state\/mobile-nav\.svelte"/.test(stack) &&
    !/new MobileNavState/.test(header + stack + main) &&
    (read("src/state/mobile-nav.svelte.ts").match(/export const mobileNav = new MobileNavState\(\)/g) ?? [])
      .length === 1,
);

/* ---------------------------------------------------------------- *
 * The three depths
 * ---------------------------------------------------------------- */

const feedDepth = between(header, "{#if atRoot}", "{:else}");
check("the feeds depth draws the wordmark", /class="wordmark">HardlyReader</.test(feedDepth));
check("and no control to its left", !/class="step"/.test(feedDepth) && !/onclick=\{back\}/.test(feedDepth));

const deeper = between(header, "{:else}", "</header>");
check("every deeper level draws the step out", /class="step"[\s\S]{0,240}?onclick=\{back\}/.test(deeper));
check("the step out names its destination, visibly", /<span class="chev"[^>]*>‹<\/span>\s*<span class="back-to">\{backTo\}<\/span>/.test(deeper));
check(
  "and says the same thing to a screen reader",
  /aria-label=\{`Back to the \$\{backTo\.toLowerCase\(\)\}`\}/.test(deeper),
);

// The root is "nothing behind this pane", which is a different question from
// "how many layers does the stack have": the feeds slid over the posts are
// depth 1 and still have somewhere to go back to. Asking the depth alone made
// that state draw the wordmark with no way out.
check("the root is asked of the nav, not of the depth", /const atRoot = \$derived\(slideStack \? mobileNav\.depth === 0 : depth === 1\)/.test(header));
check("the wordmark is drawn only there", /#if atRoot/.test(header));

// Posts → Feeds, Article → Posts, and a pane slid over another → the pane it was
// slid over. The walk's one step is the feeds, because in one column there is no
// posts pane to have come from.
check("the walk goes back to the feeds", /if \(!slideStack\) return "Feeds";/.test(header));
check(
  "an overlay goes back to the pane underneath it",
  /overlayPane !== null\) return mobileNav\.basePane === 3 \? "Article" : "Posts"/.test(header),
);
check("and with nothing over it, the article's step is the posts", /Nothing over the base[\s\S]{0,120}?return "Posts";/.test(header));

// The title names the pane you are in: the feeds when they are slid over the
// list, the stream (category or filter) at the posts depth, the post at the
// article depth.
check("the feeds slid over the list are titled Feeds", /if \(slideStack && mobileNav\.overlayPane === 1\) return "Feeds";/.test(header));
check(
  "the title is where you are, not where you came from",
  /return depth === 3 \? \(reader\.selected\?\.title \?\? reader\.activeTitle\) : reader\.activeTitle;/.test(header),
);
check("and it is drawn once, clipped rather than wrapped", /<span class="where" title=\{title\}>\{title\}<\/span>/.test(deeper) && /\.where \{[^}]*text-overflow: ellipsis/.test(header));
// The title is a name, not a transition: it changes with the pane in one frame.
// The slide belongs to the layers (`MobilePaneStack`, on `layout.motion`).
check(
  "the title changes without animating",
  !/\.where \{[^}]*transition/.test(header) && !/\.where \{[^}]*animation/.test(header),
);

// 36px of visible bar, plus the status bar's own height — which `app.css` pays
// as padding, so the surface behind the clock is still the header's. It was 42,
// which is a desktop toolbar's height; on a phone that reads as a gap between
// the clock and the app rather than as a bar.
// The bar's top edge has to land *below* the clock, not on it. The inset is
// paid minus `--status-lift`, declared once on the root: at 24 of a 62pt inset
// the bar's top row was the clock's last row and the status bar clipped its
// hairline. 18 leaves 6px of air — a margin, not a band.
check(
  "the bar clears the status bar by a hair, not by a band",
  /--status-lift: 18px;/.test(app) && (app.match(/--status-lift:/g) ?? []).length === 1,
);

check(
  "the visible height is 36px",
  // Measured from where the padding puts it: the bar rides `--status-lift`
  // higher than the raw inset, and its height has to agree or `overflow: hidden`
  // clips it.
  /height: calc\(max\(0px, calc\(var\(--safe-top\) - var\(--status-lift\)\)\) \+ 36px\)/.test(header),
);

/* ---------------------------------------------------------------- *
 * Sync, and the door to everything else
 * ---------------------------------------------------------------- */

const sync = between(header, 'class="sync"', "</button>");
check("Sync is the reader's own refresh", /async function refresh\(\) \{\s*await reader\.refresh\(\);\s*\}/.test(header) && /onclick=\{refresh\}/.test(sync));
check(
  "there is no second sync path",
  !/from "\.\.\/api\//.test(header) && !/\bfetch\(/.test(header) && !/transport/.test(header),
);
check("Sync keeps its two arrows", (sync.match(/<path /g) ?? []).length === 5, String((sync.match(/<path /g) ?? []).length));
check("...and answers a finished sync with a tick, not a stopped spinner", /#if justFinished[\s\S]{0,200}?class="glyph tick"/.test(header));
check("...which names itself when it lands", /justFinished \? "Synced" : description/.test(header));
check("...and pulses the bar, as the desktop bar does", /class="pulse"/.test(header) && /hrs-bar-pulse/.test(header));
check("no turning arrows on the phone bar", !/animation: turn/.test(header));
check("and its progress readout", /role="progressbar"[\s\S]{0,200}?syncReadout\(reader\.sync\)/.test(header) || /const readout = \$derived\(syncReadout\(reader\.sync\)\)/.test(header) && /role="progressbar"/.test(header));
check("Sync is the trailing control", /<\/button>\s*<\/header>/.test(header) && !/class="step"|class="more"/.test(sync));

const more = between(header, 'class="more"', "</button>");
check("the gear is the app's settings door", /class="gear"/.test(more) && /settingsOpen = true/.test(more));
// The comment above the button still names the glyph it replaced, which is where
// the reason belongs; what must not draw it is the bar itself.
check(
  "...and no longer a •••, which a phone uses for more of the same row",
  !between(header, "<header", "</header>").includes("•••"),
);
check(
  "the bar is the three controls that move you, and nothing else",
  /class="more"/.test(header) && !/<ThemeToggle/.test(header),
);

// The two settings a reader reaches for while reading are in the bar, not two
// levels down in the sheet: the arrangement, and the text.
check("the bar carries the arrangement switch", /\{#if controls\}\s*\{@render controls\(\)\}\s*\{\/if\}/.test(header));
check("...passed in by the view, not imported", /controls\?: Snippet/.test(header) && /<PhoneHeader[\s\S]{0,300}?controls=\{layoutSwitch\}/.test(main));
check("and the Aa panel opens from it", /<ReadingControls bind:this=\{readingControls\}/.test(header));
check("...closing the sheet on its way open", /onopen=\{\(\) => \(settingsOpen = false\)\}/.test(header));
check(
  "the Aa panel clears the bar it opens under",
  /--rc-panel-top: calc\(max\(0px, calc\(var\(--safe-top\) - var\(--status-lift\)\)\) \+ 40px\)/.test(app) &&
    /top: var\(--rc-panel-top, 46px\)/.test(read("src/components/ReadingControls.svelte")),
);
// The panel is fixed and mounted inside the bar, and a phone's bar is
// `overflow: hidden` with a `backdrop-filter` material — which makes the bar the
// containing block for its fixed children, so the panel was positioned against
// the bar and clipped to its 74px: it measured in the right place, painted
// nothing, and every point inside its rect hit the list underneath. It is moved
// into `body` on mount instead.
check(
  "...and it is moved out of the bar, because the bar clips what is fixed inside it",
  /use:portal/.test(read("src/components/ReadingControls.svelte")) &&
    /document\.body\.appendChild\(node\)/.test(read("src/components/ReadingControls.svelte")) &&
    /overflow: hidden/.test(header),
);
// One component, two bars: 36px on a phone and 42px in a window, so the panel's
// place cannot be one number. 46 is the window's 42 + 4 of breath; a phone
// overrides it on the root, where a portaled panel still inherits it.
check(
  "...and the window's bar keeps its own 4px breath under 42px",
  /height: 42px;\s*flex: 0 0 42px;/.test(desktopHeader) && !/--rc-panel-top/.test(desktopHeader),
);
check(
  "...the same switch the sidebar draws beside the search field",
  /import ThemeToggle from "\.\/ThemeToggle\.svelte"/.test(read("src/components/Sidebar.svelte")) &&
    /\{#if phoneSidebar\}\s*<ThemeToggle size=\{30\} \/>/.test(read("src/components/Sidebar.svelte")),
);
check("it is announced as opening a dialog", /aria-haspopup="dialog"/.test(more));
check("and it opens the consolidated sheet", /bind:open=\{settingsOpen\}/.test(header) && /<SettingsPanel/.test(header));
check(
  "the same settings component the desktop bar mounts",
  /import SettingsPanel from "\.\/SettingsPanel\.svelte"/.test(header) &&
    /import SettingsPanel from "\.\/SettingsPanel\.svelte"/.test(desktopHeader),
);
check(
  "with the same account contract",
  /<SettingsPanel[\s\S]{0,200}?name=\{subtitle\}[\s\S]{0,120}?\{onaddaccount\}[\s\S]{0,80}?\{onsignout\}/.test(header),
);
check("no new menu and no second panel", !/role="menu"/.test(header));

/* ---------------------------------------------------------------- *
 * Mounted on a phone, and only there
 * ---------------------------------------------------------------- */

check(
  "Main mounts it behind the device check",
  /\{#if layout\.device === "phone"\}\s*<PhoneHeader[\s\S]{0,200}?\{:else\}\s*<Header/.test(main),
);
check("the desktop bar does not know about phones", !/PhoneHeader|data-device|device === "phone"/.test(desktopHeader));
check("and the phone's own controls are not part of the desktop bar", !/PhoneHeader/.test(desktopHeader) && !/ThemeToggle size=/.test(desktopHeader));
// One back strip per screen: on a phone the bar above is the strip, so the
// one-column crumb row is not drawn there. Desktop keeps it.
check("the phone draws no second back strip", /mode === 1 && level !== "feeds" && layout\.device !== "phone"/.test(main));
check("but the crumb row still exists for a desktop column", /class="crumbs"/.test(main));

/* ---------------------------------------------------------------- *
 * The safe area, on the edges
 * ---------------------------------------------------------------- */

// The rectangle first: `#app` must not inset the app any more, or the edges
// below would pay every inset twice and produce the band this task removes.
check(
  "the app is no longer one inset rectangle",
  (() => {
    const block = app.match(/^#app \{[\s\S]*?\}/m)?.[0] ?? "";
    // The page owns the inset colour now (`background`), but `#app` must still
    // pay no padding: one rectangle inside another doubles every inset.
    return /height: 100%;/.test(block) && !/padding/.test(block);
  })(),
);
check(
  "a phone's shell is the dynamic viewport, edge to edge",
  /html\[data-device="phone"\] #app \{\s*height: 100dvh;\s*padding: 0;\s*\}/.test(app),
);
check(
  "the header takes its own top and sides",
  /html\[data-device="phone"\] \.phone-header \{\s*\/\*[\s\S]{0,400}?\*\/\s*padding-top: max\(0px, calc\(var\(--safe-top\) - var\(--status-lift\)\)\);\s*padding-left: max\(10px, var\(--safe-left\)\);\s*padding-right: max\(10px, var\(--safe-right\)\);/.test(
    app,
  ),
);
check(
  "the stack's content clears the home indicator",
  // ...and it clears it in the counts row, like the grid: the layer reaches the
  // glass and the last row pays the inset, so the two presentations agree.
  /html\[data-device="phone"\] \.stack-scroller \{\s*padding-bottom: 0;\s*\}/.test(app),
);
check("and the stack carries that class", /class="layer stack-scroller"/.test(stack));
check(
  "landscape insets only the outermost columns",
  /@media \(orientation: landscape\) \{\s*html\[data-device="phone"\] \.panes > \.slot\.feeds \{\s*padding-left: var\(--safe-left\);\s*\}\s*html\[data-device="phone"\] \.panes > \.slot\.article \{\s*padding-right: var\(--safe-right\);\s*\}/.test(
    app,
  ),
);
check(
  "and the bottom of every pane, not of the container it is measured from",
  // The panes run to the glass: the inset is paid by the last row of the feeds
  // column (`.status`), and the list and the article stop at the edge.
  /html\[data-device="phone"\] \.panes > \.slot\.feeds,\s*html\[data-device="phone"\] \.panes > \.slot\.posts,\s*html\[data-device="phone"\] \.panes > \.slot\.article \{\s*padding-bottom: 0;/.test(
    app,
  ) &&
    // The stack is the phone's own presentation: it used to keep an 80px band
    // under the words while the grid had none.
    /html\[data-device="phone"\] \.stack-scroller \{\s*padding-bottom: 0;/.test(app),
);
// One source of numbers: the tokens are the only place `env()` is read.
check(
  "the insets are declared once",
  (app.match(/--safe-(top|right|bottom|left): env\(safe-area-inset-/g) ?? []).length === 4,
);
check("the settings sheet reads the token", /padding-top: max\(12px, var\(--safe-top\)\);/.test(settings) && !/env\(safe-area/.test(settings));
check("the pin pad reads the token", /padding-bottom: var\(--safe-bottom\);/.test(pinPad) && !/env\(safe-area/.test(pinPad));
// And nothing written for the phone is written for anything else.
check("no phone rule is unscoped", !/^\.phone-header \{/m.test(app) && !/^\.stack-scroller \{/m.test(app));

check(
  "landscape reserves nothing above the bar",
  /@media \(orientation: landscape\) \{\s*html\[data-device="phone"\] \.phone-header \{\s*padding-top: 0;/.test(app) &&
    /@media \(orientation: landscape\) \{\s*\.phone-header \{\s*height: 36px;/.test(header),
);
check(
  "and the idle loading line takes no room on a phone",
  /html\[data-device="phone"\] \.aura:not\(\.on\):not\(\.syncing\) \{[\s\S]{0,200}?height: 0;/.test(app),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
