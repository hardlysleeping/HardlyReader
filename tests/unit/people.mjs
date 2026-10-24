/**
 * Checks for the optional person lookup beside the search field.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs tests/unit/people.mjs
 *
 * No server and no network: a fake transport records each request and answers
 * from a canned body, so the wire shapes, the remembered availability and the
 * source shape of the field are all exercised without one. The names are
 * invented — this suite is about names, subscription flags and availability.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHOR_SEARCH_WIRED,
  PEOPLE_PREF_KEY,
  authorPanel,
  observeAvailability,
  parseAddPerson,
  parsePeopleList,
  parsePeopleStatus,
  peoplePanel,
  peopleScope,
  readRememberedAvailability,
  recordAvailability,
  secondMode,
  toggleTurn,
} from "../../src/lib/people.ts";
import { groupHits, searchFeeds } from "../../src/lib/search.ts";
import {
  ApiError,
  addPerson,
  getApiState,
  getPeopleStatus,
  parseApiState,
  searchPeople,
} from "../../src/api/hardlyread.ts";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SESSION = {
  serverUrl: "http://127.0.0.1:18080/",
  email: "itest",
  token: "itest/0123456789abcdef",
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A transport that records what was asked and answers from a function. */
function recorder(answer) {
  const calls = [];
  const transport = async (url, init = {}) => {
    const call = { url, method: init.method ?? "GET", body: init.body, signal: init.signal };
    calls.push(call);
    return answer(call, calls.length);
  };
  return { transport, calls };
}

/** A Storage good enough for the remember/read pair, with no browser around. */
function fakeStore() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/* ---------------------------------------------------------------------------
 * shapes
 * ------------------------------------------------------------------------- */

{
  const rows = parsePeopleList({
    people: [
      { name: "Ada Lovelace", added: true },
      { name: "Grace Hopper", added: false },
    ],
  });
  check("an answer becomes names and flags", rows.length === 2 && rows[0].name === "Ada Lovelace" && rows[0].added === true);
  check("an unsubscribed name is not added", rows[1].added === false);
}

check("a bare list is accepted as well as a wrapped one", parsePeopleList([{ name: "Ada" }]).length === 1);
check("a nameless row is dropped", parsePeopleList({ people: [{ added: true }, { name: "" }] }).length === 0);
check("a missing list is empty, never a crash", parsePeopleList({}).length === 0 && parsePeopleList(undefined).length === 0);
check("a name is trimmed", parsePeopleList({ people: [{ name: "  Ada  " }] })[0].name === "Ada");
check(
  "a repeated name is only shown once",
  parsePeopleList({ people: [{ name: "Ada" }, { name: "ada" }] }).length === 1,
);
check(
  "added is only true when the server said so",
  parsePeopleList({ people: [{ name: "Ada", added: "yes" }] })[0].added === false,
);

check("the status route says yes", parsePeopleStatus({ enabled: true }) === true);
check("no status body means no capability", parsePeopleStatus({}) === false && parsePeopleStatus(undefined) === false);
check("a non-boolean flag is not a capability", parsePeopleStatus({ enabled: 1 }) === false);

check("an accepted add keeps the server's words", (() => {
  const result = parseAddPerson({ ok: true, message: "Added." });
  return result.ok === true && result.message === "Added.";
})());
check("a refused add is not an exception", parseAddPerson({ ok: false, message: "No such name." }).ok === false);

/* ---------------------------------------------------------------------------
 * the wire
 * ------------------------------------------------------------------------- */

{
  const { transport, calls } = recorder(() =>
    jsonResponse(200, { enabled: true, people: [{ name: "Ada Lovelace", added: false }] }),
  );
  const answer = await searchPeople(transport, SESSION, "  ada lo  ");

  check("one request answers a search", calls.length === 1);
  check("it is a GET on /v1/people", calls[0].method === "GET" && calls[0].url.endsWith("/v1/people?q=ada%20lo"), calls[0].url);
  check("the query is trimmed and encoded", calls[0].url.includes("q=ada%20lo"));
  check("the answer is parsed", answer.people.length === 1 && answer.enabled === true);
  check("an answer with no message says nothing", answer.message === null);
}

