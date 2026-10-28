/**
 * The billing service: four routes, and the webhook that writes the row.
 *
 * `POST /checkout`      — verified JWT in, Checkout URL out. The only route the app calls.
 * `GET  /plans`         — what is for sale, priced by Stripe.
 * `POST /stripe/webhook`— signed events in, `cloud_sync` written.
 * `GET  /health`        — is this process up, and is it configured.
 *
 * The split of responsibilities is the whole design:
 *
 * - the app sends a **plan name** and a **JWT**, and never a price id, a
 *   customer id or a user id;
 * - checkout creation writes the **customer ⇄ reader link**, from the JWT —
 *   the same transaction that makes a payment attributable;
 * - the webhook never reads a user id from the body. It reads a customer id,
 *   looks the reader up in the link table, and refuses to guess (`unknown_customer`);
 * - not one byte of card data passes through anything here: Checkout is a page
 *   on Stripe's domain, and this service only ever sees a URL and an event.
 *
 * Every response is JSON. Nothing is cached. Nothing in a log line is a secret.
 */
import { verifySignature, SIGNATURE_HEADER } from "./signature.mjs";
import { mapSubscription, planOf, priceIdsOf } from "./subscription-state.mjs";
import { isPlanKey, priceIdFor } from "./plans.mjs";
import { StripeError } from "./stripe-api.mjs";

/** The largest body either route will read, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024;

/** The events this shop acts on. Anything else is acknowledged and dropped. */
export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
];

/**
 * Builds the request handler.
 *
 * Everything that talks to the outside world is injected — `db`, `stripe`,
 * `auth`, `now`, `log` — so the suite can drive real HTTP, real signature
 * verification and the real state mapping against doubles only for the two
 * parties that need the internet.
 */
export function createBillingApp({ config, db, stripe, auth, offer, now = () => Date.now(), log = silentLog }) {
  const origins = new Set(config.origins ?? []);

  return async function handle(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }), origins);
    }

    try {
      if (method === "GET" && url.pathname === "/health") {
        return withCors(request, json(200, { ok: true, plans: offer.plans().length }), origins);
      }

      if (method === "GET" && url.pathname === "/plans") {
        return withCors(request, await handlePlans(offer, log), origins);
      }

      if (method === "POST" && url.pathname === "/checkout") {
        return withCors(request, await handleCheckout({ request, config, db, stripe, auth, log }), origins);
      }

      if (method === "POST" && url.pathname === "/stripe/webhook") {
        // No CORS: Stripe is a server, and a browser has no business posting here.
        return await handleWebhook({ request, config, db, stripe, log, now });
      }

      return withCors(request, json(404, { error: "not_found" }), origins);
    } catch (cause) {
      log.error("request_failed", { path: url.pathname, error: String(cause) });
      return withCors(request, json(500, { error: "internal" }), origins);
    }
  };
}

/* --------------------------------- /plans --------------------------------- */

async function handlePlans(offer, log) {
  try {
    const plans = await offer.load();
    return json(200, { plans });
  } catch (cause) {
    // An unreadable price is not a free one. The app shows its own fallback
    // words and no press is taken.
    log.warn("plans_unavailable", { error: String(cause) });
    return json(503, { error: "plans_unavailable", plans: [] });
  }
}

/* -------------------------------- /checkout -------------------------------- */

async function handleCheckout({ request, config, db, stripe, auth, log }) {
  const token = bearer(request.headers.get("authorization"));
  const userId = await auth.userId(token);
  if (userId === null) return json(401, { error: "not_signed_in" });

  let body;
  try {
    body = await readJson(request);
  } catch (cause) {
    return json(400, { error: "bad_json" });
  }

  const plan = body?.plan;
  if (!isPlanKey(plan)) return json(400, { error: "unknown_plan" });

  const priceId = priceIdFor(plan, config.prices);
  if (priceId === null) {
    // Configured away rather than trusted from the request: a deployment that
    // sells only yearly must not be talked into monthly by a client.
    return json(400, { error: "plan_not_offered", plan });
  }

  let customerId = await db.customerOf(userId);
  if (customerId === null) {
    // Written before the session exists: if the purchase completes, the webhook
    // has a link to follow. If it does not, an unused customer sits in Stripe,
    // which costs nothing and is cleaned up by nobody's cron.
    const created = await stripe.createCustomer({ userId });
    await db.linkCustomer(userId, created);
    customerId = created;
  }

  const session = await stripe.createCheckoutSession({
    customerId,
    priceId,
    userId,
    successUrl: `${config.appUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${config.appUrl}/?checkout=cancelled`,
  });

  log.info("checkout_created", { plan, customer: customerId, session: session.id });
  // Only the URL crosses the wire. No price, no customer, no secret.
  return json(200, { url: session.url });
}

/* ------------------------------ /stripe/webhook ----------------------------- */

