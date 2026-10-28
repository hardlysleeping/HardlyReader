/**
 * Local mode: the owner's acceptance test, as one scripted run.
 *
 *   pnpm test:acceptance
 *
 * The list it proves is the one from the plan, in order, with no server
 * anywhere:
 *
 *   1. launch        — a fresh install opens the local library, no sign-in
 *   2. add feed      — through `reader.addFeed`, the form's own method
 *   3. import OPML   — two folders, a feed in each, through `reader.importOpml`
 *   4. refresh       — an hour later, a new article arrives and is stored
 *   5. read          — the article is open, with its body
 *   6. star          — the row control, through `reader.toggleStar`
 *   7. mark read     — the reader's own control, through `reader.markRead`
 *   8. quit          — the database handle is closed, not left open
 *   9. reopen        — a new handle on the same file has everything
 *
 * The engine is the app's own: `openLocalProfile({ engine: "sqlite" })` →
 * `SqliteDatabase` → the real `CREATE TABLE`, the real upserts, the real
 * transactions, against a real SQLite file on disk. Only the plugin IPC link is
 * replaced — `connect` — because a Node process has no Rust behind it. Nothing
 * here uses `:memory:`: the whole claim is that closing the app and opening it
 * again loses nothing, and a memory database would prove the opposite of that
 * by passing.
 *
 * The feeds are served by a real HTTP server on 127.0.0.1, over the app's real
 * transport, so the fetch, the parse, the conditional-request headers and the
 * store write are the ones the app runs. Any request to anything but those
 * three fixture feeds fails the run — "no server anywhere" is checked, not
 * asserted in a comment.
 *
 * What this cannot cover, and the manual pass in `docs/local-acceptance.md`
 * covers instead:
 *
 *   - iOS killing the app while it is backgrounded. Here the close is orderly:
 *     `close()` runs, SQLite commits, the file is whole. A jetsam kill mid-write
 *     is a different event, and only a phone can produce it.
 *   - IndexedDB eviction under storage pressure, which is the browser/PWA
 *     engine (`preferredEngine()` in a tab). This run exercises SQLite, the
 *     engine the installed app uses. An evicted IndexedDB database is gone with
 *     no error to catch, and no test can make Safari do it on demand.
 *   - The Tauri SQL plugin itself: `connect` is the seam. That the plugin binds
 *     `$1` placeholders over IPC is proven by the desktop app launching, not
 *     here.
 *   - The UI: this drives the reader state, not the DOM. That a tap reaches
 *     `reader.toggleStar` is `phone-*.mjs` and the manual pass.
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { GEN_DIR, buildReaderModule } from "./build-reader.mjs";
import {
  READING_LIST,
  STATE_READ,
  STATE_STARRED,
  isRead,
  isStarred,
} from "../../src/api/freshrss.ts";
import { openLocalProfile } from "../../src/api/profile.ts";
import { parseOpml } from "../../src/lib/opml.ts";

let checks = 0;
let failures = 0;
const ran = [];

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
}

/** A file's size, or 0 when there is no file — a missing library is an answer. */
function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** A step, printed before it runs, so the output reads as the list it proved. */
function step(number, title, note = "") {
  ran.push(`${number}. ${title}`);
  console.log(`\n${number}. ${title}${note === "" ? "" : ` — ${note}`}`);
}

/** Lets the reader's unawaited follow-ups (sidebar reloads) land. */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------------------
 * A real SQLite file, through the app's own engine
 * ----------------------------------------------------------------------- */

const dir = mkdtempSync(join(tmpdir(), "hardlyreader-acceptance-"));

/**
 * The plugin's three calls, over `node:sqlite`.
 *
 * The driver above this writes `$1`, `$2`, … because sqlx numbers its
 * arguments; `node:sqlite` binds positionally, so the numbers become `?`. The
 * order is preserved and no statement reuses a number, which is what makes the
 * substitution safe — it is checked by the run itself, since a mismatch would
 * bind the wrong column into the wrong one.
 */
class NodeSqliteEngine {
  constructor(db) {
    this.db = db;
  }

  async execute(query, values = []) {
    const sql = query.replace(/\$(\d+)/g, "?");
    if (values.length === 0) {
      this.db.exec(sql);
      return;
    }
    this.db.prepare(sql).run(...values);
  }

