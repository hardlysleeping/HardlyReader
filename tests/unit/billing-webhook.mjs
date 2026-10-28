/**
 * The billing service, from the outside.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/billing-webhook.mjs
 *
 * This drives the real request handler with real `Request`/`Response` objects and
 * real HMAC signatures. Only the three parties that need the internet are
 * doubled: Stripe, Supabase Auth and the database. What is *not* doubled is the
 * part that matters most — the decision about which reader an event belongs to.
 * Several checks below are about the webhook refusing to learn a user id from a
 * body it was handed, because that is the difference between a payment and a
 * gift to whoever can curl.
 */
import { createBillingApp, HANDLED_EVENTS } from "../../server/billing/app.mjs";
import { signPayload } from "../../server/billing/signature.mjs";
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
const DAY = 86_400_000;
const SECRET = "whsec_test_secret";
const USER = "11111111-1111-1111-1111-111111111111";
const TOKEN = "jwt_for_the_reader";

const PRICES = { monthly: "price_month", yearly: "price_year" };

/** A stripe subscription, item-level period, paid up for three more days. */
function subscription(overrides = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    status: "active",
    customer: "cus_1",
    created: Math.floor((NOW - 30 * DAY) / 1000),
    items: { data: [{ price: { id: "price_month" }, current_period_end: Math.floor((NOW + 3 * DAY) / 1000) }] },
    ...overrides,
  };
}

/**
 * The database, as the service sees it: three methods, and a record of them.
 *
 * `applyEvent` answers with whatever the test set, because the real answers
 * (`applied`, `duplicate`, `stale`, `unknown_customer`, `kept_other_source`) are
 * decided by SQL and are proven against a real Postgres in
 * `billing-postgres.mjs`.
 */
class FakeDb {
  constructor({ customers = {}, outcome = "applied", fail = null } = {}) {
    this.customers = { ...customers };
    this.outcome = outcome;
    this.fail = fail;
    this.linked = [];
    this.applied = [];
    this.customerReads = 0;
  }

  async customerOf(userId) {
    this.customerReads += 1;
    return this.customers[userId] ?? null;
  }

  async linkCustomer(userId, customerId) {
    this.customers[userId] = customerId;
    this.linked.push({ userId, customerId });
  }

  async applyEvent(event) {
    if (this.fail !== null) throw new Error(this.fail);
    this.applied.push(event);
    if (typeof this.outcome === "function") return this.outcome(event);
    return this.outcome;
  }
}

function build({ db = new FakeDb(), stripe = new FakeStripe(), auth = new FakeAuth({ [TOKEN]: USER }), prices = PRICES, offer = null } = {}) {
  const config = {
    appUrl: "https://app.test",
    origins: ["https://app.test"],
    webhookSecret: SECRET,
    prices,
  };
  const logs = [];
  const log = {
    info: (event, fields) => logs.push({ level: "info", event, ...fields }),
    warn: (event, fields) => logs.push({ level: "warn", event, ...fields }),
    error: (event, fields) => logs.push({ level: "error", event, ...fields }),
  };
  const resolvedOffer = offer ?? new Offer({ stripe, prices, now: () => NOW });
  const handle = createBillingApp({
    config,
    db,
    stripe,
    auth,
    offer: resolvedOffer,
    now: () => NOW,
    log,
  });
  return { handle, db, stripe, auth, logs, config };
}

