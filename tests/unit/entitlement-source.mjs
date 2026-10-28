/**
 * Where the entitlement comes from: a server row, and nothing a client can invent.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/entitlement-source.mjs
 *
 * `tests/unit/entitlements.mjs` proves what the capability *means* once it has an
 * answer — one boolean, expiry pauses, nothing local is touched. This suite is
 * about the answer's source: a `select`-only `entitlements` row for `auth.uid()`,
 * read with the reader's JWT, cached per user id so a plane does not pause a
 * subscription, and `none` — never `active` — for every way that can fail.
 *
 * The five rules held to here are the five the card states:
 *
 * 1. a row with `cloud_sync = true` → `cloudSync` true;
 * 2. a lapsed row → false, the sync paused, and the library untouched;
 * 3. no row, a 500, a timeout, a malformed answer, a refused JWT → false;
 * 4. the last answer survives going offline, for that reader and no one else;
 * 5. no client path writes `cloud_sync` — not in this code, and not in the SQL.
 *
 * The network and the clock are injected, so none of this needs a Supabase
 * project; the SQL is read off disk, so the policy claims are checked against the
 * file that will actually be applied.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { LocalStore } from "../../src/api/local/store.ts";
import { LocalBackend } from "../../src/api/local/local-backend.ts";
import { READING_LIST } from "../../src/api/freshrss.ts";
import { GEN_DIR, ROOT, absolute } from "./build-reader.mjs";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** The capability, built the way the other state suites build theirs. */
function buildEntitlementsModule() {
  const file = join(ROOT, "src/state/entitlements.svelte.ts");
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "entitlements.svelte.ts",
  });
  const compiled = compileModule(outputText, {
    generate: "client",
    filename: "entitlements.svelte.ts",
  });
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "entitlements.mjs");
  writeFileSync(out, compiled.js.code);
  return pathToFileURL(out).href;
}

const {
  ENTITLEMENT_CACHE_PREFIX,
  Entitlements,
  RemoteStore,
  SYNC_CAPABILITY,
  SYNC_MONTHLY,
  entitlementFromRow,
  readEntitlement,
  storedCloudSession,
} = await import(buildEntitlementsModule());

const PROJECT = "https://fixtureproject.supabase.co";
const ANON_KEY = "anon-key-not-a-secret";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
/**
 * "Now", as the store is told it.
 *
 * The clock is injected into the store, but `Entitlements` reads the wall clock
 * when it re-reads an answer (`readEntitlement`'s default), so the two have to
 * agree or every date in this suite is judged by a different calendar. Real now
 * it is, with every date below an offset from it.
 */
const NOW = Date.now();

/* --------------------------------------------------------------------------
 * The three things a test drives instead of a project, a clock and a network
 * ----------------------------------------------------------------------- */

