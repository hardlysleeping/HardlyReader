/**
 * Checks for the row byline.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/byline.mjs
 *
 * The rule that matters: a feed title is not an author's name, so it is only
 * ever shown when the item itself carries no author.
 */
import { authorOf, bylineOf, bylineTitle, feedNameOf } from "../../src/lib/byline.ts";

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail === undefined ? "" : `(${JSON.stringify(detail)})`}`);
  }
}

const authored = { author: "Ada Lovelace", origin: { title: "Punch" } };
check("an author is the byline", bylineOf(authored) === "Ada Lovelace");
check("the feed is still reachable in the tooltip", bylineTitle(authored) === "Ada Lovelace — Punch");

check("no author falls back to the feed", bylineOf({ origin: { title: "Punch" } }) === "Punch");
check("an empty author falls back too", bylineOf({ author: "   ", origin: { title: "Punch" } }) === "Punch");
check("an author equal to the feed is not printed twice", bylineOf({ author: "Punch", origin: { title: "Punch" } }) === "Punch");
check(
  "and its tooltip is one name, not a repeat",
  bylineTitle({ author: "Punch", origin: { title: "Punch" } }) === "Punch",
);
check(
  "case and accents do not make a duplicate look different",
  bylineOf({ author: "PUNCH", origin: { title: "punch" } }) === "punch",
);
check("neither known is an empty string, not 'undefined'", bylineOf({}) === "");
check("nor is a blank feed title", bylineOf({ origin: { title: "  " } }) === "");
check("an author alone still shows", bylineOf({ author: "Grace Hopper" }) === "Grace Hopper");
check("and its tooltip is the same name", bylineTitle({ author: "Grace Hopper" }) === "Grace Hopper");
check(
  "a missing origin object does not throw",
  bylineOf({ author: "Ada", origin: undefined }) === "Ada",
);
check(
  "a numeric author is ignored rather than printed",
  bylineOf({ author: 42, origin: { title: "Punch" } }) === "Punch",
);

// The card asks for both names separately: it has the room, and "which feed is
// this from" is a different question from "who wrote it".
check("the feed name is the feed's, not the author's", feedNameOf(authored) === "Punch");
check("the author is the item's own", authorOf(authored) === "Ada Lovelace");
check("both are empty rather than 'undefined' when unknown", feedNameOf({}) === "" && authorOf({}) === "");
check("a blank author is empty, not whitespace", authorOf({ author: "  " }) === "");
check("a card with both prints both", feedNameOf(authored) !== authorOf(authored));

// The row uses it, with the tooltip carrying both names.
import { readFileSync } from "node:fs";
const list = readFileSync(new URL("../../src/components/ArticleList.svelte", import.meta.url), "utf8");
check("the row asks the helper who wrote it", /\{bylineOf\(item\)\}/.test(list));
check("and keeps the feed for the tooltip", /title=\{bylineTitle\(item\)\}/.test(list));
check(
  "it no longer hard-codes the feed title on the byline",
  !/<span class="feed-name">\{item\.origin\?\.title \?\? ""\}<\/span>/.test(list),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
