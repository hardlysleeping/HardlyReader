/**
 * More than one account, as Pane 1 draws it.
 *
 * The sidebar had one owner until there was a second account. When there is, each
 * account gets a band with its own name on it and its own categories and feeds under
 * it — because `feed/12` is a different feed on every server, and a list with no
 * owner on it is a list that cannot be trusted. These checks pin what makes that
 * usable: one account draws no band at all, the account being read opens on its own,
 * another account's rows are read once and only when its band is opened, and a
 * library on this device does not merge itself into a sync account's reading list.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/account-groups.mjs
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { localProfile, syncProfile } from "../../src/api/profile.ts";
import { buildReaderModule, GEN_DIR } from "./build-reader.mjs";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

mkdirSync(GEN_DIR, { recursive: true });
writeFileSync(join(GEN_DIR, "reader-groups.mjs"), buildReaderModule());
const { ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader-groups.mjs")).href);

function session(email) {
  return { serverUrl: "https://reader.example", apiPath: "/api/greader.php", email, token: `t-${email}` };
}

/** A backend that answers the rows it was given, and records every read. */
function backend(feeds = [], counts = []) {
  const calls = { subscriptions: 0, unreadCounts: 0, streams: [] };
  return {
    kind: "greader",
    calls,
    async profile() {
      return { userId: "0", userName: "someone" };
    },
    async subscriptions() {
      calls.subscriptions += 1;
      return feeds;
    },
    async tags() {
      return [];
    },
    async unreadCounts() {
      calls.unreadCounts += 1;
      return counts;
    },
    async stream(id) {
      calls.streams.push(id);
      return { id, items: [] };
    },
    async setRead() {},
    async setStarred() {},
    async subscribe() {},
    async unsubscribe() {},
    async moveFeed() {},
  };
}

function feed(id, title, label = "Tech") {
  return { id, title, url: `https://example.com/${id}`, categories: [{ id: `user/-/label/${label}`, label }] };
}

// ——— one account needs no bands ———

{
  const reader = new ReaderState();
  const only = syncProfile(session("one@example.com"), backend([feed("feed/1", "One")]));
  reader.adoptAccounts([only]);
  reader.profile = only;
  check("a single account draws no bands", reader.hasAccountGroups === false);
  check("and its tree is simply open", reader.isAccountGroupOpen(only.slug) === true);
  equal("with no copy taken for a drawer that does not exist", Object.keys(reader.accountSidebars), []);
}

// ——— a single account beside an empty library is still one account ———

{
  // The case that made this necessary: FreshRSS, and the library on the device that
  // has never had a feed in it. Two accounts in the registry, one account on screen.
  const reader = new ReaderState();
  const device = localProfile(backend(), "On this device");
  const server = syncProfile(session("only@example.com"), backend([feed("feed/1", "One")]));
  reader.adoptAccounts([device, server]);
  reader.profile = server;
  reader.subscriptions = [feed("feed/1", "One")];

  check("the empty library is still in the registry", reader.accountList.length === 2);
  equal("so no account gets a band", reader.bandedAccounts.map((p) => p.slug), []);
  check("so the window draws no bands at all", reader.hasAccountGroups === false);
  check("and the tree is not folded under a heading", reader.isAccountGroupOpen(server.slug) === true);

  // The moment it holds a feed, it is an account and it gets a band.
  device.enabled = false;
  reader.subscriptions = [];
  const withFeed = new ReaderState();
  const device2 = localProfile(backend(), "On this device");
  const server2 = syncProfile(session("only@example.com"), backend([feed("feed/1", "One")]));
  withFeed.adoptAccounts([device2, server2]);
  withFeed.profile = device2;
  withFeed.subscriptions = [feed("feed/9", "Mine")];
  equal("a library with a feed is an account", withFeed.bandedAccounts.length, 2);
  check("and the window draws its bands", withFeed.hasAccountGroups === true);
}

// ——— the account being read opens, the other does not ———

