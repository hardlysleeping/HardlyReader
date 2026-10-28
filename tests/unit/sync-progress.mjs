/**
 * Checks for the sync readout.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/sync-progress.mjs
 *
 * Two halves. The first is the arithmetic and the step machine on its own: what
 * makes a count honest is that it cannot be pushed past the total, cannot be
 * moved twice for one step, and cannot be rounded up at the end. The second
 * half drives a real `ReaderState` over a stub `fetch` that answers each request
 * only when the test says so, because the thing the owner complained about —
 * a bar that sits at 0 and then jumps to 5 — is a wiring bug, not an arithmetic
 * one: the fetches have to report themselves.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import {
  SYNC_IDLE,
  SYNC_STEPS,
  SYNC_TOTAL,
  createSyncTracker,
  percentOf,
  syncDescription,
  syncReadout,
} from "../../src/lib/sync-progress.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

/** Boolean form, for the async half: `check(name, ok)` takes a boolean. */
let failures = 0;
function checkOk(name, ok, detail) {
  passed += 1;
  if (!ok) {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  (${detail})`}`);
    return;
  }
  console.log(`  ok   ${name}`);
}

check("idle is not active and has no step", () => {
  assert.equal(SYNC_IDLE.active, false);
  assert.equal(SYNC_IDLE.step, "");
});

check("a sync is five fetches", () => assert.equal(SYNC_TOTAL, 5));
check("...named, and each says what it is doing", () => {
  assert.deepEqual(
    SYNC_STEPS.map((step) => step.id),
    ["feeds", "tags", "counts", "extension", "posts"],
  );
  assert.equal(SYNC_STEPS.length, SYNC_TOTAL);
  assert.equal(SYNC_STEPS[2].doing, "counting unread");
});

check("percent is the rounded fraction", () => {
  assert.equal(percentOf(2, 5), 40);
  assert.equal(percentOf(1, 3), 33);
});

check("percent clamps beyond the ends", () => {
  assert.equal(percentOf(7, 5), 100);
  assert.equal(percentOf(-1, 5), 0);
});

check("percent of an unknown total is zero, not NaN", () => {
  assert.equal(percentOf(0, 0), 0);
  assert.equal(percentOf(3, 0), 0);
});

check("readout is the count and the percentage", () => {
  assert.equal(syncReadout({ active: true, done: 2, total: 5, step: "loading tags" }), "2/5 steps");
});

check("readout never claims more done than the total", () => {
  assert.equal(syncReadout({ active: true, done: 9, total: 5, step: "loading tags" }), "5/5 steps");
});

check("an unknown total names the step instead of 0/0", () => {
  assert.equal(syncReadout({ active: true, done: 0, total: 0, step: "loading feeds" }), "loading feeds…");
});

check("an unknown total with no step still says something true", () => {
  assert.equal(syncReadout({ active: true, done: 0, total: 0, step: "" }), "Syncing…");
});

check("description is the button label when idle", () => {
  assert.equal(syncDescription(SYNC_IDLE), "Sync now");
});

check("description names the step and the count", () => {
  assert.equal(
    syncDescription({ active: true, done: 2, total: 5, step: "loading tags" }),
    "Syncing, loading tags: 2 of 5 steps, 40 percent",
  );
});

check("description before the count is known says starting", () => {
  assert.equal(syncDescription({ active: true, done: 0, total: 0, step: "" }), "Syncing: starting");
});

/* ---------------------------------------------------------------------------
 * the count itself
 * ------------------------------------------------------------------------- */

check("a fresh sync starts at zero out of five, naming no step yet", () => {
  const tracker = createSyncTracker();
  const state = tracker.begin();
  assert.deepEqual(state, { active: true, done: 0, total: SYNC_TOTAL, step: "" });
});

check("a step in flight is named, in the app's words", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  assert.equal(tracker.start("counts").step, "counting unread");
});

check("the label stays on the step that is really still running", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  tracker.start("feeds");
  tracker.start("posts");
  assert.equal(tracker.land("posts").step, "loading feeds");
  assert.equal(tracker.land("feeds").step, "");
});

check("one step cannot be counted twice", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  tracker.start("feeds");
  assert.equal(tracker.land("feeds").done, 1);
  assert.equal(tracker.land("feeds").done, 1);
});

