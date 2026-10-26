/**
 * More than one account on one device.
 *
 * The app used to hold exactly one session, and every device-local key was
 * global because of it. `lib/account-key` made the keys per account; this suite
 * pins the list on top of that:
 *
 * - adding a second account keeps the first, and the new one becomes the one in
 *   use;
 * - switching re-reads each account's own layout and reading choices, in the
 *   real stores, so the previous account's panes and text scale do not follow it;
 * - removing an account drops its session and nothing else — its scoped state is
 *   still on disk;
 * - a second account never adopts a pre-scoping key the first one already owns;
 * - switching asks the server first, through the same store the app uses, with
 *   the network stubbed here.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/accounts.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { ACCOUNTS_KEY, SESSION_KEY, loadSession } from "../../src/api/session.ts";
import { AuthError } from "../../src/api/freshrss.ts";
import { accountSlug, scopedKey } from "../../src/lib/account-key.ts";
import {
  accountRows,
  activateAccount,
  forgetAccount,
  rememberAccount,
  sessionFor,
} from "../../src/lib/accounts.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, "tests/unit/.gen");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** Two logins on one device. Synthetic hosts, no password anywhere. */
const ONE = { serverUrl: "https://one.example", email: "one@one.example" };
const TWO = { serverUrl: "https://two.example", email: "two@two.example" };

/** What the client stores for a signed-in account. */
const sessionOf = (identity) => ({
  serverUrl: identity.serverUrl,
  apiPath: "/api/greader.php",
  email: identity.email,
  token: `token-${identity.email}`,
});

const LAYOUT_KEY = "hardlyreader.layout.v1";
const READING_KEY = "hardlyreader.reading.v1";

/** A plain-Map `localStorage`, so a relaunch is a new object over the same map. */
function memoryStore(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

/**
 * A runes module as plain ESM, imported from a throwaway file inside the project
 * so its relative imports resolve the way the app's build resolves them.
 */
function buildModule(relative, outName) {
  const source = readFileSync(join(ROOT, relative), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: relative });
  const folder = dirname(relative);
  const code = compiled.js.code.replace(/from\s+"(\.[^"]*)"/g, (whole, specifier) => {
    const target = join(ROOT, folder, `${specifier}.ts`);
    if (!existsSync(target)) throw new Error(`unresolved import ${specifier} from ${relative}`);
    return `from ${JSON.stringify(pathToFileURL(target).href)}`;
  });
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, outName);
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

/** The window a desktop launch sees, as the layout store measures it. */
function stubWindow() {
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 900,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
    __TAURI_INTERNALS__: {},
  };
  globalThis.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
}

stubWindow();

// --- the list ---------------------------------------------------------------
// One device, two sessions, and one of them in use at a time.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionOf(ONE)) });
  globalThis.localStorage = storage;

  const rows = accountRows();
  check("a device signed in before the list existed reads as one account", rows.length === 1, rows.length);
  check("...and that account is the one in use", rows[0]?.active === true);
  check("...under its own slug", rows[0]?.slug === accountSlug(ONE), rows[0]?.slug);

  rememberAccount(sessionOf(TWO));
  const both = accountRows();
  check(
    "adding a second account keeps the first",
    both.length === 2 && both[0].email === ONE.email && both[1].email === TWO.email,
    both.map((row) => row.email).join(", "),
  );
  check("the account just signed in is the one in use", both[1].active === true && both[0].active === false);
  check(
    "the session in use is the one just signed in",
    JSON.parse(storage.getItem(SESSION_KEY)).email === TWO.email,
  );
  check("both sessions are stored", JSON.parse(storage.getItem(ACCOUNTS_KEY)).length === 2);

  activateAccount(accountSlug(ONE));
  check("switching makes the other account the one in use", JSON.parse(storage.getItem(SESSION_KEY)).email === ONE.email);
  check("...without reordering the list", accountRows()[0].email === ONE.email);

  const wasActive = forgetAccount(accountSlug(TWO));
  check("removing the account not in use says so", wasActive === false);
  check("...leaves it out of the list", accountRows().length === 1);
  check("...and leaves the session in use alone", JSON.parse(storage.getItem(SESSION_KEY)).email === ONE.email);

  const activeGone = forgetAccount(accountSlug(ONE));
  check("removing the account in use is reported as that", activeGone === true);
  check("...and the device is left with no session", loadSession() === null && accountRows().length === 0);
  check(
    "no storage key names an address",
    [...storage.store.keys()].every((key) => !key.includes("@")),
    [...storage.store.keys()].join(", "),
  );
}

