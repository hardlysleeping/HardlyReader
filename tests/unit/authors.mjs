/**
 * Checks for the author search: an index over the posts the app has already
 * loaded, filtered by the field, and a post list narrowed by one author.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/authors.mjs
 *
 * No server and no network. The two runes modules the feature lives in are
 * compiled to plain ESM here (`people.svelte.ts` with the API layer replaced by
 * a recorder, `reader.svelte.ts` whole), so "typing in author mode asks nobody
 * for anything" is a claim about real calls that were counted, not about text
 * in a file. The names are invented.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import {
  AUTHOR_SEARCH_WIRED,
  authorIndexOf,
  authorNameOf,
  authorPanel,
  filterAuthors,
  toggleSearch,
} from "../../src/lib/people.ts";
import { filterByAuthor } from "../../src/lib/article-filter.ts";
import { buildReaderModule } from "./build-reader.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, `tests/unit/.gen-${process.pid}`);

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

/** One sentence per item, written the way the reader sends it. */
function post(id, author, feed) {
  return author === undefined ? { id, origin: { streamId: `feed/${id}`, title: feed } } : { id, author, origin: { streamId: `feed/${id}`, title: feed } };
}

/* ---------------------------------------------------------------------------
 * the index: who wrote what, over the posts already in hand
 * ------------------------------------------------------------------------- */

{
  const index = authorIndexOf([
    post("1", "Ada Lovelace", "Notes"),
    post("2", "Grace Hopper", "Notes"),
    post("3", "Ada Lovelace", "Notes"),
  ]);
  check("every distinct name is one row", index.length === 2, `${index.length}`);
  check("the most prolific author is first", index[0].name === "Ada Lovelace");
  check("a row carries how many posts the name holds", index[0].count === 2 && index[1].count === 1);
}

{
  const index = authorIndexOf([
    post("1", "Ada Lovelace", "Notes"),
    post("2", "ada lovelace", "Notes"),
    post("3", "ADA LOVELACE", "Notes"),
  ]);
  check("names are de-duplicated case-insensitively", index.length === 1 && index[0].count === 3);
  check("the spelling of the first post is the one kept", index[0].name === "Ada Lovelace");
}

{
  const index = authorIndexOf([
    post("1", "Bea", "Notes"),
    post("2", "ada", "Notes"),
    post("3", "Cy", "Notes"),
  ]);
  check(
    "equal counts are ordered by name, case-insensitively",
    index.map((row) => row.name).join(",") === "ada,Bea,Cy",
    index.map((row) => row.name).join(","),
  );
}

check("no posts is no authors", authorIndexOf([]).length === 0);
check("a missing post list is not a crash", authorIndexOf(undefined ?? []).length === 0);

{
  const index = authorIndexOf([
    post("1", undefined, "The Weekly"),
    post("2", "", "The Weekly"),
    post("3", "   ", "The Weekly"),
  ]);
  check("a post with no author of its own adds nobody", index.length === 0);
}

{
  const index = authorIndexOf([post("1", "The Weekly", "The Weekly")]);
  check("a feed's own name is not an author", index.length === 0);
  check("...however the two are spelled", authorIndexOf([post("1", "the weekly", "The Weekly")]).length === 0);
  check("...and authorNameOf is what says so", authorNameOf(post("1", "the weekly", "The Weekly")) === "");
}

{
  check("an author that is not the feed is a person", authorNameOf(post("1", " Ada ", "Notes")) === "Ada");
  check("an author with no feed behind it is still an author", authorNameOf({ author: "Ada" }) === "Ada");
  check("a post with no author at all has no name", authorNameOf({}) === "");
}

{
  // The mixed case: the same feed publishes both a signed post and a feed-named
  // one, and only the signed one is indexed.
  const index = authorIndexOf([post("1", "The Weekly", "The Weekly"), post("2", "Ada", "The Weekly")]);
  check("a feed name mixed with real bylines indexes only the people", index.length === 1 && index[0].name === "Ada");
}

