/**
 * The Account section, rendered without a browser.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/account-panel.mjs
 *
 * The decisions are held by `tests/unit/cloud-account.mjs`; this suite holds the
 * markup, because two of this card's rules are about what must **not** be drawn:
 *
 *   - a signed-in account is offered **Add Apple**, never "sign in with Apple" —
 *     the button that exists is the one that links, and the other is how one
 *     person ends up with two accounts;
 *   - there is **no "also delete my cloud files" checkbox**. That is a separate
 *     action with its own wording (`PROVIDER_FILES_ACTION`), and a deletion must
 *     never read as permission to empty a reader's folder.
 *
 * Nothing is stubbed to fake a state: the store is the real one over
 * `FakeIdentity` and a recorded account server, so every string below is what the
 * app would draw after those presses.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compile, compileModule, preprocess } from "svelte/compiler";
import { render } from "svelte/server";
import ts from "typescript";

import { FakeIdentity } from "../../src/api/identity.ts";
import { CANCEL_FIRST, PROVIDER_FILES_ACTION, PROVIDER_FILES_WARNING, REVOKE_THIS_DEVICE } from "../../src/api/account.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN = join(ROOT, `tests/unit/.gen-${process.pid}/account-panel`);

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* --------------------------------------------------------------------------
 * The build: TypeScript, then Svelte, then point the imports at what they need
 * ----------------------------------------------------------------------- */

const typescript = {
  script: ({ content, attributes }) => {
    if (attributes.lang !== "ts") return undefined;
    return {
      code: ts.transpileModule(content, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          // A component's imports are used in its *markup*, which TypeScript
          // cannot see: without this it elides them and the render dies.
          verbatimModuleSyntax: true,
        },
        fileName: "component.ts",
      }).outputText,
    };
  },
};

const built = new Map();

function sourceOf(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.svelte`]) {
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
  const out = join(GEN, `${basename(relative).replace(/\.ts$/, ".runes.mjs")}`);
  writeFileSync(out, rewrite(compiled.js.code, file));
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

async function buildComponent(relative) {
  const file = join(ROOT, relative);
  const pre = await preprocess(readFileSync(file, "utf8"), typescript, { filename: relative });
  const compiled = compile(pre.code, { generate: "server", filename: relative, dev: false });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${basename(relative).replace(/\.svelte$/, ".mjs")}`);
  writeFileSync(out, rewrite(compiled.js.code, file));
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

buildRunes("src/state/entitlements.svelte.ts");
buildRunes("src/api/billing.ts");
const { CloudAccount } = await import(await buildRunes("src/state/cloud-account.svelte.ts"));
const { default: Panel } = await import(await buildComponent("src/components/CloudAccountPanel.svelte"));

/* --------------------------------------------------------------------------
 * One device, one account server
 * ----------------------------------------------------------------------- */

function memoryKeys() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DEVICE_ROWS = [
  { session_id: "fake-session-1", label: "Linux · Firefox", platform: "Linux", created_at: "2026-10-27T10:00:00Z", last_seen_at: "2026-10-27T12:00:00Z" },
  { session_id: "fake-session-2", label: "iOS", platform: "iOS", created_at: "2026-10-20T10:00:00Z", last_seen_at: "2026-10-26T12:00:00Z" },
];

/** A surface over a fake device, with the account server answering from `answers`. */
function surface(answers = {}) {
  const request = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/rest\/v1\//, "");
    const handler = answers[path];
    return handler === undefined ? json(200, null) : handler({ path, method: init.method, body: init.body });
  };
  return new CloudAccount({
    identity: new FakeIdentity({ keys: memoryKeys() }),
    server: () => ({ url: "https://project.test", anonKey: "anon", request }),
    userAgent: () => "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0",
    billingBase: () => "https://billing.test",
    open: () => {},
    keys: memoryKeys(),
    now: () => Date.parse("2026-10-27T12:05:00Z"),
  });
}

const STANDARD = {
  "rpc/register_device": () => json(200, "ok"),
  account_devices: () => json(200, DEVICE_ROWS),
};

const draw = (account) => render(Panel, { props: { account } }).body;
const text = (body) => body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const count = (haystack, needle) => haystack.split(needle).length - 1;

/* --------------------------------------------------------------------------
 * Signed out: the three doors, and nothing else
 * ----------------------------------------------------------------------- */

{
  const account = surface(STANDARD);
  const body = draw(account);
  const words = text(body);

  check("the section leads with what an account is for", words.includes("An account is only for HardlyReader Sync"));
  check("...and that the library does not need one", words.includes("Your library on this device works without one"));
  check("Google is one press", count(body, "Continue with Google") === 1);
  check("Apple is one press", count(body, "Continue with Apple") === 1);
  check("the address door takes an address", /type="email"/.test(body) && count(body, "Email me a link") === 1);
  check("no device list is drawn before there is an account", !words.includes("Devices"));
  check("and nothing can be deleted", !words.includes("Delete my account"));
  check("nothing is claimed to be signed in", !words.includes("Signed in with"));
  check("no refusal is invented before a press", !/role="status"/.test(body));
}