// --- the layout, through the real store -------------------------------------
// The store is a singleton loaded at import, which is exactly why a switch used
// to keep the previous account's panes: `reload()` is what the reader calls when
// it mounts for a session, and it has to find the new account's own copy.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionOf(ONE)) });
  globalThis.localStorage = storage;
  const { layout } = await import(`${buildModule("src/state/layout.svelte.ts", "accounts-layout.mjs")}?launch=1`);

  layout.setMode(2);
  check(
    "the first account's mode is stored under its own key",
    storage.getItem(scopedKey(LAYOUT_KEY, ONE))?.includes('"mode":2') === true,
    storage.getItem(scopedKey(LAYOUT_KEY, ONE)),
  );
  check("...and not under the bare key", storage.getItem(LAYOUT_KEY) === null);

  rememberAccount(sessionOf(TWO));
  layout.reload();
  check("switching re-reads the layout instead of keeping the old panes", layout.desired === 3, layout.desired);
  layout.setMode(1);
  check(
    "the second account's choice lands on its own key",
    storage.getItem(scopedKey(LAYOUT_KEY, TWO))?.includes('"mode":1') === true,
    storage.getItem(scopedKey(LAYOUT_KEY, TWO)),
  );

  activateAccount(accountSlug(ONE));
  layout.reload();
  check("the first account comes back to its own mode", layout.desired === 2, layout.desired);

  activateAccount(accountSlug(TWO));
  layout.reload();
  check("and the second account comes back to its own", layout.desired === 1, layout.desired);
  check(
    "the first account's blob was never written by the second",
    storage.getItem(scopedKey(LAYOUT_KEY, ONE))?.includes('"mode":2') === true,
    storage.getItem(scopedKey(LAYOUT_KEY, ONE)),
  );
}

// --- the reading choices, through the real module ---------------------------
// `load()` is what a remount calls, and it has to start from the defaults: an
// account that never saved a blob must not open at the previous account's shape.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionOf(ONE)) });
  globalThis.localStorage = storage;
  const { reading } = await import(`${buildModule("src/state/reading.svelte.ts", "accounts-reading.mjs")}?launch=1`);

  reading.load();
  reading.setListView("cards");
  check(
    "the first account's view is stored under its own key",
    storage.getItem(scopedKey(READING_KEY, ONE))?.includes('"cards"') === true,
  );

  rememberAccount(sessionOf(TWO));
  reading.load();
  check("switching drops the previous account's reading choices", reading.listView === "regular", reading.listView);
  reading.setListView("grid");

  activateAccount(accountSlug(ONE));
  reading.load();
  check("the first account comes back to its own view", reading.listView === "cards", reading.listView);

  activateAccount(accountSlug(TWO));
  reading.load();
  check("and the second account to its own", reading.listView === "grid", reading.listView);
}

// --- the chrome, through the real store -------------------------------------
// The band's fold is the smallest of the three stores and shows the same rule:
// the account in use is resolved at every read, so a remount lands on its own
// chrome rather than on the one that was on screen a moment ago.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionOf(ONE)) });
  globalThis.localStorage = storage;
  const { chrome } = await import(`${buildModule("src/state/chrome.svelte.ts", "accounts-chrome.mjs")}?launch=1`);

  chrome.load();
  chrome.setBandCollapsed(true);
  check("the first account's band state is stored", storage.getItem(scopedKey("hardlyreader.chrome.v1", ONE)) !== null);

  rememberAccount(sessionOf(TWO));
  chrome.load();
  check("switching opens on the new account's own band state", chrome.bandCollapsed === false);

  activateAccount(accountSlug(ONE));
  chrome.load();
  check("and the first account's comes back", chrome.bandCollapsed === true);
}