/* ---------------------------------------------------------------------------
 * filtering the index by what is typed
 * ------------------------------------------------------------------------- */

{
  const index = authorIndexOf([
    post("1", "Ada Lovelace", "N"),
    post("2", "Ada Lovelace", "N"),
    post("3", "Grace Hopper", "N"),
    post("4", "Bea", "N"),
  ]);
  check("a query narrows to matching names", filterAuthors(index, "ada").length === 1);
  check("matching ignores case", filterAuthors(index, "ADA")[0].name === "Ada Lovelace");
  check("matching is a substring of the name", filterAuthors(index, "love").length === 1);
  check("a query is trimmed", filterAuthors(index, "  grace  ")[0].name === "Grace Hopper");
  check("no match is an empty list, not everything", filterAuthors(index, "zzz").length === 0);
  check("an empty query is the whole index", filterAuthors(index, "").length === 3);
  check("the filter keeps the index's own order", filterAuthors(index, "a").map((r) => r.name).join(",") === "Ada Lovelace,Bea,Grace Hopper");
}

check("author mode is wired, not a shell", AUTHOR_SEARCH_WIRED === true);
check("an untouched field asks for a name", authorPanel("", 4) === "prompt" && authorPanel("  ", 0) === "prompt");
check("rows under the field are the answer", authorPanel("ada", 1) === "names");
check("no row for a name is 'nothing', never a failure", authorPanel("ada", 0) === "nothing");

/* ---------------------------------------------------------------------------
 * filtering the posts by an author
 * ------------------------------------------------------------------------- */

const POSTS = [
  post("1", "Ada Lovelace", "Notes"),
  post("2", "Grace Hopper", "Notes"),
  post("3", "Ada Lovelace", "Notes"),
  post("4", undefined, "The Weekly"),
  post("5", "The Weekly", "The Weekly"),
];

{
  const picked = filterByAuthor(POSTS, "Ada Lovelace");
  check("picking an author keeps that author's posts in order", picked.map((item) => item.id).join(",") === "1,3");
  check("matching a post to its author ignores case", filterByAuthor(POSTS, "ada lovelace").length === 2);
  check("no filter is the whole list", filterByAuthor(POSTS, null).length === 5);
  check("a blank filter is no filter, not 'the posts with no author'", filterByAuthor(POSTS, "   ").length === 5);
  check("a name nobody wrote is an empty list", filterByAuthor(POSTS, "Nobody").length === 0);
  check(
    "a feed's own name selects nothing: it was never an author",
    filterByAuthor(POSTS, "The Weekly").length === 0,
  );
  check("the filter returns a new array, never the held one", filterByAuthor(POSTS, null) !== POSTS);
}

/* ---------------------------------------------------------------------------
 * the toggle's own rule, filter included
 * ------------------------------------------------------------------------- */

{
  const on = toggleSearch({ enabled: false, query: "ada", author: null });
  check("turning it on keeps what is typed", on.enabled === true && on.query === "ada");
  check("turning it on has no filter to keep", on.author === null);

  const off = toggleSearch({ enabled: true, query: "ada", author: "Ada Lovelace" });
  check("turning it off empties the field", off.enabled === false && off.query === "");
  check("turning it off lets the author go with it", off.author === null);

  const offEmpty = toggleSearch({ enabled: true, query: "", author: null });
  check("turning an empty field off is still an empty field", offEmpty.query === "" && offEmpty.author === null);
}

/* ---------------------------------------------------------------------------
 * the state: an index that follows the posts, and typing that asks nobody
 * ------------------------------------------------------------------------- */

mkdirSync(GEN_DIR, { recursive: true });

function rewrite(code, spec, url) {
  return code
    .replaceAll(JSON.stringify(spec), JSON.stringify(url))
    .replaceAll(`'${spec}'`, JSON.stringify(url));
}