/** A request, as a client would send it. */
function request(path, { method = "GET", headers = {}, body = undefined } = {}) {
  return new Request(`https://billing.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A signed Stripe delivery, exactly as Stripe would send one. */
function delivery(event, { secret = SECRET, timestamp = Math.floor(NOW / 1000) } = {}) {
  const raw = new TextEncoder().encode(JSON.stringify(event));
  return request("/stripe/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signPayload(raw, secret, timestamp),
    },
    body: JSON.stringify(event),
  });
}

const text = async (response) => {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

/* --------------------------------------------------------------------------
 * 1. Checkout: a plan name and a JWT, nothing else
 * ----------------------------------------------------------------------- */

{
  const { handle, db, stripe } = build();
  const response = await handle(request("/checkout", { method: "POST", body: { plan: "monthly" } }));
  check("checkout without a token is refused", response.status === 401);
  check("and no customer was invented at Stripe", stripe.customers.length === 0 && db.linked.length === 0);
}

{
  const { handle, db, stripe } = build();
  const response = await handle(
    request("/checkout", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { plan: "yearly" },
    }),
  );
  const body = await text(response);
  check("checkout for a signed-in reader answers with a URL", response.status === 200 && /^https:\/\//.test(body.url));
  check("the customer is created for that reader, with the reader's id as metadata", stripe.customers[0]?.userId === USER);
  check("the link is written before the session exists", db.linked[0]?.userId === USER && db.linked[0]?.customerId === stripe.customers[0]?.id);
  const session = stripe.sessions[0];
  check("the session is a subscription on the yearly price", session.priceId === "price_year" && session.customerId === stripe.customers[0].id);
  check("the reader's id rides along as client_reference_id", session.userId === USER);
  check("it comes back to the app with a marker the app can read", /checkout=success/.test(session.successUrl) && /checkout=cancelled/.test(session.cancelUrl));
  check("the response carries no price and no customer", body.url !== undefined && Object.keys(body).join(",") === "url");
}

{
  // A second purchase reuses the customer: one identity at Stripe, one row here.
  const { handle, db, stripe } = build({ db: new FakeDb({ customers: { [USER]: "cus_existing" } }) });
  await handle(request("/checkout", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: { plan: "monthly" } }));
  check("a reader who already has a customer gets no second one", stripe.customers.length === 0 && db.linked.length === 0);
  check("and the session uses the customer that already existed", stripe.sessions[0]?.customerId === "cus_existing");
}

{
  const { handle, stripe } = build();
  const response = await handle(
    request("/checkout", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: { plan: "lifetime" } }),
  );
  check("a plan the shop does not have is refused before Stripe hears about it", response.status === 400 && stripe.sessions.length === 0);
}

{
  const { handle, stripe } = build({ prices: { monthly: null, yearly: "price_year" } });
  const response = await handle(
    request("/checkout", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: { plan: "monthly" } }),
  );
  const body = await text(response);
  check(
    "a plan this deployment does not sell is refused even though the client asked for it",
    response.status === 400 && body.error === "plan_not_offered" && stripe.sessions.length === 0,
  );
}

{
  const { handle, stripe } = build();
  stripe.fail = "stripe is down";
  const response = await handle(
    request("/checkout", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: { plan: "monthly" } }),
  );
  const body = await text(response);
  check(
    "a Stripe that is down is a 502 and says nothing about the key",
    response.status === 502 && body.error === "billing_unavailable" && !/sk_/.test(JSON.stringify(body)),
  );
}

/* --------------------------------------------------------------------------
 * 2. The webhook refuses what it did not come from
 * ----------------------------------------------------------------------- */

{
  const { handle, db } = build();
  const response = await handle(
    request("/stripe/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":"evt_1"}' }),
  );
  check("an unsigned delivery is refused", response.status === 400);
  check("and nothing was written", db.applied.length === 0);
}

{
  const { handle, db } = build();
  const event = { id: "evt_1", type: "customer.subscription.updated", created: NOW / 1000, data: { object: subscription() } };
  const response = await handle(delivery(event, { secret: "whsec_wrong" }));
  check("a delivery signed with the wrong secret is refused", response.status === 400 && db.applied.length === 0);
}

{
  const { handle, db } = build();
  const event = { id: "evt_old", type: "customer.subscription.updated", created: NOW / 1000, data: { object: subscription() } };
  const response = await handle(delivery(event, { timestamp: Math.floor(NOW / 1000) - 3600 }));
  check("a correctly signed delivery replayed an hour later is refused", response.status === 400 && db.applied.length === 0);
}

/* --------------------------------------------------------------------------
 * 3. What an event turns into
 * ----------------------------------------------------------------------- */

{
  const { handle, db, stripe } = build({ db: new FakeDb({ customers: { [USER]: "cus_1" } }) });
  const event = {
    id: "evt_active",
    type: "customer.subscription.updated",
    created: Math.floor(NOW / 1000),
    data: { object: subscription() },
  };
  const response = await handle(delivery(event));
  const body = await text(response);
  check("an active subscription is written as a grant", response.status === 200 && body.outcome === "applied");
  check("the row is true, with the period end as its expiry", db.applied[0]?.cloudSync === true && db.applied[0]?.expiresAtMs === NOW + 3 * DAY);
  check("the write is keyed by the customer, never by a user id from the body", db.applied[0]?.customerId === "cus_1" && !("userId" in db.applied[0]));
  check("the event id is passed through so the database can spend it once", db.applied[0]?.eventId === "evt_active");
  check("no Stripe call was needed: the event carried the subscription", stripe.sessions.length === 0);
}

{
  // The body claims a reader. The service must not believe it.
  const { handle, db } = build({ db: new FakeDb({ customers: { [USER]: "cus_1" } }) });
  const event = {
    id: "evt_claim",
    type: "customer.subscription.updated",
    created: Math.floor(NOW / 1000),
    data: {
      object: subscription({
        metadata: { supabase_user_id: "99999999-9999-9999-9999-999999999999" },
        client_reference_id: "99999999-9999-9999-9999-999999999999",
      }),
    },
  };
  await handle(delivery(event));
  const written = JSON.stringify(db.applied[0] ?? {});
  check(
    "a user id inside the event body is never passed to the database",
    db.applied.length === 1 && !written.includes("99999999"),
  );
}

{
  const { handle, db } = build({ db: new FakeDb({ customers: { [USER]: "cus_1" } }), stripe: new FakeStripe({ subscriptions: { sub_9: subscription({ status: "past_due", id: "sub_9" }) } }) });
  const event = {
    id: "evt_due",
    type: "invoice.payment_failed",
    created: Math.floor(NOW / 1000),
    data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_9" } },
  };
  const response = await handle(delivery(event));
  const body = await text(response);
  check("a failed invoice is looked up and lands as grace", response.status === 200 && db.applied[0]?.cloudSync === true);
  check("grace is a week past the period end", db.applied[0]?.expiresAtMs === NOW + 3 * DAY + 7 * DAY);
  check("the event was applied once", body.outcome === "applied");
}

{
  const { handle, db } = build({
    db: new FakeDb({ customers: { [USER]: "cus_1" } }),
    stripe: new FakeStripe({ subscriptions: { sub_7: subscription({ id: "sub_7" }) } }),
  });
  const event = {
    id: "evt_checkout",
    type: "checkout.session.completed",
    created: Math.floor(NOW / 1000),
    data: { object: { id: "cs_1", mode: "subscription", customer: "cus_1", subscription: "sub_7" } },
  };
  await handle(delivery(event));
  check(
    "a completed checkout is read from Stripe itself, then written",
    db.applied.length === 1 && db.applied[0].cloudSync === true && db.applied[0].customerId === "cus_1",
  );
}

{
  const { handle, db } = build({ db: new FakeDb({ customers: { [USER]: "cus_1" } }) });
  const event = {
    id: "evt_cancel",
    type: "customer.subscription.deleted",
    created: Math.floor(NOW / 1000),
    data: { object: subscription({ status: "canceled", items: { data: [{ price: { id: "price_month" }, current_period_end: Math.floor((NOW - DAY) / 1000) }] } }) },
  };
  await handle(delivery(event));
  check("a cancelled subscription whose period has ended is a refusal", db.applied[0]?.cloudSync === false);
  check("with the period end as the date, not now", db.applied[0]?.expiresAtMs === NOW - DAY);
}

/* --------------------------------------------------------------------------
 * 4. Events that must not grant anything
 * ----------------------------------------------------------------------- */

{
  const { handle, db, stripe } = build({ db: new FakeDb({ customers: { [USER]: "cus_1" } }) });
  const event = {
    id: "evt_other_price",
    type: "customer.subscription.created",
    created: Math.floor(NOW / 1000),
    data: { object: subscription({ items: { data: [{ price: { id: "price_someone_elses" }, current_period_end: Math.floor((NOW + DAY) / 1000) }] } }) },
  };
  const response = await handle(delivery(event));
  const body = await text(response);
  check(
    "a subscription on a price this shop does not sell grants nothing",
    response.status === 200 && body.outcome === "ignored" && body.why === "price_not_sold" && db.applied.length === 0,
  );
}

{
  const { handle, db } = build();
  const event = { id: "evt_nope", type: "customer.created", created: Math.floor(NOW / 1000), data: { object: { id: "cus_1" } } };
  const response = await handle(delivery(event));
  const body = await text(response);
  check("an event this shop does not act on is acknowledged and dropped", response.status === 200 && body.outcome === "ignored" && db.applied.length === 0);
  check("the five events it does act on are the five named in the doc", HANDLED_EVENTS.length === 5 && HANDLED_EVENTS.includes("invoice.payment_failed"));
}

{
  const { handle, db } = build({ db: new FakeDb({ outcome: "unknown_customer" }) });
  const event = { id: "evt_unknown", type: "customer.subscription.updated", created: Math.floor(NOW / 1000), data: { object: subscription() } };
  const response = await handle(delivery(event));
  const body = await text(response);
  check("a customer nobody is linked to is reported, not guessed at", response.status === 200 && body.outcome === "unknown_customer");
}

{
  const { handle, db } = build({ db: new FakeDb({ outcome: "duplicate" }) });
  const event = { id: "evt_replay", type: "customer.subscription.updated", created: Math.floor(NOW / 1000), data: { object: subscription() } };
  const response = await handle(delivery(event));
  const body = await text(response);
  check("a replayed event is answered, and says it changed nothing", response.status === 200 && body.outcome === "duplicate");
  check("it is still passed to the database, which is what remembers", db.applied[0]?.eventId === "evt_replay");
}

/* --------------------------------------------------------------------------
 * 5. When the far side fails, the retry must be able to do the whole thing
 * ----------------------------------------------------------------------- */

{
  const { handle, db } = build({ stripe: new FakeStripe({ fail: "stripe unreachable" }) });
  const event = {
    id: "evt_checkout_2",
    type: "checkout.session.completed",
    created: Math.floor(NOW / 1000),
    data: { object: { id: "cs_2", mode: "subscription", customer: "cus_1", subscription: "sub_7" } },
  };
  const response = await handle(delivery(event));
  check("a Stripe that cannot be asked is a 502, which Stripe will retry", response.status === 502);
  check("and the event id was not spent, so the retry does everything", db.applied.length === 0);
}

{
  const { handle } = build({ db: new FakeDb({ fail: "database gone" }) });
  const event = { id: "evt_db", type: "customer.subscription.updated", created: Math.floor(NOW / 1000), data: { object: subscription() } };
  const response = await handle(delivery(event));
  check("a database that is down is a 500, which Stripe will retry", response.status === 500);
}

/* --------------------------------------------------------------------------
 * 6. Prices, and where they are allowed to come from
 * ----------------------------------------------------------------------- */

{
  const stripe = new FakeStripe({
    prices: {
      price_month: { unit_amount: 99, currency: "usd", recurring: { interval: "month" } },
      price_year: { unit_amount: 999, currency: "usd", recurring: { interval: "year" } },
    },
  });
  const { handle } = build({ stripe });
  const first = await text(await handle(request("/plans")));
  const second = await text(await handle(request("/plans")));
  check(
    "the offer is Stripe's own prices, in the app's shape",
    first.plans.length === 2 && first.plans[0].id === "yearly" && first.plans[0].price === "$9.99" && first.plans[0].period === "year",
  );
  check("monthly is $0.99 a month", first.plans[1].price === "$0.99" && first.plans[1].period === "month");
  check("the second ask within the hour costs no Stripe call", stripe.priceCalls === 2 && second.plans.length === 2);
}

{
  const stripe = new FakeStripe({ fail: "stripe unreachable" });
  const { handle } = build({ stripe });
  const response = await handle(request("/plans"));
  check("a shop that cannot be priced is 503 with an empty offer, never a free one", response.status === 503);
}

/* --------------------------------------------------------------------------
 * 7. Small print that protects the URL somebody pays at
 * ----------------------------------------------------------------------- */

{
  const { handle } = build();
  const allowed = await handle(request("/health", { headers: { origin: "https://app.test" } }));
  check("a configured origin may call from a browser", allowed.headers.get("access-control-allow-origin") === "https://app.test");
  const refused = await handle(request("/health", { headers: { origin: "https://evil.test" } }));
  check("any other origin gets no CORS header at all", refused.headers.get("access-control-allow-origin") === null);
  const preflight = await handle(request("/checkout", { method: "OPTIONS", headers: { origin: "https://app.test" } }));
  check("and a preflight is answered without touching anything", preflight.status === 204);
}

{
  const { handle, logs } = build({ db: new FakeDb({ customers: { [USER]: "cus_1" } }) });
  await handle(request("/checkout", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: { plan: "monthly" } }));
  const event = { id: "evt_log", type: "customer.subscription.updated", created: Math.floor(NOW / 1000), data: { object: subscription() } };
  await handle(delivery(event));
  const written = JSON.stringify(logs);
  check("the log says what was applied, and in which state", /webhook_applied/.test(written) && /"state":"active"/.test(written));
  check("the log holds no token, no secret and no key", !written.includes(TOKEN) && !written.includes(SECRET) && !/sk_/.test(written));
}

{
  const { handle } = build();
  const big = "x".repeat(300 * 1024);
  const response = await handle(
    request("/stripe/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: big }),
  );
  check("an oversized body is refused before it is parsed", response.status === 413);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
