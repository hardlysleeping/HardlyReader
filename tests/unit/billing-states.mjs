/**
 * What Stripe says, and what this shop is willing to believe.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/billing-states.mjs
 *
 * `server/billing/subscription-state.mjs` is the whole policy of the purchase,
 * and it is pure: a subscription object in, the two columns to write out. This
 * suite stands at nine moments in one subscription's life and checks the answer,
 * because the expensive mistakes here are not crashes — they are a cancelled
 * reader who keeps syncing for a month, and a paying reader who loses the
 * feature the day their card is reissued.
 *
 * The signature half is here too: Stripe's webhook is the only thing that may
 * write a grant, so "did this come from Stripe" is checked against the bytes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GRACE_MS, mapSubscription, planOf, periodEndMs, priceIdsOf } from "../../server/billing/subscription-state.mjs";
import { signPayload, verifySignature } from "../../server/billing/signature.mjs";
import { formatPrice, isPlanKey, priceIdFor, pricesFromEnv } from "../../server/billing/plans.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** One second in Stripe's units. */
const S = 1000;
/** The moment the suite stands at: 2026-10-27T00:00:00Z. */
const NOW = Date.UTC(2026, 9, 27);
const DAY = 86_400 * S;

const PRICES = { monthly: "price_month", yearly: "price_year" };

/** A subscription, with the modern item-level billing period. */
function subscription(overrides = {}) {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    created: NOW / S - 30 * DAY / S,
    items: { data: [{ price: { id: "price_month" }, current_period_end: (NOW + 3 * DAY) / S }] },
    ...overrides,
  };
}

/* --------------------------------------------------------------------------
 * 1. The four states, at the moments they matter
 * ----------------------------------------------------------------------- */

const future = (NOW + 3 * DAY) / S;
const past = (NOW - 3 * DAY) / S;

check(
  "active, paid up: granted to the end of the period",
  (() => {
    const grant = mapSubscription(subscription(), { nowMs: NOW });
    return grant.cloudSync === true && grant.expiresAt === future * S && grant.state === "active";
  })(),
);

check(
  "active but the period has already passed: expired, not active",
  (() => {
    const grant = mapSubscription(subscription({ items: { data: [{ price: { id: "price_month" }, current_period_end: past }] } }), { nowMs: NOW });
    return grant.cloudSync === false && grant.state === "expired";
  })(),
);

check(
  "cancelled at period end (cancel_at_period_end, still active): granted until the period ends",
  (() => {
    const grant = mapSubscription(subscription({ cancel_at_period_end: true }), { nowMs: NOW });
    return grant.cloudSync === true && grant.expiresAt === future * S;
  })(),
);

check(
  "trialing: granted to the trial's end, which is sooner than the period",
  (() => {
    const grant = mapSubscription(subscription({ status: "trialing", trial_end: (NOW + DAY) / S }), { nowMs: NOW });
    return grant.cloudSync === true && grant.expiresAt === (NOW + DAY);
  })(),
);

check(
  "trialing with no trial end: falls back to the period end",
  (() => {
    const grant = mapSubscription(subscription({ status: "trialing", trial_end: 0 }), { nowMs: NOW });
    return grant.cloudSync === true && grant.expiresAt === future * S;
  })(),
);

check(
  "past_due: granted, and the window runs a week past the period end",
  (() => {
    const grant = mapSubscription(subscription({ status: "past_due" }), { nowMs: NOW });
    return grant.cloudSync === true && grant.state === "grace" && grant.expiresAt === future * S + GRACE_MS;
  })(),
  `grace is ${GRACE_MS / DAY} days`,
);

check(
  "past_due long after the period ended: still a week from now, never in the past",
  (() => {
    const grant = mapSubscription(
      subscription({ status: "past_due", items: { data: [{ price: { id: "price_month" }, current_period_end: past }] } }),
      { nowMs: NOW },
    );
    return grant.cloudSync === true && grant.expiresAt === NOW + GRACE_MS;
  })(),
);

