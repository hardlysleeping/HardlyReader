/**
 * Several accounts in one window: the reader's half.
 *
 * `account-registry.mjs` proves the set (slug identity, removal, `enabled`). This is
 * about the reader holding that set while still reading exactly one account — the
 * pointer and the set are different things, and the three ways they could drift are
 * the three things checked here:
 *
 *   1. turning an account off for merged views must not change who is being read;
 *   2. signing an account out must not be able to sign out the one on screen;
 *   3. `start()` must file the account before it hydrates, or a launch that fails
 *      halfway leaves Pane 1 with nothing to draw.
 *
 * The network paths are not exercised: `focus()` and `start()` hydrate streams, so
 * they are asserted against the source and left to the live pass.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/multi-account.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { localProfile, syncProfile } from "../../src/api/profile.ts";
import { buildReaderModule, GEN_DIR } from "./build-reader.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

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

const readerFile = readFileSync(new URL("../../src/state/reader.svelte.ts", import.meta.url), "utf8");

// A runes module cannot be imported by Node: it is compiled to plain ESM first,
// with every relative import rewritten (see `build-reader.mjs`).
mkdirSync(GEN_DIR, { recursive: true });
writeFileSync(join(GEN_DIR, "reader-accounts.mjs"), buildReaderModule());
const { ReaderState } = await import(pathToFileURL(join(GEN_DIR, "reader-accounts.mjs")).href);

function backend(kind = "greader") {
  return { kind };
}

function session(email) {
  return { serverUrl: "https://reader.example", apiPath: "/api/greader.php", email, token: `t-${email}` };
}

const a = syncProfile(session("a@example.com"), backend());
const b = syncProfile(session("b@example.com"), backend());
const local = localProfile(backend("local"), "On this device");

function readerWith(list) {
  const reader = new ReaderState();
  reader.adoptAccounts(list);
  return reader;
}

// ---------------------------------------------------------------------------
// The set, and the pointer.
// ---------------------------------------------------------------------------

{
  const reader = readerWith([a, b]);
  equal("the reader knows both accounts", reader.accountList.map((p) => p.slug), [a.slug, b.slug]);
  equal("and both are part of a merged view by default", reader.mergedAccounts.length, 2);

  check("turning one off for merged views succeeds", reader.enableAccount(b.slug, false) === true);
  equal("it leaves the merged view", reader.mergedAccounts.map((p) => p.slug), [a.slug]);
  equal("but stays signed in, in the full list", reader.accountList.length, 2);
  check("and is still marked as such", reader.accountList.find((p) => p.slug === b.slug)?.enabled === false);
  check("turning it back on puts it back", reader.enableAccount(b.slug, true) === true && reader.mergedAccounts.length === 2);
  check("an account that is not there cannot be turned on", reader.enableAccount("nope", true) === false);
}

// ---------------------------------------------------------------------------
// Signing out, and the account that must not be signed out.
// ---------------------------------------------------------------------------

{
  const reader = readerWith([a, b]);
  // What `start()` would have done, without the hydration.
  reader.profile = b;
  reader.backend = b.backend;
  check("the account being read refuses to be removed", reader.removeAccount(b.slug) === false);
  equal("so it is still there", reader.accountList.length, 2);
  check("another one goes", reader.removeAccount(a.slug) === true);
  equal("and only the account in use is left", reader.accountList.map((p) => p.slug), [b.slug]);
  check("removing it again says there was nothing to remove", reader.removeAccount(a.slug) === false);
}

// ---------------------------------------------------------------------------
// A local library is one of the accounts, not a mode.
// ---------------------------------------------------------------------------

{
  const reader = readerWith([local, a, b]);
  equal("three accounts, one of them on this device", reader.accountList.length, 3);
  check(
    "the local library merges alongside the servers",
    reader.mergedAccounts.some((p) => p.kind === "local") && reader.mergedAccounts.length === 3,
  );
  reader.enableAccount(local.slug, false);
  equal("and can be left out of a merged view on its own", reader.mergedAccounts.length, 2);
}

// ---------------------------------------------------------------------------
// A pane opened from an account inherits the set.
// ---------------------------------------------------------------------------

{
  const parent = readerWith([a, b]);
  parent.profile = a;
  parent.backend = a.backend;
  const pane = new ReaderState({ pane: true });
  pane.seedFrom(parent);
  equal("a pane sees the same accounts", pane.accountList.map((p) => p.slug), [a.slug, b.slug]);
  // By slug, not identity: `profile` and `backend` are runes, so Svelte hands back a
  // proxy and `pane.profile === a` is false for the same account.
  check("...and reads the same account", pane.profile !== null && pane.profile.slug === a.slug);
}

// ---------------------------------------------------------------------------
// The wiring that cannot be driven without a network.
// ---------------------------------------------------------------------------

check(
  "start() files the account before it hydrates anything",
  /this\.accounts\.add\(profile\);\s*this\.publishAccounts\(\);\s*this\.resetForAccount\(\);/.test(readerFile),
);
check(
  "starting on an account already being read is not a second round trip",
  /if \(this\.profile !== null && profileSlug\(this\.profile\) === slug\) return true;/.test(readerFile),
);
check(
  "focus() reads an account from the set, never builds one",
  /async focus\(slug: string\): Promise<boolean> \{[\s\S]{0,400}?const profile = this\.accounts\.get\(slug\);/.test(readerFile) &&
    !/focus\([\s\S]{0,400}?syncProfile\(/.test(readerFile),
);
check(
  "only publishAccounts() writes the rune",
  (readerFile.match(/this\.accountList = /g) ?? []).length === 1,
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