{
  const controller = new AbortController();
  const { transport, calls } = recorder(() => jsonResponse(200, { enabled: true, people: [] }));
  await searchPeople(transport, SESSION, "ada", controller.signal);
  check("a signal rides along, so the next keystroke can cancel", calls[0].signal === controller.signal);
}

{
  const { transport } = recorder(() => jsonResponse(200, { enabled: true, people: [], message: "The lookup did not answer." }));
  const answer = await searchPeople(transport, SESSION, "ada");
  check("a message is kept for the user", answer.message === "The lookup did not answer.");
  check("an empty list is still an answer, not a failure", answer.people.length === 0 && answer.message !== null);
}

{
  const { transport, calls } = recorder(() => jsonResponse(200, { ok: true, message: "Subscribed." }));
  const result = await addPerson(transport, SESSION, "  Ada Lovelace ");

  check("an add is one write and no retry", calls.length === 1 && calls[0].method === "POST", `${calls.length} request(s)`);
  check("it posts the name as JSON", calls[0].body === JSON.stringify({ name: "Ada Lovelace" }), calls[0].body);
  check("a successful add is reported", result.ok === true);
}

{
  const { transport, calls } = recorder(() => jsonResponse(200, { ok: true }));
  await addPerson(transport, SESSION, "Ada");
  check("the add body carries nothing but the name", Object.keys(JSON.parse(calls[0].body)).join(",") === "name");
}

{
  let threw = null;
  try {
    await addPerson(recorder(() => jsonResponse(200, { ok: true })).transport, SESSION, "   ");
  } catch (error) {
    threw = error;
  }
  check("an empty name is never sent", threw instanceof RangeError);
}

{
  const { transport } = recorder(() => jsonResponse(200, { enabled: true }));
  check("the status route is readable on its own", (await getPeopleStatus(transport, SESSION)) === true);
}

{
  const { transport } = recorder(() =>
    jsonResponse(404, { error: { code: "route_not_found", message: "Unknown route." } }),
  );
  let caught = null;
  try {
    await searchPeople(transport, SESSION, "ada");
  } catch (error) {
    caught = error;
  }
  // A server without the capability answers this, and the app never reaches it
  // because the toggle is not drawn; the error stays a real error rather than
  // being read as "no match".
  check("an absent route is an error, not an empty list", caught instanceof ApiError && caught.code === "route_not_found");
}

/* ---------------------------------------------------------------------------
 * availability, remembered per account
 * ------------------------------------------------------------------------- */

{
  const store = fakeStore();
  const scope = peopleScope("http://127.0.0.1:18080/", "itest");
  check("nothing known reads as no capability", readRememberedAvailability(scope, store) === false);

  recordAvailability("http://127.0.0.1:18080/", "itest", true, store);
  check("a yes is remembered", readRememberedAvailability(scope, store) === true);
  check("the trailing slash does not make a second account", peopleScope("http://127.0.0.1:18080", "itest") === scope);
  check("another account inherits nothing", readRememberedAvailability(peopleScope("http://127.0.0.1:18080/", "other"), store) === false);
  check("another server inherits nothing", readRememberedAvailability(peopleScope("http://elsewhere/", "itest"), store) === false);

  recordAvailability("http://127.0.0.1:18080/", "itest", false, store);
  check("a no replaces a yes", readRememberedAvailability(scope, store) === false);

  store.setItem(PEOPLE_PREF_KEY, "{not json");
  check("a corrupt store reads as no capability", readRememberedAvailability(scope, store) === false);

  check("no storage at all reads as no capability", readRememberedAvailability(scope, undefined) === false);
  let survived = true;
  try {
    recordAvailability("http://127.0.0.1:18080/", "itest", true, undefined);
  } catch {
    survived = false;
  }
  check("writing with no storage is harmless", survived);
}

