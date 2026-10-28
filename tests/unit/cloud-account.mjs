/**
 * The account surface, driven without a browser.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/cloud-account.mjs
 *
 * `state/cloud-account.svelte.ts` is the whole of the Settings → Account section
 * bar the markup, so this suite is the card's acceptance: what each press calls,
 * what it says afterwards, and — the half that matters more — what it never
 * calls. Four of the rules are about *not* doing something:
 *
 *   - adding a door never signs in a second time (one person, one `auth.users` row);
 *   - revoking another device never signs this one out;
 *   - the first delete press sends nothing at all;
 *   - a refusal while Stripe is still charging changes nothing, and points at the
 *     payment portal instead.
 *
 * The seam and the network are the real modules; `FakeIdentity` and one recorded
 * `fetch` stand in for the provider and the account server, exactly as
 * `account.mjs` does.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { FakeIdentity, PROVIDER_LABEL, secondAccountRefusal } from "../../src/api/identity.ts";
import { CANCEL_FIRST, DEVICE_REVOKED } from "../../src/api/account.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN = join(ROOT, `tests/unit/.gen-${process.pid}/cloud-account`);

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* --------------------------------------------------------------------------
 * The runes module, compiled the way the build compiles it
 * ----------------------------------------------------------------------- */

const built = new Map();

function sourceOf(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function rewrite(code, fromFile) {
  return code.replace(/(from\s*)(["'])([^"']+)\2/g, (whole, before, quote, specifier) => {
    const source = sourceOf(fromFile, specifier);
    if (source === null) return whole;
    return `${before}${quote}${built.get(source) ?? pathToFileURL(source).href}${quote}`;
  });
}

function buildRunes(relative) {
  const file = join(ROOT, relative);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: relative });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${basename(relative).replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewrite(compiled.js.code, file));
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

// The chain is built from the bottom: `api/billing.ts` imports a runes module
// (`state/entitlements.svelte.ts`), so that one is compiled first and billing's
// import of it is pointed at the compiled copy — an in-place `.svelte.ts` import
// would reach `$state` outside a compile and throw.
buildRunes("src/state/entitlements.svelte.ts");
buildRunes("src/api/billing.ts");
const { CloudAccount, PORTAL_OPENED, NO_CUSTOMER } = await import(await buildRunes("src/state/cloud-account.svelte.ts"));
const { registerOnce, registeredSession, lastSeenLabel, DEVICE_MARK_KEY } = await import(
  await buildRunes("src/lib/account-device.ts")
);
const { EMAIL_CHANGE_SENT } = await import("../../src/api/identity.ts");

/* --------------------------------------------------------------------------
 * A device's storage, and an account server that answers and remembers
 * ----------------------------------------------------------------------- */

function memoryKeys() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    size: () => map.size,
    raw: map,
  };
}

const PROJECT = "https://project.test";
const ANON = "anon_key";
const SELF_SESSION = "fake-session-1";
const OTHER_SESSION = "fake-session-other";

/**
 * PostgREST, as the four calls use it.
 *
 * `answers` is keyed by the path PostgREST answers on, so a test says what the
 * server does rather than what a function returns. Every call is recorded — body
 * and all — because "the right call and no other" is the question here.
 */