/** A JWT: a header, a payload, and a signature this suite never needs to be real. */
function jwt(sub, expSeconds) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, exp: expSeconds, role: "authenticated" })}.not-a-signature`;
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
  keys() {
    return [...this.entries.keys()];
  }
}

/** A recorded request. `answer` decides what the server "said". */
function server(answer) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init, calls.length);
  };
  return { request, calls, get last() {
    return calls[calls.length - 1];
  } };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A store over one reader, one token and that reader's device. */
function remote(options = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const session =
    options.session ??
    (() => ({ userId: options.userId ?? USER_A, token: jwt(options.userId ?? USER_A, Math.floor(NOW / 1000) + 3600) }));
  return new RemoteStore({
    url: PROJECT,
    anonKey: ANON_KEY,
    session,
    request: options.request ?? server(() => json(200, [])).request,
    storage,
    now: () => options.now ?? NOW,
    timeoutMs: 50,
  });
}

async function capability(store) {
  const entitlement = new Entitlements(store);
  await entitlement.refresh();
  return entitlement;
}

/* --------------------------------------------------------------------------
 * 1. A row, and the request that read it
 * ----------------------------------------------------------------------- */

{
  const rows = [{ cloud_sync: true, expires_at: new Date(NOW + 86_400_000).toISOString() }];
  const net = server(() => json(200, rows));
  const storage = new MemoryStorage();
  const entitlement = await capability(remote({ request: net.request, storage }));

  check("a paid row grants cloud sync", entitlement.cloudSync === true);
  check("and the state says so", entitlement.state === "active", entitlement.state);
  check("with nothing to apologise for", entitlement.reason === null);
  check("the build knows it has a server", entitlement.available === true);

  check("the row was asked for exactly once", net.calls.length === 1, String(net.calls.length));
  check("with a GET, because there is nothing here that may write", net.last.init.method === "GET", String(net.last.init.method));
  check(
    "against this project's entitlements table",
    net.last.url.startsWith(`${PROJECT}/rest/v1/entitlements?`),
    net.last.url,
  );
  check("asking for the reader's own row", net.last.url.includes(`user_id=eq.${USER_A}`), net.last.url);
  check("reading the two columns that decide it", net.last.url.includes("select=cloud_sync,expires_at"), net.last.url);
  check("and never the column that says who paid", !net.last.url.includes("source"), net.last.url);
  check("with the publishable key", net.last.init.headers.apikey === ANON_KEY);
  check(
    "and the reader's JWT as the bearer",
    net.last.init.headers.Authorization === `Bearer ${jwt(USER_A, Math.floor(NOW / 1000) + 3600)}`,
  );
  check(
    "the answer is the capability, because a row records no price",
    entitlement.state === "active" && entitlement.offer.every((product) => product.id !== SYNC_CAPABILITY),
  );
  check(
    "the answer was remembered under this reader",
    storage.keys().join(",") === `${ENTITLEMENT_CACHE_PREFIX}.${USER_A}`,
    storage.keys().join(","),
  );
}

/* --------------------------------------------------------------------------
 * 2. A lapsed row: false, paused, and the library still there
 * ----------------------------------------------------------------------- */

{
  const lapsed = entitlementFromRow(
    { cloud_sync: false, expires_at: new Date(NOW - 60_000).toISOString() },
    NOW,
  );
  check("a row that stopped paying is expired", lapsed.state === "expired", lapsed.state);
  check("and stops cloud sync", readEntitlement(lapsed, NOW).state === "expired");

  // The same row the webhook would leave if it forgot to flip the boolean: the
  // calendar outranks the word, exactly as it does for a stale store receipt.
  const staleButTrue = entitlementFromRow(
    { cloud_sync: true, expires_at: new Date(NOW - 60_000).toISOString() },
    NOW,
  );
  check("a true row whose date has passed is expired", readEntitlement(staleButTrue, NOW).state === "expired");

  const entitlement = await capability(
    remote({
      request: server(() => json(200, [{ cloud_sync: false, expires_at: new Date(NOW - 60_000).toISOString() }])).request,
    }),
  );
  check("an expired row leaves cloud sync off", entitlement.cloudSync === false);
  check("and says why", /ended/.test(String(entitlement.reason)), String(entitlement.reason));

  // The promise that matters: no sync, and nothing of the reader's touched.
  const store = new LocalStore(new MemoryDatabase());
  const backend = new LocalBackend(store, { deviceName: "This laptop" });
  await backend.subscribe({ feedUrl: "https://fixture.test/feed.xml", title: "Fixture feed" });
  await store.putEntries([
    { feedUrl: "https://fixture.test/feed.xml", guid: "one", title: "Fixture one", published: NOW / 1000 + 20, content: "<p>First.</p>" },
    { feedUrl: "https://fixture.test/feed.xml", guid: "two", title: "Fixture two", published: NOW / 1000 + 10, content: "<p>Second.</p>" },
  ]);
  const contents = await backend.stream(READING_LIST, { count: 10 });
  check(
    "the library still reads with the subscription expired",
    contents.items.map((item) => item.title).join(",") === "Fixture one,Fixture two",
    contents.items.map((item) => item.title).join(","),
  );
  check("no feed was removed", (await store.feeds()).length === 1);
  check("no post was deleted", (await store.queryEntries({ count: 10 })).entries.length === 2);
  await store.close();

  // And the half that runs a sync is drawn only behind the capability, so a
  // lapsed row is a paused section rather than a button that fails on press. The
  // anchor is the gate rather than the file's first `{#if}`: another branch may be
  // drawn before it (`pitch === "nothing"`), and this check is about the order
  // between the gate and the button, not about what precedes them.
  const panel = readFileSync(join(ROOT, "src/components/DeviceSyncPanel.svelte"), "utf8");
  const gate = panel.search(/\{[^}]*\bentitlement\.cloudSync\b[^}]*\}/);
  const run = panel.indexOf("onclick={runSync}");
  check("the sync button is behind the entitlement gate", gate !== -1 && run > gate, `${gate} / ${run}`);
  check("and the panel reads one capability, not a provider flag", !/entitlement\.(offer|state)\s*(&&|\?)/.test(panel));
}

