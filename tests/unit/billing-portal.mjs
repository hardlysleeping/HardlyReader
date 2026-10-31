/**
 * `POST /portal`, the route a refused deletion points at.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/billing-portal.mjs
 *
 * The card this belongs to deletes accounts, and `delete_my_account()` refuses
 * while Stripe is still charging (`cancel_first`). A refusal with nowhere to send
 * the reader is a dead end, so this suite holds the somewhere: the portal URL is
 * made for **the reader the JWT names**, from the customer in the link table, and
 * for nobody else.
 *
 * Everything that needs the internet is a double — Stripe, Supabase Auth, the
 * database — because the decision under test is not Stripe's. What is real is the
 * handler, the Request/Response objects and the status codes.
 */
import { createBillingApp } from "../../server/billing/app.mjs";
import { FakeAuth } from "../../server/billing/auth.mjs";
import { FakeStripe } from "../../server/billing/stripe-api.mjs";
import { Offer } from "../../server/billing/plans.mjs";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const NOW = Date.UTC(2026, 9, 27);
const SECRET = "whsec_portal_test";
const USER = "44444444-4444-4444-4444-444444444444";
const TOKEN = "jwt_for_the_reader";
const CUSTOMER = "cus_portal_1";
const PRICES = { monthly: "price_month", yearly: "price_year" };

/**
 * The database, as the service sees it here.
 *
 * `customerOf` is the whole question: a reader with a customer gets a portal, a
 * reader without one gets `no_customer` and Stripe is never called. `fail` is how
 * a test makes the link table unreachable.
 */
class FakeDb {
  constructor({ customers = {}, fail = false } = {}) {
    this.customers = { ...customers };
    this.fail = fail;
    this.customerReads = 0;
    this.linked = [];
    this.applied = [];
  }

  async customerOf(userId) {
    this.customerReads += 1;
    if (this.fail) throw new Error("the link table did not answer");
    return this.customers[userId] ?? null;
  }

  async linkCustomer(userId, customerId) {
    this.customers[userId] = customerId;
    this.linked.push({ userId, customerId });
  }

  async applyEvent() {
    return "applied";
  }
}

function build({ db = new FakeDb({ customers: { [USER]: CUSTOMER } }), stripe = new FakeStripe(), auth = new FakeAuth({ [TOKEN]: USER }) } = {}) {
  const config = {
    appUrl: "https://app.test",
    origins: ["https://app.test", "https://tracking.test"],
    webhookSecret: SECRET,
    prices: PRICES,
  };
  const logs = [];
  const log = {
    info: (event, fields) => logs.push({ level: "info", event, ...fields }),
    warn: (event, fields) => logs.push({ level: "warn", event, ...fields }),
    error: (event, fields) => logs.push({ level: "error", event, ...fields }),
  };
  const handle = createBillingApp({
    config,
    db,
    stripe,
    auth,
    offer: new Offer({ stripe, prices: PRICES, now: () => NOW }),
    now: () => NOW,
    log,
  });
  return { handle, db, stripe, logs };
}

/** A request, as the app would send it: a POST, a bearer, and no body. */
function portal({ token = TOKEN, headers = {}, query = "" } = {}) {
  return new Request(`https://billing.test/portal${query}`, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
  });
}

const body = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/* --------------------------------------------------------------------------
 * The route that works
 * ----------------------------------------------------------------------- */