check("the count cannot pass the total", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  for (const step of SYNC_STEPS) tracker.land(step.id);
  assert.equal(tracker.land("feeds").done, SYNC_TOTAL);
  assert.equal(tracker.land("posts").done, SYNC_TOTAL);
});

check("finishing does not round the count up", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  tracker.start("feeds");
  tracker.start("tags");
  tracker.land("feeds");
  tracker.fail("tags");
  const state = tracker.finish();
  assert.equal(state.active, false);
  assert.equal(state.done, 1);
  assert.equal(state.step, "");
});

check("a failed step stops being named, and is not a completion", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  tracker.start("feeds");
  tracker.start("tags");
  const state = tracker.fail("tags");
  assert.equal(state.done, 0);
  assert.equal(state.step, "loading feeds");
});

check("an overlapping sync does not reset or double the count", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  tracker.start("feeds");
  tracker.land("feeds");
  const second = tracker.begin();
  assert.equal(second.done, 1);
  assert.equal(second.active, true);
  assert.equal(tracker.land("feeds").done, 1);
  assert.equal(tracker.land("tags").done, 2);
});

check("the first of two overlapping syncs to finish does not end the readout", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  const second = tracker.begin();
  assert.equal(second.active, true);
  assert.equal(tracker.finish().active, true);
  assert.equal(tracker.finish().active, false);
});

check("a completion from a run that is over is ignored", () => {
  const tracker = createSyncTracker();
  tracker.begin();
  tracker.finish();
  assert.equal(tracker.land("feeds").done, 0);
  assert.equal(tracker.start("tags").step, "");
});

/* ---------------------------------------------------------------------------
 * the reader, over a stub transport
 * ------------------------------------------------------------------------- */

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, "tests/unit/.gen");

function absolute(relativePath) {
  return pathToFileURL(join(ROOT, relativePath)).href;
}

/** A runes module the reader imports: compiled to plain ESM, by absolute path. */
function buildRunes(relativePath, name, replacers = []) {
  const source = readFileSync(join(ROOT, relativePath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: name,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: name });
  let code = compiled.js.code;
  for (const [from, to] of replacers) code = code.replaceAll(from, JSON.stringify(to));
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, `sync-${name.replace(/\.svelte\.ts$/, "")}.mjs`);
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

const readingModule = buildRunes("src/state/reading.svelte.ts", "reading.svelte.ts", [
  ['"../lib/article-filter"', absolute("src/lib/article-filter.ts")],
  ['"../lib/list-view"', absolute("src/lib/list-view.ts")],
  ['"../lib/extract"', absolute("src/lib/extract.ts")],
  ['"../lib/feed-order"', absolute("src/lib/feed-order.ts")],
  ['"../lib/indent"', absolute("src/lib/indent.ts")],
  ['"../lib/dwell"', absolute("src/lib/dwell.ts")],
  ['"../lib/scroll-advance"', absolute("src/lib/scroll-advance.ts")],
  ['"../lib/reading-layout"', absolute("src/lib/reading-layout.ts")],
  ['"../lib/account-key"', absolute("src/lib/account-key.ts")],
  ['"../lib/add-feeds"', absolute("src/lib/add-feeds.ts")],
]);
const themeModule = buildRunes("src/state/theme.svelte.ts", "theme.svelte.ts", [
  ['"../lib/theme"', absolute("src/lib/theme.ts")],
]);
const floodsModule = buildRunes("src/state/floods.svelte.ts", "floods.svelte.ts", [
  ['"../lib/floods"', absolute("src/lib/floods.ts")],
]);