/* --------------------------------------------------------------------------
 * 3. Every failure is `none`
 * ----------------------------------------------------------------------- */

{
  const missing = await capability(remote({ request: server(() => json(200, [])).request }));
  check("no row at all means no cloud sync", missing.cloudSync === false);
  check("and the reader is simply not a subscriber", missing.state === "none", missing.state);

  const broken = await capability(remote({ request: server(() => json(500, { message: "boom" })).request }));
  check("a 500 leaves cloud sync off", broken.cloudSync === false);
  check("and names what happened", /500/.test(String(broken.reason)), String(broken.reason));

  const unauthorized = await capability(remote({ request: server(() => json(401, { message: "jwt expired" })).request }));
  check("a refused JWT leaves cloud sync off", unauthorized.cloudSync === false);
  check("and is not quietly called a lapse", /would not accept/.test(String(unauthorized.reason)), String(unauthorized.reason));

  const forbidden = await capability(remote({ request: server(() => json(403, { message: "no" })).request }));
  check("a 403 is no answer either", forbidden.cloudSync === false);

  const garbage = await capability(remote({ request: server(() => json(200, { cloud_sync: true })).request }));
  check("an answer that is not a list grants nothing", garbage.cloudSync === false);
  check("even though it contained the word true", garbage.state === "none", garbage.state);

  const offline = await capability(
    remote({
      request: () =>
        Promise.reject(Object.assign(new TypeError("fetch failed"), { name: "TypeError" })),
    }),
  );
  check("a network that is simply not there leaves cloud sync off", offline.cloudSync === false);

  const slow = await capability(
    remote({
      request: (_url, init) =>
        new Promise((_resolve, reject) => {
          // The store aborts at `timeoutMs`; a request that honours the signal is
          // what a real fetch does, and the abort is what the store must survive.
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
          );
        }),
    }),
  );
  check("a timeout leaves cloud sync off", slow.cloudSync === false);
  check("and says the server did not answer", /did not answer/.test(String(slow.reason)), String(slow.reason));

  // A session source that throws is a device with no session: nothing is asked
  // of the server on behalf of an identity we could not even name.
  const confusedNetwork = server(() => json(200, [{ cloud_sync: true }]));
  const threw = await capability(
    remote({
      request: confusedNetwork.request,
      session: () => {
        throw new Error("the session store is unreadable");
      },
    }),
  );
  check("a session that cannot be read is a signed-out device", threw.cloudSync === false);
  check("and no request went out", confusedNetwork.calls.length === 0, String(confusedNetwork.calls.length));
}

/* --------------------------------------------------------------------------
 * 4. The last answer, per reader
 * ----------------------------------------------------------------------- */