{
  const reader = new ReaderState();
  const first = syncProfile(session("first@example.com"), backend([feed("feed/1", "One")]));
  const second = syncProfile(session("second@example.com"), backend([feed("feed/7", "Seven", "Art")]));

  await reader.start(first);
  equal("the account being read is open", reader.isAccountGroupOpen(first.slug), true);
  check("a second account makes bands appear", reader.accountList.length === 1);

  await reader.start(second);
  check("two accounts, bands", reader.hasAccountGroups === true);
  equal("the account just switched to is open", reader.isAccountGroupOpen(second.slug), true);
  // Folding is the reader's, not a side effect of switching: a band that shut itself
  // when the account changed would be a list that rearranged under the thumb.
  equal("the one left behind stays open", reader.isAccountGroupOpen(first.slug), true);
  equal("and both are still in the list", reader.accountList.map((p) => p.slug), [first.slug, second.slug]);
  check("the second account is the one being read", reader.isFocused(second.slug));
}

// ——— another account's rows are read once, when its band opens ———

{
  const reader = new ReaderState();
  const atHome = syncProfile(session("home@example.com"), backend([feed("feed/1", "Home")]));
  const elsewhere = syncProfile(
    session("away@example.com"),
    backend([feed("feed/7", "Seven", "Art"), feed("feed/8", "Eight", "Art")], [{ id: "feed/7", count: 4 }]),
  );
  await reader.start(atHome);
  await reader.start(elsewhere);
  // `start()` reads the account it is starting, so this is the count after both:
  // what matters is that a folded band costs nothing beyond that.
  // Both bands are open (each was seeded when its account arrived); close them, so
  // the checks below are about opening rather than about what was already there.
  if (reader.isAccountGroupOpen(atHome.slug)) await reader.toggleAccountGroup(atHome.slug);
  if (reader.isAccountGroupOpen(elsewhere.slug)) await reader.toggleAccountGroup(elsewhere.slug);
  const afterStart = atHome.backend.calls.subscriptions;
  const countsBefore = atHome.backend.calls.unreadCounts;
  equal("a folded band has no copy of its own", reader.accountSidebars[atHome.slug], undefined);
  equal("and nothing was read for it", atHome.backend.calls.subscriptions, afterStart);
  // Not read is not the same answer as empty: the band says nothing yet.
  equal("a band nobody has opened says nothing rather than 0", reader.feedCountIn(atHome.slug), null);

  await reader.toggleAccountGroup(atHome.slug);
  equal("opening it reads that account's feeds, once", atHome.backend.calls.subscriptions, afterStart + 1);
  equal("and its counts, once", atHome.backend.calls.unreadCounts, countsBefore + 1);
  equal("the rows are grouped by the labels that account's server sent", reader.accountSidebars[atHome.slug].categories.map((g) => g.label), ["Tech"]);
  equal("with the feed inside", reader.accountSidebars[atHome.slug].categories[0].feeds.map((f) => f.id), ["feed/1"]);
  equal("its feeds are counted for the band", reader.feedCountIn(atHome.slug), 1);

  await reader.toggleAccountGroup(atHome.slug);
  equal("closing it does not read anything again", atHome.backend.calls.subscriptions, afterStart + 1);
  check("and it is closed", reader.isAccountGroupOpen(atHome.slug) === false);

  // Another account's counts are its own: `feed/7` is a different feed here.
  await reader.toggleAccountGroup(elsewhere.slug);
  equal("the other account's group carries its own unread count", reader.accountSidebars[elsewhere.slug].counts.get("feed/7"), 4);
}

// ——— the account on screen is answered from memory, not a second request ———

{
  const reader = new ReaderState();
  const here = syncProfile(session("here@example.com"), backend([feed("feed/1", "One")]));
  const there = syncProfile(session("there@example.com"), backend([feed("feed/2", "Two")]));
  await reader.start(here);
  await reader.start(there);
  // Back to the first account, whose rows are then this window's own state.
  await reader.focus(here.slug);
  const before = here.backend.calls.subscriptions;
  await reader.loadAccountSidebar(here.slug);
  equal("the account being read is not asked twice", here.backend.calls.subscriptions, before);
  check("its copy still exists, drawn from the reader's own rows", reader.accountSidebars[here.slug] !== undefined);
}

