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
const accountsPanel = read("src/components/AccountsPanel.svelte");
// The rows themselves live in `AccountsBody`, the frame the settings sheet mounts too.
const accountsBody = read("src/components/AccountsBody.svelte");
const app = read("src/app.css");
const main = read("src/views/Main.svelte");

// The menu carries what the bar gives up. Accounts is a row here because the
// name it hangs off is gone below 660px — and the panel it opens is the only
// place switching, adding and signing out live, at every width. Checked by what
// each row *does*, because the visible labels are written inside the markup.
const menuStart = header.indexOf('class="sheet"');
const menu = header.slice(menuStart, header.indexOf("</div>", menuStart));
check("the menu opens the feeds", /ontogglesidebar\?\.\(\)/.test(menu));
check("the menu opens reading", /readingControls\?\.openPanel\(\)/.test(menu));
// Settings from the menu is the settings panel — the sheet a phone can use —
// rather than the 268px popover the gear draws on a desktop.
check(
  "the menu opens the settings panel",
  /pick\(openSettings\)/.test(menu) &&
    /function openSettings\(\): void \{[\s\S]{0,160}?settingsOpen = true;/.test(header),
);
check("and settings can be opened from the popover's own door", /onallsettings=\{openSettings\}/.test(header));
check("the menu opens the account panel", /accountsPanel\?\.openAccounts\(\)/.test(menu));
// One sign out in the app, in the account rows: a second row here would be the
// same control twice, and the two could disagree about who is signed in.
check("the menu does not keep a sign out of its own", !/onsignout/.test(menu));
check("sync is not in the menu — it never leaves the bar", !/Sync now/.test(menu) && !/void refresh\(\)/.test(menu));
// Four menu actions in the written markup: Feeds, Reading, Settings, Accounts.
check("four menu actions in total", (menu.match(/role="menuitem"/g) ?? []).length === 4, String((menu.match(/role="menuitem"/g) ?? []).length));
// The rows are one component mounted by two frames — the bar's panel and the
// settings sheet — so add, switch and sign out cannot drift apart.
check(
  "the account rows are one component, mounted by both frames",
  /<AccountsBody[\s\S]{0,200}?onsignout=/.test(read("src/components/AccountsPanel.svelte")) &&
    /<AccountsBody[\s\S]{0,200}?onsignout=/.test(read("src/components/SettingsPanel.svelte")),
);
check("the breakpoint exists once, in CSS", !/matchMedia\(/.test(header) && /@media \(max-width: 560px\)/.test(header));
// The account block — name and server address — is ellipsised, so a bar too
// narrow for it did not break: it showed `hardlyrea…`. It leaves at 660, which
// is where both strings fit whole (measured: nothing is cut from ~650 up), and
// the panel is a sibling of that block rather than a child, so the menu's row
// still opens it there instead of opening a fixed box inside `display: none`.
check("the account leaves the bar where it stops fitting", /@media \(max-width: 660px\)\s*\{\s*\.account\s*\{\s*display: none;/.test(accountsPanel));
check("and the switch stays in the bar there", !/@media \(max-width: 660px\)[\s\S]{0,200}\.switch/.test(header));
check("the panel is not inside the block that hides", /\.panel\s*\{[^}]*position:\s*fixed/.test(accountsPanel));

// The name is the account's handle at full width, and it is not a permanent
// button of its own: nothing in the bar switches account or signs out until it
// is pressed.
check("the name is the account's handle", /class="who"/.test(accountsPanel) && /aria-haspopup="dialog"/.test(accountsPanel));
check("the account panel holds the actions", /onsignout\?\.\(\)/.test(accountsPanel) && /onaddaccount\?\.\(\)/.test(accountsPanel));
check(
  "the panel is the account list, switching and removing included",
  /accounts\.rows/.test(accountsBody) && /accounts\.switchTo\(/.test(accountsBody) && /accounts\.remove\(/.test(accountsBody),
);
// The one thing in the panel that cannot be undone without the API password says
// what it does, every time it is open.
check("and says what removing an account does", /Removing an account forgets its sign-in/.test(accountsBody));
check("one remove control, and every row has it", /class="row"[\s\S]*class="remove"[\s\S]*\{\/each\}/.test(accountsBody) && (accountsBody.match(/class="remove"/g) ?? []).length === 1);
check("the name shrinks before it pushes", /max-width: 150px/.test(accountsPanel) && /text-overflow: ellipsis/.test(accountsPanel));
check("the panel takes orders from the menu", /export function openAccounts\(\)/.test(accountsPanel));

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
check(
  "the name goes long before compact does",
  (() => {
    const account = Number((accountsPanel.match(/@media \(max-width: (\d+)px\)/) ?? [])[1]);
    const bar = Number((header.match(/@media \(max-width: (\d+)px\)\s*\{\s*\.bar/) ?? [])[1]);
    return account === 660 && account > bar;
  })(),
);
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

// A popover takes the press that lands outside it. Both panels are dialogs with
// no scrim, so without this a tap on the article behind them left them open over
// whatever had just been pressed — and their own trigger must still toggle.
for (const [name, source] of [["settings", themePanel], ["reading", readingControls], ["accounts", accountsPanel]]) {
  check(
    `${name} closes on a press elsewhere`,
    /window\.addEventListener\("pointerdown", onDown, true\)/.test(source) &&
      /contains\(target\)/.test(source) &&
      /removeEventListener\("pointerdown", onDown, true\)/.test(source),
  );
  check(
    `${name}'s own trigger is exempt, so it still toggles`,
    /if \(panelEl\?\.contains\(target\) \|\| (gearEl|moreEl|whoEl)\?\.contains\(target\)\) return;/.test(source),
  );
  check(`${name} has its panel bound for the containment test`, /class="panel"[^>]*bind:this=\{panelEl\}/.test(source));
}
check("settings also closes on Escape", /event\.key === "Escape"\) open = false/.test(themePanel));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