// --- a pre-scoping key belongs to one account --------------------------------
// The old global blob is adopted by the first account that reads it, and never by
// the second one: inheriting a stranger's list shape is not an upgrade.
{
  const storage = memoryStore({
    [SESSION_KEY]: JSON.stringify(sessionOf(ONE)),
    [READING_KEY]: JSON.stringify({ listView: "cards" }),
  });
  globalThis.localStorage = storage;
  const { reading } = await import(`${buildModule("src/state/reading.svelte.ts", "accounts-reading.mjs")}?launch=2`);

  reading.load();
  check("the first account adopts a pre-scoping reading blob", reading.listView === "cards", reading.listView);

  rememberAccount(sessionOf(TWO));
  reading.load();
  check("a second account starts from the defaults", reading.listView === "regular", reading.listView);
  reading.setListView("grid");
  check(
    "its write lands on its own key",
    storage.getItem(scopedKey(READING_KEY, TWO))?.includes('"grid"') === true,
  );
  check(
    "the old blob still says what the first account chose",
    storage.getItem(READING_KEY)?.includes('"cards"') === true,
    storage.getItem(READING_KEY),
  );
}

// --- switching is a re-authentication ---------------------------------------
// The store the app uses, with the network stubbed: a switch has to ask the
// server about the account it is moving to, and a refusal has to leave the
// session in use exactly where it was.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionOf(ONE)) });
  globalThis.localStorage = storage;
  rememberAccount(sessionOf(TWO));
  activateAccount(accountSlug(ONE));

  const { AccountsState } = await import(
    `${buildModule("src/state/accounts.svelte.ts", "accounts-store.mjs")}?launch=1`
  );

  const asked = [];
  const store = new AccountsState(async (session) => {
    asked.push(session.email);
    return {
      userId: "2",
      userName: "Two on two",
      userProfileId: "2",
      userEmail: session.email,
    };
  });

  check("the store opens on the account in use", store.active?.email === ONE.email, store.active?.email);
  check("...and lists both accounts", store.rows.length === 2, store.rows.length);

  const switched = await store.switchTo(accountSlug(TWO));
  check("a switch asks the server about the account it is moving to", asked.join(",") === TWO.email, asked.join(","));
  check("...and only then re-points the session", switched === true && JSON.parse(storage.getItem(SESSION_KEY)).email === TWO.email);
  check("...and the name is the one the server just gave", store.profile?.userName === "Two on two", store.profile?.userName);

  const refusing = new AccountsState(async () => {
    throw new AuthError("refused", 401);
  });
  const refused = await refusing.switchTo(accountSlug(ONE));
  check("a refused switch changes nothing", refused === false && refusing.active?.email === TWO.email);
  check(
    "...and says what to do about it",
    /refused/i.test(refusing.notice) && refusing.notice.includes(ONE.email),
    refusing.notice,
  );
  check("...and the stored session is untouched", JSON.parse(storage.getItem(SESSION_KEY)).email === TWO.email);

  // Removing an account keeps everything it owned but its sign-in.
  const { reading } = await import(`${buildModule("src/state/reading.svelte.ts", "accounts-reading.mjs")}?launch=3`);
  reading.load();
  reading.setListView("cards");
  const keptKey = scopedKey(READING_KEY, TWO);
  check("the account being removed has state on disk", storage.getItem(keptKey) !== null);

  await store.remove(accountSlug(TWO));
  check("removing the account in use moves to the one left", store.active?.email === ONE.email, store.active?.email);
  check("...drops only its session", sessionFor(accountSlug(TWO)) === null && accountRows().length === 1);
  check("...and leaves its layout and reading state on disk", storage.getItem(keptKey) !== null);
  check(
    "signing out of everything forgets every session",
    (() => {
      store.signOut();
      return store.active === null && accountRows().length === 0;
    })(),
  );
}

// --- the hook the reader calls ----------------------------------------------
// `layout.svelte.ts` loads at import, before there is an account to load for.
// Mounting the reader for a session is what closes that gap, and a switch is a
// new mount — so this one line is the difference between the new account's panes
// and the previous account's.
{
  const source = readFileSync(join(ROOT, "src/views/Main.svelte"), "utf8");
  check("the reader re-reads the layout when it mounts for a session", /layout\.reload\(\);/.test(source));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