/* --------------------------------------------------------------------------
 * Signed in: which door, the doors it does not have, and the devices
 * ----------------------------------------------------------------------- */

let signedIn;
{
  signedIn = surface(STANDARD);
  await signedIn.signIn("google");
  await signedIn.loadDevices();
  const body = draw(signedIn);
  const words = text(body);

  check("the account says which door it came through", words.includes("Signed in with Google"), words.slice(0, 160));
  check("and which address it answers to", words.includes("google@fixture.test"));

  check("the door it does not have is offered by name", count(body, "Add Apple") === 1);
  check("the door it does have is not offered again", !words.includes("Add Google"));
  check("there is no second sign-in anywhere on the screen", !words.includes("Continue with"));
  check("the add row says the account does not move", words.includes("keeps this the same account"));

  check("the device list is drawn", words.includes("Devices"));
  check("with each device's label", words.includes("Linux · Firefox") && words.includes("iOS"));
  check("and when each was last seen", words.includes("5 minutes ago"));
  check("this device is marked", count(body, "This device") === 1);
  check("one revoke per row", count(body, 'title="Revoke') + count(body, 'title="Revoking this device') === 2);

  check("the deletion row is drawn", words.includes("Delete my account"));
  check("the first press is not a confirmation yet", !words.includes("Keep it"));
  check("and no subscription control appears unprompted", !words.includes("Manage subscription"));
}

/* --------------------------------------------------------------------------
 * Nothing about a cloud folder is offered, ever
 * ----------------------------------------------------------------------- */

{
  const bodies = [draw(surface(STANDARD)), draw(signedIn)].map(text).join(" \n ");
  check("the provider-files action is not drawn", !bodies.includes(PROVIDER_FILES_ACTION), PROVIDER_FILES_ACTION);
  check("nor its warning", !bodies.includes(PROVIDER_FILES_WARNING));
  check("there is no checkbox to opt into anything", !/type="checkbox"/.test(draw(signedIn)));
  check("and no word about deleting a folder", !/delete .{0,40}folder/i.test(bodies), bodies.match(/delete .{0,40}folder/i)?.[0] ?? "");
}

/* --------------------------------------------------------------------------
 * The two-step deletion, and the refusal that has somewhere to go
 * ----------------------------------------------------------------------- */

{
  signedIn.askDelete();
  const body = draw(signedIn);
  const words = text(body);
  check("the second step asks, in one sentence", words.includes("Deleting removes your HardlyReader account"));
  check("it says the library on this device is not touched", words.includes("library on this device is not touched"));
  check("it says the reader's own folder is not touched", words.includes("neither is your own cloud folder"));
  check("two presses: delete, or keep it", count(body, "Delete my account") === 1 && count(body, "Keep it") === 1);

  signedIn.cancelDelete();
  check("the way out puts the row back", !text(draw(signedIn)).includes("Keep it"));
}

{
  const refused = surface({
    ...STANDARD,
    "rpc/delete_my_account": () => json(200, "cancel_first"),
  });
  await refused.signIn("google");
  refused.askDelete();
  await refused.confirmDelete();
  const body = draw(refused);
  const words = text(body);

  check("a refused deletion shows the sentence it was refused with", words.includes(CANCEL_FIRST), words.slice(0, 200));
  check("and offers the only way forward: the payment page", count(body, "Manage subscription") === 1);
  check("the account is still drawn as signed in", words.includes("Signed in with Google"));
}

/* --------------------------------------------------------------------------
 * Revoking this device: the sentence, then a signed-out sheet
 * ----------------------------------------------------------------------- */

{
  const own = surface(STANDARD);
  await own.signIn("google");
  await own.loadDevices();
  const self = own.deviceRows.find((row) => row.current);
  await Promise.resolve(own.revoke(self));

  const body = draw(own);
  const words = text(body);
  check("revoking this device says what it did", words.includes(REVOKE_THIS_DEVICE), words.slice(0, 200));
  check("and the sheet is back to the three doors", count(body, "Continue with Google") === 1);
  check("with no device row left behind", !words.includes("Linux · Firefox"));
}

/* --------------------------------------------------------------------------
 * Adding a door removes it from the offer
 * ----------------------------------------------------------------------- */

{
  const account = surface(STANDARD);
  await account.signIn("google");
  check("Apple is offered before it is added", text(draw(account)).includes("Add Apple"));
  await account.link("apple");
  const body = draw(account);
  const words = text(body);
  check("and not after", !words.includes("Add Apple"));
  check("the confirmation the seam gave is drawn", words.includes("Your browser is open at Apple"), words.slice(0, 220));
  check("the account still says the same door it came through", words.includes("Signed in with Google"));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
