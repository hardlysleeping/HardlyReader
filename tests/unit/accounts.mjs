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
import { DEVICE_IDENTITY } from "../../src/lib/settings-scope.ts";
import {
  accountRows,
  activateAccount,
  forgetAccount,
  rememberAccount,
  sessionFor,
} from "../../src/lib/accounts.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const GEN_DIR = join(ROOT, `tests/unit/.gen-${process.pid}`);

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
// Settings belong to the person, not to the feed account (owner, 2026-11-05:
// *"all the settings that are kept should be hardlyreader account based not based
// off whatever sync account they have connect"*). So a switch between two servers
// keeps the panes — it re-reads the same scope — and only a device with no
// HardlyReader account is scoped to the device itself.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionOf(ONE)) });
  globalThis.localStorage = storage;
  const { layout } = await import(`${buildModule("src/state/layout.svelte.ts", "accounts-layout.mjs")}?launch=1`);

  layout.setMode(2);
  check(
    "the layout is stored under the device scope, not the feed account",
    storage.getItem(scopedKey(LAYOUT_KEY, DEVICE_IDENTITY))?.includes('"mode":2') === true,
    [...storage.store.keys()].join(", "),
  );
  check(
    "...and the feed account's own key is never used",
    storage.getItem(scopedKey(LAYOUT_KEY, ONE)) === null &&
      storage.getItem(scopedKey(LAYOUT_KEY, TWO)) === null,
  );

  rememberAccount(sessionOf(TWO));
  layout.reload();
  check("switching keeps the panes a person chose", layout.desired === 2, layout.desired);
  layout.setMode(1);
  check(
    "the change is written once, for the person",
    storage.getItem(scopedKey(LAYOUT_KEY, DEVICE_IDENTITY))?.includes('"mode":1') === true,
  );

  activateAccount(accountSlug(ONE));
  layout.reload();
  check("and the other server sees the same choice", layout.desired === 1, layout.desired);
}

// --- the reading choices, through the real module ---------------------------
// `load()` is what a remount calls. Under the person rule it finds the same
// choices on either server, and the device's own copy when there is no account —
// a remount no longer resets the list shape to defaults.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionOf(ONE)) });
  globalThis.localStorage = storage;
  const { reading } = await import(`${buildModule("src/state/reading.svelte.ts", "accounts-reading.mjs")}?launch=1`);

  reading.load();
  reading.setListView("cards");
  check(
    "the view is stored under the device scope",
    storage.getItem(scopedKey(READING_KEY, DEVICE_IDENTITY))?.includes('"cards"') === true,
    [...storage.store.keys()].join(", "),
  );
  check(
    "...and not under the feed account",
    storage.getItem(scopedKey(READING_KEY, ONE)) === null,
  );

  rememberAccount(sessionOf(TWO));
  reading.load();
  check("switching keeps the person's reading choices", reading.listView === "cards", reading.listView);
  reading.setListView("grid");

  activateAccount(accountSlug(ONE));
  reading.load();
  check("and the first server reads the same choice", reading.listView === "grid", reading.listView);
}

// --- the chrome, through the real store -------------------------------------
// The band's fold is the smallest of the three stores. It is a setting, so it
// follows the person/device scope too: switching servers no longer reopens the
// bar, which is the rule the owner set on 2026-11-05.
{
  const storage = memoryStore({ [SESSION_KEY]: JSON.stringify(sessionOf(ONE)) });
  globalThis.localStorage = storage;
  const { chrome } = await import(`${buildModule("src/state/chrome.svelte.ts", "accounts-chrome.mjs")}?launch=1`);

  chrome.load();
  chrome.setBandCollapsed(true);
  check("the band's fold is stored under the settings scope", storage.getItem(scopedKey("hardlyreader.chrome.v1", DEVICE_IDENTITY)) !== null);

  rememberAccount(sessionOf(TWO));
  chrome.load();
  check("switching keeps the fold a person chose", chrome.bandCollapsed === true);

  activateAccount(accountSlug(ONE));
  chrome.load();
  check("and it comes back on the first server", chrome.bandCollapsed === true);
}

// --- a pre-scoping key belongs to one scope ---------------------------------
// The old global blob is adopted by the first scope that reads it and never by a
// second person: inheriting a stranger's list shape is not an upgrade. The same
// rule carries a per-server copy across on upgrade (see `lib/settings-scope`).
{
  const storage = memoryStore({
    [SESSION_KEY]: JSON.stringify(sessionOf(ONE)),
    [READING_KEY]: JSON.stringify({ listView: "cards" }),
  });
  globalThis.localStorage = storage;
  const { reading } = await import(`${buildModule("src/state/reading.svelte.ts", "accounts-reading.mjs")}?launch=2`);

  reading.load();
  check("the device adopts a pre-scoping reading blob", reading.listView === "cards", reading.listView);

  rememberAccount(sessionOf(TWO));
  reading.load();
  check("the other server sees the same blob, not defaults", reading.listView === "cards", reading.listView);
  reading.setListView("grid");
  check(
    "its write lands on the scope, not the old key",
    storage.getItem(scopedKey(READING_KEY, DEVICE_IDENTITY))?.includes('"grid"') === true,
  );
  check(
    "the old blob is left as a downgrade finds it",
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
  const keptKey = scopedKey(READING_KEY, DEVICE_IDENTITY);
  check("the settings in use have state on disk", storage.getItem(keptKey) !== null);

  await store.remove(accountSlug(TWO));
  check("removing the account in use moves to the one left", store.active?.email === ONE.email, store.active?.email);
  check("...drops only its session", sessionFor(accountSlug(TWO)) === null && accountRows().length === 1);
  check("...and leaves the settings on disk", storage.getItem(keptKey) !== null);
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
