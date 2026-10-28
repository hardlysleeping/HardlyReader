/**
 * The two things for sale, and the words that describe them.
 *
 * The ids here are the *server's* names for the two prices, and they are the
 * only plan names that exist anywhere: the app sends `monthly` or `yearly` and
 * never a `price_…` id, so a price can be changed in the Stripe dashboard
 * without a release, and a price this deployment does not sell cannot be
 * requested by a client that has edited its own bundle.
 *
 * The prices themselves are Stripe's: `GET /v1/prices/{id}` and formatted from
 * what comes back (`unit_amount`, `currency`), cached for an hour. If Stripe
 * cannot be asked, the offer is empty rather than invented — a row that cannot
 * say what it costs should not take the press. The app has its own fallback
 * words for exactly that case and owns them.
 */
import { StripeError } from "./stripe-api.mjs";

/** The plan keys, in the order the offer row draws them. */
export const PLAN_KEYS = ["yearly", "monthly"];

/** How long a Stripe price is believed, in milliseconds. */
export const PRICE_CACHE_MS = 60 * 60 * 1000;

/** Which env var holds each price id. */
const PRICE_ENV = {
  monthly: "STRIPE_PRICE_MONTHLY",
  yearly: "STRIPE_PRICE_YEARLY",
};

/** Whether a string is one of the two plan keys. */
export function isPlanKey(value) {
  return typeof value === "string" && PLAN_KEYS.includes(value);
}

/** The two price ids, as configured — null where the deployment has not set one. */
export function pricesFromEnv(env) {
  return {
    monthly: text(env[PRICE_ENV.monthly]),
    yearly: text(env[PRICE_ENV.yearly]),
  };
}

/** The price id for a plan key, or null when this deployment does not sell it. */
export function priceIdFor(plan, prices) {
  return isPlanKey(plan) ? (prices[plan] ?? null) : null;
}

/** Every configured price id, in plan order. */
export function configuredPriceIds(prices) {
  return PLAN_KEYS.map((plan) => prices[plan]).filter((id) => id !== null);
}

/**
 * A Stripe price, read as the row the app draws.
 *
 * `unit_amount` is in the currency's smallest unit (`990` is `$9.90`), and the
 * decimal places are the currency's, not a guess: `Intl` knows that a yen has
 * none. An amount Stripe does not report is not zero — it is "no price", and the
 * plan is left out of the offer rather than shown as free.
 */
export function formatPrice(price) {
  const amount = typeof price?.unit_amount === "number" ? price.unit_amount : null;
  const currency = typeof price?.currency === "string" ? price.currency : null;
  const interval = typeof price?.recurring?.interval === "string" ? price.recurring.interval : null;
  if (amount === null || currency === null || interval === null) return null;
  if (interval !== "month" && interval !== "year") return null;
  return {
    price: formatAmount(amount, currency),
    period: interval,
  };
}

/** `990, "usd"` → `"$9.90"`, in the currency's own conventions. */
export function formatAmount(amount, currency) {
  const fractionDigits = digitsFor(currency);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount / 10 ** fractionDigits);
  } catch {
    // A currency `Intl` refuses: the amount and its code, unformatted, is still
    // a truthful answer.
    return `${(amount / 10 ** fractionDigits).toFixed(fractionDigits)} ${currency.toUpperCase()}`;
  }
}

function digitsFor(currency) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * What is for sale right now, in the app's shape.
 *
 * One Stripe call per price, at most once an hour. A failure caches nothing, so
 * the next request tries again rather than serving an empty shop for an hour.
 */
export class Offer {
  constructor({ stripe, prices, now = () => Date.now() }) {
    this.stripe = stripe;
    this.prices = prices;
    this.now = now;
    /** @type {{ at: number, plans: Array<{id: string, price: string, period: string}> } | null} */
    this.cache = null;
  }

  plans() {
    return this.cache === null ? [] : this.cache.plans;
  }

  async load() {
    if (this.cache !== null && this.now() - this.cache.at < PRICE_CACHE_MS) return this.cache.plans;
    const plans = [];
    for (const plan of PLAN_KEYS) {
      const id = this.prices[plan];
      if (id === null) continue;
      const price = await this.stripe.getPrice(id);
      const formatted = formatPrice(price);
      if (formatted === null) {
        throw new StripeError(`price ${id} has no recurring amount to show`, { code: "unreadable_price" });
      }
      plans.push({ id: plan, price: formatted.price, period: formatted.period });
    }
    this.cache = { at: this.now(), plans };
    return plans;
  }
}

function text(value) {
  return typeof value === "string" && value !== "" ? value : null;
}
