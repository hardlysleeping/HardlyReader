/**
 * What a Stripe subscription means for `cloud_sync`, in one function.
 *
 * This file is the whole policy of HardlySyncing as a purchase, and it has
 * no imports on purpose: the webhook is allowed to be wrong about plumbing, but
 * it must not be allowed to be wrong about *money*. Every status Stripe can
 * report is answered here, by name, so a status nobody thought about lands on
 * "no grant" with a reason instead of on `true`.
 *
 * The four states the app already understands (`state/entitlements.svelte.ts`:
 * `none`, `active`, `grace`, `expired`) are not stored in the database — the row
 * is `cloud_sync` plus `expires_at`, and nothing else. So the mapping is not
 * cosmetic: it has to express grace in the two columns that exist.
 *
 * - `active` / `trialing` → true, until the period ends;
 * - `past_due` → true, and the window is *extended* past the period end by
 *   `GRACE_MS`, because Stripe is still retrying the card and the person on the
 *   other side has not stopped paying — their bank has. This is the app's
 *   `grace` state written honestly: a date in the future and the flag still on;
 * - `canceled` / `unpaid` → false *at the period end, not before*. A
 *   subscription cancelled today is paid up until the 14th, and revoking on the
 *   3rd is taking something back that was bought.
 *
 * Two things are deliberately not decided here: whether the subscription is on
 * a price this shop sells (that is `planOf`), and whether the reader is linked
 * to this Stripe customer at all (that is the database, never the webhook body).
 *
 * Plain JavaScript, no build step: the service runs as `node server/billing/main.mjs`.
 *
 * @typedef {"monthly" | "yearly"} PlanKey
 * @typedef {{ monthly: string | null, yearly: string | null }} Prices
 * @typedef {"active" | "grace" | "expired"} MappedState
 * @typedef {object} Grant
 * @property {boolean} cloudSync       What goes in `entitlements.cloud_sync`.
 * @property {number | null} expiresAt What goes in `entitlements.expires_at`, in
 *   milliseconds since the epoch; null for "no date".
 * @property {MappedState} state       Which of the app's states this is.
 * @property {string} why              Why, in a sentence — for logs, never for a reader.
 */

/**
 * Seven days of grace after a failed payment.
 *
 * Long enough to cover a card that was reissued and a reader who is away for a
 * week, short enough that the row turns itself off without anyone pressing
 * anything. Stripe keeps retrying inside this window and sends
 * `customer.subscription.updated` when it succeeds, which puts the row back to
 * the plain period end.
 */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The plan a subscription is on, by price id.
 *
 * The app never sends a price id and never learns one; the webhook says which
 * of *our* two prices was bought, and a subscription on any other price grants
 * nothing. That is the difference between "Stripe says this is active" and
 * "Stripe says this subscription is active on something we sell" — without this
 * check, a $0.01 price created in the dashboard would unlock the feature.
 *
 * @param {unknown} subscription
 * @param {Prices} prices
 * @returns {PlanKey | null}
 */
export function planOf(subscription, prices) {
  const ids = priceIdsOf(subscription);
  if (ids.length === 0) return null;
  for (const id of ids) {
    if (prices.monthly !== null && id === prices.monthly) return "monthly";
    if (prices.yearly !== null && id === prices.yearly) return "yearly";
  }
  return null;
}

/**
 * Every price id on the subscription, whichever shape the API version carries.
 *
 * @param {unknown} subscription
 * @returns {string[]}
 */
export function priceIdsOf(subscription) {
  const sub = asRecord(subscription);
  const items = asRecord(sub.items);
  const data = Array.isArray(items.data) ? items.data : [];
  /** @type {string[]} */
  const ids = [];
  // `items.data[].price` is the modern shape; `plan.id` is what a very old API
  // version puts on the subscription. Both are read, because a webhook endpoint
  // pinned to an older version is a configuration fact, not a bug report.
  for (const item of data) {
    const price = asRecord(asRecord(item).price);
    const id = text(price.id) ?? text(asRecord(asRecord(item).plan).id);
    if (id !== null) ids.push(id);
  }
  const legacy = text(asRecord(sub.plan).id);
  if (legacy !== null && !ids.includes(legacy)) ids.push(legacy);
  return ids;
}

/**
 * When the paid-for period ends, in milliseconds, or `null` when Stripe does not
 * say.
 *
 * Since API version `2025-03-31.basil` the billing period lives on each
 * subscription *item* rather than on the subscription, so both places are read.
 * A wrong answer here is a wrong expiry, so the earliest of the two is taken:
 * a subscription with a monthly and a yearly item is paid up only as far as the
 * shorter one.
 *
 * @param {unknown} subscription
 * @returns {number | null}
 */
