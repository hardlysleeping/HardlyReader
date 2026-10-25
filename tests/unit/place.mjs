/**
 * Headless checks for remembering where you were.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/place.mjs
 *
 * Two halves. The pure half exercises the stored shape (`src/lib/place.ts`) with
 * nothing but plain objects. The other drives the real `ReaderState`: a stubbed
 * localStorage, a session, and the actual save/read methods the app calls, so
 * "does it come back after a restart" is answered by the same code that runs in
 * the window rather than by reading it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EMPTY_PLACE, parsePlace, placeKey } from "../../src/lib/place.ts";
import { GEN_DIR, ROOT, buildReaderModule } from "./build-reader.mjs";

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- the shape

check("nothing stored reads as nowhere", same(parsePlace(null), EMPTY_PLACE));
check("a non-object reads as nowhere", same(parsePlace("feed/1"), EMPTY_PLACE));

const full = parsePlace({
  streamId: "feed/7",
  streamTitle: "MoMA",
  articleId: "tag:google.com,2005:reader/item/abc",
  expandedFeedId: "feed/9",
  articleScroll: 640,
  listScroll: 210,
});
check(
  "a complete place round-trips, down to the line being read",
  same(full, {
    streamId: "feed/7",
    streamTitle: "MoMA",
    articleId: "tag:google.com,2005:reader/item/abc",
    expandedFeedId: "feed/9",
    articleScroll: 640,
    listScroll: 210,
  }),
  JSON.stringify(full),
);

check("no offsets read as the top", parsePlace({ streamId: "feed/7" }).articleScroll === 0);
check(
  "a negative offset is the top",
  parsePlace({ streamId: "feed/7", articleScroll: -40 }).articleScroll === 0,
);
check(
  "a nonsense offset is the top",
  parsePlace({ streamId: "feed/7", listScroll: "far" }).listScroll === 0,
);

check(
  "a stream without its title still names something",
  parsePlace({ streamId: "feed/7" }).streamTitle === "Feed",
);
check(
  "a post without a stream is dropped, since it cannot be resumed",
  parsePlace({ articleId: "item-1" }).articleId === null,
);
check(
  "but an unfolded feed survives that, it is not tied to a stream",
  parsePlace({ articleId: "item-1", expandedFeedId: "feed/9" }).expandedFeedId === "feed/9",
);
check("blank strings are not values", parsePlace({ streamId: "   " }).streamId === null);
check("unknown fields are ignored", !("secret" in parsePlace({ streamId: "feed/1", secret: 1 })));
check("a number is not a stream", parsePlace({ streamId: 7 }).streamId === null);

check(
  "the key carries both the server and the user",
  placeKey("https://a.example", "one@example") === "hardlyreader:place:https://a.example|one@example",
  placeKey("https://a.example", "one@example"),
);
check(
  "two accounts on one server never share a place",
  placeKey("https://a.example", "one@example") !== placeKey("https://a.example", "two@example"),
);
check(
  "two servers with one address never share a place",
  placeKey("https://a.example", "one@example") !== placeKey("https://b.example", "one@example"),
);

// ------------------------------------------------------------- the real thing

/** A stand-in for the window's storage, so the test owns what is on disk. */
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
  key: (index) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
};

mkdirSync(GEN_DIR, { recursive: true });
const generated = join(GEN_DIR, "reader.mjs");
writeFileSync(generated, buildReaderModule());
const { ReaderState } = await import(pathToFileURL(generated).href);

const session = { serverUrl: "https://a.example", email: "one@example" };

function openFeed(reader, streamId, title, articleId = null, expandedFeedId = null, scroll = null) {
  reader.session = session;
  reader.activeStream = streamId;
  reader.activeTitle = title;
  reader.selectedId = articleId;
  reader.expandedFeedId = expandedFeedId;
  if (scroll !== null) {
    reader.rememberScroll("article", scroll.article);
    reader.rememberScroll("list", scroll.list);
  }
  reader.savePlace();
}

const first = new ReaderState();
openFeed(first, "feed/7", "MoMA", "item-abc");

const afterRestart = new ReaderState();
afterRestart.session = session;
const resumed = afterRestart.readPlace();
check("a restart resumes the feed that was open", resumed.streamId === "feed/7", resumed.streamId);
check("with its title, so the sidebar need not wait", resumed.streamTitle === "MoMA");
check("and the post that was open", resumed.articleId === "item-abc", String(resumed.articleId));

const otherAccount = new ReaderState();
otherAccount.session = { serverUrl: "https://a.example", email: "two@example" };
check(
  "another account on the same server starts at nothing",
  otherAccount.readPlace().streamId === null,
  String(otherAccount.readPlace().streamId),
);

