/**
 * An account only when cloud sync is asked for.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/identity.mjs
 *
 * Two promises are held here, and they pull in opposite directions:
 *
 * 1. **No account is the normal case.** A local library must open, list and read
 *    with `userId === null`, and constructing an identity must make no request —
 *    no launch probe, no token fetch, nothing. The suite counts `fetch` calls to
 *    prove the absence, rather than trusting a comment.
 * 2. **When there is an account, it is just an account.** A sign-in yields a
 *    token, the token survives a restart, a refresh that fails signs the device
 *    out, and signing out forgets the account — and in every one of those cases
 *    a real local library over `MemoryDatabase` is opened before and read back
 *    after, so "the library was not touched" is measured rather than intended.
 *
 * `FakeIdentity` drives all of it in memory; `SupabaseIdentity` is driven through
 * a fake client so the thin wrapper's two calls — which provider call a door
 * makes, and how a session becomes a record — are checked without a provider.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalStore, localItemId } from "../../src/api/local/store.ts";
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { READING_LIST } from "../../src/api/freshrss.ts";
import { ROOT } from "./build-reader.mjs";
import {
  FakeIdentity,
  IDENTITY_KEY,
  IDENTITY_PROVIDERS,
  NoIdentity,
  SupabaseIdentity,
  clearIdentityRecord,
  createIdentity,
  identityConfig,
  parseIdentityRecord,
  readIdentityRecord,
  roleOf,
  sessionRecord,
  writeIdentityRecord,
} from "../../src/api/identity.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const FEED = "https://fixture.test/feed.xml";
const T = 1_700_000_000;

/* --------------------------------------------------------------------------
 * The device's storage, and a network that must stay unused
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

/** Counts every request the code under test makes. Zero is the answer most of this suite wants. */
let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  requests += 1;
  return realFetch(...args);
};

/** A real library on this device: one feed, two posts. Nothing here knows about accounts. */
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

/** What is in the library, as one string, so before and after can be compared. */
async function shelf({ store, backend }) {
  const contents = await backend.stream(READING_LIST, { count: 10 });
  const feeds = await store.feeds();
  const page = await store.queryEntries({ count: 10 });
  return {
    titles: contents.items.map((item) => item.title).join(","),
    posts: page.entries.length,
    feeds: feeds.length,
  };
}

/* --------------------------------------------------------------------------
 * Rule 1: no account, and everything works
 * ----------------------------------------------------------------------- */