check(
  "cancelled after the period ended: refused, and the date is the period end, not now",
  (() => {
    const grant = mapSubscription(
      subscription({ status: "canceled", items: { data: [{ price: { id: "price_month" }, current_period_end: past }] } }),
      { nowMs: NOW },
    );
    return grant.cloudSync === false && grant.expiresAt === past * S && grant.state === "expired";
  })(),
);

check(
  "cancelled before the period ends: still granted — a cancellation is not a refund",
  (() => {
    const grant = mapSubscription(subscription({ status: "canceled" }), { nowMs: NOW });
    return grant.cloudSync === true && grant.expiresAt === future * S;
  })(),
);

check(
  "unpaid after the period: refused; unpaid before it ends: still granted",
  (() => {
    const after = mapSubscription(
      subscription({ status: "unpaid", items: { data: [{ price: { id: "price_month" }, current_period_end: past }] } }),
      { nowMs: NOW },
    );
    const before = mapSubscription(subscription({ status: "unpaid" }), { nowMs: NOW });
    return after.cloudSync === false && before.cloudSync === true;
  })(),
);

check(
  "incomplete: never granted, not even for a little while",
  mapSubscription(subscription({ status: "incomplete" }), { nowMs: NOW }).cloudSync === false,
);

check(
  "incomplete_expired: refused",
  mapSubscription(subscription({ status: "incomplete_expired" }), { nowMs: NOW }).cloudSync === false,
);

check(
  "paused: refused, with the date that explains it",
  (() => {
    const grant = mapSubscription(subscription({ status: "paused" }), { nowMs: NOW });
    return grant.cloudSync === false && grant.expiresAt === future * S;
  })(),
);

check(
  "a status Stripe invents next year: refused, and says so",
  (() => {
    const grant = mapSubscription(subscription({ status: "quantum_pending" }), { nowMs: NOW });
    return grant.cloudSync === false && /quantum_pending/.test(grant.why);
  })(),
);

check(
  "a missing subscription object grants nothing",
  mapSubscription(null, { nowMs: NOW }).cloudSync === false,
);

/* --------------------------------------------------------------------------
 * 2. The period, in both API shapes
 * ----------------------------------------------------------------------- */

check(
  "period end is read from the subscription (pre-basil API version)",
  periodEndMs({ current_period_end: (NOW + DAY) / S, items: { data: [] } }) === NOW + DAY,
);

check(
  "period end is read from the item (2025-03-31.basil and later)",
  periodEndMs({ items: { data: [{ current_period_end: (NOW + DAY) / S }] } }) === NOW + DAY,
);

check(
  "with two items the earlier period end wins: paid up only as far as the shorter one",
  periodEndMs({
    current_period_end: (NOW + 30 * DAY) / S,
    items: { data: [{ current_period_end: (NOW + DAY) / S }, { current_period_end: (NOW + 9 * DAY) / S }] },
  }) === NOW + DAY,
);

check("no period at all is null, not zero", periodEndMs({ items: { data: [] } }) === null);

/* --------------------------------------------------------------------------
 * 3. Which price was bought
 * ----------------------------------------------------------------------- */

check(
  "the monthly price is a monthly plan",
  planOf(subscription(), PRICES) === "monthly",
);

check(
  "the yearly price is a yearly plan",
  planOf(subscription({ items: { data: [{ price: { id: "price_year" } }] } }), PRICES) === "yearly",
);

check(
  "a price this shop does not sell is no plan at all",
  planOf(subscription({ items: { data: [{ price: { id: "price_other" } }] } }), PRICES) === null,
);

check(
  "an unconfigured price cannot match, not even itself",
  planOf(subscription(), { monthly: null, yearly: null }) === null,
);

check(
  "every price id on the subscription is reported, for the log",
  priceIdsOf({ items: { data: [{ price: { id: "price_a" } }, { price: { id: "price_b" } }] } }).join(",") ===
    "price_a,price_b",
);

check(
  "the suite's own prices come from the environment's names",
  (() => {
    const prices = pricesFromEnv({ STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "" });
    return prices.monthly === "price_m" && prices.yearly === null;
  })(),
);

