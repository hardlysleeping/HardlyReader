/**
 * Installing the web store: one line at the app's start, and the Buy button sells.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/billing-install.mjs
 *
 * `src/api/billing.ts` is the purchase and `src/state/entitlements.svelte.ts` is
 * the capability, and neither may import the other — so until something composes
 * them, the panel's Buy button answers "this app cannot charge a card" and there
 * is no way to buy. `src/api/web-store.ts` is that composition, and this suite
 * holds it to the four things it promises:
 *
 *   1. a build with no billing URL gets no `WebStore`, and behaves exactly as it
 *      did before (its store is the one it had, and nothing is refreshed);
 *   2. with one, a press calls `beginCheckout` — the fake `fetch` sees the plan
 *      name and the reader's token, the browser double sees the URL — and grants
 *      nothing, because the row is the webhook's to write;
 *   3. a return with `?checkout=success` refreshes exactly once, so sync is on
 *      without a reload; `?checkout=cancelled` refreshes once too and says
 *      nothing alarming, and an ordinary launch refreshes nothing at all;
 *   4. no card field, no price id and no key has entered `src/`, and the token a
 *      purchase carries comes from the same stored session the read uses.
 *
 * The app's own modules are compiled here (type-stripped, `compileModule`,
 * relative specifiers rewritten to real files), so what runs is the app's code
 * and not a copy of it.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

const ROOT = new URL("../..", import.meta.url).pathname;
const GEN = join(ROOT, `tests/unit/.gen-${process.pid}`);

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* --------------------------------------------------------------------------
 * The app's modules, compiled
 * ----------------------------------------------------------------------- */

const built = new Map();