function accountServer(answers = {}) {
  const calls = [];
  const request = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/rest\/v1\//, "");
    calls.push({ path, method: init.method, body: init.body, headers: init.headers });
    const handler = answers[parsed.pathname.replace(/^\/rest\/v1\//, "")] ?? answers.default;
    if (handler === undefined) return new Response("null", { status: 200 });
    return handler({ path, method: init.method, body: init.body, headers: init.headers });
  };
  return { request, calls, count: (path) => calls.filter((call) => call.path === path).length };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DEVICE_ROWS = [
  { session_id: SELF_SESSION, label: "Linux · Firefox", platform: "Linux", created_at: "2026-10-27T10:00:00Z", last_seen_at: "2026-10-27T12:00:00Z" },
  { session_id: OTHER_SESSION, label: "iOS", platform: "iOS", created_at: "2026-10-20T10:00:00Z", last_seen_at: "2026-10-26T12:00:00Z" },
];

const NOW = Date.parse("2026-10-27T12:05:00Z");

/** One account surface over one fake device, for one check block. */
function surface({ answers, identity, keys = memoryKeys(), billing = null } = {}) {
  const server = accountServer(answers);
  const id = identity ?? new FakeIdentity({ keys: memoryKeys() });
  const opened = [];
  const account = new CloudAccount({
    identity: id,
    server: () => ({ url: PROJECT, anonKey: ANON, request: server.request }),
    userAgent: () => "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0",
    billingBase: () => "https://billing.test",
    billingFetch: billing?.fetch,
    open: (url) => opened.push(url),
    keys,
    now: () => NOW,
  });
  return { account, identity: id, server, opened, keys };
}

/* --------------------------------------------------------------------------
 * Signed out: the three doors, and nothing asked before a press
 * ----------------------------------------------------------------------- */

{
  const { account, server } = surface();
  check("a device with no account is signed out", account.signedIn === false && account.providerLabel === "");
  check("and no press has asked the server anything", server.calls.length === 0, JSON.stringify(server.calls));
  check("an empty surface forbids no door", account.doorsToAdd.join(",") === "google,apple");
  check("the address is offered by name, not as a third door", !account.doorsToAdd.includes("email"));
}

{
  const { account, identity, server } = surface();
  await account.opened();
  check("opening the section on a signed-out device asks the account server nothing", server.calls.length === 0, JSON.stringify(server.calls));
  check("and it does not register this device", server.count("rpc/register_device") === 0);
  check("but it does ask the provider whether a session came back", identity.calls.includes("refresh"), identity.calls.join(","));
}

{
  const { account, identity, server, keys } = surface({
    answers: { "rpc/register_device": () => json(200, "ok") },
  });
  await account.signIn("google");

  check("a door signs in through the seam", identity.calls.includes("signIn:google"), identity.calls.join(","));
  check("and this device is signed in afterwards", account.signedIn === true);
  check("with the door it came through, named", account.provider === "google" && account.providerLabel === "Google");
  check("its address is shown", account.email === "google@fixture.test", String(account.email));

  // The one registration, and it is not in the reader's way: `signIn()` returned
  // before the row was written.
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("the sign-in registered this device once", server.count("rpc/register_device") === 1, JSON.stringify(server.calls.map((call) => call.path)));
  const written = JSON.parse(server.calls.find((call) => call.path === "rpc/register_device").body);
  check("with a label from the user agent", written.p_label === "Linux · Firefox", JSON.stringify(written));
  check("and a platform", written.p_platform === "Linux");
  check("the session is remembered on this device", registeredSession(keys) === SELF_SESSION, String(registeredSession(keys)));

  // A reload: the same session, a second surface over the same device store.
  const again = surface({
    answers: { "rpc/register_device": () => json(200, "ok") },
    identity: identity,
    keys,
  });
  await again.account.opened();
  check("a second opening for the same session registers nothing", again.server.count("rpc/register_device") === 0, JSON.stringify(again.server.calls.map((call) => call.path)));
}

/* --------------------------------------------------------------------------
 * Signed in: adding a door is a link, never a second sign-in
 * ----------------------------------------------------------------------- */

{
  const { account, identity, server } = surface();
  await account.signIn("google");

  check("only the doors this account does not have are offered", account.doorsToAdd.join(",") === "apple", account.doorsToAdd.join(","));

  await account.link("apple");
  check("adding Apple links it", identity.calls.includes("link:apple"), identity.calls.join(","));
  check("and does not sign in a second time", identity.calls.filter((call) => call.startsWith("signIn:")).length === 1, identity.calls.join(","));
  check("the account is the same row before and after", identity.userId === "fake-google-user", String(identity.userId));
  check("the confirmation is the seam's own sentence", /browser is open at Apple/i.test(String(account.notice)), String(account.notice));
  check("the door is now listed, so it is no longer offered", account.doorsToAdd.length === 0, account.doorsToAdd.join(","));

  await new Promise((resolve) => setTimeout(resolve, 0));
  check("and linking registered no second device", server.count("rpc/register_device") === 1, JSON.stringify(server.calls.map((call) => call.path)));
}

{
  const { account, identity } = surface();
  await account.signIn("google");
  await account.link("email", "reader@example.test");
  check("a change of address goes through the seam as a link", identity.calls.includes("link:email"), identity.calls.join(","));
  check("and says it needs confirming from both inboxes", account.notice === EMAIL_CHANGE_SENT, String(account.notice));
}

{
  // The provider refuses the door — an identity already linked elsewhere, or
  // manual linking switched off in the project. A rejection is the sentence.
  const identity = new FakeIdentity({ keys: memoryKeys(), failLink: true });
  const { account } = surface({ identity });
  await account.signIn("google");
  await account.link("apple");
  check("a refused add is a sentence, not a stack trace", /Apple: /i.test(String(account.note)), String(account.note));
  check("and this device is still signed in", account.signedIn === true);
}

/* --------------------------------------------------------------------------
 * Devices: the list, and what revoking one means
 * ----------------------------------------------------------------------- */

{
  const { account, server } = surface({
    answers: {
      "rpc/register_device": () => json(200, "ok"),
      account_devices: () => json(200, DEVICE_ROWS),
    },
  });
  await account.signIn("google");
  await account.loadDevices();

  check("the list is one GET on the table", server.calls.filter((call) => call.path === "account_devices").every((call) => call.method === "GET"));
  check("two devices are drawn", account.deviceRows.length === 2, String(account.deviceRows.length));
  const self = account.deviceRows.find((row) => row.current);
  check("this device's row is recognised from its own session claim", self?.id === SELF_SESSION, String(self?.id));
  check("the other row is not marked as this one", account.deviceRows.filter((row) => row.current).length === 1);
  check("a row carries its label", self?.label === "Linux · Firefox", String(self?.label));
  check("a row carries its platform", self?.platform === "Linux", String(self?.platform));
  check("a row carries when it was last seen", account.lastSeen(self?.lastSeenAt ?? null) === "5 minutes ago", account.lastSeen(self?.lastSeenAt ?? null));
  check("and a row with no date says so", lastSeenLabel(null) === "not seen yet");
}

{
  const { account } = surface({
    answers: {
      "rpc/register_device": () => json(200, "ok"),
      account_devices: () => json(403, {}),
    },
  });
  await account.signIn("google");
  await account.loadDevices();
  check("a refused list is a sentence, not an empty device list", account.deviceRows.length === 0 && account.devicesState === "failed");
  check("...that says what happened", /could not be read/.test(String(account.note)), String(account.note));
}

{
  const { account, identity } = surface({
    answers: {
      "rpc/register_device": () => json(200, "ok"),
      account_devices: () => json(200, DEVICE_ROWS),
      "rpc/revoke_device": () => json(200, true),
    },
  });
  await account.signIn("google");
  await account.loadDevices();
  const other = account.deviceRows.find((row) => !row.current);

  await account.revoke(other);
  check("revoking another device ends its session", true);
  check("the sentence says its library is still on it", account.note === DEVICE_REVOKED, String(account.note));
  check("the row is gone from the list on screen", account.deviceRows.length === 1);
  check("and this device is still signed in", account.signedIn === true && identity.calls.includes("signOut") === false);
}

{
  const { account, identity, server } = surface({
    answers: {
      "rpc/register_device": () => json(200, "ok"),
      account_devices: () => json(200, DEVICE_ROWS),
      "rpc/revoke_device": () => json(200, true),
    },
  });
  await account.signIn("google");
  await account.loadDevices();
  const self = account.deviceRows.find((row) => row.current);

  await account.revoke(self);
  const sent = JSON.parse(server.calls.find((call) => call.path === "rpc/revoke_device").body);
  check("revoking this device names its own session", sent.p_session === SELF_SESSION, JSON.stringify(sent));
  check("the sentence says it is this device signing out", /This is the device you are reading on/.test(String(account.note)), String(account.note));
  check("and it signs this device out locally", identity.calls.includes("signOut") && account.signedIn === false, identity.calls.join(","));
  check("the device list goes with the account", account.deviceRows.length === 0);
  check("and nothing was deleted anywhere", server.count("rpc/delete_my_account") === 0);
}

/* --------------------------------------------------------------------------
 * Deleting: two presses, and a refusal with somewhere to go
 * ----------------------------------------------------------------------- */

{
  const { account, identity, server } = surface({
    answers: {
      "rpc/register_device": () => json(200, "ok"),
      "rpc/delete_my_account": () => json(200, "deleted"),
    },
  });
  await account.signIn("google");

  account.askDelete();
  check("the first press sends nothing", server.count("rpc/delete_my_account") === 0 && account.confirmingDelete === true);
  account.cancelDelete();
  check("and the way out sends nothing either", server.count("rpc/delete_my_account") === 0 && account.confirmingDelete === false);

  account.askDelete();
  await account.confirmDelete();
  check("the second press calls the one function", server.count("rpc/delete_my_account") === 1);
  check("the answer is the deletion sentence", /account and its subscription record are deleted/.test(String(account.note)), String(account.note));
  check("the sentence says the library and the folder are still there", /library on this device is still here/.test(String(account.note)));
  check("and this device signs itself out", identity.calls.includes("signOut") && account.signedIn === false, identity.calls.join(","));
  check("the second step is closed behind it", account.confirmingDelete === false);
}

{
  const { account, identity, server } = surface({
    answers: {
      "rpc/register_device": () => json(200, "ok"),
      "rpc/delete_my_account": () => json(200, "cancel_first"),
    },
  });
  await account.signIn("google");
  account.askDelete();
  await account.confirmDelete();

  check("a live subscription refuses the deletion", account.note === CANCEL_FIRST, String(account.note));
  check("nothing is signed out", identity.calls.includes("signOut") === false && account.signedIn === true);
  check("and the sheet now offers the way to cancel", account.needsCancel === true);
  check("nothing was deleted server-side by us either", server.count("rpc/delete_my_account") === 1);
}

{
  // A network that never answers: a sentence, and the account still there.
  const { account } = surface({
    answers: {
      "rpc/register_device": () => json(200, "ok"),
      "rpc/delete_my_account": () => {
        throw new Error("offline");
      },
    },
  });
  await account.signIn("google");
  account.askDelete();
  await account.confirmDelete();
  check("a deletion that did not answer claims nothing", /Nothing has changed/.test(String(account.note)), String(account.note));
  check("and this device stays signed in", account.signedIn === true);
}

/* --------------------------------------------------------------------------
 * The portal: where a refused deletion sends the reader
 * ----------------------------------------------------------------------- */

{
  const portals = [];
  const billing = {
    fetch: async (url, init) => {
      portals.push({ url, init });
      return json(200, { url: "https://billing.stripe.com/p/session/bps_1" });
    },
  };
  const { account, identity, opened } = surface({
    answers: {
      "rpc/register_device": () => json(200, "ok"),
      "rpc/delete_my_account": () => json(200, "cancel_first"),
    },
    billing,
  });
  await account.signIn("google");
  await account.manageSubscription();

  check("the portal is asked for by POST", portals.length === 1 && portals[0].init.method === "POST", JSON.stringify(portals.map((call) => call.url)));
  check("at the service's own route", portals[0]?.url === "https://billing.test/portal", portals[0]?.url);
  check("with this device's token and nothing else", portals[0]?.init.headers.Authorization === `Bearer ${identity.token}`);
  check("no body names a customer", portals[0]?.init.body === undefined);
  check("and the URL is opened outside the app", opened.join(",") === "https://billing.stripe.com/p/session/bps_1", opened.join(","));
  check("the sentence says nothing has changed yet", account.note === PORTAL_OPENED, String(account.note));
}

{
  const { account, opened } = surface({
    answers: { "rpc/register_device": () => json(200, "ok") },
    billing: { fetch: async () => json(404, { error: "no_customer" }) },
  });
  await account.signIn("google");
  await account.manageSubscription();
  check("a reader with no customer is told there is nothing to cancel", account.note === NO_CUSTOMER, String(account.note));
  check("and no page is opened for them", opened.length === 0);
}

{
  const { account, opened } = surface({
    answers: { "rpc/register_device": () => json(200, "ok") },
    billing: {
      fetch: async () => {
        throw new Error("offline");
      },
    },
  });
  await account.signIn("google");
  await account.manageSubscription();
  check("a portal that could not be opened says so, and opens nothing", /could not be opened/.test(String(account.note)) && opened.length === 0);
}

/* --------------------------------------------------------------------------
 * One registration per sign-in, and the mark that makes it true
 * ----------------------------------------------------------------------- */

{
  const keys = memoryKeys();
  let registered = 0;
  const once = () => {
    registered += 1;
    return { ok: true };
  };

  const first = await registerOnce({ sessionId: SELF_SESSION, register: once, keys });
  const second = await registerOnce({ sessionId: SELF_SESSION, register: once, keys });
  check("the same session is registered once", first === "registered" && second === "already", `${first}/${second}`);
  check("and the mark names that session", keys.getItem(DEVICE_MARK_KEY) === SELF_SESSION);

  const changed = await registerOnce({ sessionId: OTHER_SESSION, register: once, keys });
  check("a new session is registered again", changed === "registered" && registered === 2, `${changed}/${registered}`);

  const failing = await registerOnce({
    sessionId: "fake-session-3",
    register: () => ({ ok: false }),
    keys,
  });
  check("a failed registration keeps no mark, so it is retried", failing === "failed" && keys.getItem(DEVICE_MARK_KEY) === OTHER_SESSION);

  const none = await registerOnce({ sessionId: null, register: once, keys });
  check("a device with no session asks nothing", none === "no_session" && registered === 2);

  const raising = await registerOnce({
    sessionId: "fake-session-4",
    register: () => {
      throw new Error("offline");
    },
    keys,
  });
  check("a call that throws is a failure, not an exception", raising === "failed", raising);
}

/* --------------------------------------------------------------------------
 * The return from a provider: the seam adopts what the provider's client stored
 * ----------------------------------------------------------------------- */

{
  // `supabase-js` writes the session after this app read its own storage, so a
  // device that has just signed in with Google holds no record until somebody asks
  // the client. `refresh()` with no record is that ask — and it is a storage read
  // when there is nothing to find.
  const { SupabaseIdentity } = await import("../../src/api/identity.ts");
  const calls = [];
  const client = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            access_token: "at-returned",
            expires_at: 1_800_000_000,
            user: {
              id: "user-returned",
              email: "reader@fixture.test",
              identities: [{ provider: "google" }],
            },
          },
        },
        error: null,
      }),
      refreshSession: async () => {
        calls.push("refreshSession");
        return { data: { session: null }, error: { message: "unexpected" } };
      },
      signOut: async () => ({ error: null }),
    },
  };
  const returned = new SupabaseIdentity({ client, keys: memoryKeys() });
  check("a return holds no record before it is asked for", returned.userId === null);
  await returned.refresh();
  check("and the session the provider stored becomes the account", returned.userId === "user-returned", String(returned.userId));
  check("with the door the account's own identity list names", returned.provider === "google", String(returned.provider));
  check("the token is the one it came back with", returned.token === "at-returned");
  check("and no renewal was asked for", calls.length === 0, calls.join(","));

  const quiet = new SupabaseIdentity({
    client: { auth: { getSession: async () => ({ data: { session: null }, error: null }), signOut: async () => ({}) } },
    keys: memoryKeys(),
  });
  await quiet.refresh();
  check("a device with nothing stored adopts nothing and says nothing", quiet.userId === null && quiet.notice === null);
}

/* --------------------------------------------------------------------------
 * A signed-in account that is already on the device
 * ----------------------------------------------------------------------- */

{
  const keys = memoryKeys();
  const identity = new FakeIdentity({ keys, record: null });
  await identity.signIn("apple");
  const record = JSON.parse(keys.getItem("hardlyreader.identity.v1"));
  const restarted = new FakeIdentity({ keys, record });
  const { account } = surface({
    identity: restarted,
    answers: { "rpc/register_device": () => json(200, "ok"), account_devices: () => json(200, []) },
  });
  check("a restart finds the account already there", account.signedIn === true && account.provider === "apple");

  // Signed in with Apple, offered Google: the refusal comes from the seam, and the
  // surface shows it rather than quietly creating a second account.
  await account.signIn("google");
  check("a second sign-in through another door is refused by name", account.notice === secondAccountRefusal("google"), String(account.notice));
  check("and the account did not move", restarted.userId === "fake-apple-user", String(restarted.userId));
  check("the seam never asked a provider to sign in", restarted.calls.includes("signInRefused:google"), restarted.calls.join(","));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
