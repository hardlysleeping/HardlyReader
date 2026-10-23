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
check("the menu can sign out", /onsignout\?\.\(\)/.test(menu));
check("sync is not in the menu — it never leaves the bar", () =>
  !/Sync now/.test(menu) && !/void refresh\(\)/.test(menu));
check("five rows, one per door", (menu.match(/role="menuitem"/g) ?? []).length === 5, String((menu.match(/role="menuitem"/g) ?? []).length));

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
check("settings can be opened from outside", /export function openSettings\(\)/.test(themePanel));
check("reading can be opened from outside", /export function openPanel\(\)/.test(readingControls));

// Compact rules: exactly the controls that do not fit are the ones that go.
const compact = header.slice(header.indexOf("@media (max-width: 560px)"));
for (const selector of [".account", ".tools"]) {
  check(`${selector} is hidden when compact`, compact.includes(selector));
}
check("the menu button survives the compact rules", !/\.menu\s*{[^}]*display:\s*none/.test(compact));

// No horizontal scrolling, by construction.
check("the page cannot scroll sideways", /overflow-x:\s*hidden/.test(app));
check("scrollbars are slim everywhere", /scrollbar-width:\s*thin/.test(app));
check("the reading popup is capped, not window-height", /max-height:\s*min\(72vh, 460px\)/.test(read("src/components/ReadingControls.svelte")));
check("the pane container clips instead of scrolling", /overflow-x:\s*clip/.test(main));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
