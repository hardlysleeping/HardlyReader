/**
 * One person, one account: linking, deleting, and the device list.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/account.mjs
 *
 * `tests/unit/identity.mjs` is about what an account *is*; this suite is about
 * what happens when one reader has more than one way in, when they leave, and
 * when they want a device signed out from another one. Three promises, and each
 * is checked against something that could actually break it:
 *
 * 1. **Two providers, one subscription.** Linking a second door keeps the same
 *    `auth.users` id, which is the key of the entitlement row — so the same row is
 *    read, the same cache entry answers offline, and a second sign-in is refused
 *    rather than quietly creating a second account with no purchase attached.
 * 2. **Deleting the account deletes one row in `auth` and nothing else.** The
 *    local library is opened and read back afterwards, the reader's cloud folder
 *    is not reachable from this code path at all (checked in the source, not
 *    assumed), and the SQL cannot do it either.
 * 3. **Revoking a device signs that device out and leaves its library.** The
 *    revocation is one call; the device's next refresh is what ends its session,
 *    and the suite drives that through the identity seam with a real library open.
 *
 * The network is a recorded fake and the SQL is read off disk, so none of this
 * needs a Supabase project — and the claims about the schema are checked against
 * the file that will actually be applied.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { READING_LIST } from "../../src/api/freshrss.ts";
import { GEN_DIR, ROOT } from "./build-reader.mjs";
import {
  ACCOUNT_DELETED,
  CANCEL_FIRST,
  DEVICE_REVOKED,
  NOT_SIGNED_IN,
  PROVIDER_FILES_ACTION,
  PROVIDER_FILES_WARNING,
  REVOKE_THIS_DEVICE,
  deleteAccount,
  describeDevice,
  listDevices,
  registerDevice,
  revokeDevice,
} from "../../src/api/account.ts";
import {
  FakeIdentity,
  fakeToken,
  readIdentityRecord,
  sessionIdOf,
} from "../../src/api/identity.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** The capability module, built the way the state suites build theirs. */
function buildEntitlementsModule() {
  const file = join(ROOT, "src/state/entitlements.svelte.ts");
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "entitlements.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "entitlements.svelte.ts" });
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "entitlements.mjs");
  writeFileSync(out, compiled.js.code);
  return pathToFileURL(out).href;
}

const { ENTITLEMENT_CACHE_PREFIX, RemoteStore } = await import(buildEntitlementsModule());

const PROJECT = "https://fixtureproject.supabase.co";
const ANON_KEY = "anon-key-not-a-secret";
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";
const SESSION = "33333333-3333-3333-3333-333333333333";
const OTHER_SESSION = "44444444-4444-4444-4444-444444444444";
const NOW = Date.now();
const FEED = "https://fixture.test/feed.xml";
const T = 1_700_000_000;

/* --------------------------------------------------------------------------
 * The three things a test drives instead of a project, a browser and a network
 * ----------------------------------------------------------------------- */

