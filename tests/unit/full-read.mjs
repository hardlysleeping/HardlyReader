// Full reader mode: one article, fetched from the publisher on demand.
//
// The global extraction preference fetches every post that has a link; this is
// the same fetch behind a button, for one article at a time. These checks guard
// the parts a click cannot show: that it works with the preference off, that a
// late page cannot land on the next article, and that nothing it does can cost
// the reader the text the feed already sent.
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

const pane = read("src/components/ReaderPane.svelte");
const extract = read("src/lib/extract.ts");

const button = pane.slice(pane.indexOf('class="icon full"'), pane.indexOf("</button>", pane.indexOf('class="icon full"')));

check("the button is in the article toolbar", /header class="toolbar"/.test(pane) && pane.indexOf('class="icon full"') > pane.indexOf('class="toolbar"'));
check("it is only offered for a page that can be fetched", /\{#if link && canExtract\(link\)\}/.test(pane));
check("it says what pressing it does, both ways", /aria-label=\{manualActive \? "Show what the feed sent" : "Load the full article"\}/.test(pane));
check("it is a toggle, not a one-way switch", /manualActive \? dropFullArticle\(\) : void loadFullArticle\(\)/.test(button));
check("it reads as pressed while the full text is up", /aria-pressed=\{manualActive\}/.test(button) && /class:on=\{manualActive\}/.test(button));

// The fetch is the pane's, and it does not consult the account-wide preference:
// asking for this article is the whole point, whatever the setting says.
check("it fetches this article's own link", /await extractFor\(id, link\)/.test(pane));
check("it does not touch the global preference", !/reading\.extract\s*=/.test(pane) && !/toggleExtract/.test(pane));

// Landing rules: the result is keyed to the id that asked for it, and a change
// of article starts clean.
check("the result is tagged with the article it came from", /manualId = id;/.test(pane) && /const manualActive = \$derived\(manualId !== null && manualId === item\?\.id/.test(pane));
check("a late page is dropped", /if \(item\?\.id !== id\) return;/.test(pane));
check("moving on forgets the last one", /if \(current === manualId\) return;/.test(pane) && /manualBody = null;/.test(pane));

// A paywall stub is not a full article, and the feed's version is never lost.
check("a thin extraction is refused", /chooseBody\(result, feedBody\)\.source !== "article"/.test(pane));
check("the feed's text is still the fallback", /const body = \$derived\(sanitizeArticle\(chooseBody\(extractedNow, feedBody\)\.html\)\)/.test(pane));
check("a refusal is visible rather than silent", /no full article/.test(pane) && /role="status"/.test(pane));
check("and it can be retried", /class="retry"[\s\S]{0,200}loadFullArticle\(\)/.test(pane));

// The building blocks it reuses are the extractor's, not new ones.
check("the extractor still owns the policy", /export function chooseBody/.test(extract) && /export async function extractFor/.test(extract));

// The star in the article's toolbar is the one mark drawn smaller than its own
// box: ★ at the row's 13px reads as a speck beside ● and ⇣. It gets a bigger
// glyph and a wider box, and the row's height does not move with it.
{
  const star = /\.star \{[^}]*\}/.exec(pane)?.[0] ?? "";
  const icon = /\.icon \{[^}]*\}/.exec(pane)?.[0] ?? "";
  const size = (rule) => Number(/(?:^|;|\s)font-size: (\d+)px/.exec(rule)?.[1] ?? 0);
  check("the star is drawn larger than the toolbar's own type", size(star) > size(icon) && size(star) >= 17, `${size(star)} against ${size(icon)}`);
  check("its box is wider than the 28px the other marks get", /min-width: 32px/.test(star) && /\.icon \{[^}]*min-width: 28px/.test(icon));
  check("and the row's height is not its business", !/height:/.test(star), star);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
