/**
 * Checks for the remembered-settings document: provenance, the merge rule and
 * the offline queue.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/prefs-sync.mjs
 *
 * Pure module, no compiler, no DOM, no server. What is asserted is exactly the
 * policy the account's copy depends on:
 *
 *   - a newer stamp wins, in either direction;
 *   - an equal stamp keeps the local value, because it is the one on screen;
 *   - an unknown namespace, a malformed stamp and a poison value are ignored
 *     rather than adopted or allowed to erase what is held;
 *   - a device with no provenance for a namespace adopts the account's copy
 *     instead of claiming its own;
 *   - the offline queue sends in the order the changes happened, keeps the
 *     unsent head on a failure, and never retries something the server has said
 *     it cannot take.
 *
 * The wire round trip at the end is the same code the client's PUT and GET use,
 * so a document that survives it is one the adapter can store and hand back.
 */
import {
  PREFS_API_VERSION,
  PrefsQueue,
  emptyPrefs,
  entryOf,
  mergePreferences,
  newerThan,
  nextPrefsStamp,
  parseLocalPreferences,
  parsePreferences,
  preferencesBody,
  samePreferences,
  sameValue,
  withEntry,
} from "../../src/lib/prefs-sync.ts";

let checks = 0;
let failures = 0;

function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
  }
}

/** Structural equality, for values a parser rebuilt. */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One namespace entry. */
function entry(value, updatedAt) {
  return { updatedAt, value };
}

/** A document holding one or more namespace entries. */
function doc(entries) {
  let out = emptyPrefs();
  for (const [namespace, value] of Object.entries(entries)) {
    out = withEntry(out, namespace, value);
  }
  return out;
}

const READING_A = { textScale: 1.2, listView: "cards" };
const READING_B = { textScale: 0.9, listView: "list" };
const THEME_A = { mode: "dark", accent: "#613583" };
const THEME_B = { mode: "light", accent: "#0078e0" };

/* --------------------------------------------------------------- the merge */

{
  const local = doc({ reading: entry(READING_A, 100) });
  const remote = doc({ reading: entry(READING_B, 200) });
  const merged = mergePreferences(local, remote);

  check(
    "a newer account value wins",
    entryOf(merged.doc, "reading")?.value === READING_B,
    entryOf(merged.doc, "reading"),
  );
  check("…and is reported as adopted", merged.adopted.includes("reading"), merged.adopted);
  check(
    "…with its stamp carried through",
    entryOf(merged.doc, "reading")?.updatedAt === 200 && merged.doc.updatedAt === 200,
    merged.doc,
  );
}

{
  const local = doc({ reading: entry(READING_B, 300) });
  const remote = doc({ reading: entry(READING_A, 200) });
  const merged = mergePreferences(local, remote);

  check(
    "a newer local value is kept",
    entryOf(merged.doc, "reading")?.value === READING_B,
    entryOf(merged.doc, "reading"),
  );
  check("…and nothing is adopted", merged.adopted.length === 0, merged.adopted);
  check("…and it is reported as kept", merged.kept.includes("reading"), merged.kept);
}

{
  const local = doc({ theme: entry(THEME_B, 500) });
  const remote = doc({ theme: entry(THEME_A, 500) });
  const merged = mergePreferences(local, remote);

  check(
    "an equal stamp keeps the local value",
    entryOf(merged.doc, "theme")?.value === THEME_B,
    entryOf(merged.doc, "theme"),
  );
  check("…and adopts nothing", merged.adopted.length === 0, merged.adopted);
  check(
    "…though the tie is remembered as local provenance",
    entryOf(merged.doc, "theme")?.updatedAt === 500,
  );
}

{
  // Two devices editing different halves: both survive, which is the reason
  // provenance is per namespace rather than one stamp for the whole blob.
  const local = doc({ reading: entry(READING_A, 900), search: entry({ deep: true }, 100) });
  const remote = doc({ reading: entry(READING_B, 800), theme: entry(THEME_A, 950) });
  const merged = mergePreferences(local, remote);

  check(
    "different namespaces both survive: local reading",
    entryOf(merged.doc, "reading")?.value === READING_A,
  );
  check(
    "different namespaces both survive: account theme",
    entryOf(merged.doc, "theme")?.value === THEME_A && merged.adopted.includes("theme"),
  );
  check(
    "a namespace only this device holds is kept",
    entryOf(merged.doc, "search")?.value.deep === true,
  );
  check(
    "the document's stamp is the newest entry, not the account's",
    merged.doc.updatedAt === 950,
    merged.doc.updatedAt,
  );
}