{
  // A paid answer, then a launch with no network: the reader keeps what they had.
  const storage = new MemoryStorage();
  const expires = new Date(NOW + 7 * 86_400_000).toISOString();
  const first = await capability(remote({ request: server(() => json(200, [{ cloud_sync: true, expires_at: expires }])).request, storage }));
  check("the paid answer was granted", first.cloudSync === true);

  const offline = await capability(remote({ request: () => Promise.reject(new TypeError("fetch failed")), storage }));
  check("an offline launch keeps a paying reader working", offline.cloudSync === true);
  check("and still calls the subscription active", offline.state === "active", offline.state);

  // ...but the calendar still rules the cache: offline on the day after it lapses
  // is not a grant. The cached answer is re-read, not believed.
  const afterLapse = await capability(
    remote({
      request: () => Promise.reject(new TypeError("fetch failed")),
      storage,
      now: NOW + 8 * 86_400_000,
    }),
  );
  check("offline after the date has passed does not grant", afterLapse.cloudSync === false);
  check("and calls it expired rather than active", afterLapse.state === "expired", afterLapse.state);

  // A manual grant carries no date at all. Offline, it is still a grant — there is
  // nothing to have lapsed, and inventing a deadline would be a second policy.
  const lifetimeStorage = new MemoryStorage();
  await capability(remote({ request: server(() => json(200, [{ cloud_sync: true, expires_at: null }])).request, storage: lifetimeStorage }));
  const lifetime = await capability(
    remote({ request: () => Promise.reject(new TypeError("fetch failed")), storage: lifetimeStorage }),
  );
  check("an undated grant still grants offline", lifetime.cloudSync === true);
  check("because there is no date to outrank it", lifetime.state === "active", lifetime.state);

  // A no is an answer too: a lapsed reader who goes offline stays off.
  const noneStorage = new MemoryStorage();
  await capability(remote({ request: server(() => json(200, [])).request, storage: noneStorage }));
  const noRowOffline = await capability(remote({ request: () => Promise.reject(new TypeError("fetch failed")), storage: noneStorage }));
  check("a reader with no row who goes offline stays off", noRowOffline.cloudSync === false);

  // A refused credential is not the offline case: the server disowned this
  // session, so the cache must not speak for it.
  const refusedStorage = new MemoryStorage();
  await capability(remote({ request: server(() => json(200, [{ cloud_sync: true, expires_at: expires }])).request, storage: refusedStorage }));
  const refused = await capability(remote({ request: server(() => json(401, { message: "revoked" })).request, storage: refusedStorage }));
  check("a JWT the server refuses does not fall back to the cache", refused.cloudSync === false);
  check("even though this device holds a paid answer", refused.state === "none", refused.state);
}

/* --------------------------------------------------------------------------
 * 5. One device, two readers, two answers
 * ----------------------------------------------------------------------- */

{
  const storage = new MemoryStorage();
  const expires = new Date(NOW + 7 * 86_400_000).toISOString();
  const owner = await capability(remote({ request: server(() => json(200, [{ cloud_sync: true, expires_at: expires }])).request, storage }));
  check("the first reader is granted", owner.cloudSync === true);

  const other = await capability(
    remote({ userId: USER_B, request: () => Promise.reject(new TypeError("fetch failed")), storage }),
  );
  check("a different user id does not inherit the first reader's answer", other.cloudSync === false);
  check("and is not shown their subscription either", other.state === "none", other.state);
  check(
    "the cache is keyed per reader",
    !storage.keys().includes(`${ENTITLEMENT_CACHE_PREFIX}.${USER_B}`) &&
      storage.keys().includes(`${ENTITLEMENT_CACHE_PREFIX}.${USER_A}`),
    storage.keys().join(","),
  );

  // A signed-out device is nobody, so the reader who used it last cannot answer
  // for it — and no request is made on behalf of an identity we do not have.
  const net = server(() => json(200, [{ cloud_sync: true, expires_at: expires }]));
  const signedOut = await capability(remote({ session: () => null, request: net.request, storage }));
  check("a signed-out device has no cloud sync", signedOut.cloudSync === false);
  check("and asks nobody", net.calls.length === 0, String(net.calls.length));
  check(
    "while the paying reader's own answer is still on disk",
    storage.keys().includes(`${ENTITLEMENT_CACHE_PREFIX}.${USER_A}`),
  );
}