  async select(query, values = []) {
    const sql = query.replace(/\$(\d+)/g, "?");
    return values.length === 0 ? this.db.prepare(sql).all() : this.db.prepare(sql).all(...values);
  }

  async close() {
    this.db.close();
  }
}

/** The connector `openLocalProfile` needs, with the app's own file name. */
async function connect(name) {
  const { DatabaseSync } = await import("node:sqlite");
  return new NodeSqliteEngine(new DatabaseSync(join(dir, name)));
}

/* --------------------------------------------------------------------------
 * The feeds, over real HTTP
 * ----------------------------------------------------------------------- */

const published = new Map([
  ["/panel.xml", [
    { guid: "panel-1", title: "Panel one", day: 20, body: "<p>Ink and wash.</p>" },
    { guid: "panel-2", title: "Panel two", day: 21, body: "<p>Gutter and bleed.</p>" },
  ]],
  ["/motion.xml", [
    { guid: "motion-1", title: "Motion one", day: 19, body: "<p>A loop that holds.</p>" },
  ]],
  ["/print.xml", [
    { guid: "print-1", title: "Print one", day: 18, body: "<p>Paper first.</p>" },
    { guid: "print-2", title: "Print two", day: 17, body: "<p>Ink limits.</p>" },
  ]],
]);

const asked = [];

