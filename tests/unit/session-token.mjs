/**
 * The session token is not in the session record any more.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs session-token.mjs
 *
 * What this pins, because each of them would be a bug a reader feels:
 *
 * - an **upgrade** (a record with the token inline) moves the token to the store,
 *   rewrites the record without it, and still signs the reader in;
 * - a **current** record (token moved) comes back with its token after the boot's
 *   hydrate, which is what every sync reader in the app relies on;
 * - a record whose **secret is missing** is dropped rather than offered as a
 *   sign-in that always fails;
 * - a **write** never leaves the token in storage, and a **delete** takes both.
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
  check("...and gone from the record", recordOf(SESSION_KEY).token === "", JSON.stringify(recordOf(SESSION_KEY)));
  check("...marked as moved", recordOf(SESSION_KEY).tokenStored === true);
  check("...and gone from the list too", recordOf(ACCOUNTS_KEY)[0].token === "");
  check("the reader is still signed in", loadSession()?.token === "token-legacy", JSON.stringify(loadSession()));
  check("the account is still listed", readSessions().length === 1 && readSessions()[0].token === "token-legacy");
  check("nothing plain is left under the old key", !JSON.stringify(recordOf(SESSION_KEY)).includes("token-legacy"));
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
  await hydrateSessions();
  check("after hydrating the session is back", loadSession()?.token === "token-current");
}

// ---------------------------------------------------------------------------
// 3. A record whose secret is gone: dropped, not offered as a broken sign-in
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
// 4. Writing: the record never carries the token, the store does
// ---------------------------------------------------------------------------
{
  map.clear();
  const fresh = session("token-fresh", "new@example.test");
  saveSession(fresh);
  await tick();
  check("the record has no token", recordOf(SESSION_KEY).token === "", JSON.stringify(recordOf(SESSION_KEY)));
  check("...but says where it went", recordOf(SESSION_KEY).tokenStored === true);
  check("the store has it", secretOf(fresh) === "token-fresh");
  check("this launch can still read it", loadSession()?.token === "token-fresh");

  writeSessions([fresh]);
  await tick();
  check("a written list carries no tokens", recordOf(ACCOUNTS_KEY)[0].token === "", JSON.stringify(recordOf(ACCOUNTS_KEY)));
  check("...and the store does", secretOf(fresh) === "token-fresh");
}

// ---------------------------------------------------------------------------
// 5. Signing out: both halves go
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
// 6. A malformed record is discarded rather than thrown over
// ---------------------------------------------------------------------------
{
  map.clear();
  map.set(SESSION_KEY, "{not json");
  check("a broken record reads as no session", loadSession() === null);
  check("...and is removed", map.get(SESSION_KEY) === undefined);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
