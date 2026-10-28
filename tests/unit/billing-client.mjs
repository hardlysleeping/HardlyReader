/**
 * The app's four lines of the purchase.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/billing-client.mjs
 *
 * `src/api/billing.ts` is the whole of the client's side: a plan name and a
 * token out, a Checkout URL in, a page opened, the entitlement refreshed. This
 * suite runs it against a fake `fetch`, and drives the real `Entitlements` class
 * through `WebStore` — because the interesting claim is not "the URL was
 * opened", it is "opening a checkout did not grant anything, and a refresh after
 * the webhook wrote the row did".
 *
 * Both modules are compiled the way this repo compiles its runes modules
 * (type-stripped, `compileModule`, relative specifiers rewritten to real files),
 * so the code under test is the app's own, not a copy of it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const out = join(GEN, `billing-${relativePath.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewritten);
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

build("src/state/entitlements.svelte.ts");
const billing = await import(build("src/api/billing.ts"));
const { Entitlements, SYNC_MONTHLY, SYNC_YEARLY, grantsCloudSync } = await import(
  built.get(join(ROOT, "src/state/entitlements.svelte.ts"))
);
const {
  beginCheckout,
  openCheckout,
  checkoutReturned,
  planKeyOf,
  productIdOf,
  CheckoutError,
  CHECKOUT_OPENED,
  WebStore,
} = billing;

/* --------------------------------------------------------------------------
 * A fake service, and a fake Stripe-hosted page
 * ----------------------------------------------------------------------- */

const TOKEN = "jwt_from_the_identity_module";
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

/* --------------------------------------------------------------------------
 * 1. Asking for a checkout
 * ----------------------------------------------------------------------- */

{
  const call = fakeFetch([{ status: 200, body: { url: CHECKOUT_URL } }]);
  const url = await beginCheckout({ plan: "yearly", token: TOKEN, base: "https://billing.test", fetch: call });
  check("a checkout request answers with the URL to open", url === CHECKOUT_URL);
  const sent = call.calls[0];
  check("it goes to the billing service's /checkout", sent.url === "https://billing.test/checkout");
  check("it carries the reader's token, not a user id", sent.headers.Authorization === `Bearer ${TOKEN}`);
  check("and the only thing in the body is the plan name", sent.body === JSON.stringify({ plan: "yearly" }));
}

{
  const call = fakeFetch([{ status: 401, body: { error: "not_signed_in" } }]);
  let code = null;
  try {
    await beginCheckout({ plan: "monthly", token: "stale", base: "https://billing.test", fetch: call });
  } catch (cause) {
    code = cause instanceof CheckoutError ? cause.code : "not_a_checkout_error";
  }
  check("an unauthenticated request fails by name, not by message", code === "not_signed_in");
}

{
  const call = fakeFetch([{ status: 400, body: { error: "plan_not_offered" } }]);
  let code = null;
  try {
    await beginCheckout({ plan: "monthly", token: TOKEN, base: "https://billing.test", fetch: call });
  } catch (cause) {
    code = cause?.code ?? null;
  }
  check("a plan this deployment does not sell is a named refusal", code === "plan_not_offered");
}

{
  const call = fakeFetch([{ status: 200, body: { url: "http://not-https.test/pay" } }]);
  let code = null;
  try {
    await beginCheckout({ plan: "monthly", token: TOKEN, base: "https://billing.test", fetch: call });
  } catch (cause) {
    code = cause?.code ?? null;
  }
  check("a non-https page is refused rather than opened", code === "no_url");
}

{
  const call = async () => {
    throw new TypeError("Failed to fetch");
  };
  let code = null;
  try {
    await beginCheckout({ plan: "monthly", token: TOKEN, base: "https://billing.test", fetch: call });
  } catch (cause) {
    code = cause?.code ?? null;
  }
  check("an unreachable service is billing_unreachable, so the panel can say so", code === "billing_unreachable");
}

{
  let code = null;
  try {
    await beginCheckout({ plan: "monthly", token: TOKEN, base: "", fetch: fakeFetch([]) });
  } catch (cause) {
    code = cause?.code ?? null;
  }
  check("a build with no billing service configured cannot open a checkout", code === "billing_unreachable");
}

{
  const opened = [];
  const call = fakeFetch([{ status: 200, body: { url: CHECKOUT_URL } }]);
  const url = await openCheckout({
    plan: "monthly",
    token: TOKEN,
    base: "https://billing.test",
    fetch: call,
    open: async (target) => void opened.push(target),
  });
  check("the page is handed to the opener, which is the system browser", opened[0] === CHECKOUT_URL && url === CHECKOUT_URL);
}

/* --------------------------------------------------------------------------
 * 2. The two products are the app's, not Stripe's
 * ----------------------------------------------------------------------- */

check("the monthly product id is a monthly plan", planKeyOf(SYNC_MONTHLY) === "monthly");
check("the yearly product id is a yearly plan", planKeyOf(SYNC_YEARLY) === "yearly");
check("anything else is no plan", planKeyOf("someone.else.thing") === null);
check("a plan name maps back to the app's product id", productIdOf("yearly") === SYNC_YEARLY);

/* --------------------------------------------------------------------------
 * 3. Coming back
 * ----------------------------------------------------------------------- */

check(
  "a return from Checkout is recognised, with its session",
  (() => {
    const back = checkoutReturned("?checkout=success&session_id=cs_test_9");
    return back?.kind === "success" && back.sessionId === "cs_test_9";
  })(),
);

check("a cancelled checkout is recognised", checkoutReturned("?checkout=cancelled")?.kind === "cancelled");
check("an ordinary load is not a return from checkout", checkoutReturned("?feed=42") === null);
check("neither is an empty search", checkoutReturned("") === null);