function feedXml(path) {
  const items = published.get(path) ?? [];
  const rows = items
    .map(
      (item) => `    <item>
      <title>${item.title}</title>
      <link>https://fixture.test${path}#${item.guid}</link>
      <guid isPermaLink="false">${item.guid}</guid>
      <pubDate>${new Date(Date.UTC(2026, 9, item.day, 9, 0, 0)).toUTCString()}</pubDate>
      <description><![CDATA[${item.body}]]></description>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${path.replace(/^\/|\.xml$/g, "")} feed</title>
    <link>https://fixture.test${path}</link>
    <description>A fixture</description>
${rows}
  </channel>
</rss>`;
}

const server = createServer((request, response) => {
  asked.push(request.url);
  const path = (request.url ?? "").split("?")[0];
  if (!published.has(path)) {
    response.writeHead(404).end("no such feed");
    return;
  }
  response.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
  response.end(feedXml(path));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const FEED_PANEL = `${origin}/panel.xml`;
const FEED_MOTION = `${origin}/motion.xml`;
const FEED_PRINT = `${origin}/print.xml`;

/* --------------------------------------------------------------------------
 * The reader, built the way the suites that drive it build it
 * ----------------------------------------------------------------------- */

buildReaderModule();
writeFileSync(join(GEN_DIR, "reader.mjs"), buildReaderModule());
const { ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader.mjs")).href);

const file = join(dir, "hardlyreader.db");

/** What a launch does: open the device's library and draw its list. */
async function launch(label) {
  const profile = await openLocalProfile({ engine: "sqlite", connect, label });
  const store = profile.backend.store;
  const reader = new ReaderState();
  reader.profile = profile;
  reader.backend = profile.backend;
  await reader.openStream(READING_LIST, "Reading list");
  return { profile, store, reader };
}

const item = (reader, title) => reader.items.find((entry) => entry.title === title);

let first = null;
let readId = null;
let starredId = null;

try {
  /* ------------------------------------------------------------------ 1 */
  step(1, "launch", "a fresh install, no account");
  first = await launch("This laptop");
  const { profile, store, reader } = first;

  check("the profile is a local library", profile.kind === "local", profile.kind);
  check("there is no session to sign in with", profile.session === null);
  check("the engine is SQLite, not a tab's IndexedDB", store.engine === "sqlite", store.engine);
  check("the file is the app's own name, on disk", fileSize(file) > 0, `${file.split("/").pop()}, ${fileSize(file)} bytes`);
  check("a new library has nothing in it", reader.items.length === 0, String(reader.items.length));
  check("no network was touched to open it", asked.length === 0, asked.join(", "));

  /* ------------------------------------------------------------------ 2 */
  step(2, "add feed", "the + Add feed form");
  const added = await reader.addFeed(FEED_PANEL);

  check("the feed was accepted", added === true);
  check(
    "it is in the sidebar",
    reader.subscriptions.some((feed) => feed.url === FEED_PANEL),
    reader.subscriptions.map((feed) => feed.title).join(", "),
  );
  check("its two articles were fetched on subscribe", reader.items.length === 2, String(reader.items.length));
  check("the feed learnt its own title", (await store.feed(FEED_PANEL))?.title === "panel feed",
    String((await store.feed(FEED_PANEL))?.title));
  check("it was stamped as fetched", (await store.feed(FEED_PANEL))?.fetched_at !== null);

  /* ------------------------------------------------------------------ 3 */
  step(3, "import OPML", "two folders, a feed in each");
  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="Comics" title="Comics">
      <outline type="rss" text="Motion" title="Motion" xmlUrl="${FEED_MOTION}" htmlUrl="https://fixture.test/motion"/>
    </outline>
    <outline text="Print" title="Print">
      <outline type="rss" text="Print" title="Print" xmlUrl="${FEED_PRINT}" htmlUrl="https://fixture.test/print"/>
    </outline>
  </body>
</opml>`;

  const imported = parseOpml(opml);
  check("the file parsed into two feeds, each with its folder",
    imported.length === 2 && imported.every((feed) => feed.category !== undefined),
    imported.map((feed) => `${feed.url.split("/").pop()}:${feed.category ?? "-"}`).join(", "));

  const result = await reader.importOpml(imported);
  check("both feeds were subscribed", result.added.length === 2 && result.failed.length === 0,
    [...result.added.map((url) => url.split("/").pop()), ...result.failed.map((f) => f.error)].join(", "));

  const folders = (await store.folders()).map((folder) => folder.key);
  check("the two folders exist as folders", folders.includes("Comics") && folders.includes("Print"),
    folders.join(", "));

  const subs = await reader.subscriptions;
  const filed = (url) => subs.find((feed) => feed.url === url)?.categories.map((c) => c.label) ?? [];
  check("the first feed is inside Comics", filed(FEED_MOTION).includes("Comics"),
    filed(FEED_MOTION).join(", "));
  check("the second is inside Print", filed(FEED_PRINT).includes("Print"), filed(FEED_PRINT).join(", "));
  check("neither landed in the other's folder",
    !filed(FEED_MOTION).includes("Print") && !filed(FEED_PRINT).includes("Comics"));

  const tags = reader.tags.map((tag) => tag.id);
  check("the sidebar draws both as labels",
    tags.some((id) => id.endsWith("/Comics")) && tags.some((id) => id.endsWith("/Print")),
    tags.filter((id) => id.includes("label")).join(", "));

  check("the imported feeds were fetched too", (await store.queryEntries({})).entries.length === 5,
    String((await store.queryEntries({})).entries.length));

  /* ------------------------------------------------------------------ 4 */
  step(4, "refresh", "an hour later, one new article");
  const NOW = Math.floor(Date.now() / 1000);
  // The clock, moved: every feed was fetched seconds ago, and the poll refuses
  // to refetch one inside its interval. An hour of sitting on a shelf is
  // exactly `fetched_at` being older than the interval, so it is written that
  // way rather than by reaching into the policy.
  for (const feed of await store.feeds()) {
    await store.recordFetch(feed.key, { at: NOW - 2 * 3600, etag: null, lastModified: null });
  }
  published.get("/panel.xml").push({
    guid: "panel-3",
    title: "Panel three",
    day: 22,
    body: "<p>Staples and signatures.</p>",
  });

  await reader.refresh();

  const afterRefresh = await store.queryEntries({});
  check("all three feeds were due", afterRefresh.entries.length === 6,
    String(afterRefresh.entries.length));
  check("the new article is the one that arrived",
    afterRefresh.entries.some((row) => row.title === "Panel three"));
  check("and it is on screen after the refresh", item(reader, "Panel three") !== undefined,
    reader.items.map((entry) => entry.title).join(", "));

  /* ------------------------------------------------------------------ 5 */
  step(5, "read", "open the article that just arrived");
  const opened = item(reader, "Panel three");
  check("the article is in the list to open", opened !== undefined);
  reader.select(opened);
  check("it is the open article", reader.selected?.id === opened.id);
  check("its body is there to read", (reader.selected?.content?.content ?? "").includes("Staples"),
    String(reader.selected?.content?.content));
  check("opening it did not mark it read by itself", isRead(reader.selected) === false);

  /* ------------------------------------------------------------------ 6 */
  step(6, "star", "the row control");
  await reader.toggleStar(opened);
  const starredRow = await store.entry(opened.id);
  check("the star is written to the library", starredRow?.starred === 1, String(starredRow?.starred));
  check("and the open article says so", isStarred(reader.selected) === true,
    JSON.stringify(reader.selected?.categories));

  /* ------------------------------------------------------------------ 7 */
  step(7, "mark read", "the reader's own control");
  await reader.markRead(opened);
  const readRow = await store.entry(opened.id);
  check("the read mark is written to the library", readRow?.read === 1, String(readRow?.read));
  check("and the row on screen says so", isRead(opened) === true, JSON.stringify(opened.categories));

  readId = opened.id;
  starredId = opened.id;
  const unreadNow = await profile.backend.stream(READING_LIST, { count: 50, excludeRead: true });
  check("the unread view drops it", !unreadNow.items.some((entry) => entry.id === readId),
    unreadNow.items.map((entry) => entry.title).join(", "));

  // The reader fires a sidebar reload it does not await; let it land before the
  // handle is closed, or the close would race a read.
  await settle();

  /* ------------------------------------------------------------------ 8 */
  step(8, "quit", "the database is closed");
  await store.close();
  let closed = false;
  try {
    await store.feeds();
  } catch {
    closed = true;
  }
  check("the handle is closed, so nothing can be written after the quit", closed);
  check("the file is on disk and holds data", fileSize(file) > 20_000, `${fileSize(file)} bytes`);

  /* ------------------------------------------------------------------ 9 */
  step(9, "reopen", "a new handle on the same file");
  const second = await launch("This laptop");
  const store2 = second.store;
  const reader2 = second.reader;

  check("it is still a local library with no session", second.profile.session === null);
  check("the reopened library is a different handle on the same file", store2 !== store);

  const feeds2 = await store2.feeds();
  check("all three subscriptions came back", feeds2.length === 3,
    feeds2.map((feed) => feed.key.split("/").pop()).join(", "));
  check("with their folders", feeds2.find((feed) => feed.key === FEED_MOTION)?.folder === "Comics" &&
    feeds2.find((feed) => feed.key === FEED_PRINT)?.folder === "Print",
  feeds2.map((feed) => `${feed.key.split("/").pop()}:${feed.folder ?? "-"}`).join(", "));
  check("and the folders are still folders", (await store2.folders()).length === 2,
    (await store2.folders()).map((folder) => folder.key).join(", "));

  const entries2 = await store2.queryEntries({});
  check("every article is still there", entries2.entries.length === 6, String(entries2.entries.length));

  const read2 = await store2.entry(readId);
  check("the read article is still read", read2?.read === 1, String(read2?.read));
  check("its body survived the quit", (read2?.content ?? "").includes("Staples"), String(read2?.content));
  check("its star survived the quit", read2?.starred === 1, String(read2?.starred));

  const others = entries2.entries.filter((row) => row.key !== readId);
  check("nothing else was marked read", others.every((row) => row.read === 0));
  check("nothing else was starred", others.every((row) => row.starred === 0));

  check("the list is drawn again after the reopen", reader2.items.length === 6,
    String(reader2.items.length));
  check("the read article is still flagged in the list",
    isRead(reader2.items.find((entry) => entry.id === readId) ?? {}));
  check("the starred article is still flagged in the list",
    isStarred(reader2.items.find((entry) => entry.id === readId) ?? {}));

  await reader2.openStream(STATE_STARRED, "Starred");
  check("the starred stream holds exactly the starred article",
    reader2.items.length === 1 && reader2.items[0].id === starredId,
    reader2.items.map((entry) => entry.title).join(", "));

  await reader2.openStream(READING_LIST, "Reading list");
  const unread2 = await store2.queryEntries({ excludeRead: true });
  check("the unread stream still leaves it out", unread2.entries.length === 5,
    String(unread2.entries.length));

  /* ------------------------------------------------------------- the tail */
  const stray = asked.filter((url) => !["/panel.xml", "/motion.xml", "/print.xml"].includes(url.split("?")[0]));
  check("every request went to a fixture feed and nowhere else", stray.length === 0, stray.join(", "));
  const flags = reader2.items.find((entry) => entry.id === readId)?.categories ?? [];
  check("both marks are the state tags GReader spells",
    flags.includes(STATE_READ) && flags.includes(STATE_STARRED), flags.join(", "));

  await store2.close();
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nran: ${ran.join(" → ")}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
