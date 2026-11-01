/**
 * Unit checks for Buzz as a *section* — the wiring, not the clustering.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/buzz-section.mjs
 *
 * The engine has its own suite (`buzz.mjs`) and the topics their own
 * (`topics.mjs`, `topics-store.mjs`). What is asserted here is the shape the
 * owner asked for and that a later edit could quietly undo: the bolt is above
 * Reading list, it is a toggle rather than a fifth view, a topic row is
 * collapsed until its own chevron is pressed, the icons are clipped at four
 * with a `+N`, and a topic can only be removed on the second press.
 *
 * The store is a `.svelte.ts` module, so it cannot be imported here (`$state`
 * is a compile-time thing) — the source is read instead, which is how every
 * other state suite in this tree checks wiring.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TOPICS } from "../../src/lib/topics.ts";
import { LIST_VIEWS } from "../../src/lib/list-view.ts";

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const at = (path) => readFileSync(join(here, "../..", path), "utf8");

const sidebar = at("src/components/Sidebar.svelte");
const state = at("src/state/buzz.svelte.ts");
const list = at("src/components/BuzzList.svelte");
const main = at("src/views/Main.svelte");
const stack = at("src/components/MobilePaneStack.svelte");
const reader = at("src/state/reader.svelte.ts");

// ------------------------------------------------------------ it is a section

{
  // The bolt is drawn before Reading list, which is what "above Reading list"
  // means once this file is markup. Order in the source is the order on screen.
  const bolt = sidebar.indexOf('class="row strong buzz-toggle"');
  const reading = sidebar.indexOf('class:active={openStreamId === READING_LIST}');
  check("the bolt is in the sidebar", bolt !== -1);
  check("...and above Reading list", bolt !== -1 && bolt < reading, `${bolt} < ${reading}`);

  // Not a view: four members, and Buzz is not one of them. If a fifth ever
  // appears, the reader can leave Buzz by picking a view, which is exactly the
  // state the owner wanted to avoid (what does the ⚡ mean then?).
  check("LIST_VIEWS is still four", LIST_VIEWS.length === 4, LIST_VIEWS.join(","));
  check("...and never learns a fifth", !LIST_VIEWS.includes("buzz"));

  check("pressing it is a toggle, not a selection", /if \(buzz\.active\) \{\s*buzz\.close\(\);/.test(sidebar));
  check("...and it says so to a screen reader", /aria-expanded=\{buzz\.active\}/.test(sidebar));

  // On a phone the stories live in pane 2, so opening the section has to put
  // them in front of you; on a wide layout pane 2 is already on screen.
  check(
    "a phone is taken to the stories",
    /layout\.device === "phone" && inlinePosts\) mobileNav\.show\(2\)/.test(sidebar),
  );
}

// ------------------------------------------------------- the rows are topics

{
  check("the rows are the reader's topics", /#each topics\.list as topic/.test(sidebar));
  check("the store seeds them on first open", /topics\.load\(\);/.test(state));
  check("a fresh install has the shipped topics", DEFAULT_TOPICS.length >= 8, String(DEFAULT_TOPICS.length));
  check("the first topic is the unfiltered window", DEFAULT_TOPICS[0].keywords.length === 0);

  // Collapsed: the feeds are behind the chevron, so the section opens as names.
  check("a row is collapsed until unfolded", /#if unfolded\}\s*\{#each buzz\.feedsFor/.test(sidebar));
  check("...and one boolean per row decides it", /expanded = \$state<Set<string>>\(new Set\(\)\)/.test(state));
  check("...toggled by the chevron alone", /toggleFeeds\(topicId: string\): void/.test(state));

  // The name narrows; it does not unfold. Two targets, two jobs.
  check("the name selects the topic", /onclick=\{\(\) => pickTopic\(topic\.id\)\}/.test(sidebar));
  check("...and the chevron is its own button", /class="buzz-fold"/.test(sidebar));
}

// ------------------------------------------------------------ the icon strip

{
  check("the collapsed row shows the feed's picture", /\{#if feed\.icon\}\s*\n\s*<img src=\{feed\.icon\}/.test(sidebar));
  check("...with letters when there is none", /initials\(feed\.title\)/.test(sidebar));
  check("...four at most", /carrying\.slice\(0, 4\)/.test(sidebar));
  check("...+N for the rest", /carrying\.length > 4[\s\S]{0,80}\+\{carrying\.length - 4\}/.test(sidebar));
  check("the icon comes from the subscription", /icon: feed\.iconUrl \?\? null/.test(state));
  check("...on the feed row too", /icon: string \| null/.test(state));

  // Decorative: the title carries the meaning, so the strip is hidden from a
  // screen reader rather than read as five unlabelled images.
  check("the strip is decorative", /class="buzz-icons" aria-hidden="true"/.test(sidebar));
}

// ------------------------------------------------------------ making/removing

{
  check("a topic can be added", /topics\.add\(topicName, topicWords\)/.test(sidebar));
  check("...through the store's one parser", /topicFromInput\(name, keywords, this\.list\)/.test(at("src/state/topics.svelte.ts")));
  check("removal asks first", /removeAsked === topic\.id \? reallyRemove\(topic\.id\) : askRemove\(topic\.id\)/.test(sidebar));
  check("...and says so", /Remove it — tap again/.test(sidebar));
  check("...and never re-seeds it", /this\.#settled = true;/.test(at("src/state/topics.svelte.ts")));
  check("removing the selected topic falls back to everything", /void buzz\.selectTopic\(null\)/.test(sidebar));
}

// --------------------------------------------------------- the posts pane

{
  check("the desktop posts pane draws stories", /\{#if buzz\.active\}\s*\n\s*<BuzzList \/>/.test(main));
  check("...and so does the phone's pane 2", /\{#if buzz\.active\}\s*\n\s*<BuzzList \/>/.test(stack));
  check("a story opens its coverage", /buzz\.select\(open \? null : story\.id\)/.test(list));
  check("...and an article is the reader's own selection", /reader\.select\(item\)/.test(state));
  check("the window is fetched without touching the stream", /async recentItems\(/.test(reader));
  check("...and never moves activeStream", !/activeStream\s*=/.test(state));
  check("Buzz does not save itself", !/localStorage/.test(state) && !/snapshot/.test(state));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