{
  const seen = [];
  observeAvailability((scope, available) => seen.push([scope, available]));
  const store = fakeStore();
  recordAvailability("http://127.0.0.1:18080/", "itest", true, store);
  check("a live view is told about a fresh answer", seen.length === 1 && seen[0][1] === true);
  observeAvailability(null);
  recordAvailability("http://127.0.0.1:18080/", "itest", true, store);
  check("an uninstalled view hears nothing", seen.length === 1);
}

/* ---------------------------------------------------------------------------
 * the state read is the only discovery
 * ------------------------------------------------------------------------- */

check("an absent flag reads as no capability", parseApiState({ apiVersion: 3 }).peopleAvailable === false);
check("the flag is read when it is there", parseApiState({ peopleAvailable: true }).peopleAvailable === true);

{
  const previous = globalThis.localStorage;
  const store = fakeStore();
  globalThis.localStorage = store;
  try {
    const { transport, calls } = recorder(() =>
      jsonResponse(200, {
        apiVersion: 3,
        hiddenCategories: { available: false },
        favorites: { available: false },
        sidebarIndent: { available: true, px: 12 },
        peopleAvailable: true,
      }),
    );
    await getApiState(transport, SESSION);
    check("availability comes from the one state request", calls.length === 1 && calls[0].url.endsWith("/v1/state"));
    check(
      "the state answer is remembered for this account",
      readRememberedAvailability(peopleScope(SESSION.serverUrl, SESSION.email), store) === true,
    );

    const failing = recorder(() => {
      throw new Error("offline");
    });
    let rejected = false;
    try {
      await getApiState(failing.transport, SESSION);
    } catch {
      rejected = true;
    }
    check("a state read that fails rejects", rejected);
    check(
      "a failed read does not take the capability away",
      readRememberedAvailability(peopleScope(SESSION.serverUrl, SESSION.email), store) === true,
    );
  } finally {
    globalThis.localStorage = previous;
  }
}

/* ---------------------------------------------------------------------------
 * one toggle, two searches
 * ------------------------------------------------------------------------- */

check("where the server answers the lookup the toggle means people", secondMode(true) === "people");
check("where it does not, the same toggle is the author search", secondMode(false) === "author");
check(
  "the second search is never the feed filter",
  secondMode(true) !== "feeds" && secondMode(false) !== "feeds",
);
check("author mode is wired to the loaded posts, not a shell", AUTHOR_SEARCH_WIRED === true);
check("author mode asks for a name first", authorPanel("", 0) === "prompt" && authorPanel("   ", 5) === "prompt");
check("a typed author name with rows shows them", authorPanel("Ada", 2) === "names");
check(
  "a typed author name with nothing behind it is a narrow, honest answer",
  authorPanel("Ada", 0) === "nothing",
);

/* ---------------------------------------------------------------------------
 * the field's own text across a press
 * ------------------------------------------------------------------------- */

{
  const off = toggleTurn(true, "ada");
  check("turning it off empties the field", off.enabled === false && off.query === "");
  const on = toggleTurn(false, "ada");
  check("turning it on keeps what is typed", on.enabled === true && on.query === "ada");
  check("turning it on leaves an empty field alone", toggleTurn(false, "").query === "");
  check("turning it off clears whitespace as well", toggleTurn(true, "   ").query === "");

  // Off, then on again, then off: the field is empty at every point where the
  // feed list is the list, so the tree comes back whole rather than filtered by
  // a name that was typed for the other search.
  const groups = [
    {
      id: "g1",
      label: "Engineering",
      feeds: [
        { id: "f1", title: "Ada Weekly" },
        { id: "f2", title: "Grace Notes" },
      ],
    },
  ];
  check("a name in the field would filter the feed list", searchFeeds("ada", groups, null).length === 1);

  let turn = { enabled: true, query: "ada" };
  turn = { ...toggleTurn(turn.enabled, turn.query) };
  check("the first press off leaves nothing in the field", turn.enabled === false && turn.query === "");
  turn = { ...toggleTurn(turn.enabled, turn.query) };
  check("the press back on has nothing to keep", turn.enabled === true && turn.query === "");
  turn = { ...toggleTurn(turn.enabled, turn.query) };
  check(
    "the feed list is unfiltered after an off-then-on-off cycle",
    turn.enabled === false &&
      searchFeeds(turn.query, groups, null).length === 0 &&
      groupHits(turn.query, [], groups).length === 0,
  );
}