const readerModule = buildRunes("src/state/reader.svelte.ts", "reader.svelte.ts", [
  ['"../api/freshrss"', absolute("src/api/freshrss.ts")],
  ['"../api/hardlyread"', absolute("src/api/hardlyread.ts")],
  ['"../api/transport"', absolute("src/api/transport.ts")],
  ['"../api/backend"', absolute("src/api/backend.ts")],
  ['"../api/greader-backend"', absolute("src/api/greader-backend.ts")],
  ['"../api/profile"', absolute("src/api/profile.ts")],
  ['"../lib/reading-order"', absolute("src/lib/reading-order.ts")],
  ['"../lib/feed-order"', absolute("src/lib/feed-order.ts")],
  ['"../lib/indent"', absolute("src/lib/indent.ts")],
  ['"../lib/article-filter"', absolute("src/lib/article-filter.ts")],
  ['"../lib/list-view"', absolute("src/lib/list-view.ts")],
  ['"./reading.svelte"', readingModule],
  ['"./theme.svelte"', themeModule],
  ['"./floods.svelte"', floodsModule],
  ['"../lib/stream-cycle"', absolute("src/lib/stream-cycle.ts")],
  ['"../lib/dwell"', absolute("src/lib/dwell.ts")],
  ['"../lib/contextmenu"', absolute("src/lib/contextmenu.ts")],
  ['"../lib/sync-progress"', absolute("src/lib/sync-progress.ts")],
  ['"../lib/place"', absolute("src/lib/place.ts")],
  ['"../lib/sidebar-doc"', absolute("src/lib/sidebar-doc.ts")],
  ['"./hidden-write"', absolute("src/state/hidden-write.ts")],
  ['"./hidden"', absolute("src/state/hidden.ts")],
  ['"./favorites"', absolute("src/state/favorites.ts")],
  ['"./write"', absolute("src/state/write.ts")],
  ['"./stream-cache"', absolute("src/state/stream-cache.ts")],
  ['"./pins"', absolute("src/state/pins.ts")],
  ['"./persist"', absolute("src/state/persist.ts")],
  ['"../lib/api-snapshot"', absolute("src/lib/api-snapshot.ts")],
  ['"../lib/stream-loads"', absolute("src/lib/stream-loads.ts")],
  ['"../lib/stream-perf"', absolute("src/lib/stream-perf.ts")],
  ['"../lib/stream-scroll"', absolute("src/lib/stream-scroll.ts")],
  ['"../lib/account-key"', absolute("src/lib/account-key.ts")],
  ['"../lib/add-feeds"', absolute("src/lib/add-feeds.ts")],
  ['"../lib/opml"', absolute("src/lib/opml.ts")],
  ['"../lib/extract-ledger"', absolute("src/lib/extract-ledger.ts")],
  ['"../lib/full-text"', absolute("src/lib/full-text.ts")],
]);

const { ReaderState } = await import(readerModule);

const SESSION = { serverUrl: "http://127.0.0.1:18080", email: "itest", token: "itest/0123456789abcdef" };

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Which of the five fetches a URL belongs to. */
function stepOf(url) {
  if (url.includes("/subscription/list")) return "feeds";
  if (url.includes("/tag/list")) return "tags";
  if (url.includes("/unread-count")) return "counts";
  if (url.includes("/stream/contents")) return "posts";
  if (url.includes("misc.php")) return "extension";
  return "other";
}

const BODIES = {
  feeds: { subscriptions: [] },
  tags: { tags: [] },
  counts: { unreadcounts: [] },
  extension: { apiVersion: 1 },
  posts: { items: [], continuation: null },
};

/**
 * A transport that answers nothing until the test delivers it: every request
 * stays in `waiting`, in the order it was made.
 */
function bench() {
  const reader = new ReaderState();
  reader.session = { ...SESSION };
  const waiting = [];
  globalThis.fetch = (input) =>
    new Promise((resolve) => {
      waiting.push({ url: String(input), resolve });
    });
  return { reader, waiting };
}

/** Answers one waiting request, by the step it belongs to. */
function deliver(waiting, step, answer = { status: 200 }) {
  const at = waiting.findIndex((request) => stepOf(request.url) === step);
  if (at === -1) {
    throw new Error(`no ${step} request waiting (have ${waiting.map((r) => stepOf(r.url)).join(",")})`);
  }
  const [request] = waiting.splice(at, 1);
  request.resolve(json(answer.status ?? 200, answer.body ?? BODIES[step]));
}

const counts = (waiting) => waiting.filter((request) => stepOf(request.url) !== "other").length;

/* --- the five ticks, one per fetch, in the order they finish -------------- */
{
  const { reader, waiting } = bench();
  const run = reader.refresh();
  await flush();

  checkOk("a sync asks for all five things at once", counts(waiting) === 5, `${counts(waiting)} request(s)`);
  checkOk(
    "before anything lands it names the fetch it is waiting on",
    reader.sync.done === 0 && reader.sync.step === "loading feeds",
    `${reader.sync.done} ${reader.sync.step}`,
  );

  const done = [reader.sync.done];
  const labels = [];
  // Deliberately not the declared order: the count follows the fetches, not the
  // list they are written in.
  for (const step of ["tags", "posts", "feeds", "counts", "extension"]) {
    deliver(waiting, step);
    await flush();
    done.push(reader.sync.done);
    labels.push(reader.sync.step);
  }

  checkOk("the count ticks once per fetch, in the order they finish", done.join(",") === "0,1,2,3,4,5", done.join(","));
  checkOk(
    "and the label always names a fetch that is still running",
    labels.join("|") === "loading feeds|loading feeds|counting unread|reading extension state|",
    labels.join("|"),
  );
  checkOk("never past the total", Math.max(...done) === SYNC_TOTAL, String(Math.max(...done)));
  checkOk(
    "a finished sync is a full one",
    reader.sync.done === SYNC_TOTAL && reader.sync.active === false,
    `${reader.sync.done} active=${reader.sync.active}`,
  );

  await run;
}