// ——— a row from another account is a way there ———

{
  const reader = new ReaderState();
  const home = syncProfile(session("home@example.com"), backend([feed("feed/1", "One")]));
  const away = syncProfile(session("away@example.com"), backend([feed("feed/7", "Seven", "Art")]));
  await reader.start(home);
  await reader.start(away);

  const opened = await reader.openInAccount(home.slug, "feed/1", "One");
  check("a row in another account opens", opened === true);
  check("after switching to that account", reader.isFocused(home.slug));
  equal("and opening the stream there", home.backend.calls.streams.at(-1), "feed/1");

  const missing = await reader.openInAccount("ffffffff", "feed/9", "Nine");
  check("an account that is not signed in opens nothing", missing === false);
}

// ——— a library on this device does not merge itself ———

{
  const reader = new ReaderState();
  const local = localProfile(backend(), "On this device");
  await reader.start(local);
  check("a library alone is the whole window, merged or not", reader.accountList.length === 1);
  check("and it is not marked as left out", reader.accountList[0].enabled !== false);

  const server = syncProfile(session("later@example.com"), backend());
  await reader.start(server);
  const filed = reader.accountList.find((p) => p.slug === local.slug);
  check("adding a sync service later takes the library out of the merged view", filed.enabled === false, JSON.stringify(filed));
  check("while the service itself is in it", reader.accountList.find((p) => p.slug === server.slug).enabled !== false);
  check("the library is still signed in and still listed", reader.accountList.length === 2);

  // The same thing seen from the other end: local added to a window already on a server.
  const other = new ReaderState();
  const sync = syncProfile(session("first@example.com"), backend());
  await other.start(sync);
  await other.start(localProfile(backend(), "On this device"));
  const added = other.accountList.find((p) => p.kind === "local");
  check("a library added while a service is in use starts out not merged", added.enabled === false, JSON.stringify(added));

  // An explicit choice is never overruled.
  const explicit = new ReaderState();
  await explicit.start(syncProfile(session("explicit@example.com"), backend()));
  await explicit.start({ ...localProfile(backend(), "On this device"), enabled: true });
  check("a library somebody turned on stays on", explicit.accountList.find((p) => p.kind === "local").enabled === true);
}

// ---------------------------------------------------------------------------
// One account sees exactly what it saw before there were accounts.
// ---------------------------------------------------------------------------

{
  const here = new URL("../..", import.meta.url).pathname;
  const reader = readFileSync(join(here, "src/state/reader.svelte.ts"), "utf8");
  check(
    "bands are gated on more than one account",
    /get bandedAccounts\(\)[\s\S]{0,200}?holding\.length > 1 \? holding : \[\]/.test(reader) &&
      /get hasAccountGroups\(\)[\s\S]{0,80}?bandedAccounts\.length > 0/.test(reader),
  );

  const sidebar = readFileSync(join(here, "src/components/Sidebar.svelte"), "utf8");
  check("and Pane 1 draws them behind that gate", /\{#if reader\.hasAccountGroups\}/.test(sidebar));
  check(
    "the tree is not folded under a band when there is only one account",
    /isAccountGroupOpen\(slug: string\)[\s\S]{0,200}?if \(!this\.hasAccountGroups\) return true;/.test(reader),
  );

  const list = readFileSync(join(here, "src/components/ArticleList.svelte"), "utf8");
  check(
    "the posts column draws account headings only when there are sections",
    /sections\.length > 0[\s\S]{0,120}?tabbedAccounts\(sections, closedTabs\)[\s\S]{0,120}?: tabbed\(store\.listItems, closedTabs\)/.test(list),
  );

  // A merged page is only ever built for more than one account, so a single
  // account's column can never come back with sections in it.
  check(
    "and a single account never produces a merged page",
    /mergesStream\(stream: string\): boolean \{[\s\S]{0,200}?mergedAccounts\.length < 2\) return false;/.test(reader),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