/* --------------------------------------------------------------------------
 * 4. The store: buying opens a page and grants nothing
 * ----------------------------------------------------------------------- */

{
  // No grant anywhere in the doubles: the row is the webhook's to write.
  const call = fakeFetch([
    { status: 200, body: { url: CHECKOUT_URL } },
    { status: 200, body: { url: CHECKOUT_URL } },
  ]);
  const opened = [];
  const store = new WebStore({
    token: () => TOKEN,
    base: "https://billing.test",
    fetch: call,
    open: async (target) => void opened.push(target),
  });
  const entitlements = new Entitlements(store);

  const bought = await entitlements.purchase(SYNC_MONTHLY);
  check("pressing buy opens the checkout page", opened[0] === CHECKOUT_URL);
  check("and it does not grant cloud sync, because nothing has been paid yet", entitlements.cloudSync === false);
  check("purchase() answers false, so the panel does not claim a purchase", bought === false);
  check(
    "the app says the checkout is open rather than that it failed",
    entitlements.reason === CHECKOUT_OPENED,
    entitlements.reason ?? "(none)",
  );
}

{
  const call = fakeFetch([]);
  const opened = [];
  const store = new WebStore({
    token: () => TOKEN,
    base: "https://billing.test",
    fetch: call,
    open: async (target) => void opened.push(target),
  });
  const receipt = await store.purchase("someone.else.thing");
  check("a product id this app does not sell never reaches the network", call.calls.length === 0 && opened.length === 0);
  check("and it grants nothing", grantsCloudSync(receipt) === false);
}

/* --------------------------------------------------------------------------
 * 5. A second device sees the purchase after a refresh
 * ----------------------------------------------------------------------- */

{
  // What the server's row looks like once the webhook has written it: the same
  // subscription, on the other device, with no local knowledge of the purchase.
  const server = {
    read: async () => ({
      state: "active",
      productId: SYNC_YEARLY,
      expiresAt: Date.now() + 30 * 86_400_000,
      reason: null,
    }),
  };
  const store = new WebStore({ token: () => TOKEN, base: "https://billing.test", fetch: fakeFetch([]), server });
  const entitlements = new Entitlements(store);
  check("a fresh device starts with no cloud sync", entitlements.cloudSync === false);
  await entitlements.refresh();
  check("after one refresh it reads the server's row and grants", entitlements.cloudSync === true && entitlements.state === "active");
}

{
  const server = {
    read: async () => {
      throw new Error("network is down");
    },
  };
  const store = new WebStore({ token: () => TOKEN, base: "https://billing.test", fetch: fakeFetch([]), server });
  const entitlements = new Entitlements(store);
  await entitlements.refresh();
  check("a server that cannot be asked is no grant — never a presumed one", entitlements.cloudSync === false);
}

{
  const store = new WebStore({ token: () => TOKEN, base: "https://billing.test", fetch: fakeFetch([]) });
  const entitlements = new Entitlements(store);
  await entitlements.refresh();
  check("a build with no server reader says none rather than guessing", entitlements.cloudSync === false);
}

/* --------------------------------------------------------------------------
 * 6. What is for sale comes from the service, priced by Stripe
 * ----------------------------------------------------------------------- */

{
  const call = fakeFetch([
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
  const store = new WebStore({ token: () => TOKEN, base: "https://billing.test", fetch: call });
  const entitlements = new Entitlements(store);
  await entitlements.loadProducts();
  check(
    "the offer the panel draws is the service's own prices",
    entitlements.offer.length === 2 && entitlements.offer[0].price === "$9.99" && entitlements.offer[0].id === SYNC_YEARLY,
  );
  check(
    "monthly is there too, in the app's own product id",
    entitlements.offer[1].id === SYNC_MONTHLY && entitlements.offer[1].price === "$0.99",
  );
}

{
  const call = fakeFetch([{ status: 200, body: { plans: [{ id: "lifetime", price: "$99", period: "year" }] } }]);
  const store = new WebStore({ token: () => TOKEN, base: "https://billing.test", fetch: call });
  const products = await store.products();
  check("a plan the app has no id for is dropped, not mislabelled", products.length === 0);
}

/* --------------------------------------------------------------------------
 * 7. Proof, by reading the source, that nothing card-shaped is here
 * ----------------------------------------------------------------------- */

const client = readFileSync(join(ROOT, "src/api/billing.ts"), "utf8");
const serverFiles = ["app.mjs", "stripe-api.mjs", "db.mjs", "main.mjs"].map((name) =>
  readFileSync(join(ROOT, "server/billing", name), "utf8"),
);

check(
  "no card field exists anywhere in the client: there is no form to fill in",
  !/\bcard_number|\bcvc\b|\bexp_month\b|card\[/i.test(client),
);
check(
  "the client never names a Stripe price id — prices live in Stripe",
  !/price_[A-Za-z0-9]/.test(client) && /planKeyOf/.test(client),
);
check(
  "the client holds no key of any kind",
  !/sk_live|sk_test|service_role|SUPABASE_SERVICE_KEY|whsec_/.test(client),
);
check(
  "the service reads its secrets from the environment and never writes them out",
  serverFiles.every((source) => !/console\.log\([^)]*secretKey/.test(source)) &&
    serverFiles.some((source) => /process\.env/.test(source)),
);
check(
  "a customer is created with an idempotency key, so a double press cannot create two",
  /this\.post\("\/v1\/customers", form, `hr-customer-\$\{userId\}`\)/.test(
    readFileSync(join(ROOT, "server/billing/stripe-api.mjs"), "utf8"),
  ),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
