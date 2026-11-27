/**
 * The session token is in the OS store, with a copy in the record.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs session-token.mjs
 *
 * What this pins, because each of them would be a bug a reader feels:
 *
 * - an **upgrade** (a record with the token inline) moves the token to the store
 *   and keeps a copy in the record, so it still signs the reader in;
 * - a **current** record comes back with its token after the boot's hydrate;
 * - a **store that lost its values** (a re-signed sideload reads a different
 *   Keychain) must NOT end the sign-in: the record's copy answers, the store is
 *   healed and the account stays listed;
 * - a record with **no copy anywhere** is dropped rather than offered as a
 *   sign-in that always fails;
 * - a **write** puts the token in the store and keeps the record's copy, and a
 *   **delete** takes both.
 *
 * The device store is what is exercised here: `lib/secrets` picks it whenever the
 * page has no shell, which is exactly this suite.
 */
import { ACCOUNTS_KEY, SESSION_KEY, hydrateSessions, loadSession, readSessions, saveSession, clearSession, tokenKey, writeSessions } from "../../src/api/session.ts";
import { DEVICE_PREFIX } from "../../src/lib/secrets.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const map = new Map();
globalThis.localStorage = {
  get length() {
    return map.size;
  },
  key: (index) => [...map.keys()][index] ?? null,
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key),
  clear: () => map.clear(),
};

const session = (token, email = "me@example.test", serverUrl = "https://example.test") => ({
  serverUrl,
  apiPath: "/api/greader.php",
  email,
  token,
});
const secretOf = (entry) => map.get(`${DEVICE_PREFIX}${tokenKey(entry)}`) ?? null;
const recordOf = (key) => JSON.parse(map.get(key) ?? "null");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 1. An upgrade: the token is inline, and must move without losing the sign-in
// ---------------------------------------------------------------------------
{
  map.clear();
  const legacy = session("token-legacy");
  map.set(SESSION_KEY, JSON.stringify(legacy));
  map.set(ACCOUNTS_KEY, JSON.stringify([legacy]));
  const usable = await hydrateSessions();
  check("an upgrade leaves one usable session", usable === 1, String(usable));
  check("the token is in the store", secretOf(legacy) === "token-legacy", String(secretOf(legacy)));
  check("...and kept in the record", recordOf(SESSION_KEY).token === "token-legacy", JSON.stringify(recordOf(SESSION_KEY)));
  check("...marked as stored", recordOf(SESSION_KEY).tokenStored === true);
  check("...and kept in the list too", recordOf(ACCOUNTS_KEY)[0].token === "token-legacy");
  check("the reader is still signed in", loadSession()?.token === "token-legacy", JSON.stringify(loadSession()));
  check("the account is still listed", readSessions().length === 1 && readSessions()[0].token === "token-legacy");
}

// ---------------------------------------------------------------------------
// 2. A current record: token already moved, read back by the boot's hydrate
// ---------------------------------------------------------------------------
{
  map.clear();
  const current = session("token-current", "current@example.test");
  map.set(SESSION_KEY, JSON.stringify({ ...current, token: "", tokenStored: true }));
  map.set(`${DEVICE_PREFIX}${tokenKey(current)}`, "token-current");
  check("before hydrating there is no usable session", loadSession() === null);
  const usable = await hydrateSessions();
  check("after hydrating the session is usable", usable === 1 && loadSession()?.token === "token-current", JSON.stringify(loadSession()));
}

// ---------------------------------------------------------------------------
// 3. A record with no copy anywhere: dropped, not offered as a broken sign-in
// ---------------------------------------------------------------------------
{
  map.clear();
  const orphan = session("token-orphan");
  map.set(SESSION_KEY, JSON.stringify({ ...orphan, token: "", tokenStored: true }));
  const usable = await hydrateSessions();
  check("no usable session", usable === 0 && loadSession() === null);
  check("the dead record is removed", map.get(SESSION_KEY) === undefined);
}