/* --------------------------------------------------------------------------
 * The stored session, read the way `supabase-js` wrote it
 * ----------------------------------------------------------------------- */

{
  const storage = new MemoryStorage();
  const token = jwt(USER_A, Math.floor(NOW / 1000) + 3600);
  storage.setItem("sb-fixtureproject-auth-token", JSON.stringify({ access_token: token, expires_at: Math.floor(NOW / 1000) + 3600 }));
  const session = storedCloudSession(storage, PROJECT);
  check("the stored session names its reader", session !== null && session.userId === USER_A);
  check("and carries the token", session !== null && session.token === token);
  check(
    "with the expiry read off the token",
    session !== null && session.expiresAt === (Math.floor(NOW / 1000) + 3600) * 1000,
    String(session?.expiresAt),
  );

  check("a device with no session is no session", storedCloudSession(new MemoryStorage(), PROJECT) === null);
  storage.setItem("sb-fixtureproject-auth-token", JSON.stringify({ access_token: "not-a-jwt" }));
  check("a value that is not a JWT names nobody", storedCloudSession(storage, PROJECT) === null);
  storage.setItem("sb-fixtureproject-auth-token", "{ not json");
  check("and a corrupt value is discarded, not guessed at", storedCloudSession(storage, PROJECT) === null);
}

/* --------------------------------------------------------------------------
 * The seam, and the shop that is not on the device
 * ----------------------------------------------------------------------- */

{
  const store = remote();
  const surface = ["products", "purchase", "restore", "current"];
  check(
    "RemoteStore implements Store",
    surface.every((name) => typeof store[name] === "function"),
    surface.join(","),
  );
  check("it sells nothing in-app: the prices are bought on the web", (await store.products()).length === 0);

  const refusal = await store.purchase(SYNC_MONTHLY);
  check("a purchase press is refused, not invented", refusal.state === "none" && refusal.reason !== null);
  check("and the refusal does not pretend a row exists", refusal.productId === null);
}

/* --------------------------------------------------------------------------
 * The store the panel will actually hold: Checkout for buying, this for reading
 * ----------------------------------------------------------------------- */

