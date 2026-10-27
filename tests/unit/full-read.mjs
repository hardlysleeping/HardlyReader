// Full reader mode: one article, fetched from the publisher on demand.
//
// The account-wide extraction preference fetches every post that has a link;
// this is the same fetch behind a button, for one article at a time — in both
// directions, because "give me what the feed sent" is the other half of "give me
// the article". These checks guard the parts a click cannot show: that it works
// with the preference off, that the choice belongs to one entry and outlives the
// next post, that a late page cannot land on the next article, and that nothing
// it does can cost the reader the text the feed already sent.
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
const inline = read("src/components/InlineArticle.svelte");
const extract = read("src/lib/extract.ts");
const ledger = read("src/lib/extract-ledger.ts");

const button = pane.slice(pane.indexOf('class="icon full"'), pane.indexOf("</button>", pane.indexOf('class="icon full"')));

check("the button is in the article toolbar", /header class="toolbar"/.test(pane) && pane.indexOf('class="icon full"') > pane.indexOf('class="toolbar"'));
check("it is only offered for a page that can be fetched", /\{#if link && canExtract\(link\)\}/.test(pane));
check("it says what pressing it does, both ways", /aria-label=\{showingArticle \? "Show what the feed sent" : "Load the full article"\}/.test(button));
check("it reads as pressed while the full text is up", /aria-pressed=\{showingArticle\}/.test(button) && /class:on=\{showingArticle\}/.test(button));
check("it shows that a page is being fetched", /aria-busy=\{fetching\}/.test(button) && /\{fetching \? "⋯" : "¶"\}/.test(button));
check("one press path, whichever way it goes", /onclick=\{\(\) => void toggleReading\(\)\}/.test(button));

// The two directions of the override.
check("a press on the article asks for the feed's text", /if \(showingArticle\) \{\s*setChoice\("feed"\);\s*return;\s*\}/.test(pane));
check("a press on the feed fetches the page", /extractFor\(id, link, \{ force: true \}\)/.test(pane));
check("and only an arrived article is remembered as the choice", /setChoice\("article"\);/.test(pane) && pane.indexOf('setChoice("article")') > pane.indexOf("refused = true"));

// The choice is one entry's, and it is the ledger's.
check("the choice is written by one function", /function setChoice\(next: BodyChoice \| null\): void/.test(pane));
check("writing it remembers it against the entry", /ledger\.remember\(id, next\)/.test(pane));
check("clearing it forgets the entry", /ledger\.forget\(id\)/.test(pane));
check("moving to another post reads that post's own choice", /choice = current === null \? null : ledger\.choice\(current\)/.test(pane));
check("the ledger stores choices by entry id", /choices\[entryId\] = \{ choice, at: now \}/.test(ledger));
check("and keeps them under the one documented key", /hardlyreader\.extract\.v1/.test(ledger));
check("a choice only ever has two values", /export type BodyChoice = "feed" \| "article";/.test(ledger));

// The automatic fetch is the account's, the override's, and never a page the
// ledger has parked.
check("the pane asks for a page when the account or this post wants one", /const wanted = \(reading\.extract \|\| choice === "article"\) && choice !== "feed";/.test(pane));
check("an automatic fetch goes through the ledger", /void extractFor\(id, url\)\.then/.test(pane));
check("a parked page is not asked again without a press", /if \(!options\.force && ledger\.parked\(url\)\) return null;/.test(extract));
check("a failure is written down with its reason", /ledger\.record\(url, page\.failure\)/.test(extract) && /ledger\.record\(url, "thin"\)/.test(extract));
check("a page that answers is forgiven", /ledger\.forgive\(url\)/.test(extract));

// What is on screen comes from one function, so both choices and the automatic
// rule cannot disagree.
check("the body is resolved by bodyFor", /const picked = \$derived\(bodyFor\(choice, extractedNow, feedBody\)\)/.test(pane));
check("the feed's text is still the fallback", /const feedBody = \$derived\(sanitizeArticle\(/.test(pane));
check("asking for the feed never fetches", /choice !== "feed"/.test(pane));

// A paywall stub is not a full article, and the network is the reader's to ask
// for: the preference is never written by the button.
check("a thin extraction is refused", /chooseBody\(result, feedBody\)\.source !== "article"/.test(pane));
check("it does not touch the global preference", !/reading\.extract\s*=/.test(pane) && !/toggleExtract/.test(pane));
check("a late page is dropped", /if \(item\?\.id !== id\) return;/.test(pane));
check("a refusal is visible rather than silent", /no full article/.test(pane) && /role="status"/.test(pane));
check("and it can be retried with the same press", /class="retry"[\s\S]{0,200}toggleReading\(\)/.test(pane));

// One post read in two places must not disagree about which text is the article.
check("the inline row reads the pane's choice", /const choice = \$derived\(ledger\.choice\(item\.id\)\)/.test(inline));
check("and resolves the body the same way", /bodyFor\(choice, extractedFor === item\.id \? extracted : null, feedBody\)/.test(inline));
check("a post put back on the feed is not fetched there either", /\(reading\.extract \|\| choice === "article"\) && choice !== "feed"/.test(inline));

// The building blocks it reuses are the extractor's, not new ones.
check("the extractor still owns the policy", /export function chooseBody/.test(extract) && /export function bodyFor/.test(extract) && /export async function extractFor/.test(extract));

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