// ---------------------------------------------------------------------------
// 4. A store that lost its values must not end the sign-in
//
// A sideloaded iOS build reads the Keychain under its own signing identity, so a
// re-signed install finds an empty store while the app's own records are still
// there. The launch after it must keep the reader signed in, heal the store and
// leave the account listed: an update that asks for the password again is the bug
// this pins.
// ---------------------------------------------------------------------------
{
  map.clear();
  const kept = session("token-kept", "kept@example.test");
  const record = { ...kept, token: "token-kept", tokenStored: true };
  map.set(SESSION_KEY, JSON.stringify(record));
  map.set(ACCOUNTS_KEY, JSON.stringify([record]));
  const usable = await hydrateSessions();
  check("a lost store still signs the reader in", usable === 1 && loadSession()?.token === "token-kept", JSON.stringify(loadSession()));
  check("the account is still listed", readSessions().length === 1, String(readSessions().length));
  check("the store is healed", secretOf(kept) === "token-kept", String(secretOf(kept)));
  check("the record is still there", map.get(SESSION_KEY) !== undefined);
}

// ---------------------------------------------------------------------------
// 4b. The same launch through the shell's own command channel
//
// This is the iPhone's path: `secret_get` is `hr_keychain_get`, and a re-signed
// app finds an empty Keychain while the record still carries its copy.
// ---------------------------------------------------------------------------
{
  map.clear();
  const native = new Map();
  const invoke = async (command, args) => {
    if (command === "secret_get") return native.get(args.key) ?? null;
    if (command === "secret_set") {
      native.set(args.key, args.value);
      return null;
    }
    if (command === "secret_delete") native.delete(args.key);
    return null;
  };
  const phone = session("token-phone", "phone@example.test");
  map.set(SESSION_KEY, JSON.stringify({ ...phone, token: "token-phone", tokenStored: true }));
  const usable = await hydrateSessions({ invoke });
  check("a native store that answers nothing still signs in", usable === 1 && loadSession()?.token === "token-phone", JSON.stringify(loadSession()));
  check("...and the native store is written back", native.get(tokenKey(phone)) === "token-phone", String(native.get(tokenKey(phone))));
}

// ---------------------------------------------------------------------------
// 5. Writing: the store holds the token, and the record keeps a fallback copy
// ---------------------------------------------------------------------------
{
  map.clear();
  const fresh = session("token-fresh", "new@example.test");
  saveSession(fresh);
  await tick();
  check("the store has it", secretOf(fresh) === "token-fresh");
  check("...marked as stored", recordOf(SESSION_KEY).tokenStored === true);
  check("...and the record keeps its own copy", recordOf(SESSION_KEY).token === "token-fresh", JSON.stringify(recordOf(SESSION_KEY)));
  check("this launch can still read it", loadSession()?.token === "token-fresh");

  writeSessions([fresh]);
  await tick();
  check("a written list keeps the copy too", recordOf(ACCOUNTS_KEY)[0].token === "token-fresh", JSON.stringify(recordOf(ACCOUNTS_KEY)));
  check("...and the store does", secretOf(fresh) === "token-fresh");
}

// ---------------------------------------------------------------------------
// 6. Signing out: both halves go
// ---------------------------------------------------------------------------
{
  map.clear();
  const gone = session("token-gone");
  saveSession(gone);
  await tick();
  clearSession();
  await tick();
  check("the record is gone", map.get(SESSION_KEY) === undefined);
  check("the secret is gone", secretOf(gone) === null, String(secretOf(gone)));
  check("no session is read", loadSession() === null);
}

// ---------------------------------------------------------------------------
// 7. A malformed record is discarded rather than thrown over
// ---------------------------------------------------------------------------
{
  map.clear();
  map.set(SESSION_KEY, "{not json");
  check("a broken record reads as no session", loadSession() === null);
  check("...and is removed", map.get(SESSION_KEY) === undefined);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;