{
  requests = 0;
  const keys = memoryKeys();
  const id = new FakeIdentity({ keys });

  check("a fresh device has no account", id.userId === null && id.token === null);
  check("and does not call that a problem", id.notice === null);
  check("and holds no provider either", id.provider === null);
  check("creating an identity makes no request", requests === 0, String(requests));

  const opened = await library();
  const before = await shelf(opened);
  check("a library opens with no account behind it", before.feeds === 1, String(before.feeds));
  check("and its posts read", before.titles === "Fixture one,Fixture two", before.titles);
  check("and still nothing was requested", requests === 0, String(requests));

  // The launch path, as the shell runs it: storage read, listener installed.
  id.restore();
  const stop = id.watch({
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  stop();
  check("restoring and watching a device with no account makes no request", requests === 0, String(requests));
  check("and asking it to refresh changes nothing", (await id.refresh()) === undefined && id.userId === null);

  await opened.store.close();
}

/* --------------------------------------------------------------------------
 * A sign-in yields a token, and the token survives the app being closed
 * ----------------------------------------------------------------------- */

{
  requests = 0;
  const keys = memoryKeys();
  const id = new FakeIdentity({ keys });
  await id.signIn("google");

  check("a sign-in yields a user id", id.userId === "fake-google-user", String(id.userId));
  check("and a token", typeof id.token === "string" && id.token !== "", String(id.token));
  check("and names the door it came through", id.provider === "google", String(id.provider));
  check("and is signed in", id.signedIn === true);
  check("and costs no request of ours", requests === 0, String(requests));

  const stored = readIdentityRecord(keys);
  check("the token is written where the session lives", stored !== null && stored.token === id.token);
  check(
    "under one device key, not a second store",
    keys.held.has(IDENTITY_KEY) && [...keys.held.keys()].filter((key) => /identity/.test(key)).length === 1,
    [...keys.held.keys()].join(","),
  );
  check("and the record names no server and no library", stored !== null && !/serverUrl|apiPath/.test(JSON.stringify(stored)));

  // A restart is a new instance over the same storage. This is the whole of
  // "session persistence": no request, no prompt, no re-sign-in.
  const next = new FakeIdentity({ keys });
  check("a restart finds the account again", next.userId === id.userId, String(next.userId));
  check("with the same token", next.token === id.token);
  check("and makes no request to find it", next.calls.length === 0 && requests === 0, next.calls.join(",") || "(none)");

  // The email door is the fallback, and it needs an address to send a link to.
  const emailKeys = memoryKeys();
  const byEmail = new FakeIdentity({ keys: emailKeys });
  await byEmail.signIn("email");
  check("an emailed sign-in with no address signs nobody in", byEmail.userId === null);
  check("and says what it needs", /address/.test(String(byEmail.notice)), String(byEmail.notice));
  await byEmail.signIn("email", "reader@fixture.test");
  check("and with one it does", byEmail.userId !== null && byEmail.email === "reader@fixture.test", String(byEmail.email));

  check("the three doors are the three that exist", IDENTITY_PROVIDERS.join(",") === "google,apple,email");
}

/* --------------------------------------------------------------------------
 * A failed refresh is signed out, never a broken reader
 * ----------------------------------------------------------------------- */

{
  requests = 0;
  const keys = memoryKeys();
  const id = new FakeIdentity({ keys });
  await id.signIn("google");
  const earned = id.token;
  check("a signed-in device starts with a token", typeof earned === "string" && id.userId !== null);

  const opened = await library();
  const before = await shelf(opened);

  id.failRefresh = true;
  await id.refresh();

  check("a refused refresh signs the device out", id.userId === null && id.token === null);
  check("and says so", /sign-in has expired/i.test(String(id.notice)), String(id.notice));
  check("and says the library is untouched", /nothing in your library was touched/i.test(String(id.notice)));
  check("and leaves no token on disk", readIdentityRecord(keys) === null, JSON.stringify(readIdentityRecord(keys)));
  check("while the identity key itself is gone", !keys.held.has(IDENTITY_KEY), [...keys.held.keys()].join(","));

  const after = await shelf(opened);
  check("the library still holds its posts", after.posts === before.posts && after.posts === 2, String(after.posts));
  check("with the same titles", after.titles === before.titles, after.titles);
  check("and the same feed", after.feeds === before.feeds && after.feeds === 1, String(after.feeds));
  check("a refused refresh made no request of ours", requests === 0, String(requests));

  // A reader that carries on reading after the sign-out: the library is a store,
  // and a store does not consult an account to accept a write.
  await opened.store.setRead([localItemId(FEED, "one")], true);
  const marked = await opened.store.queryEntries({ count: 10 });
  check(
    "and posts can still be marked read after the sign-out",
    marked.entries.filter((entry) => Boolean(entry.read)).length === 1,
    JSON.stringify(marked.entries.map((entry) => [entry.guid, entry.read ?? null])),
  );

  await opened.store.close();
}

/* --------------------------------------------------------------------------
 * Signing out forgets the account and nothing else
 * ----------------------------------------------------------------------- */

{
  requests = 0;
  const keys = memoryKeys();
  // The session and a profile's own keys, as they exist on a device in use.
  const session = JSON.stringify({
    serverUrl: "https://reader.test",
    apiPath: "/api/greader.php",
    email: "reader@fixture.test",
    token: "freshrss-token",
  });
  keys.setItem("hardlyreader.session", session);
  keys.setItem("3f2a1b0c|hardlyreader.layout.v1", '{"mode":"three"}');
  keys.setItem("3f2a1b0c|hardlyreader.prefs.v1", '{"reading":{}}');

  const id = new FakeIdentity({ keys });
  await id.signIn("apple");
  const opened = await library();
  const before = await shelf(opened);

  await id.signOut();

  check("signing out leaves no account", id.userId === null && id.token === null);
  check("and no record on disk", !keys.held.has(IDENTITY_KEY));
  check("and says nothing is wrong", id.notice === null, String(id.notice));
  check("the FreshRSS session is still signed in", keys.getItem("hardlyreader.session") === session);
  check("the profile's layout is still its own", keys.getItem("3f2a1b0c|hardlyreader.layout.v1") === '{"mode":"three"}');
  check("and its reading preferences", keys.getItem("3f2a1b0c|hardlyreader.prefs.v1") === '{"reading":{}}');

  const after = await shelf(opened);
  check("the library kept its posts", after.posts === before.posts && after.titles === before.titles, after.titles);
  check("and its feed", after.feeds === 1, String(after.feeds));
  check("signing out made no request", requests === 0, String(requests));
  await opened.store.close();
}

/* --------------------------------------------------------------------------
 * Return to the window: refresh with a token, nothing without one
 * ----------------------------------------------------------------------- */

{
  // A window that comes back is the only thing that refreshes a token, and a
  // device with no account gives it nothing to do.
  const id = new FakeIdentity({ keys: memoryKeys() });
  let listener = null;
  let removed = 0;
  const doc = {
    visibilityState: "visible",
    addEventListener: (_type, fn) => {
      listener = fn;
    },
    removeEventListener: () => {
      removed += 1;
    },
  };
  const stop = id.watch(doc);
  listener();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("a return to the window with no account refreshes nothing", id.calls.length === 0, id.calls.join(",") || "(none)");

  await id.signIn("google");
  id.calls.length = 0;
  const first = id.token;
  doc.visibilityState = "hidden";
  listener();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("a window going away refreshes nothing", id.calls.length === 0, id.calls.join(",") || "(none)");

  doc.visibilityState = "visible";
  listener();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("a return to the window with an account refreshes it", id.calls.includes("refresh"), id.calls.join(","));
  check("and the token is a new one", id.token !== null && id.token !== first, `${first} → ${id.token}`);

  stop();
  check("and the listener is removed when the shell says so", removed === 1, String(removed));
}

/* --------------------------------------------------------------------------
 * The real one, thin, through a fake client
 * ----------------------------------------------------------------------- */

function fakeClient(overrides = {}) {
  const calls = [];
  const auth = {
    signInWithOAuth: async (options) => {
      calls.push(["oauth", options.provider, options.options]);
      return { data: { url: "https://provider.test/authorize" }, error: null };
    },
    signInWithOtp: async (options) => {
      calls.push(["otp", options.email]);
      return { data: {}, error: null };
    },
    getSession: async () => {
      calls.push(["getSession"]);
      return {
        data: {
          session: {
            access_token: "at-1",
            expires_at: T,
            user: { id: "user-1", email: "reader@fixture.test" },
          },
        },
        error: null,
      };
    },
    refreshSession: async () => {
      calls.push(["refreshSession"]);
      return {
        data: {
          session: {
            access_token: "at-2",
            expires_at: T + 3600,
            user: { id: "user-1", email: "reader@fixture.test" },
          },
        },
        error: null,
      };
    },
    signOut: async () => {
      calls.push(["signOut"]);
      return { error: null };
    },
    ...overrides,
  };
  return { client: { auth }, calls };
}

{
  requests = 0;
  const keys = memoryKeys();
  const { client, calls } = fakeClient();
  const navigated = [];
  const id = new SupabaseIdentity({
    client,
    keys,
    navigate: (url) => navigated.push(url),
    redirectTo: "https://app.test/",
  });
  check("building the real one makes no request", calls.length === 0 && requests === 0, calls.join(",") || "(none)");

  await id.signIn("google");
  const oauth = calls.find((call) => call[0] === "oauth");
  check("Google is asked for by name", oauth !== undefined && oauth[1] === "google", JSON.stringify(oauth ?? null));
  check(
    "the provider page is left to us to open",
    oauth !== undefined && oauth[2]?.skipBrowserRedirect === true,
    JSON.stringify(oauth?.[2] ?? null),
  );
  check("and it comes back where we said", oauth !== undefined && oauth[2]?.redirectTo === "https://app.test/");
  check("the window is sent to it", navigated.join(",") === "https://provider.test/authorize", navigated.join(","));
  check("the session becomes the record", id.userId === "user-1" && id.token === "at-1", `${id.userId}/${id.token}`);
  check("with the address", id.email === "reader@fixture.test", String(id.email));
  check("with the door it came through", id.provider === "google", String(id.provider));
  check("and the expiry in milliseconds", id.provider !== null && readIdentityRecord(keys)?.expiresAt === T * 1000);

  await id.refresh();
  check("a refresh adopts the new token", id.token === "at-2", String(id.token));
  check("and keeps the same account", id.userId === "user-1", String(id.userId));

  const { client: otpClient, calls: otpCalls } = fakeClient({
    getSession: async () => ({ data: { session: null }, error: null }),
  });
  const byLink = new SupabaseIdentity({ client: otpClient, keys: memoryKeys() });
  await byLink.signIn("email", "reader@fixture.test");
  const otp = otpCalls.find((call) => call[0] === "otp");
  check("the email door asks for a link", otp !== undefined && otp[1] === "reader@fixture.test", JSON.stringify(otp ?? null));
  check("and says to go and open it", /check your email/i.test(String(byLink.notice)), String(byLink.notice));
  check("and signs nobody in until the link is opened", byLink.userId === null);
  await byLink.signIn("email", "   ");
  check("an address of spaces is refused before the provider hears about it", byLink.userId === null && /address/.test(String(byLink.notice)));

  // The refusal the app must survive: a token that cannot be renewed.
  const raising = fakeClient({
    refreshSession: async () => ({ data: { session: null }, error: { message: "Invalid Refresh Token" } }),
  });
  const opened = await library();
  const before = await shelf(opened);
  const lapsed = new SupabaseIdentity({ client: raising.client, keys: memoryKeys() });
  await lapsed.signIn("google");
  check("a device signed in through the real one holds a token", lapsed.token === "at-1");
  await lapsed.refresh();
  check("a refresh the provider refuses signs the device out", lapsed.userId === null && lapsed.token === null);
  check("and the sentence says the library is untouched", /library is untouched/i.test(String(lapsed.notice)), String(lapsed.notice));
  const after = await shelf(opened);
  check("and the library really is", after.titles === before.titles && after.posts === 2, after.titles);
  await opened.store.close();
}

/* --------------------------------------------------------------------------
 * A build with no project configured: no identity, and no attempt to invent one
 * ----------------------------------------------------------------------- */

{
  const none = createIdentity(null, memoryKeys());
  check("a build with no project has no account", none.userId === null && none.token === null);
  check("and says which build this is, not that a sign-in failed", none instanceof NoIdentity);
  await none.signIn("google");
  check("asking it to sign in signs nobody in", none.userId === null);
  check("and refuses by name", /no sign-in provider configured/.test(String(none.notice)), String(none.notice));
  await none.refresh();
  check("and a refresh changes nothing on a build with no provider", none.userId === null && none.signedIn === false);
}

/* --------------------------------------------------------------------------
 * The build's two public values, and the one key that must never arrive
 * ----------------------------------------------------------------------- */

/** A JWT-shaped string with the given claims. Unsigned: nothing here verifies one. */
function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.not-a-real-signature`;
}

{
  check("no environment at all is no identity", identityConfig(null) === null);
  check("and an empty one is too", identityConfig({}) === null);
  check("and half of one is not enough", identityConfig({ PUBLIC_SUPABASE_URL: "https://ref.supabase.co" }) === null);

  const anon = jwt({ role: "anon", iss: "supabase" });
  const config = identityConfig({ PUBLIC_SUPABASE_URL: "https://ref.supabase.co/", PUBLIC_SUPABASE_ANON_KEY: anon });
  check("the anon key is enough", config !== null && config.anonKey === anon);
  check("and the project URL is normalised", config !== null && config.url === "https://ref.supabase.co", String(config?.url));
  check("the anon key reads as anon", roleOf(anon) === "anon", String(roleOf(anon)));

  const service = jwt({ role: "service_role", iss: "supabase" });
  check("the service key reads as the service key", roleOf(service) === "service_role", String(roleOf(service)));
  check(
    "a service key in the build's environment is refused, not used",
    identityConfig({ PUBLIC_SUPABASE_URL: "https://ref.supabase.co", PUBLIC_SUPABASE_ANON_KEY: service }) === null,
  );
  check(
    "and a build handed one has no identity rather than an open database",
    createIdentity(
      identityConfig({ PUBLIC_SUPABASE_URL: "https://ref.supabase.co", PUBLIC_SUPABASE_ANON_KEY: service }),
      memoryKeys(),
    ) instanceof NoIdentity,
  );
  check("a key that is not a JWT is not refused for that", roleOf("sb_publishable_abc123") === null);
}

/* --------------------------------------------------------------------------
 * The record: stored shape, and what an unreadable one costs
 * ----------------------------------------------------------------------- */

{
  const keys = memoryKeys();
  const record = {
    userId: "user-1",
    token: "at-1",
    email: "reader@fixture.test",
    provider: "google",
    expiresAt: T * 1000,
  };
  writeIdentityRecord(record, keys);
  check("a written record reads back the same", JSON.stringify(readIdentityRecord(keys)) === JSON.stringify(record));
  check("and the parser accepts it on its own", parseIdentityRecord(record) !== null);

  check("a record with no token is not an account", parseIdentityRecord({ ...record, token: "" }) === null);
  check("a record with no user is not an account", parseIdentityRecord({ ...record, userId: undefined }) === null);
  check(
    "a record naming a door this app does not offer is not an account",
    parseIdentityRecord({ ...record, provider: "myspace" }) === null,
  );

  keys.setItem(IDENTITY_KEY, "{not json");
  check("an unreadable record is no account", readIdentityRecord(keys) === null);
  check("and is dropped rather than re-read every launch", !keys.held.has(IDENTITY_KEY));
  clearIdentityRecord(keys);
  check("clearing an absent record is not an error", readIdentityRecord(keys) === null);

  const session = sessionRecord(
    { access_token: "at-9", expires_at: T, user: { id: "user-9", email: "another@fixture.test" } },
    "apple",
  );
  check("a session becomes a record with the door it came through", session.provider === "apple");
  check("and an expiry in milliseconds", session.expiresAt === T * 1000, String(session.expiresAt));
}

/* --------------------------------------------------------------------------
 * The source rules: one file names the provider, and the reading path is clean
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

{
  const files = sourceFiles(join(ROOT, "src"));
  const read = (path) => readFileSync(path, "utf8");
  // Prose is not code: the module explains what a service key is and why it may
  // not be here, and that explanation must not read as a use of one.
  const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const named = files
    .filter((path) => /@supabase\//.test(code(path)))
    .map((path) => relative(ROOT, path));
  check("the provider package is named in exactly one file", named.join(",") === "src/api/identity.ts", named.join(",") || "(none)");

  // Only the refusal may name it, and only to compare against: the string is a
  // claim to look up, never a key to use.
  const service = files
    .filter((path) => /service_role|SERVICE_ROLE/.test(code(path)))
    .map((path) => relative(ROOT, path));
  check(
    "the service key is named only by the check that refuses it",
    service.join(",") === "src/api/identity.ts",
    service.join(",") || "(none)",
  );

  const own = code(join(ROOT, "src/api/identity.ts"));
  check("the identity module opens no request of its own", !/\bfetch\s*\(/.test(own));
  check("and reads its two values from the environment", /import\.meta\.env/.test(own));

  // Nothing that reads or renders a post may require a token. The reading path
  // is named here, not "everything but identity": a grep that passes because a
  // new file was not on the list is the failure mode this check exists for.
  const readingPath = [
    ...sourceFiles(join(ROOT, "src/api/local")),
    ...["freshrss.ts", "greader-backend.ts", "backend.ts", "session.ts", "transport.ts", "profile.ts"].map((name) =>
      join(ROOT, "src/api", name),
    ),
    ...["reader.svelte.ts", "layout.svelte.ts", "prefs.svelte.ts"].map((name) => join(ROOT, "src/state", name)),
  ];
  const required = readingPath
    .filter((path) => /from\s+"[^"]*identity|identity\.(userId|token)/.test(code(path)))
    .map((path) => relative(ROOT, path));
  check("no reading path imports or reads an identity", required.length === 0, required.join(",") || "(none)");

  const app = read(join(ROOT, "src/App.svelte"));
  check("the shell keeps the identity live on return", /identity\.watch\(\)/.test(app));
  check("and removes its listener when it unmounts", /stopWatchingIdentity\?\.\(\)/.test(app));
  check("and never makes the reader wait for it", !/await\s+identity\./.test(app));

  const env = read(join(ROOT, ".env.example"));
  check("the example environment names the project URL", /PUBLIC_SUPABASE_URL=/.test(env));
  check("and the anon key", /PUBLIC_SUPABASE_ANON_KEY=/.test(env));
  check("and no service key", !/SERVICE_ROLE|service_role/.test(env.replace(/^#.*$/gm, "")));
  check("while saying in prose that it never ships", /service_role[\s\S]{0,200}never/i.test(env) || /never[\s\S]{0,200}service_role/i.test(env));

  const docs = read(join(ROOT, "docs/accounts-and-entitlements.md"));
  check("the document says the service key never ships", /service key never ships/i.test(docs));
  check("and that an account exists only when sync is asked for", /only when|on demand|never at\s+launch/i.test(docs));
  check("and where the token is kept", /localStorage/i.test(docs) && /device[- ]key/i.test(docs));

  const pkg = JSON.parse(read(join(ROOT, "package.json")));
  check("the provider is one dependency, declared", typeof pkg.dependencies["@supabase/supabase-js"] === "string");
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