/* --- a failed fetch leaves the readout short ------------------------------ */
{
  const { reader, waiting } = bench();
  const run = reader.refresh();
  await flush();

  deliver(waiting, "tags", { status: 500, body: { error: { message: "tag list exploded" } } });
  await flush();
  checkOk("a failed fetch is not counted", reader.sync.done === 0, String(reader.sync.done));
  checkOk("...and stops being named as the running step", reader.sync.step === "loading feeds", reader.sync.step);

  for (const step of ["feeds", "counts", "posts", "extension"]) {
    deliver(waiting, step);
    await flush();
  }
  await run;

  checkOk("the readout stops short of the total", reader.sync.done === SYNC_TOTAL - 1, String(reader.sync.done));
  checkOk("the sync is over", reader.sync.active === false);
  // The reader's own banner text, not a second message invented for the bar:
  // the GReader layer reports the status, which is what the sidebar shows.
  checkOk("and the error the reader already has is the one on screen", reader.error === "Request failed (HTTP 500)", String(reader.error));
}

/* --- a second refresh overlapping a running one --------------------------- */
{
  const { reader, waiting } = bench();
  const first = reader.refresh();
  await flush();
  const second = reader.refresh();
  await flush();

  checkOk("the second sync asks for its own five", counts(waiting) === 10, `${counts(waiting)} request(s)`);

  const done = [reader.sync.done];
  const steps = ["feeds", "tags", "counts", "extension", "posts"];
  for (const step of steps) {
    // Both runs' copies of one fetch, one after the other.
    deliver(waiting, step);
    await flush();
    done.push(reader.sync.done);
    deliver(waiting, step);
    await flush();
    done.push(reader.sync.done);
  }
  await Promise.all([first, second]);

  checkOk("an overlapping sync never counts a step twice", done.join(",") === "0,1,1,2,2,3,3,4,4,5,5", done.join(","));
  checkOk("it never goes backwards", done.every((value, at) => at === 0 || value >= done[at - 1]), done.join(","));
  checkOk("it never passes the total", Math.max(...done) <= SYNC_TOTAL, done.join(","));
  checkOk(
    "and both runs end at a full readout",
    reader.sync.done === SYNC_TOTAL && reader.sync.active === false,
    `${reader.sync.done} active=${reader.sync.active}`,
  );
  checkOk("neither run reports an error", reader.error === null, String(reader.error));
}

/* --- an overlapping sync that fails while the other succeeds -------------- */
{
  const { reader, waiting } = bench();
  const first = reader.refresh();
  await flush();
  const second = reader.refresh();
  await flush();

  deliver(waiting, "counts", { status: 500, body: { error: { message: "counts exploded" } } });
  await flush();
  deliver(waiting, "counts");
  await flush();
  for (const step of ["feeds", "tags", "extension", "posts"]) {
    deliver(waiting, step);
    await flush();
    deliver(waiting, step);
    await flush();
  }
  await Promise.all([first, second]);

  checkOk(
    "one run's failure does not undo the other run's success",
    reader.sync.done === SYNC_TOTAL,
    String(reader.sync.done),
  );
  checkOk("the failure is still reported", reader.error === "Request failed (HTTP 500)", String(reader.error));
}

/* --- the header draws the step it is given -------------------------------- */
{
  const header = readFileSync(new URL("../../src/components/Header.svelte", import.meta.url), "utf8");
  checkOk("the header shows the running step", /reader\.sync\.step/.test(header));
  checkOk("...inside the readout beside the count", /\{readout\}/.test(header));
  checkOk("the readout is described in full for a screen reader", /aria-valuetext=\{description\}/.test(header));
}

console.log(`${passed} checks passed${failures === 0 ? "" : `, ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