/** The API layer, replaced by a recorder: every call it sees is a call made. */
writeFileSync(
  join(GEN_DIR, "people-api-stub.mjs"),
  `globalThis.__authorCalls ??= [];
export async function searchPeople(transport, session, query) {
  globalThis.__authorCalls.push({ kind: "people", query });
  return { people: [{ name: "Ada Lovelace", added: false }], enabled: true, message: null };
}
export async function addPerson() {
  globalThis.__authorCalls.push({ kind: "add" });
  return { ok: true, message: null };
}
`,
);

writeFileSync(
  join(GEN_DIR, "people-transport-stub.mjs"),
  `globalThis.__authorCalls ??= [];
export const transport = async () => {
  globalThis.__authorCalls.push({ kind: "transport" });
  throw new Error("no network in this suite");
};
`,
);

function buildPeopleStateModule() {
  const source = readFileSync(join(ROOT, "src/state/people.svelte.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "people.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "people.svelte.ts" });
  let code = compiled.js.code;
  code = rewrite(code, "../api/hardlyread", pathToFileURL(join(GEN_DIR, "people-api-stub.mjs")).href);
  code = rewrite(code, "../api/transport", pathToFileURL(join(GEN_DIR, "people-transport-stub.mjs")).href);
  code = rewrite(code, "../lib/people", absolute("src/lib/people.ts"));
  const out = join(GEN_DIR, "people.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { people } = await import(buildPeopleStateModule());
globalThis.__authorCalls = [];

{
  const posts = [post("1", "Ada Lovelace", "N"), post("2", "Ada Lovelace", "N"), post("3", "Grace Hopper", "N")];
  people.indexAuthors(posts);
  check("the index is filled from the posts in hand", people.authors.length === 2, `${people.authors.length}`);
  check("the index is ranked before the field touches it", people.authors[0].name === "Ada Lovelace" && people.authors[0].count === 2);

  const first = people.authors;
  people.indexAuthors(posts);
  check("the same post list is not indexed again", people.authors === first);

  people.indexAuthors([...posts, post("4", "Bea", "N")]);
  check("a longer post list brings its author in", people.authors.length === 3 && people.authors !== first);
  people.indexAuthors(posts);
  check("a different post list replaces the index", people.authors.length === 2);

  check("the field filters the index", people.authorMatches("hop").map((row) => row.name).join(",") === "Grace Hopper");
  check("the field does not touch the index itself", people.authors.length === 2);

  const built = people.authors;
  for (const query of ["a", "ad", "ada", "ada ", ""]) people.authorMatches(query);
  check("typing never rebuilds the index", people.authors === built);
}

{
  // The claim the mode rests on: an author search is not a request.
  const session = { serverUrl: "http://127.0.0.1:18080/", email: "itest", token: "itest/x" };

  people.watch("ada", session, "author");
  await sleep(320);
  check("typing in author mode asks nobody for anything", globalThis.__authorCalls.length === 0, `${globalThis.__authorCalls.length} calls`);

  people.watch("ada", session, "feeds");
  await sleep(320);
  check("the feed filter asks nobody either", globalThis.__authorCalls.length === 0, `${globalThis.__authorCalls.length} calls`);

  // Proof the recorder would have seen a call: the same field, in the mode that
  // does look names up, is one request after the same pause.
  people.watch("love", session, "people");
  await sleep(320);
  check(
    "people mode is the one that asks, so the silence above is real",
    globalThis.__authorCalls.length === 1 && globalThis.__authorCalls[0].kind === "people",
    JSON.stringify(globalThis.__authorCalls),
  );
  check("the mode's own answer is left alone", people.results.length === 1 && people.results[0].name === "Ada Lovelace");
  people.setEnabled(false);
}

/* ---------------------------------------------------------------------------
 * the reader: a narrowed list, and the whole list back
 * ------------------------------------------------------------------------- */

{
  writeFileSync(join(GEN_DIR, "reader-authors.mjs"), buildReaderModule());
  const { ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader-authors.mjs")).href);
  const reader = new ReaderState();
  reader.items = POSTS.map((item) => ({ ...item }));

  check("an unfiltered stream is every post", reader.listItems.length === 5);

  reader.setAuthorFilter("Ada Lovelace");
  check("a picked author narrows the list, in order", reader.listItems.map((item) => item.id).join(",") === "1,3");
  check("the held posts are untouched by the filter", reader.items.length === 5);
  check("the list count is the narrowed one, and the total is still there", reader.listItems.length === 2 && reader.items.length === 5);

  reader.setAuthorFilter("  ada lovelace  ");
  check("a picked name is trimmed and matched case-insensitively", reader.listItems.length === 2);

  reader.setAuthorFilter(null);
  check("clearing the filter brings the stream back whole", reader.listItems.length === 5);
  reader.setAuthorFilter("   ");
  check("a blank name is no filter, not an empty list", reader.listItems.length === 5 && reader.authorFilter === null);

  // A filter that survives a stream change would look like a feed without posts.
  reader.setAuthorFilter("Grace Hopper");
  reader.items = [post("9", "Ada Lovelace", "N")];
  check("a new stream is filtered by the shared filter, not shown empty by accident", reader.listItems.length === 0);
  reader.setAuthorFilter(null);
  check("...and is whole once it is lifted", reader.listItems.length === 1);
}

/* ---------------------------------------------------------------------------
 * one toggle cycle, end to end: the mode, the field and the filter
 * ------------------------------------------------------------------------- */

{
  const { ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader-authors.mjs")).href);
  const reader = new ReaderState();
  reader.items = POSTS.map((item) => ({ ...item }));

  // Type a name with the toggle off, then turn it on: the text is kept.
  let turn = toggleSearch({ enabled: false, query: "ada", author: null });
  check("the press on keeps the typed name", turn.enabled === true && turn.query === "ada");
  check("the press on leaves the list whole", reader.listItems.length === 5);

  // Pick the author the field answered with: the list narrows, the field stays.
  reader.setAuthorFilter("Ada Lovelace");
  check("picking an author narrows the posts", reader.listItems.length === 2);
  check("picking an author leaves the field as it was", turn.query === "ada");

  // Off: the mode, the text and the filter all end together.
  turn = toggleSearch({ enabled: turn.enabled, query: turn.query, author: reader.authorFilter });
  reader.setAuthorFilter(turn.author);
  check("the press off empties the field", turn.enabled === false && turn.query === "");
  check("the press off lifts the author filter", reader.authorFilter === null);
  check("the press off puts the whole feed list back", reader.listItems.length === 5);

  // On again: nothing typed, nothing filtered.
  turn = toggleSearch({ enabled: turn.enabled, query: turn.query, author: reader.authorFilter });
  reader.setAuthorFilter(turn.author);
  check("the press back on has no filter and no text of its own", turn.query === "" && reader.authorFilter === null);
  check("the empty field asks for a name", authorPanel(turn.query, filterAuthors(people.authors, turn.query).length) === "prompt");
}

/* ---------------------------------------------------------------------------
 * source shapes: no request on the author path, no origin named
 * ------------------------------------------------------------------------- */

{
  const sidebar = readFileSync(join(ROOT, "src/components/Sidebar.svelte"), "utf8");
  const authorStart = sidebar.indexOf('{:else if mode === "author"}');
  const hitsStart = sidebar.indexOf("{:else if searching}");
  const branch = sidebar.slice(authorStart, hitsStart);

  check("the author branch never reaches the API", !/searchPeople|people\.add\(|transport/.test(branch));
  check("the author branch has no 'not wired' copy left", !/not wired/i.test(branch));
  check("the author branch is what is drawn on the author index", branch.includes("authorRows") && branch.includes("people.authors.length"));

  const copy = [
    readFileSync(join(ROOT, "src/lib/people.ts"), "utf8"),
    readFileSync(join(ROOT, "src/state/people.svelte.ts"), "utf8"),
    branch,
  ];
  check("the feature names no address of its own", copy.every((text) => !/https?:\/\//.test(text)));
}

/* ------------------------------------------------------------------------- */

if (failures > 0) {
  console.log(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`authors: ${checks} checks passed`);