/** A `KeyStore` in memory, so "restart" is two identities over one object. */
function memoryKeys() {
  const held = new Map();
  return {
    held,
    getItem: (key) => (held.has(key) ? held.get(key) : null),
    setItem: (key, value) => {
      held.set(key, String(value));
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

/** `localStorage`, without a browser. */
class MemoryStorage {
  entries = new Map();
  getItem(key) {
    return this.entries.has(key) ? this.entries.get(key) : null;
  }
  setItem(key, value) {
    this.entries.set(key, String(value));
  }
}

/** A recorded network. `answer` decides what the server "said". */
function server(answer) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init, calls.length);
  };
  return { request, calls };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The session a `RemoteStore` reads: whoever this device is signed in as. */
const sessionOf = (id) => (id.userId === null ? null : { userId: id.userId, token: id.token });

/** A token for a device, with the session claim a device list keys on. */
const tokenFor = (userId, sessionId) => fakeToken({ sub: userId, session_id: sessionId });

/* --------------------------------------------------------------------------
 * A real library on this device: one feed, two posts
 * ----------------------------------------------------------------------- */

async function library() {
  const store = new LocalStore(new MemoryDatabase());
  const backend = new LocalBackend(store, { deviceName: "This laptop" });
  await backend.subscribe({ feedUrl: FEED, title: "Fixture feed" });
  await store.putEntries([
    { feedUrl: FEED, guid: "one", title: "Fixture one", published: T + 20, content: "<p>First.</p>" },
    { feedUrl: FEED, guid: "two", title: "Fixture two", published: T + 10, content: "<p>Second.</p>" },
  ]);
  return { store, backend };
}

async function shelf({ store, backend }) {
  const contents = await backend.stream(READING_LIST, { count: 10 });
  const feeds = await store.feeds();
  const page = await store.queryEntries({ count: 10 });
  return {
    titles: contents.items.map((item) => item.title).join(","),
    posts: page.entries.length,
    feeds: feeds.length,
    firstId: page.entries[0] ? localItemId(FEED, "one") : null,
  };
}

/* --------------------------------------------------------------------------
 * Trap 5: two providers, one person, one subscription
 * ----------------------------------------------------------------------- */

{
  const keys = memoryKeys();
  const storage = new MemoryStorage();
  const id = new FakeIdentity({ keys });
  await id.signIn("google");
  const userId = id.userId;
  const session = id.sessionId;

  const paid = server(() => json(200, [{ cloud_sync: true, expires_at: null }]));
  const store = new RemoteStore({
    url: PROJECT,
    anonKey: ANON_KEY,
    session: () => sessionOf(id),
    request: paid.request,
    storage,
    now: () => NOW,
    timeoutMs: 50,
  });

  const before = await store.current();
  check("a Google sign-in reads the subscription it paid for", before.state === "active", before.state);
  check(
    "and the answer is cached under that reader's id",
    storage.getItem(`${ENTITLEMENT_CACHE_PREFIX}.${userId}`) !== null,
    [...storage.entries.keys()].join(","),
  );
  check(
    "the row asked for is the reader's own",
    paid.calls.length === 1 && paid.calls[0].url.includes(`user_id=eq.${userId}`),
    paid.calls[0]?.url ?? "(none)",
  );
  check(
    "and the query asks for the capability and the date, and no provider",
    !/source|provider/i.test(paid.calls[0].url) && /select=cloud_sync,expires_at&/.test(paid.calls[0].url),
    paid.calls[0].url,
  );

  // Apple, added later, from the sheet: the same account, one more door.
  await id.link("apple");
  check("adding Apple keeps one account", id.userId === userId, `${userId} → ${id.userId}`);
  check("and one session", id.sessionId === session, `${session} → ${id.sessionId}`);
  check("and both doors are known", id.providers.join(",") === "google,apple", id.providers.join(","));
  check(
    "and the stored record keeps the same id, so a restart cannot land elsewhere",
    readIdentityRecord(keys)?.userId === userId,
    String(readIdentityRecord(keys)?.userId),
  );
  check(
    "the cache entry the subscription lives in is the same key",
    storage.getItem(`${ENTITLEMENT_CACHE_PREFIX}.${id.userId}`) !== null,
  );

  // The reader comes back on a plane, through the other door: the last answer
  // still stands, because it was never keyed by a provider.
  const offline = new RemoteStore({
    url: PROJECT,
    anonKey: ANON_KEY,
    session: () => sessionOf(id),
    request: async () => {
      throw new Error("no network");
    },
    storage,
    now: () => NOW,
    timeoutMs: 50,
  });
  const off = await offline.current();
  check("a Linked account read offline still has the subscription", off.state === "active", off.state);
  check("and says nothing is wrong", off.reason === null, String(off.reason));

  // The trap itself: signing in again instead of linking.
  const second = new FakeIdentity({ keys: memoryKeys() });
  await second.signIn("google");
  const was = second.userId;
  await second.signIn("apple");
  check("a second sign-in is refused, so it cannot create a second account", second.userId === was, String(second.userId));
  check("and the sentence says what to do instead", /already signed in/i.test(String(second.notice)));
  check("and names the door they tried", /Apple/.test(String(second.notice)), String(second.notice));
  check(
    "the provider was never asked for a second sign-in",
    second.calls.join(",") === "signIn:google,signInRefused:apple",
    second.calls.join(","),
  );

  // A link the provider refuses is the sheet's to show, and the account is unmoved.
  const refused = new FakeIdentity({ keys: memoryKeys(), failLink: true });
  await refused.signIn("google");
  const held = refused.userId;
  let threw = false;
  try {
    await refused.link("apple");
  } catch {
    threw = true;
  }
  check("a refused link rejects, because a sheet asked for it", threw);
  check("and the account is still the one that was there", refused.userId === held);
  check("and still has only its own door", refused.providers.join(",") === "google", refused.providers.join(","));

  // A change of address is not a second account either.
  const changing = new FakeIdentity({ keys: memoryKeys() });
  await changing.signIn("google");
  const idBefore = changing.userId;
  await changing.link("email", "new@fixture.test");
  check("a changed address keeps one account", changing.userId === idBefore, String(changing.userId));
  check("and becomes the address on the account", changing.email === "new@fixture.test", String(changing.email));
  check("and says it has to be confirmed", /confirm/i.test(String(changing.notice)), String(changing.notice));

  // Linking with nothing to link to is a sentence, not an account.
  const nobody = new FakeIdentity({ keys: memoryKeys() });
  await nobody.link("apple");
  check("linking with no account signs nobody in", nobody.userId === null);
  check("and says to sign in first", /sign in first/i.test(String(nobody.notice)), String(nobody.notice));
  check("and asks the provider nothing", nobody.calls.join(",") === "", nobody.calls.join(",") || "(none)");
}

/* --------------------------------------------------------------------------
 * Trap 18: deleting an account, and the two things it must not take with it
 * ----------------------------------------------------------------------- */

{
  const keys = memoryKeys();
  const id = new FakeIdentity({ keys });
  await id.signIn("google");
  const opened = await library();
  const before = await shelf(opened);

  const deleted = server(() => json(200, "deleted"));
  const result = await deleteAccount({
    url: PROJECT,
    anonKey: ANON_KEY,
    token: id.token,
    request: deleted.request,
  });
  check("deleting the account reports what the server did", result.ok === true && result.outcome === "deleted", JSON.stringify(result));
  check("and it is one call", deleted.calls.length === 1, String(deleted.calls.length));
  check(
    "to the function that deletes a person, and nothing else",
    deleted.calls[0].url === `${PROJECT}/rest/v1/rpc/delete_my_account`,
    deleted.calls[0].url,
  );
  check("with no body that could name another account", deleted.calls[0].init.body === "{}");
  check("and the reader's own token", deleted.calls[0].init.headers.Authorization === `Bearer ${id.token}`);

  // The device signs out locally, which is a storage clear and nothing more.
  await id.signOut();
  check("after it, the device has no account", id.userId === null);
  const after = await shelf(opened);
  check("the library still has both posts", after.posts === before.posts && after.titles === before.titles, after.titles);
  check("and its feed", after.feeds === 1, String(after.feeds));
  check("and the same local ids", after.firstId === before.firstId);
  await opened.store.close();

  // Money still moving: the account is not deleted, and nothing changed.
  const charging = server(() => json(200, "cancel_first"));
  const blocked = await deleteAccount({ url: PROJECT, anonKey: ANON_KEY, token: "token", request: charging.request });
  check("an account still being charged is not deleted", blocked.ok === true && blocked.outcome === "cancel_first");
  check("and the sentence says why, and what to do", /cancel/i.test(CANCEL_FIRST) && /nothing else has changed/i.test(CANCEL_FIRST));

  // A device with no account asks nothing.
  const silent = server(() => json(200, "deleted"));
  const nobody = await deleteAccount({ url: PROJECT, anonKey: ANON_KEY, token: "", request: silent.request });
  check("deleting with no account is refused before any request", nobody.ok === false && silent.calls.length === 0);
  check("and says there is no account", nobody.reason === NOT_SIGNED_IN, String(nobody.reason));

  // A session the server has disowned deletes nothing.
  const disowned = server(() => json(401, { message: "invalid JWT" }));
  const refused = await deleteAccount({ url: PROJECT, anonKey: ANON_KEY, token: "token", request: disowned.request });
  check("a refused token deletes nothing", refused.ok === false && /would not accept/i.test(String(refused.reason)));
  check("and a 5xx is not mistaken for a deletion", (await deleteAccount({
    url: PROJECT,
    anonKey: ANON_KEY,
    token: "token",
    request: server(() => json(500, {})).request,
  })).ok === false);
  check(
    "an answer that is not one of the two outcomes claims nothing",
    (await deleteAccount({
      url: PROJECT,
      anonKey: ANON_KEY,
      token: "token",
      request: server(() => json(200, "ok!")).request,
    })).ok === false,
  );

  // The second action, in its own words, and not this one.
  check("the deletion says the library is still here", /library on this device is still here/i.test(ACCOUNT_DELETED));
  check("and that the reader's cloud folder is untouched", /cloud folder are still there/i.test(ACCOUNT_DELETED));
  check("the second action has its own wording", /^Delete the files/.test(PROVIDER_FILES_ACTION), PROVIDER_FILES_ACTION);
  check("and says what it is not", /separate from deleting your account/i.test(PROVIDER_FILES_WARNING));
  check("and that the account and library are not touched by it", /not touched/i.test(PROVIDER_FILES_WARNING));
}

/* --------------------------------------------------------------------------
 * The device list, and revoking one device
 * ----------------------------------------------------------------------- */

{
  const token = tokenFor(USER, SESSION);
  const rows = [
    { session_id: SESSION, label: "Linux · WebKit", platform: "Linux", created_at: new Date(NOW - 90_000).toISOString(), last_seen_at: new Date(NOW - 1_000).toISOString() },
    { session_id: OTHER_SESSION, label: "iOS · Safari", platform: "iOS", created_at: new Date(NOW - 9_000_000).toISOString(), last_seen_at: new Date(NOW - 5_000_000).toISOString() },
  ];
  const list = server(() => json(200, rows));
  const listed = await listDevices({ url: PROJECT, anonKey: ANON_KEY, token, request: list.request });
  check("the device list reads", listed.ok === true && listed.devices.length === 2, JSON.stringify(listed).slice(0, 80));
  check("and is one GET on the reader's own rows", list.calls.length === 1 && list.calls[0].init.method === "GET" && list.calls[0].url.includes("account_devices?"));
  check("with last seen first, as the server ordered it", listed.devices[1].label === "iOS · Safari", listed.devices[1].label);
  check("the device asking is marked as this one", listed.devices[0].current === true);
  check("and the other is not", listed.devices[1].current === false);
  check("with its last seen time read as a date", listed.devices[0].lastSeenAt === Date.parse(rows[0].last_seen_at), String(listed.devices[0].lastSeenAt));

  check("asking from no account asks nothing", (await listDevices({ url: PROJECT, anonKey: ANON_KEY, token: " ", request: list.request })).ok === false);
  check("a refused token is a refusal, not an empty list", (await listDevices({ url: PROJECT, anonKey: ANON_KEY, token, request: server(() => json(403, {})).request })).ok === false);
  check("an answer that is not a list is not a device list", (await listDevices({ url: PROJECT, anonKey: ANON_KEY, token, request: server(() => json(200, { devices: [] })).request })).ok === false);
  check("a network that does not answer is a sentence", (await listDevices({ url: PROJECT, anonKey: ANON_KEY, token, request: async () => { throw new Error("offline"); } })).ok === false);

  const revoke = server(() => json(200, true));
  const revoked = await revokeDevice({ url: PROJECT, anonKey: ANON_KEY, token, request: revoke.request }, OTHER_SESSION);
  check("revoking a device is one call", revoke.calls.length === 1 && revoked.ok === true && revoked.revoked === true, JSON.stringify(revoked));
  check("to revoke_device", revoke.calls[0].url === `${PROJECT}/rest/v1/rpc/revoke_device`, revoke.calls[0].url);
  check("naming that session, and only that session", revoke.calls[0].init.body === JSON.stringify({ p_session: OTHER_SESSION }));
  check("and nothing about a library, a file or an entitlement", !/library|file|entitlement|cloud_sync/i.test(revoke.calls[0].init.body + revoke.calls[0].url));

  check("revoking a session the server cannot find says so, and is not an error", (await revokeDevice(
    { url: PROJECT, anonKey: ANON_KEY, token, request: server(() => json(200, false)).request },
    OTHER_SESSION,
  )).revoked === false);
  const quiet = server(() => json(200, true));
  check("revoking nothing asks nothing", (await revokeDevice({ url: PROJECT, anonKey: ANON_KEY, token, request: quiet.request }, "  ")).ok === false && quiet.calls.length === 0);
  check("and revoking from no account asks nothing", (await revokeDevice({ url: PROJECT, anonKey: ANON_KEY, token: "", request: quiet.request }, OTHER_SESSION)).ok === false && quiet.calls.length === 0);

  check("the revoke sentence promises the library survives", /library is still on it/i.test(DEVICE_REVOKED), DEVICE_REVOKED);
  check("and revoking this device says it signs you out here", /signs this device out/i.test(REVOKE_THIS_DEVICE));

  // "That device signs out on next refresh and keeps reading": the refresh the
  // revoked session makes is the one that fails, and the library is read back.
  const revokedDevice = new FakeIdentity({ keys: memoryKeys() });
  await revokedDevice.signIn("google");
  const opened = await library();
  const before = await shelf(opened);
  revokedDevice.failRefresh = true; // what a session with no refresh token does
  await revokedDevice.refresh();
  check("a revoked device is signed out on its next refresh", revokedDevice.userId === null && revokedDevice.token === null);
  check("and is told the library is untouched", /library (is|was) (un)?touched/i.test(String(revokedDevice.notice)), String(revokedDevice.notice));
  const after = await shelf(opened);
  check("and it really is still readable", after.titles === before.titles && after.posts === 2, after.titles);
  await opened.store.close();

  // Registering: "this device is here", once, and only its own session.
  const register = server(() => json(200, SESSION));
  const named = describeDevice("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
  const registered = await registerDevice({ url: PROJECT, anonKey: ANON_KEY, token, request: register.request }, named);
  check("registering a device is one call", register.calls.length === 1 && registered.ok === true, JSON.stringify(registered));
  check("to register_device", register.calls[0].url === `${PROJECT}/rest/v1/rpc/register_device`);
  check("with a label and a platform, and no session id it could choose", register.calls[0].init.body === JSON.stringify({ p_label: named.label, p_platform: named.platform }), register.calls[0].init.body);
  check("and the session it answers with is the token's own", registered.sessionId === SESSION, String(registered.sessionId));
}

/* --------------------------------------------------------------------------
 * A label from a user agent, which nothing branches on
 * ----------------------------------------------------------------------- */

{
  const iphone = describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
  check("an iPhone is an iPhone", iphone.platform === "iOS" && iphone.label === "iOS · Safari", iphone.label);
  const android = describeDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36");
  check("an Android phone is Android, and Chrome rather than Safari", android.label === "Android · Chrome", android.label);
  const linux = describeDevice("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15");
  check("a WebKitGTK window is not called Safari", linux.label === "Linux · WebKit", linux.label);
  const windows = describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0");
  check("Edge is Edge", windows.label === "Windows · Edge", windows.label);
  const nothing = describeDevice("");
  check("no user agent is still a label", nothing.label === "This device" && nothing.platform === "This device", nothing.label);
}

/* --------------------------------------------------------------------------
 * The source rules: no provider, no library, no second entitlement
 * ----------------------------------------------------------------------- */

function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|svelte|js|json)$/.test(name)) found.push(path);
  }
  return found;
}