function build(relativePath) {
  const file = join(ROOT, relativePath);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relativePath,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: relativePath });
  const rewritten = compiled.js.code.replace(/(from\s*)(["'])([^"']+)\2/g, (whole, before, quote, specifier) => {
    if (!specifier.startsWith(".")) return whole;
    const base = resolve(dirname(file), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.js`]) {
      try {
        readFileSync(candidate);
      } catch {
        continue;
      }
      return `${before}${quote}${built.get(candidate) ?? pathToFileURL(candidate).href}${quote}`;
    }
    return whole;
  });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `install-${relativePath.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewritten);
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

build("src/state/entitlements.svelte.ts");
build("src/api/billing.ts");
const installModule = await import(build("src/api/web-store.ts"));
const { installWebStore } = installModule;

const {
  Entitlements,
  NativeStore,
  SYNC_CAPABILITY,
  SYNC_MONTHLY,
  SYNC_YEARLY,
  noEntitlement,
} = await import(built.get(join(ROOT, "src/state/entitlements.svelte.ts")));
const { WebStore, CHECKOUT_OPENED } = await import(built.get(join(ROOT, "src/api/billing.ts")));

/* --------------------------------------------------------------------------
 * Doubles: a page, a service, a server row
 * ----------------------------------------------------------------------- */

const TOKEN = "jwt_from_the_stored_session";
const BILLING = "https://billing.test/";
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_1";

/** A `fetch` that answers from a queue and records what it was asked. */
function fakeFetch(answers) {
  const calls = [];
  const queue = [...answers];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const answer = queue.shift() ?? { status: 500, body: {} };
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  };
  impl.calls = calls;
  return impl;
}

/** A `Store` that records presses and answers whatever it was given. */
function fakeStore(answer = null) {
  const store = {
    presses: [],
    products: [],
    purchase: async (id) => {
      store.presses.push(id);
      return answer ?? noEntitlement();
    },
    restore: async () => answer ?? noEntitlement(),
    current: async () => answer ?? noEntitlement(),
  };
  return store;
}

/**
 * The server reader: what `RemoteStore` is to `WebStore`. It answers with a row,
 * and counts how many times it was asked — which is how "refreshes once" is
 * measured rather than asserted.
 */
function serverReader(entitlement) {
  const reader = {
    reads: 0,
    answer: entitlement,
    async read() {
      reader.reads += 1;
      return typeof reader.answer === "function" ? reader.answer() : reader.answer;
    },
  };
  return reader;
}

/** A row the webhook has written: paid up, so it grants. */
function subscribed() {
  return { state: "active", productId: SYNC_CAPABILITY, expiresAt: Date.now() + 30 * 86_400_000, reason: null };
}

function installer(capability, extra = {}) {
  return installWebStore({ entitlement: capability, fetch: fakeFetch([]), open: () => {}, ...extra });
}

/* --------------------------------------------------------------------------
 * 1. A build with no billing URL is the build it was
 * ----------------------------------------------------------------------- */

{
  const original = fakeStore();
  const capability = new Entitlements(original);
  const service = fakeFetch([]);
  const opened = [];
  const reader = serverReader(subscribed());

  const result = installWebStore({
    entitlement: capability,
    base: "",
    search: "?checkout=success",
    reader,
    token: () => TOKEN,
    fetch: service,
    open: (url) => void opened.push(url),
  });

  check("no billing URL: no web store is installed", result.store === null);
  check(
    "no billing URL: nothing is refreshed, not even on a page that looks like a return",
    result.refreshed === null && reader.reads === 0,
  );

  const bought = await capability.purchase(SYNC_MONTHLY);
  check(
    "no billing URL: the panel's press still goes to the store the capability had",
    bought === false && original.presses.length === 1,
  );
  check(
    "no billing URL: no checkout is asked for and no page is opened",
    service.calls.length === 0 && opened.length === 0,
  );
}

{
  // A billing service, and no server to read the row from: selling would grant
  // nothing, so this is still the shell's stub — `NativeStore`, unchanged.
  const native = new NativeStore();
  const capability = new Entitlements(native);
  const service = fakeFetch([]);
  const result = installWebStore({
    entitlement: capability,
    base: BILLING,
    search: "?checkout=success",
    reader: native,
    fetch: service,
    open: () => {},
  });

  check("a billing URL with no server reader is not given a checkout either", result.store === null);
  check("and that build keeps the store it had, unchanged", capability.available === false);
}

/* --------------------------------------------------------------------------
 * 2. With a billing URL the press asks the service, and grants nothing
 * ----------------------------------------------------------------------- */

{
  const capability = new Entitlements(fakeStore());
  const service = fakeFetch([{ status: 200, body: { url: CHECKOUT_URL } }]);
  const opened = [];
  const result = installWebStore({
    entitlement: capability,
    base: BILLING,
    search: "",
    reader: serverReader(noEntitlement("this device is not signed in to HardlySyncing")),
    token: () => TOKEN,
    fetch: service,
    open: (url) => void opened.push(url),
  });

  check("with a billing URL the store is the web store", result.store instanceof WebStore);
  check("and a plain launch asks nobody and refreshes nothing", result.refreshed === null);

  const bought = await capability.purchase(SYNC_YEARLY);

  const sent = service.calls[0];
  check("a press asks the billing service for a checkout", sent?.url === "https://billing.test/checkout");
  check("it sends the plan name", sent?.body === JSON.stringify({ plan: "yearly" }));
  check("and the reader's token as the bearer — no user id, nothing else", sent?.headers.Authorization === `Bearer ${TOKEN}`);
  check("the page that comes back is handed to the opener", opened[0] === CHECKOUT_URL);
  check("purchase() answers false, so the panel does not claim a purchase", bought === false);
  check(
    "and nothing is granted: the row is the webhook's to write",
    capability.cloudSync === false && capability.state === "none",
  );
  check("the panel is told the checkout is open rather than that it failed", capability.reason === CHECKOUT_OPENED);
}

{
  // The token is the stored session, and this device has none: no empty bearer
  // may leave, and nothing may be granted.
  const capability = new Entitlements(fakeStore());
  const service = fakeFetch([{ status: 200, body: { url: CHECKOUT_URL } }]);
  installer(capability, {
    base: BILLING,
    reader: serverReader(noEntitlement()),
    fetch: service,
  });

  const bought = await capability.purchase(SYNC_MONTHLY);
  check("with no stored session no request is sent at all", service.calls.length === 0 && bought === false);
  check("and it still grants nothing", capability.cloudSync === false);
}

{
  // The offer the panel draws is the service's, once the real store is installed.
  const capability = new Entitlements(fakeStore());
  const service = fakeFetch([
    {
      status: 200,
      body: {
        plans: [
          { id: "yearly", price: "$9.99", period: "year" },
          { id: "monthly", price: "$0.99", period: "month" },
        ],
      },
    },
  ]);
  installer(capability, { base: BILLING, reader: serverReader(noEntitlement()), token: () => TOKEN, fetch: service });
  await capability.loadProducts();
  check(
    "the installed store prices the offer from the service",
    capability.offer.length === 2 &&
      capability.offer[0].id === SYNC_YEARLY &&
      capability.offer[0].price === "$9.99" &&
      capability.offer[1].id === SYNC_MONTHLY,
  );
}

/* --------------------------------------------------------------------------
 * 3. Coming back from Checkout turns sync on, once
 * ----------------------------------------------------------------------- */

{
  const capability = new Entitlements(fakeStore());
  const reader = serverReader(subscribed());
  check("a device that has never checked starts with no cloud sync", capability.cloudSync === false);

  const result = installer(capability, {
    base: BILLING,
    search: "?checkout=success&session_id=cs_test_9",
    reader,
    token: () => TOKEN,
  });

  check(
    "a return from Checkout is read off the page, with its session",
    result.checkout?.kind === "success" && result.checkout.sessionId === "cs_test_9",
  );
  check("it asks the server exactly once", reader.reads === 1);
  await result.refreshed;
  check("and it is still exactly once after the answer settles", reader.reads === 1);
  check("so sync is on without a reload", capability.cloudSync === true && capability.state === "active");
}

{
  // A reader who was already subscribed and cancelled a second checkout: the
  // return refreshes, and there is nothing to say about it.
  const capability = new Entitlements(fakeStore());
  const reader = serverReader(subscribed());

  const result = installer(capability, { base: BILLING, search: "?checkout=cancelled", reader, token: () => TOKEN });
  check("a cancelled checkout is recognised", result.checkout?.kind === "cancelled");
  check("and it refreshes too, exactly once", reader.reads === 1);
  await result.refreshed;
  check("the subscription that was already there is still on", capability.cloudSync === true);
  check("and cancelling leaves the panel nothing to explain", capability.reason === null, capability.reason ?? "(none)");
}

{
  // The same return on a device that does not own Sync: the row is the only
  // answer, and it is the server's words — never a reproach invented here.
  const said = "this device is not signed in to HardlySyncing";
  const capability = new Entitlements(fakeStore());
  const reader = serverReader(noEntitlement(said));

  const result = installer(capability, { base: BILLING, search: "?checkout=cancelled", reader, token: () => TOKEN });
  await result.refreshed;
  check("cancelling grants nothing", capability.cloudSync === false);
  check("cancelling says nothing alarming", !/fail|error|problem|declin|cancel|denied|went wrong/i.test(capability.reason ?? ""), capability.reason ?? "(none)");
  check("and leaves the server's own sentence alone", capability.reason === said);
}

{
  const capability = new Entitlements(fakeStore());
  const reader = serverReader(subscribed());
  const result = installer(capability, { base: BILLING, search: "?feed=42", reader, token: () => TOKEN });
  check("an ordinary load is not a return from Checkout", result.checkout === null && result.refreshed === null);
  check("so an ordinary launch does not refresh on this path at all", reader.reads === 0);
}

{
  const capability = new Entitlements(fakeStore());
  const reader = serverReader(subscribed());
  const options = { base: BILLING, search: "?checkout=success", reader, token: () => TOKEN };
  const first = installer(capability, options);
  const second = installer(capability, options);
  await first.refreshed;
  check("installing twice composes once", second === first && second.store === first.store);
  check("and refreshes once", reader.reads === 1);
}

/* --------------------------------------------------------------------------
 * 4. The source: where the install lives, and what has not entered src/
 * ----------------------------------------------------------------------- */

const source = (relative) => readFileSync(join(ROOT, relative), "utf8");

const installSource = source("src/api/web-store.ts");
const mainSource = source("src/main.ts");

check(
  "the app installs the store at its start, before anything mounts",
  (mainSource.match(/installWebStore\(\)/g) ?? []).length === 1 &&
    mainSource.indexOf("installWebStore()") < mainSource.indexOf("mount(App"),
);
check(
  "the token is the stored Supabase session the reader also uses, and not the identity's",
  /token: options\.token \?\? \(\(\) => storedCloudSession\(\)\?\.token \?\? ""\)/.test(installSource) &&
    !/identity/.test(installSource),
);
check(
  "the return path refreshes once and installs no second hook",
  (installSource.match(/\.refresh\(/g) ?? []).length === 1 &&
    !/addEventListener|setInterval|setTimeout/.test(installSource),
);
check(
  "the capability imports nothing from the app: no cycle back into billing",
  !/^\s*import[^;]*from\s*["'][^"']*(api\/billing|web-store)/m.test(source("src/state/entitlements.svelte.ts")),
);

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (/\.(ts|svelte|js|mjs|css|html)$/.test(name)) found.push(path);
  }
  return found;
}

const sources = walk(join(ROOT, "src"));
const files = new Map(sources.map((path) => [path, readFileSync(path, "utf8")]));
const offenders = (pattern) => sources.filter((path) => pattern.test(files.get(path))).map((path) => path.slice(ROOT.length));

check("src/ holds a lot of files, so the sweep below means something", sources.length > 100, String(sources.length));
check(
  "no card field exists anywhere in src/: there is no form to fill in",
  offenders(/\bcard_number\b|\bcvc\b|\bexp_month\b|\bexp_year\b|autocomplete="cc-/i).length === 0,
  offenders(/\bcard_number\b|\bcvc\b|\bexp_month\b|\bexp_year\b|autocomplete="cc-/i).join(", "),
);
check(
  "no Stripe price id exists anywhere in src/: prices live in Stripe",
  offenders(/price_[A-Za-z0-9]{4,}/).length === 0,
  offenders(/price_[A-Za-z0-9]{4,}/).join(", "),
);
check(
  "no key of any kind exists anywhere in src/",
  offenders(/sk_live_|sk_test_|whsec_|STRIPE_SECRET/).length === 0,
  offenders(/sk_live_|sk_test_|whsec_|STRIPE_SECRET/).join(", "),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