const otherServer = new ReaderState();
otherServer.session = { serverUrl: "https://b.example", email: "one@example" };
check("another server starts at nothing", otherServer.readPlace().streamId === null);

// Leaving the post and standing in the feed is its own place: reopening lands on
// the article list, not back in a post the user closed.
const closed = new ReaderState();
openFeed(closed, "feed/7", "MoMA", null);
const afterClose = new ReaderState();
afterClose.session = session;
check("closing the post is remembered too", afterClose.readPlace().articleId === null);
check("...without losing the feed", afterClose.readPlace().streamId === "feed/7");

// Exactly where you were: how far into the post, and how far down the list.
const scrolled = new ReaderState();
openFeed(scrolled, "feed/7", "MoMA", "item-abc", null, { article: 1234, list: 900 });
const afterScroll = new ReaderState();
afterScroll.session = session;
check("the line being read comes back", afterScroll.readPlace().articleScroll === 1234, String(afterScroll.readPlace().articleScroll));
check("and so does the row the list was scrolled to", afterScroll.readPlace().listScroll === 900, String(afterScroll.readPlace().listScroll));

// A post opened by hand starts at its edge, so the remembered line is dropped.
const opened = new ReaderState();
openFeed(opened, "feed/7", "MoMA", "item-abc", null, { article: 1234, list: 900 });
opened.select({ id: "item-xyz" });
check("opening another post forgets the old line", opened.readPlace().articleScroll === 0);
check("...but keeps the list where it is", opened.readPlace().listScroll === 900);

// A feed opened by hand starts at the top of the list.
opened.openStream("feed/8", "Other").catch(() => {});
check("opening another feed puts the list back at the top", opened.readPlace().listScroll === 0);

// The one-column layout unfolds a feed in place; that is a place as well.
const unfolded = new ReaderState();
openFeed(unfolded, "user/-/state/com.google/reading-list", "Reading list", null, "feed/9");
const afterExpand = new ReaderState();
afterExpand.session = session;
check(
  "the feed unfolded in place comes back",
  afterExpand.readPlace().expandedFeedId === "feed/9",
  String(afterExpand.readPlace().expandedFeedId),
);

// A stored value written by an older build, or by hand, must not break sign-in.
store.set(placeKey(session.serverUrl, session.email), "{not json");
const broken = new ReaderState();
broken.session = session;
check("corrupt storage falls back to nowhere instead of throwing", broken.readPlace().streamId === null);

store.set(placeKey(session.serverUrl, session.email), JSON.stringify({ streamId: "feed/7" }));
const partial = new ReaderState();
partial.session = session;
check("a partial record still resumes the feed", partial.readPlace().streamId === "feed/7");
check("and is not mistaken for a post", partial.readPlace().articleId === null);

const signedOut = new ReaderState();
check("no session means nothing to remember", signedOut.readPlace().streamId === null);
signedOut.savePlace();
check("and saving without a session writes nothing", store.size === 1);

// ------------------------------------------------------- the wiring in reader

const source = readFileSync(join(ROOT, "src/state/reader.svelte.ts"), "utf8");
const body = (name) => {
  const start = source.indexOf(`  ${name}`);
  if (start === -1) return "";
  return source.slice(start, source.indexOf("\n  }", start));
};

check("opening a feed records it", body("async openStream").includes("this.savePlace()"));
check("opening a post records it", body("select(").includes("this.savePlace()"));
check("closing a post records that", body("closeReader(").includes("this.savePlace()"));
check("unfolding a feed in place records it", body("setExpandedFeed(").includes("this.savePlace()"));
check("sign-in reads the place before loading anything", body("async start").includes("this.readPlace()"));
check(
  "sign-in opens the remembered stream rather than the Reading list",
  body("async start").includes("place.streamId ?? READING_LIST"),
);
check(
  "a deleted feed falls back to the Reading list",
  body("async start").includes('await this.openStream(READING_LIST, "Reading list")'),
);
check(
  "a post is reopened through select(), so the read rule still applies",
  body("async start").includes("this.select(open)"),
);
check(
  "sign-in hands the remembered line to the panes",
  body("async start").includes("this.articleScrollRestore = place.articleScroll > 0"),
);
check(
  "and the remembered list offset with it",
  body("async start").includes("this.listScrollRestore = place.listScroll > 0"),
);
check(
  "the post pane reports its scroll as it is read",
  readFileSync(join(ROOT, "src/components/ReaderPane.svelte"), "utf8").includes('rememberScroll("article"'),
);
check(
  "the list reports its scroll the same way",
  readFileSync(join(ROOT, "src/components/ArticleList.svelte"), "utf8").includes('rememberScroll("list"'),
);
check(
  "the folded categories are already persisted preferences",
  source.includes("collapsed: this.collapsedCategories") && source.includes("raw?.collapsed"),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