export function periodEndMs(subscription) {
  const sub = asRecord(subscription);
  /** @type {number[]} */
  const candidates = [];
  pushSeconds(candidates, sub.current_period_end);
  const items = asRecord(sub.items);
  const data = Array.isArray(items.data) ? items.data : [];
  for (const item of data) pushSeconds(candidates, asRecord(item).current_period_end);
  if (candidates.length === 0) return null;
  return Math.min(...candidates) * 1000;
}

/**
 * When a trial ends, in milliseconds, or `null` for a subscription without one.
 *
 * @param {unknown} subscription
 * @returns {number | null}
 */
export function trialEndMs(subscription) {
  const sub = asRecord(subscription);
  const end = seconds(sub.trial_end);
  return end === null ? null : end * 1000;
}

/**
 * A Stripe subscription, read as a grant or a refusal.
 *
 * `nowMs` is injected so the suite can stand at any moment in the subscription's
 * life instead of waiting months for one. Unknown statuses never grant: a status
 * Stripe adds next year must fail closed, and it must say so in the log rather
 * than look like a lapsed card.
 *
 * @param {unknown} subscription
 * @param {{ nowMs?: number, graceMs?: number }} [options]
 * @returns {Grant}
 */
export function mapSubscription(subscription, options = {}) {
  const now = options.nowMs ?? Date.now();
  const graceMs = options.graceMs ?? GRACE_MS;
  const sub = asRecord(subscription);
  const status = text(sub.status) ?? "unknown";
  const periodEnd = periodEndMs(sub);
  const createdSeconds = seconds(sub.created);
  const createdAt = createdSeconds === null ? null : createdSeconds * 1000;

  /**
   * The answer for a status whose life is exactly its billing period.
   *
   * @param {string} live
   * @param {string} dead
   * @returns {Grant}
   */
  const untilPeriodEnd = (live, dead) => {
    if (periodEnd === null) return { cloudSync: true, expiresAt: null, state: "active", why: live };
    return periodEnd > now
      ? { cloudSync: true, expiresAt: periodEnd, state: "active", why: live }
      : { cloudSync: false, expiresAt: periodEnd, state: "expired", why: dead };
  };

  switch (status) {
    case "active":
      // `cancel_at_period_end` needs no branch: the subscription is still paid
      // up until the period ends, which is exactly what this arm already says.
      return untilPeriodEnd(
        "paid up until the end of the period",
        "the period ended and the subscription is over",
      );

    case "trialing": {
      const end = trialEndMs(sub) ?? periodEnd;
      if (end === null) {
        return { cloudSync: true, expiresAt: null, state: "active", why: "in a trial with no end date" };
      }
      return end > now
        ? { cloudSync: true, expiresAt: end, state: "active", why: "in a trial" }
        : { cloudSync: false, expiresAt: end, state: "expired", why: "the trial ended" };
    }

    case "past_due": {
      // The card failed and Stripe is retrying. The reader keeps syncing until
      // `period end + graceMs`, whichever is later, so a payment that fails on
      // the day it is due still leaves the full window.
      const base = periodEnd === null ? now : Math.max(periodEnd, now);
      return {
        cloudSync: true,
        expiresAt: base + graceMs,
        state: "grace",
        why: "the last payment failed and is being retried",
      };
    }

    case "canceled":
      return untilPeriodEnd(
        "cancelled, and paid up until the period ends",
        "cancelled and the period has ended",
      );

    case "unpaid":
      // Dunning has given up. Still honoured to the period end, because the
      // period was paid for; false from the moment it is not.
      return untilPeriodEnd(
        "unpaid, but the period it paid for has not ended",
        "unpaid, and the period it paid for is over",
      );

    case "paused":
      return {
        cloudSync: false,
        expiresAt: periodEnd,
        state: "expired",
        why: "the subscription is paused",
      };

    case "incomplete":
    case "incomplete_expired":
      // Checkout was opened and the first invoice was never paid. Nothing was
      // bought, so nothing is granted — including "for a little while".
      return {
        cloudSync: false,
        expiresAt: periodEnd,
        state: "expired",
        why: "the first payment never completed",
      };

    default:
      return {
        cloudSync: false,
        expiresAt: periodEnd ?? createdAt,
        state: "expired",
        why: `status "${status}" is not one this shop grants`,
      };
  }
}

/* ------------------------------- reading shape ------------------------------ */

/** @returns {Record<string, any>} */
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}

/** @returns {string | null} */
function text(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A Stripe timestamp is seconds since the epoch; 0 and null both mean "unset".
 *
 * @returns {number | null}
 */
function seconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** @returns {void} */
function pushSeconds(into, value) {
  const found = seconds(value);
  if (found !== null) into.push(found);
}