/* ---------------------------------------------------------------------------
 * what the list says in people mode
 * ------------------------------------------------------------------------- */

{
  const panel = (over = {}) =>
    peoplePanel({ query: "ada", settled: true, count: 0, note: null, ...over });

  check("an empty field says what to type", panel({ query: "" }) === "prompt");
  check("whitespace is an empty field", panel({ query: "   ", settled: false }) === "prompt");
  check("nothing is drawn before the answer for this exact text", panel({ settled: false }) === "waiting");
  check("an answer with names shows names", panel({ count: 2 }) === "names");
  check("an answer with nothing says nothing matched", panel() === "nothing");
  check("a lookup that broke is not an empty answer", panel({ note: "The lookup did not answer." }) === "failed");
  check("names and a message keep the names", panel({ count: 1, note: "One name did not answer." }) === "names");
  check(
    "rows left over from an earlier query are never drawn under new text",
    panel({ settled: false, count: 3 }) === "waiting",
  );
}

/* ---------------------------------------------------------------------------
 * source shapes: one list at a time, the tree back when the toggle is off
 * ------------------------------------------------------------------------- */

const sidebar = readFileSync(join(here, "../../src/components/Sidebar.svelte"), "utf8");
const stateSource = readFileSync(join(here, "../../src/state/people.svelte.ts"), "utf8");
const field = sidebar.slice(sidebar.indexOf('<div class="find">'), sidebar.indexOf("<SidebarBand />"));

