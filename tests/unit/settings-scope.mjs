/**
 * Settings belong to the person, not to the feed server.
 *
 * The owner's rule (2026-11-05): *"all the settings that are kept should be
 * hardlyreader account based not based off whatever sync account they have
 * connect, with freshrss ofc being the exception if they have the correct
 * extensions"*, and, on the free path, *"mirror"* — the server's
 * `/v1/preferences` route stays as carriage for the person's document rather than
 * becoming an entitlement.
 *
 * What this suite holds still:
 *
 *   - the scope is the HardlyReader account's `userId` when one is signed in, and
 *     this device when one is not — never `accountSlug(serverUrl|email)`;
 *   - the layout, the reading choices and the chrome preferences all read and
 *     write through it, and none of them writes a feed-account key;
 *   - the copies a per-server build left behind are carried across once, and the
 *     ownership rule still refuses a stranger's copy;
 *   - the prefs document's record is filed by that scope, while what stays per
 *     feed account (sidebar arrangement, reading place, offline copy, the
 *     extension-state snapshot) is still per feed account — those ids are that
 *     server's own;
 *   - the mirror is intact: the document is still sent over the session's own
 *     adapter route, and a merge is still decided per namespace by its stamp.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { accountSlug, scopedKey } from "../../src/lib/account-key.ts";
import {
  DEVICE_IDENTITY,
  PERSON_SERVER,
  personIdentity,
  readSettings,
  settingsAccount,
  settingsKey,
  settingsSlug,
  writeSettings,
} from "../../src/lib/settings-scope.ts";
import { IDENTITY_KEY } from "../../src/lib/identity-key.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function memoryStore(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

const ONE = { serverUrl: "https://one.example", email: "one@one.example" };
const TWO = { serverUrl: "https://two.example", email: "two@two.example" };
const SESSION_KEY = "hardlyreader.session";
const identity = (userId) => JSON.stringify({ userId, token: "t", provider: "email" });

// ---------------------------------------------------------------------------
// 1. One scope: the person, or this device
// ---------------------------------------------------------------------------

{
  const bare = memoryStore();
  check("no identity means this device", personIdentity(bare) === null);
  check(
    "...and the device scope is a fixed pseudo-account",
    settingsAccount(bare).serverUrl === DEVICE_IDENTITY.serverUrl &&
      settingsAccount(bare).email === DEVICE_IDENTITY.email,
  );
  check("a corrupt identity record is no account", personIdentity(memoryStore({ [IDENTITY_KEY]: "{not json" })) === null);
  check(
    "an identity without a userId is no account",
    personIdentity(memoryStore({ [IDENTITY_KEY]: JSON.stringify({ token: "t" }) })) === null,
  );

  const signed = memoryStore({ [IDENTITY_KEY]: identity("person-a") });
  const person = personIdentity(signed);
  check("a signed-in device scopes to the person", person?.email === "person-a");
  check("...under a server a real address can never be", person?.serverUrl === PERSON_SERVER);
  check(
    "and the feed account is not part of the scope",
    settingsSlug(memoryStore({ [IDENTITY_KEY]: identity("person-a"), [SESSION_KEY]: JSON.stringify(ONE) })) ===
      settingsSlug(memoryStore({ [IDENTITY_KEY]: identity("person-a"), [SESSION_KEY]: JSON.stringify(TWO) })),
  );
}

// ---------------------------------------------------------------------------
// 2. Two feed accounts, one set of settings — and no feed-account key
// ---------------------------------------------------------------------------

{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(ONE) });
  writeSettings(storage, "hardlyreader.reading.v1", JSON.stringify({ listView: "cards" }));
  check(
    "a write lands on the settings key",
    storage.getItem(settingsKey(storage, "hardlyreader.reading.v1"))?.includes('"cards"') === true,
    [...storage.store.keys()].join(", "),
  );
  check(
    "and never on the feed account's key",
    storage.getItem(scopedKey("hardlyreader.reading.v1", ONE)) === null &&
      storage.getItem(scopedKey("hardlyreader.reading.v1", TWO)) === null,
  );

  // Switching the server changes nothing about the scope.
  storage.setItem(SESSION_KEY, JSON.stringify(TWO));
  check("the other server reads the same choice", readSettings(storage, "hardlyreader.reading.v1")?.includes('"cards"') === true);
  check("...from the same one key", storage.store.size === 2, [...storage.store.keys()].join(", "));

  // Signing into the HardlyReader account moves the scope to the person.
  storage.setItem(IDENTITY_KEY, identity("person-a"));
  check("a person's scope is their own", settingsKey(storage, "x").startsWith("x:"));
  check(
    "and the device's copy is not theirs",
    readSettings(storage, "hardlyreader.reading.v1") === null ||
      readSettings(storage, "hardlyreader.reading.v1")?.includes('"cards"') === true,
  );
}

// ---------------------------------------------------------------------------
// 3. The move off per-server keys, once
// ---------------------------------------------------------------------------

{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(ONE), [IDENTITY_KEY]: identity("person-c") });
  storage.setItem(scopedKey("hardlyreader.layout.v1", ONE), JSON.stringify({ mode: 2 }));
  check("a copy written per server is read by the person", readSettings(storage, "hardlyreader.layout.v1")?.includes('"mode":2') === true);
  check(
    "...and carried onto the person's key",
    storage
      .getItem(scopedKey("hardlyreader.layout.v1", { serverUrl: PERSON_SERVER, email: "person-c" }))
      ?.includes('"mode":2') === true,
  );
  check("the feed account's key is left for a downgrade", storage.getItem(scopedKey("hardlyreader.layout.v1", ONE)) !== null);

  // A second person on the same device gets defaults, not the first one's copy.
  const shared = memoryStore({ [SESSION_KEY]: JSON.stringify(TWO), [IDENTITY_KEY]: identity("person-d") });
  shared.setItem(scopedKey("hardlyreader.layout.v1", TWO), JSON.stringify({ mode: 3 }));
  shared.setItem("hardlyreader.layout.v1:legacy-owner", accountSlug(DEVICE_IDENTITY));
  check("another scope's claimed copy is not adopted", readSettings(shared, "hardlyreader.layout.v1") === null);
}

// ---------------------------------------------------------------------------
// 4. The stores are wired to it, and nothing else moved
// ---------------------------------------------------------------------------

{
  const reading = read("src/state/reading.svelte.ts");
  const layout = read("src/state/layout.svelte.ts");
  const chrome = read("src/lib/chrome-prefs.ts");
  const prefs = read("src/state/prefs.svelte.ts");

  check("the reading choices read the settings scope", /readSettings\(localStorage, STORAGE_KEY\)/.test(reading));
  check("...and write it", /writeSettings\(localStorage, STORAGE_KEY,/.test(reading));
  check(
    "...without asking the feed account",
    !/readAccountValue\(localStorage, STORAGE_KEY, storedAccount\(localStorage\)\)/.test(reading),
  );
  check("the layout reads and writes the settings scope", /readSettings\(localStorage, STORAGE_KEY\)/.test(layout) && /writeSettings\(\s*localStorage,\s*STORAGE_KEY,/.test(layout));
  check("the chrome preferences do too", /readSettings\(storage, CHROME_KEY\)/.test(chrome) && /writeSettings\(storage, CHROME_KEY,/.test(chrome));
  check(
    "a chrome reader still takes an account for its callers, and ignores it",
    /_account: AccountIdentity \| null = null,/.test(chrome),
  );

  // The prefs record is the person's; the wire is still the session's (the mirror).
  check(
    "the prefs record is filed by the settings scope",
    /scopedKey\(RECORD_KEY, settingsAccount\(localStorage\)\)/.test(prefs),
  );
  check(
    "the mirror still goes out over the session's adapter route",
    /preferences/.test(prefs) && /this\.session/.test(prefs),
  );
  const doc = read("src/lib/prefs-sync.ts");
  check("a merge is still decided per namespace by its stamp", /newerThan/.test(doc) && /mergePreferences/.test(doc));

  // What stays per feed account, because the ids are that server's own.
  const reader = read("src/state/reader.svelte.ts");
  const place = read("src/lib/place.ts");
  const snapshot = read("src/lib/api-snapshot.ts");
  const split = read("src/state/split.svelte.ts");
  check("the sidebar arrangement is still per feed account", /readAccountValue\(localStorage, PREFS_BASE, scope/.test(reader));
  check("the offline copy is still per feed account", /readAccountValue\(storage, KEPT_BASE, scope\)/.test(reader));
  check("the reading place is still per feed account", /scopedKey\(PLACE_BASE, account\)/.test(place));
  check("the extension-state snapshot is still per feed account", /readAccountValue\(storage, API_SNAPSHOT_KEY, account\)/.test(snapshot));
  check("the split arrangement is still per feed account", /readAccountValue\(store, SPLIT_BASE, this\.account\)/.test(split));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