{
  const { handle, db, stripe, logs } = build();
  const response = await handle(portal());
  const answer = await body(response);

  check("a signed-in reader with a customer gets a portal", response.status === 200, String(response.status));
  check("and it is an https URL, because the app opens it next", /^https:\/\//.test(answer?.url ?? ""), answer?.url);
  check("made for their own customer", stripe.portals.length === 1 && stripe.portals[0].customerId === CUSTOMER);
  check("and it returns to the app's own origin", stripe.portals[0]?.returnUrl?.startsWith("https://app.test"), stripe.portals[0]?.returnUrl);
  check("the customer came from the link table, keyed by the token", db.customerReads === 1);
  check("no customer is created as a side effect", stripe.customers.length === 0);
  check("only the URL crosses the wire", Object.keys(answer ?? {}).join(",") === "url", JSON.stringify(answer));
  check("the log names the event without the token", logs.some((line) => line.event === "portal_created") && !JSON.stringify(logs).includes(TOKEN));
}

{
  // One subscription, more than one app: the portal returns to whichever served
  // app asked, and only to one this service serves.
  const { handle, stripe } = build();
  await handle(portal({ query: `?return=${encodeURIComponent("https://tracking.test")}` }));
  check("a served app gets its own return", stripe.portals[0]?.returnUrl === "https://tracking.test/?portal=done", stripe.portals[0]?.returnUrl);

  const second = build();
  await second.handle(portal({ query: `?return=${encodeURIComponent("https://somebody-else.test")}` }));
  check(
    "an origin we do not serve falls back to the configured app",
    second.stripe.portals[0]?.returnUrl === "https://app.test/?portal=done",
    second.stripe.portals[0]?.returnUrl,
  );
}

/* --------------------------------------------------------------------------
 * Refusals, each with its own name
 * ----------------------------------------------------------------------- */

{
  const { handle, stripe } = build();
  const unsigned = await handle(portal({ token: null }));
  check("no token is not signed in", unsigned.status === 401 && (await body(unsigned))?.error === "not_signed_in");
  check("and Stripe is not asked", stripe.portals.length === 0);

  const wrong = await handle(portal({ token: "somebody_elses_jwt" }));
  check("a token the provider refuses is not signed in", wrong.status === 401 && (await body(wrong))?.error === "not_signed_in");
  check("and no portal is made for it", stripe.portals.length === 0);
}

{
  // A reader who has never been through Checkout: no customer, so no portal. The
  // alternative — creating a customer here — would leave a Stripe row nobody asked
  // for, and the route is a cancellation, not a purchase.
  const { handle, db, stripe } = build({ db: new FakeDb({ customers: {} }) });
  const response = await handle(portal());
  const answer = await body(response);
  check("no customer is no portal", response.status === 404 && answer?.error === "no_customer", `${response.status} ${JSON.stringify(answer)}`);
  check("and nothing is invented at Stripe", stripe.customers.length === 0 && stripe.portals.length === 0);
  check("the link table was still asked", db.customerReads === 1);
}

{
  const { handle, stripe } = build({ db: new FakeDb({ fail: true }) });
  const response = await handle(portal());
  check("an unreachable link table is 502, not a crash", response.status === 502 && (await body(response))?.error === "billing_unavailable");
  check("and Stripe is not asked at all", stripe.portals.length === 0);
}

{
  const stripe = new FakeStripe({ fail: "stripe is down" });
  const { handle, logs } = build({ stripe });
  const response = await handle(portal());
  check("a Stripe that will not answer is 502", response.status === 502 && (await body(response))?.error === "billing_unavailable");
  const written = JSON.stringify(logs);
  check("the failure is logged for a human", /portal_failed/.test(written));
  check("and the log holds no secret", !written.includes(TOKEN) && !written.includes(SECRET));
}

/* --------------------------------------------------------------------------
 * The route is the only new surface
 * ----------------------------------------------------------------------- */

{
  // The portal takes the same credentials as Checkout and adds no way to name a
  // customer: no body is read, so there is nothing to talk it into.
  const { handle, stripe } = build();
  const withBody = await handle(
    new Request("https://billing.test/portal", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ customer: "cus_somebody_else", customer_id: "cus_somebody_else" }),
    }),
  );
  check("a body naming another customer changes nothing", withBody.status === 200 && stripe.portals[0].customerId === CUSTOMER, stripe.portals[0]?.customerId);

  const get = await handle(new Request("https://billing.test/portal", { method: "GET" }));
  check("GET is not the route", get.status === 404);

  const cors = await handle(portal({ headers: { origin: "https://evil.example" } }));
  check("a foreign origin gets no CORS grant", cors.headers.get("access-control-allow-origin") === null);
  const allowed = await handle(portal({ headers: { origin: "https://app.test" } }));
  check("the app's own origin does", allowed.headers.get("access-control-allow-origin") === "https://app.test");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