{
  // `api/billing.ts` composes `WebStore` out of a checkout opener and a server
  // reader, and left that reader unwritten. This is that reader — so the join is
  // checked here rather than assumed: the same panel, the same capability, and the
  // answer still comes from the row.
  //
  // `billing.ts` imports the capability, which is a runes module Node cannot load
  // raw, so the test builds it the way the app's bundler would: type-stripped, with
  // its two relative imports pointed at the real files.
  const entitlementsUrl = buildEntitlementsModule();
  const billingUrl = (() => {
    const { outputText } = ts.transpileModule(readFileSync(join(ROOT, "src/api/billing.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: "billing.ts",
    });
    const code = outputText
      .replaceAll('"../state/entitlements.svelte"', JSON.stringify(entitlementsUrl))
      .replaceAll('"../lib/open-external"', JSON.stringify(absolute("src/lib/open-external.ts")));
    const out = join(GEN_DIR, "billing.mjs");
    writeFileSync(out, code);
    return pathToFileURL(out).href;
  })();
  const { Entitlements: Capability } = await import(entitlementsUrl);
  const { WebStore } = await import(billingUrl);

  const token = jwt(USER_A, Math.floor(NOW / 1000) + 3600);
  const net = server(() => json(200, [{ cloud_sync: true, expires_at: new Date(NOW + 86_400_000).toISOString() }]));
  const store = new WebStore({
    token: () => token,
    server: remote({ request: net.request, storage: new MemoryStorage() }),
    base: PROJECT,
    open: () => {},
    fetch: net.request,
  });
  const entitlement = new Capability(store);
  await entitlement.refresh();
  check("the composed store grants from the row alone", entitlement.cloudSync === true, entitlement.state);
  check(
    "without a press, a receipt or a checkout",
    net.calls.length === 1 && net.last.url.includes("/rest/v1/entitlements"),
    net.calls.map((call) => call.url).join(","),
  );
  check(
    "and the reader it delegates to is the one this suite tested",
    typeof store.server.read === "function" && (await store.server.read()).state === "active",
  );
}

/* --------------------------------------------------------------------------
 * Grep: no client path writes `cloud_sync`
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
  // Prose is not code: the capability names the writes it forbids, so the scan
  // reads every file with its comments taken out.
  const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const name = (path) => relative(ROOT, path);

  const talkers = files.filter((path) => /rest\/v1\/entitlements/.test(code(path))).map(name);
  check(
    "one file talks to the table",
    talkers.join(",") === "src/state/entitlements.svelte.ts",
    talkers.join(",") || "(none)",
  );

  const own = code(join(ROOT, "src/state/entitlements.svelte.ts"));
  check("and its only request is a GET", /method:\s*"GET"/.test(own));
  check(
    "no POST, PATCH, PUT or DELETE anywhere in the capability",
    !/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(own),
  );
  check(
    "no supabase-js write shape either",
    !/\.(insert|update|upsert|delete)\s*\(/.test(own),
    (own.match(/\.(insert|update|upsert|delete)\s*\(/g) ?? []).join(","),
  );

  // The build's two values must be read through the literal `import.meta.env`:
  // Vite replaces that expression, and a cast around it type-checks, builds, and
  // ships a bundle with no configuration at all (the trap in the identity's own
  // notes, proved by building with dummy values and grepping the chunk).
  check("the configuration comes from the literal import.meta.env", /\(import\.meta\.env \?\? null\)/.test(own));
  check(
    "not through a cast Vite cannot see",
    !/import\.meta as (unknown|ImportMeta)/.test(own),
    (own.match(/import\.meta as \w+/g) ?? []).join(","),
  );

  const tableWrite = files.filter((path) =>
    /entitlements["'`]?\s*\)?\s*\.(insert|update|upsert|delete)\s*\(/.test(code(path)),
  ).map(name);
  check("no file anywhere writes the table", tableWrite.length === 0, tableWrite.join(",") || "(none)");

  const fn = files.filter((path) => /set_entitlement/.test(code(path))).map(name);
  check("no app code references the webhook's function", fn.length === 0, fn.join(",") || "(none)");

  // The other half of the grep: the SQL must not grow the policy this suite says
  // does not exist, and the webhook's function must stay out of clients' reach.
  const sql = readFileSync(join(ROOT, "supabase/schema.sql"), "utf8");
  const policyBodies = [...sql.matchAll(/create policy[\s\S]{0,400}?;/gi)].map((match) => match[0]);
  check("the table has a policy", policyBodies.length === 1, String(policyBodies.length));
  check(
    "and it is a select on the reader's own row",
    policyBodies.length === 1 && /for select/i.test(policyBodies[0]) && /auth\.uid\(\) = user_id/.test(policyBodies[0]),
  );
  check(
    "with no write policy at all",
    !policyBodies.some((body) => /\bfor (insert|update|delete|all)\b/i.test(body)),
  );
  check("RLS is enabled on it", /alter table public\.entitlements enable row level security/i.test(sql));
  check(
    "the webhook function is revoked from clients",
    /revoke all on function public\.set_entitlement[^;]*from authenticated/i.test(sql),
  );
  check(
    "and granted to the service role alone",
    (sql.match(/grant execute on function public\.set_entitlement[^;]*to ([a-z_]+)/i) ?? [])[1] === "service_role",
  );

  // The document the card says must stay true.
  const doc = readFileSync(join(ROOT, "docs/accounts-and-entitlements.md"), "utf8");
  check(
    "the document still says a client can never write cloud_sync",
    /client can never write `cloud_sync`/i.test(doc),
  );
  check(
    "and still says a failed fetch means false, never a broken reader",
    /failed fetch, a 500, an expired JWT/i.test(doc),
  );
  check("and still keeps FreshRSS outside the system", /FreshRSS is outside this system/i.test(doc));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