check("the toggle lives in the search field", field.includes('class="find-deep find-person"'));
check(
  "the toggle is drawn on every account, never gated on the capability",
  !/\{#if peopleOn\}/.test(field) && !sidebar.includes("peopleOn") && !sidebar.includes("peopleShowing"),
);
check("...never as a disabled placeholder", !/class="find-deep find-person"[\s\S]{0,240}?disabled=/.test(field));
check(
  "the button states which second search it stands for",
  field.includes('aria-pressed={mode !== "feeds"}') && field.includes('second === "people"'),
);
check(
  "the mode is one question to the state, and availability is read, not fetched",
  sidebar.includes("people.modeFor(reader.session)") && stateSource.includes("modeFor(session: Session | null)"),
);
check(
  "typing hands the mode to the lookup, so only people mode asks the network",
  sidebar.includes("people.watch(search.query, reader.session, mode)") &&
    stateSource.includes('if (mode !== "people" || session === null'),
);
check("a row is not drawn before an answer", /settled\(query: string\): boolean/.test(stateSource));
check(
  "clearing on the way off is a write to the input itself, not only to the state",
  field.includes("bind:this={findBox}") &&
    field.includes("value={search.query}") &&
    sidebar.includes('findBox.value = ""'),
);
check(
  "the press decides through one turn of the toggle, filter included",
  sidebar.includes(
    "toggleSearch({ enabled: people.enabled, query: search.query, author: reader.authorFilter })",
  ) && stateSource.includes("setEnabled(on: boolean)"),
);
check(
  "the list decides through one panel answer, not through markup conditions",
  sidebar.includes("peoplePanel({") && sidebar.includes("settled: people.settled(search.query)"),
);

/* The branches of the list, in the order they are written. */
const peopleStart = sidebar.indexOf('{#if mode === "people"}');
const authorStart = sidebar.indexOf('{:else if mode === "author"}');
const hitsStart = sidebar.indexOf("{:else if searching}");
const treeStart = sidebar.indexOf("\n  {:else}\n", hitsStart);
const peopleBranch = sidebar.slice(peopleStart, authorStart);
const authorBranch = sidebar.slice(authorStart, hitsStart);
const hitsBranch = sidebar.slice(hitsStart, treeStart);
const treeBranch = sidebar.slice(treeStart);

check(
  "people mode is the first branch, so no feed row is drawn beside it",
  peopleStart > 0 && peopleStart < authorStart && authorStart < hitsStart && treeStart > hitsStart,
);
check("every person row lives inside people mode", peopleBranch.includes("{#each peopleRows as person"));
check(
  "the people branch holds no feed or category rows",
  !peopleBranch.includes("hitGroups") &&
    !peopleBranch.includes("reader.categories") &&
    !peopleBranch.includes("hit.feed"),
);
check(
  "feed and category hits are only reachable with the toggle off",
  hitsBranch.includes("{#each hitGroups as group") && !/person/i.test(hitsBranch),
);
check(
  "the tree itself is only reachable with the toggle off",
  treeBranch.includes("{#each reader.categories as category") && treeBranch.includes('class="row feed"'),
);
check("the empty field in people mode asks for a name", peopleBranch.includes("Type a name to search people."));
check(
  "a broken lookup is drawn in the rows' place, apart from 'nothing matched'",
  peopleBranch.includes('{:else if panel === "failed"}') && peopleBranch.includes("No one named"),
);
check(
  "author mode has its own prompt, its own rows and its own honest empty answer",
  authorBranch.includes("Type an author's name.") &&
    authorBranch.includes("{#each authorRows as author") &&
    authorBranch.includes("in the posts you have loaded") &&
    !authorBranch.includes("not wired up yet"),
);
check(
  "author mode draws no feed or person rows of its own",
  !authorBranch.includes("peopleRows") &&
    !authorBranch.includes("hitGroups") &&
    !authorBranch.includes("reader.categories"),
);
check(
  "an author row shows the name and how many posts it holds",
  authorBranch.includes("<span class=\"label\">{author.name}</span>") &&
    authorBranch.includes("<span class=\"count\">{author.count}</span>"),
);
check(
  "the way back to the unfiltered list is in the same control",
  authorBranch.includes("onclick={() => reader.setAuthorFilter(null)}") &&
    authorBranch.includes("Show all") &&
    field.includes("onclick={clearFind}"),
);
check(
  "picking an author narrows the posts and stays in the mode with the field as it is",
  authorBranch.includes("onclick={() => chooseAuthor(author.name)}") &&
    sidebar.includes("reader.setAuthorFilter(reader.authorFilter === name ? null : name)"),
);
check(
  "the index is rebuilt from the held posts, never from typing",
  sidebar.includes("people.indexAuthors(reader.items)") &&
    stateSource.includes("indexAuthors(posts: readonly BylineSource[])") &&
    sidebar.includes("people.authorMatches(search.query)"),
);
check(
  "one button, both modes",
  (sidebar.match(/class="find-deep find-person"/g) ?? []).length === 1,
);

/* ---------------------------------------------------------------------------
 * no source named, and nothing of the mode persisted
 * ------------------------------------------------------------------------- */

const peopleSources = [
  readFileSync(join(here, "../../src/lib/people.ts"), "utf8"),
  stateSource,
];
check(
  "the feature carries no address of its own",
  peopleSources.every((text) => !/https?:\/\//.test(text)),
);
check(
  "the toggle is not persisted, only the capability is",
  peopleSources[1].includes("localStorage") === false && peopleSources[0].includes("PEOPLE_PREF_KEY"),
);

/* ------------------------------------------------------------------------- */

if (failures > 0) {
  console.log(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`people: ${checks} checks passed`);