/** Code, without comments: prose about a folder is not a use of one. */
const code = (path) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

{
  const account = code(join(ROOT, "src/api/account.ts"));
  const identity = code(join(ROOT, "src/api/identity.ts"));

  check("the account module names no cloud provider", !/icloud|dropbox|onedrive|google drive|drive\.google/i.test(account));
  check("and neither does the identity seam", !/icloud|dropbox|onedrive|google drive|drive\.google/i.test(identity));
  check("the account module reaches no library", !/from\s+"[^"]*(local\/|state\/)/.test(account), (account.match(/from\s+"[^"]+"/g) ?? []).join(","));
  check("and no key store, so deleting an account cannot clear or write one", !/localStorage|IDENTITY_KEY|KeyStore/.test(account));
  check("and names the provider package nowhere", !/@supabase\//.test(account));
  check("no client path writes an entitlement row", !/rest\/v1\/entitlements/.test(account) && !/rest\/v1\//.test(identity));

  const all = sourceFiles(join(ROOT, "src"));
  const reading = all
    .filter((path) => relative(ROOT, path).startsWith("src/api/local") || /(reader|layout|prefs)\.svelte\.ts$/.test(path))
    .filter((path) => /from\s+"[^"]*\/account"/.test(readFileSync(path, "utf8")))
    .map((path) => relative(ROOT, path));
  check("no reading path imports the account module", reading.length === 0, reading.join(",") || "(none)");
}

/* --------------------------------------------------------------------------
 * The SQL: the things it must do, and the things it must not
 * ----------------------------------------------------------------------- */

{
  const sql = readFileSync(join(ROOT, "supabase/schema.sql"), "utf8");

  /** One statement block of the schema, from its `create` to the closing `$$;`. */
  const fn = (name) => {
    const start = sql.indexOf(`create or replace function public.${name}`);
    if (start === -1) return "";
    const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
    return end === -1 ? sql.slice(start) : sql.slice(start, end + 3);
  };

  const devicePolicies = [...sql.matchAll(/create policy[\s\S]{0,200}?on public\.account_devices[\s\S]{0,500}?;/gi)].map((m) => m[0]);
  check("the device table has three policies", devicePolicies.length === 3, String(devicePolicies.length));
  check(
    "reading is the reader's own rows",
    devicePolicies.some((body) => /for select/i.test(body) && /user_id = auth\.uid\(\)/.test(body)),
  );
  check(
    "registering is pinned to the session in the caller's own token",
    devicePolicies.some((body) => /for insert/i.test(body) && /session_id = \(auth\.jwt\(\) ->> 'session_id'\)::uuid/.test(body)),
  );
  check(
    "and so is updating it",
    devicePolicies.some((body) => /for update/i.test(body) && /session_id = \(auth\.jwt\(\) ->> 'session_id'\)::uuid/.test(body)),
  );
  check("no client may delete a device row directly", !/for delete/i.test(devicePolicies.join("\n")));
  check(
    "the table is not granted delete",
    /grant select, insert, update on public\.account_devices to authenticated/i.test(sql) && !/grant[^;]*delete[^;]*account_devices/i.test(sql),
  );
  check("RLS is on it", /alter table public\.account_devices enable row level security/i.test(sql));
  check(
    "the session key is the auth session row, so it cannot outlive the session",
    /session_id\s+uuid primary key references auth\.sessions \(id\) on delete cascade/i.test(sql),
  );

  const revoke = fn("revoke_device");
  check("revoking ends a session", /delete\s+from\s+auth\.sessions/i.test(revoke));
  check("and the refresh tokens that could renew it", /delete\s+from\s+auth\.refresh_tokens/i.test(revoke));
  check("and it cannot reach an account", !/auth\.users/i.test(revoke));
  check("and it cannot reach an entitlement or a library", !/entitlements|feeds|articles|local/i.test(revoke));
  check("while checking the session is the caller's own", /user_id = v_user/.test(revoke) && /auth\.uid\(\)/.test(revoke));
  check("and only the caller may call it", /grant execute on function public\.revoke_device\(uuid\) to authenticated/i.test(sql) && /revoke all on function public\.revoke_device\(uuid\) from public, anon/i.test(sql));

  const deleteFn = fn("delete_my_account");
  check("deleting the account deletes the identity row", /delete\s+from\s+auth\.users where id = v_user/i.test(deleteFn));
  check("which is what takes the entitlement with it", /user_id\s+uuid primary key references auth\.users \(id\) on delete cascade/i.test(sql));
  check("it refuses while a paid subscription is charging", /return 'cancel_first'/i.test(deleteFn) && /cloud_sync/i.test(deleteFn));
  check("and it deletes nothing in a folder, because it names none", !/icloud|drive|dropbox|onedrive|storage\.objects/i.test(deleteFn));
  check("only the caller may call it", /grant execute on function public\.delete_my_account\(\) to authenticated/i.test(sql));
  check("and it takes no argument naming an account", /function public\.delete_my_account\(\)\s*\n?returns text/i.test(deleteFn));

  const register = fn("register_device");
  check("registering takes the session from the token, not from an argument", /auth\.jwt\(\) ->> 'session_id'/.test(register) && !/p_session/.test(register));
  check("and needs no elevated rights to do it", !/security definer/i.test(register));

  check("the schema names no cloud provider at all", !/icloud|dropbox|onedrive/i.test(sql.replace(/^\s*--.*$/gm, "")));
}

/* --------------------------------------------------------------------------
 * The document the reader is shown, and the traps table
 * ----------------------------------------------------------------------- */

{
  const doc = readFileSync(join(ROOT, "docs/accounts-and-entitlements.md"), "utf8");
  check("the document says one person is one account", /one person, one account/i.test(doc));
  check("and that linking keeps the same row", /same (entitlement )?row|one `auth\.users` row/i.test(doc));
  check("and that a second sign-in is refused", /second sign-in/i.test(doc));
  check("and that deleting an account does not touch provider files", /never touches|does not touch|untouched/i.test(doc));
  check("and that the device list ends a session, not a library", /revok/i.test(doc) && /session/i.test(doc));
  check("and that the second action has its own wording", /second action/i.test(doc));

  const traps = readFileSync(join(ROOT, "docs/sync-invariants.md"), "utf8");
  const row = (n) => (traps.match(new RegExp(`^\\| ${n} \\|.*$`, "m")) ?? [""])[0];
  check("trap 5 is held, not a card", /\*\*held\*\*/.test(row(5)) && !/t_cb99e288/.test(row(5)), row(5).slice(0, 90));
  check("  and names where", /identity\.ts|account\.ts/.test(row(5)), row(5).slice(0, 120));
  check("trap 18 is held, not a card", /\*\*held\*\*/.test(row(18)) && !/t_cb99e288/.test(row(18)), row(18).slice(0, 90));
  check("  and names where", /schema\.sql|account\.ts/.test(row(18)), row(18).slice(0, 120));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