check("only the two plan names exist", isPlanKey("monthly") && isPlanKey("yearly") && !isPlanKey("lifetime"));

check("an unknown plan has no price id", priceIdFor("lifetime", PRICES) === null);

/* --------------------------------------------------------------------------
 * 4. Prices are Stripe's, formatted rather than invented
 * ----------------------------------------------------------------------- */

check(
  "990 usd a month is $9.90 a month",
  (() => {
    const formatted = formatPrice({ unit_amount: 990, currency: "usd", recurring: { interval: "month" } });
    return formatted?.price === "$9.90" && formatted.period === "month";
  })(),
);

check(
  "99 usd a year is $0.99 a year, and the period is the price's own",
  formatPrice({ unit_amount: 99, currency: "usd", recurring: { interval: "year" } }).period === "year",
);

check(
  "a price with no amount is no offer, not a free one",
  formatPrice({ currency: "usd", recurring: { interval: "month" } }) === null,
);

check(
  "a one-off price is not a subscription price",
  formatPrice({ unit_amount: 500, currency: "usd" }) === null,
);

/* --------------------------------------------------------------------------
 * 5. Did this come from Stripe
 * ----------------------------------------------------------------------- */

const SECRET = "whsec_test_secret";
const payload = new TextEncoder().encode('{"id":"evt_1","type":"customer.subscription.created"}');
const signedAt = Math.floor(NOW / 1000);

check(
  "a correctly signed, recent payload verifies",
  verifySignature(payload, signPayload(payload, SECRET, signedAt), SECRET, { nowSeconds: signedAt }).ok === true,
);

check(
  "a body edited after signing does not",
  verifySignature(
    new TextEncoder().encode('{"id":"evt_1","type":"customer.subscription.created","x":1}'),
    signPayload(payload, SECRET, signedAt),
    SECRET,
    { nowSeconds: signedAt },
  ).ok === false,
);

check(
  "the wrong secret does not",
  verifySignature(payload, signPayload(payload, "whsec_other", signedAt), SECRET, { nowSeconds: signedAt }).ok === false,
);

check(
  "an old but correctly signed payload is refused as a replay",
  (() => {
    const result = verifySignature(payload, signPayload(payload, SECRET, signedAt), SECRET, {
      nowSeconds: signedAt + 301,
    });
    return result.ok === false && result.reason === "stale_timestamp";
  })(),
);

check(
  "two signatures while a secret is rotated: either one matching is a pass",
  (() => {
    const both = `${signPayload(payload, SECRET, signedAt)},v1=${"0".repeat(64)}`;
    return verifySignature(payload, both, SECRET, { nowSeconds: signedAt }).ok === true;
  })(),
);

check(
  "no header is a refusal with a name",
  (() => {
    const result = verifySignature(payload, null, SECRET, { nowSeconds: signedAt });
    return result.ok === false && result.reason === "missing_header";
  })(),
);

check(
  "a header with no signature in it is a refusal",
  verifySignature(payload, `t=${signedAt}`, SECRET, { nowSeconds: signedAt }).reason === "no_signature",
);

check(
  "garbage in the header is a refusal, not a crash",
  verifySignature(payload, "v1=,t=abc,wat", SECRET, { nowSeconds: signedAt }).ok === false,
);

/* --------------------------------------------------------------------------
 * 6. The rules are in these files, and nowhere else
 * ----------------------------------------------------------------------- */

const state = readFileSync(join(ROOT, "server/billing/subscription-state.mjs"), "utf8");
const schema = readFileSync(join(ROOT, "supabase/schema.sql"), "utf8");

check(
  "the mapping imports nothing: it cannot consult a database or a clock of its own",
  !/^import /m.test(state),
);

check(
  "the schema's event function refuses an unknown customer rather than guessing one",
  /unknown_customer/.test(schema) && /for update/.test(schema),
);

check(
  "the schema grants execute on the writer to the service role only",
  /revoke all on function public\.apply_stripe_event[^;]+from authenticated;/s.test(schema),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