async function handleWebhook({ request, config, db, stripe, log, now }) {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return json(413, { error: "too_large" });

  const header = request.headers.get(SIGNATURE_HEADER);
  const verified = verifySignature(raw, header, config.webhookSecret, {
    nowSeconds: Math.floor(now() / 1000),
  });
  if (!verified.ok) {
    // 400, not 500: Stripe retries a 5xx and stops on a 4xx, and a signature
    // that does not match is not going to match on the sixth attempt either.
    log.warn("webhook_unsigned", { reason: verified.reason });
    return json(400, { error: "bad_signature", reason: verified.reason });
  }

  let event;
  try {
    event = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { error: "bad_json" });
  }

  const type = typeof event?.type === "string" ? event.type : "";
  const eventId = typeof event?.id === "string" ? event.id : "";
  const created = typeof event?.created === "number" ? event.created : Math.floor(now() / 1000);
  if (eventId === "" || type === "") return json(400, { error: "bad_event" });

  if (!HANDLED_EVENTS.includes(type)) {
    log.info("webhook_ignored", { id: eventId, type, why: "event_not_handled" });
    return json(200, { received: true, outcome: "ignored", why: "event_not_handled" });
  }

  let subject;
  try {
    subject = await subjectOfEvent(event, stripe);
  } catch (cause) {
    // Stripe could not be asked what this subscription is now. Retryable: the
    // event id has not been spent, so the retry does the whole thing.
    log.error("webhook_stripe_failed", { id: eventId, type, error: String(cause) });
    return json(502, { error: "stripe_unavailable" });
  }

  if (!subject.ok) {
    log.info("webhook_ignored", { id: eventId, type, why: subject.why });
    return json(200, { received: true, outcome: "ignored", why: subject.why });
  }

  const { subscription, customerId } = subject;
  const plan = planOf(subscription, config.prices);
  if (plan === null) {
    // Active, and on something this shop does not sell. Acknowledged, so Stripe
    // stops retrying, and never granted.
    log.warn("webhook_ignored", {
      id: eventId,
      type,
      why: "price_not_sold",
      prices: priceIdsOf(subscription),
    });
    return json(200, { received: true, outcome: "ignored", why: "price_not_sold" });
  }

  const grant = mapSubscription(subscription, { nowMs: now() });
  let outcome;
  try {
    outcome = await db.applyEvent({
      eventId,
      type,
      created,
      customerId,
      cloudSync: grant.cloudSync,
      expiresAtMs: grant.expiresAt,
    });
  } catch (cause) {
    log.error("webhook_db_failed", { id: eventId, type, error: String(cause) });
    return json(500, { error: "db_unavailable" });
  }

  log.info("webhook_applied", {
    id: eventId,
    type,
    outcome,
    plan,
    cloud_sync: grant.cloudSync,
    state: grant.state,
  });
  return json(200, { received: true, outcome });
}

/**
 * The subscription an event is about, and the customer it belongs to.
 *
 * Three of the five events carry the subscription itself, which is the state as
 * of the event — the freshest thing available and one API call cheaper. The
 * other two carry an id, so they are looked up.
 *
 * The customer id is taken from the object, and never from a `user`/`metadata`
 * field: the customer is the key the database resolves, and everything else in
 * the body is a claim.
 */
async function subjectOfEvent(event, stripe) {
  const object = event?.data?.object ?? {};
  const type = event.type;

  if (type === "checkout.session.completed") {
    if (object.mode !== "subscription") return { ok: false, why: "not_a_subscription" };
    const subscriptionId = idOf(object.subscription);
    if (subscriptionId === null) return { ok: false, why: "no_subscription" };
    const subscription = await stripe.getSubscription(subscriptionId);
    return { ok: true, subscription, customerId: idOf(subscription.customer) ?? idOf(object.customer) };
  }

  if (type === "invoice.payment_failed") {
    // `invoice.subscription` is the field; newer API versions nest it under
    // `parent.subscription_details`, so both are read.
    const subscriptionId =
      idOf(object.subscription) ?? idOf(object.parent?.subscription_details?.subscription);
    if (subscriptionId === null) return { ok: false, why: "no_subscription" };
    const subscription = await stripe.getSubscription(subscriptionId);
    return { ok: true, subscription, customerId: idOf(subscription.customer) ?? idOf(object.customer) };
  }

  // customer.subscription.created | .updated | .deleted
  const customerId = idOf(object.customer);
  if (customerId === null) return { ok: false, why: "no_customer" };
  return { ok: true, subscription: object, customerId };
}

/* --------------------------------- helpers -------------------------------- */

/** A Stripe field that is either an id or an expanded object's id. */
function idOf(value) {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "object" && value !== null) {
    const id = value.id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

function bearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}

async function readJson(request) {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) throw new Error("too_large");
  return JSON.parse(new TextDecoder().decode(raw) || "{}");
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * CORS, for the PWA only.
 *
 * The desktop app is not subject to it and the phone app has no origin. A
 * browser tab does, and the allow-list is configured rather than `*` because
 * this endpoint takes an Authorization header and returns a URL somebody can
 * pay at.
 */
function withCors(request, response, origins) {
  const origin = request.headers.get("origin");
  if (origin !== null && origins.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
    response.headers.set("Access-Control-Allow-Headers", "authorization, content-type");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Max-Age", "600");
  }
  return response;
}

/** The default log: one JSON line per thing, on stdout, with no secrets in it. */
export const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Stripe errors are already redacted at construction; this keeps the code honest. */
export { StripeError };