{
  // A device that has never compared this namespace has no provenance to
  // prefer, so the account's value arrives even at its oldest stamp.
  const local = doc({ reading: entry(READING_A, 0) });
  const remote = doc({ reading: entry(READING_B, 7) });
  const merged = mergePreferences(local, remote);

  check(
    "an unstamped local value yields to the account",
    entryOf(merged.doc, "reading")?.value === READING_B,
    entryOf(merged.doc, "reading"),
  );
  check("…and is adopted", merged.adopted.includes("reading"));

  const alone = mergePreferences(local, emptyPrefs());
  check(
    "an unstamped local value with no account copy survives",
    entryOf(alone.doc, "reading")?.value === READING_A,
  );
}

/* -------------------------------------------------------- poison and unknown */

{
  const remote = parsePreferences({
    apiVersion: PREFS_API_VERSION,
    updatedAt: 9_999_999_999_999,
    entries: {
      reading: entry(READING_B, 200),
      // A namespace this build has never heard of: a newer client may write it,
      // and adopting it would put a value into a store that cannot validate it.
      experiments: entry({ telemetry: true }, 300),
      theme: entry("not an object", 400),
      search: entry({ deep: false }, 0),
    },
  });

  check("an unknown namespace is not adopted", !Object.hasOwn(remote.entries, "experiments"));
  check("a scalar where an object belongs is ignored", remote.entries.theme === undefined);
  check("a zero stamp proves nothing and is ignored", remote.entries.search === undefined);
  const malformed = parsePreferences({
    apiVersion: PREFS_API_VERSION,
    updatedAt: 10,
    entries: { search: entry({ deep: "yes" }, Number.NaN) },
  });
  check("a malformed stamp is ignored", malformed.entries.search === undefined);
  check(
    "the rest of the document still arrives",
    same(entryOf(remote, "reading")?.value, READING_B),
    entryOf(remote, "reading"),
  );
  check(
    "the document cannot claim a stamp its entries do not carry",
    remote.updatedAt === 200,
    remote.updatedAt,
  );
}

{
  // A hostile or corrupt blob: an own `__proto__` key must not reach a
  // prototype, and the value must not be adopted.
  const hostile = JSON.parse(
    '{"entries":{"reading":{"updatedAt":10,"value":{"__proto__":{"polluted":true},"textScale":1.1}}}}',
  );
  const parsed = parsePreferences(hostile);
  const value = entryOf(parsed, "reading")?.value ?? {};

  check("a poison key does not pollute Object.prototype", ({}).polluted === undefined);
  check("…and is dropped from the value", !Object.hasOwn(value, "__proto__"), Object.keys(value));
  check("…while the real fields survive", value.textScale === 1.1, value);

  const local = doc({ reading: entry(READING_A, 100) });
  const merged = mergePreferences(local, parsed);
  check(
    "a poison value never replaces the local one when it is older",
    entryOf(merged.doc, "reading")?.value === READING_A,
  );
}

{
  const empty = parsePreferences(null);
  check("nothing parses as an empty document", empty.updatedAt === 0 && Object.keys(empty.entries).length === 0);

  const localOnly = parseLocalPreferences({
    entries: { reading: { updatedAt: 0, value: READING_A } },
  });
  check(
    "this device's record keeps a value that has no stamp yet",
    same(entryOf(localOnly, "reading")?.value, READING_A),
    localOnly,
  );
  check(
    "…and its document stamp stays zero",
    localOnly.updatedAt === 0,
    localOnly.updatedAt,
  );
}

/* ------------------------------------------------------------- stamps, body */

{
  const now = 1_700_000_000_000;
  check("a stamp follows the clock when it has moved", nextPrefsStamp(now - 5, now) === now);
  check(
    "a stamp is still strictly newer when the clock has not ticked",
    nextPrefsStamp(now, now) === now + 1,
  );
  check(
    "a stamp is still strictly newer when the clock has gone backwards",
    nextPrefsStamp(now, now - 60_000) === now + 1,
  );
}

{
  const full = doc({
    reading: entry(READING_A, 100),
    theme: entry(THEME_A, 250),
  });
  const body = preferencesBody(full);
  const back = parsePreferences(body);

  check("the body carries the newest stamp", body.updatedAt === 250, body.updatedAt);
  check("the body round trips", samePreferences(full, back), body);
  check(
    "namespaces this device does not hold are absent from the body",
    !Object.hasOwn(body.entries, "search"),
    Object.keys(body.entries),
  );

  const unstamped = doc({ reading: entry(READING_A, 0) });
  check(
    "an unstamped value is never sent",
    Object.keys(preferencesBody(unstamped).entries).length === 0,
    preferencesBody(unstamped),
  );
}

