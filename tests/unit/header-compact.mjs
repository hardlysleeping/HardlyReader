// The header has one job in a narrow window: stay inside it. Everything that
// does not fit moves into the menu behind the hamburger, and nothing is lost —
// these checks guard both halves of that sentence.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const header = read("src/components/Header.svelte");
const themePanel = read("src/components/ThemePanel.svelte");
const readingControls = read("src/components/ReadingControls.svelte");
const app = read("src/app.css");
const main = read("src/views/Main.svelte");

// The menu carries what the bar gives up, plus the two things it always did.
// Checked by what each row *does*, because the visible labels are written inside
// the markup (and one of them is a conditional), not as plain text.
const menu = header.slice(header.indexOf('class="sheet"'), header.indexOf("</div>\n  </div>"));
check("the menu opens the feeds", /ontogglesidebar\?\.\(\)/.test(menu));
check("the menu opens reading", /readingControls\?\.openPanel\(\)/.test(menu));
check("the menu opens settings", /themePanel\?\.openSettings\(\)/.test(menu));
// The row is always in the markup and hidden by the media query when the bar has
// the name to press; only the no-name case is gated in JS, because then the menu
// is the only way out.
check("the menu can sign out when the name is not there to press", /class:narrow-only=\{!!subtitle\}[\s\S]{0,120}onsignout\?\.\(\)/.test(menu));
check("the menu's sign out is not gated twice", !/\{#if narrow/.test(menu));
check("sync is not in the menu — it never leaves the bar", !/Sync now/.test(menu) && !/void refresh\(\)/.test(menu));
// Five menu actions in the written markup: four in the drawer (Feeds, Reading,
// Settings, Sign out) and the account sheet's own Sign out.
check("five menu actions in total", (menu.match(/role="menuitem"/g) ?? []).length === 5, String((menu.match(/role="menuitem"/g) ?? []).length));
// Two ways to sign out is clutter; none is worse. One media query decides, so
// there is no second copy of the breakpoint to drift away from it.
check("the breakpoint exists once, in CSS", !/matchMedia\(/.test(header) && /@media \(max-width: 560px\)/.test(header));
check("wide bars do not repeat the menu's sign out", /@media \(min-width: 561px\)\s*\{[\s\S]{0,120}narrow-only/.test(header));

// Sign out hangs off the name at full width, and the name is not a permanent
// button of its own: nothing in the bar signs out until it is pressed.
const account = header.slice(header.indexOf('class="account"'), header.indexOf('class="spacer"'));
check("the name is the account's handle", /class="who"/.test(account) && /aria-haspopup="menu"/.test(account));
check("sign out lives behind the name", /onsignout\?\.\(\)/.test(account));
check("the name shrinks before it pushes", /max-width: 150px/.test(header) && /text-overflow: ellipsis/.test(header));

// Sync is outside the tools group, so the compact rules cannot hide it.
const tools = header.slice(header.indexOf('class="tools"'), header.indexOf("</span>", header.indexOf('class="tools"')));
check("sync is not part of the group that hides", !/class="sync"/.test(tools));
check("the menu opens by the hamburger", /class="icon menu"/.test(header) && /aria-haspopup="menu"/.test(header));

// Opening a panel from a menu row needs the panels to take orders.
// Two panels hang from one bar. Each covers the other when both are up, so
// opening either shuts the other on the way open — the header only relays the
// news, since each panel owns its own open state.
check(
  "the Aa panel shuts the settings panel as it opens, from the button and from the menu",
  /onopen\?: \(\) => void/.test(readingControls) &&
    /function toggle\(\): void \{\s*open = !open;\s*if \(open\) onopen\?\.\(\);/.test(readingControls) &&
    /export function openPanel\(\) \{\s*open = true;\s*onopen\?\.\(\);/.test(readingControls) &&
    /export function closePanel\(\)/.test(readingControls),
);
check(
  "the settings panel shuts the Aa panel as it opens, likewise",
  /onopen\?: \(\) => void/.test(themePanel) &&
    /function toggleSettings\(\): void \{\s*open = !open;\s*if \(open\) onopen\?\.\(\);/.test(themePanel) &&
    /export function openSettings\(\) \{[^}]*onopen\?\.\(\);/.test(themePanel) &&
    /export function closeSettings\(\)/.test(themePanel),
);
check(
  "and the header wires each to the other",
  /onopen=\{\(\) => themePanel\?\.closeSettings\(\)\}/.test(header) &&
    /onopen=\{\(\) => readingControls\?\.closePanel\(\)\}/.test(header),
);
check("settings can be opened from outside", /export function openSettings\(\)/.test(themePanel));
check("reading can be opened from outside", /export function openPanel\(\)/.test(readingControls));

// Compact rules: exactly the controls that do not fit are the ones that go —
// the triggers, never the panels they open.
const compact = header.slice(header.indexOf("@media (max-width: 560px)"));
check("the name goes when compact", /\.account,/.test(compact));
check("the bar-sized controls go when compact", /\.tools > :global\(\.reading\)/.test(compact) && /\.tools > :global\(\.themebar\)/.test(compact));
check("but the group holding the panels is not hidden", !/\.tools\s*{[^}]*display:\s*none/.test(compact), compact.slice(0, 400));
// The cap is the room the window has, less the bar it hangs under — so a tall
// window shows the whole tab and a phone still gets a panel that fits on screen.
check("so a menu row can still open settings on a phone", /role="dialog"/.test(themePanel) && /max-height:\s*calc\(100vh - 68px\)/.test(themePanel));
check("the settings popup keeps its tabs in reach", /position:\s*sticky/.test(themePanel));
check("the menu button survives the compact rules", !/\.menu\s*{[^}]*display:\s*none/.test(compact));

// No horizontal scrolling, by construction.
check("the page cannot scroll sideways", /overflow-x:\s*hidden/.test(app));
check("scrollbars are slim everywhere", /scrollbar-width:\s*thin/.test(app));
check("the reading popup is capped, not window-height", /max-height:\s*min\(72vh, 460px\)/.test(read("src/components/ReadingControls.svelte")));
check("the pane container clips instead of scrolling", /overflow-x:\s*clip/.test(main));


// The bar carries the app's own tools and nothing else. The window's minimize and
// maximize were drawn here once, on the theory that a title bar owns them; a bar
// that is not the real title bar drew two buttons that looked like furniture and
// did what the window manager already does, so they are gone — the GNOME title
// bar above is the one that moves, minimizes and closes this window.
check(
  "the bar carries no window buttons of its own",
  !/winbtn|wincontrols/.test(header) &&
    !/minimizeWindow|toggleMaximizeWindow|watchMaximized/.test(header) &&
    !/aria-label="Minimize"/.test(header),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