{
  const local = doc({ reading: entry(READING_A, 900) });
  const remote = doc({ reading: entry(READING_B, 800), theme: entry(THEME_A, 950) });
  const merged = mergePreferences(local, remote);

  check(
    "newerThan names only the namespaces this device wins",
    newerThan(merged.doc, remote).join(",") === "reading",
    newerThan(merged.doc, remote),
  );
  check(
    "newerThan names nothing when the account is ahead",
    newerThan(remote, merged.doc).length === 0,
    newerThan(remote, merged.doc),
  );
  check("sameValue compares content, not identity", sameValue({ a: 1 }, { a: 1 }));
  check("sameValue sees a changed field", !sameValue({ a: 1 }, { a: 2 }));
}

/* -------------------------------------------------------- the offline queue */

{
  // Two changes while the network was down, flushed in the order they happened.
  const first = doc({ reading: entry(READING_A, 100) });
  const second = doc({ reading: entry(READING_B, 200) });
  const queue = new PrefsQueue();
  queue.enqueue(first);
  queue.enqueue(second);

  const sent = [];
  const outcome = await queue.flush(async (next) => {
    sent.push(next.updatedAt);
    return "sent";
  });

  check("a queued pair flushes in order", sent.join(",") === "100,200", sent);
  check("…and drains", outcome === "drained" && queue.size === 0, { outcome, size: queue.size });
}

{
  // The first send fails: the head stays, and the second flush resumes without
  // losing or duplicating anything.
  const first = doc({ reading: entry(READING_A, 100) });
  const second = doc({ reading: entry(READING_B, 200) });
  const queue = new PrefsQueue();
  queue.enqueue(first);
  queue.enqueue(second);

  const attempts = [];
  const offline = await queue.flush(async (next) => {
    attempts.push(`fail:${next.updatedAt}`);
    return "retry";
  });

  check("an offline flush reports itself", offline === "offline", offline);
  check("…keeps the unsent head", queue.size === 2 && queue.peek()?.updatedAt === 100, queue.size);

  const sent = [];
  const online = await queue.flush(async (next) => {
    sent.push(next.updatedAt);
    return "sent";
  });

  check(
    "the retry sends the failed write first, then the one behind it",
    sent.join(",") === "100,200",
    sent,
  );
  check("…and drains", online === "drained" && queue.size === 0, online);
  check("…with no duplicate attempt of the first", attempts.length === 1, attempts);
}

{
  // A failure in the middle of a batch leaves the rest queued, in order.
  const queue = new PrefsQueue();
  queue.enqueue(doc({ reading: entry(READING_A, 100) }));
  queue.enqueue(doc({ reading: entry(READING_B, 200) }));
  queue.enqueue(doc({ theme: entry(THEME_A, 300) }));

  let calls = 0;
  const outcome = await queue.flush(async () => {
    calls += 1;
    return calls < 2 ? "sent" : "retry";
  });

  check(
    "a failure after one success stops the flush",
    outcome === "offline" && calls === 2,
    { outcome, calls },
  );
  check("…with the unsent tail still queued", queue.size === 2, queue.size);
  check("…headed by the write that failed", queue.peek()?.updatedAt === 200, queue.peek()?.updatedAt);
}

{
  // The server says it can never take this: no route, or a read-only session.
  const queue = new PrefsQueue();
  queue.enqueue(doc({ reading: entry(READING_A, 100) }));
  queue.enqueue(doc({ reading: entry(READING_B, 200) }));

  let calls = 0;
  const outcome = await queue.flush(async () => {
    calls += 1;
    return "stop";
  });

  check("a stop is reported", outcome === "stopped", outcome);
  check("…and the queue is not retried", calls === 1, calls);
  check("…and is emptied", queue.size === 0, queue.size);
}

{
  // Snapshots are full copies, so the newest one alone is enough: an old one
  // past the limit can be forgotten without losing anything.
  const queue = new PrefsQueue(2);
  queue.enqueue(doc({ reading: entry(READING_A, 100) }));
  queue.enqueue(doc({ reading: entry(READING_B, 200) }));
  queue.enqueue(doc({ theme: entry(THEME_A, 300) }));

  check("the queue is bounded", queue.size === 2, queue.size);
  check("…by dropping the oldest snapshots", queue.peek()?.updatedAt === 200, queue.peek()?.updatedAt);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
