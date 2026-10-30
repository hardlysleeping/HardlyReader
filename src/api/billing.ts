/**
 * Buying HardlySyncing on the web.
 *
 * The app's whole part in a purchase is four lines of JavaScript: ask the
 * billing service for a Checkout URL, hand it to the system browser, notice when
 * the reader comes back, and refresh the entitlement. There is no price id here,
 * no customer id, no card field and no receipt to verify — Checkout is Stripe's
 * page, on Stripe's domain, and the row that grants anything is written by the
 * webhook on the server. A client that could grant the capability itself would be
 * a free subscription in two lines.
 *
 * That is also why this works everywhere at once: a PWA, a Flatpak, a Linux
 * build and a sideloaded iPhone all have a browser, and none of them need a
 * store's permission to take a payment.
 *
 * `server/billing/` is the other half. `docs/billing.md` is the whole picture.
 */
import { openExternal } from "../lib/open-external";
import {
  SYNC_MONTHLY,
  SYNC_YEARLY,
  noEntitlement,
  type Entitlement,
  type Product,
  type Receipt,
  type Store,
} from "../state/entitlements.svelte";

/** The two plan names the service knows. Prices are Stripe's and never appear here. */
export type PlanKey = "monthly" | "yearly";

/**
 * Where the billing service lives.
 *
 * The published address is the default, because it has to survive five build paths — the AppImage
 * and flatpak in a container, the APK on this box, the IPA on a macOS runner and the Docker image —
 * and an env var that one of them forgets is a release with no subscribe button. The vars still win
 * so a fork or a staging deployment can point somewhere else, and neither value is a secret.
 */
export const BILLING_DEFAULT = "https://billing.hardlysleep.ing";

export function billingUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const configured = env.VITE_BILLING_URL ?? env.PUBLIC_BILLING_URL ?? BILLING_DEFAULT;
  return configured.replace(/\/$/, "");
}

/** Which plan a sync product id buys. */
export function planKeyOf(id: string): PlanKey | null {
  if (id === SYNC_MONTHLY) return "monthly";
  if (id === SYNC_YEARLY) return "yearly";
  return null;
}

/** The product id a plan name is sold as, in this app's own vocabulary. */
export function productIdOf(plan: PlanKey): string {
  return plan === "yearly" ? SYNC_YEARLY : SYNC_MONTHLY;
}

/** What the service said when it would not sell. */
export type CheckoutFailure =
  | "not_signed_in"
  | "unknown_plan"
  | "plan_not_offered"
  | "billing_unreachable"
  | "no_url";

/** A refusal with a name, so the panel can say something true and short. */
export class CheckoutError extends Error {
  readonly code: CheckoutFailure;

  constructor(code: CheckoutFailure, message?: string) {
    super(message ?? code);
    this.name = "CheckoutError";
    this.code = code;
  }
}

/** What the panel shows when the browser has the payment and the app does not. */
export const CHECKOUT_OPENED =
  "Checkout is open in your browser — come back here when it is done and HardlySyncing will be waiting.";

export interface BeginCheckoutOptions {
  plan: PlanKey;
  /** The reader's Supabase access token. Never stored, never logged. */
  token: string;
  /** Defaults to the configured service; the suite passes its own. */
  base?: string;
  fetch?: typeof fetch;
}

/**
 * Asks the service for a Checkout URL.
 *
 * The only thing sent is the plan name and the reader's token. The only thing
 * accepted back is an `https://` URL — a response that is not one is a refusal,
 * because the next thing that happens is that URL being opened for the reader.
 */
export async function beginCheckout(options: BeginCheckoutOptions): Promise<string> {
  const base = (options.base ?? billingUrl()).replace(/\/$/, "");
  if (base === "") throw new CheckoutError("billing_unreachable", "no billing service is configured");
  if (options.token === "") throw new CheckoutError("not_signed_in");

  const call = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${base}/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({ plan: options.plan }),
    });
  } catch (cause) {
    throw new CheckoutError("billing_unreachable", String(cause));
  }

  const body = await readJson(response);
  if (response.status === 401) throw new CheckoutError("not_signed_in");
  if (response.status === 400 && typeof body?.error === "string") {
    throw new CheckoutError(
      body.error === "plan_not_offered" ? "plan_not_offered" : "unknown_plan",
      body.error,
    );
  }
  if (!response.ok) throw new CheckoutError("billing_unreachable", `billing answered ${response.status}`);
  if (typeof body?.url !== "string" || !/^https:\/\//i.test(body.url)) {
    throw new CheckoutError("no_url", "the service returned no checkout page");
  }
  return body.url;
}

/**
 * Opens Checkout in the reader's browser and returns nothing.
 *
 * `open` is injected so the suite can watch the URL without a browser, and so a
 * shell with its own opener could pass one. The app's own is `openExternal`,
 * which hands the URL to the OS window and never loads it inside the reader.
 */
export async function openCheckout(
  options: BeginCheckoutOptions & { open?: (url: string) => Promise<void> | void },
): Promise<string> {
  const url = await beginCheckout(options);
  await (options.open ?? openExternal)(url);
  return url;
}

/* ------------------------------- the portal -------------------------------- */

/** What the service said when it would not open the portal. */
export type PortalFailure = "not_signed_in" | "no_customer" | "billing_unreachable" | "no_url";

/** A refusal with a name, so the account sheet can say something true and short. */
export class PortalError extends Error {
  readonly code: PortalFailure;

  constructor(code: PortalFailure, message?: string) {
    super(message ?? code);
    this.name = "PortalError";
    this.code = code;
  }
}

export interface BeginPortalOptions {
  /** The reader's Supabase access token. Never stored, never logged. */
  token: string;
  /** Defaults to the configured service; the suite passes its own. */
  base?: string;
  fetch?: typeof fetch;
}

/**
 * Asks the service for the billing portal's URL.
 *
 * This is where a reader goes when `delete_my_account()` answered `cancel_first`:
 * the account cannot be deleted while Stripe is still charging, and cancelling is
 * the reader's own action at the payment provider. Stripe's portal is that action
 * — cancel, change the card, read the invoices — and this app never sees a card.
 *
 * The only thing sent is the reader's token; the customer is resolved from it
 * server-side, so nothing here can name somebody else's subscription. The only
 * thing accepted back is an `https://` URL, because the next thing that happens is
 * that URL being opened for the reader.
 */
export async function beginPortal(options: BeginPortalOptions): Promise<string> {
  const base = (options.base ?? billingUrl()).replace(/\/$/, "");
  if (base === "") throw new PortalError("billing_unreachable", "no billing service is configured");
  if (options.token === "") throw new PortalError("not_signed_in");

  const call = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${base}/portal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
      },
    });
  } catch (cause) {
    throw new PortalError("billing_unreachable", String(cause));
  }

  if (response.status === 401) throw new PortalError("not_signed_in");
  if (response.status === 404) throw new PortalError("no_customer");
  const body = await readJson(response);
  if (!response.ok) throw new PortalError("billing_unreachable", `billing answered ${response.status}`);
  if (typeof body?.url !== "string" || !/^https:\/\//i.test(body.url)) {
    throw new PortalError("no_url", "the service returned no portal page");
  }
  return body.url;
}

/**
 * Opens the portal in the reader's browser, and returns the URL it opened.
 *
 * Returning the URL rather than nothing is for the sheet's own test: it can watch
 * what was opened without a browser. `open` is injected for the same reason
 * `openCheckout` injects it.
 */
export async function openBillingPortal(
  options: BeginPortalOptions & { open?: (url: string) => Promise<void> | void },
): Promise<string> {
  const url = await beginPortal(options);
  await (options.open ?? openExternal)(url);
  return url;
}

/** What a return from Checkout means, read off `location.search`. */
export type CheckoutReturn = { kind: "success"; sessionId: string | null } | { kind: "cancelled" };

/**
 * The `?checkout=` a Checkout redirect comes back with, or null.
 *
 * A returned page can be reloaded, bookmarked, or reached a week later, so this
 * says what happened and nothing else: the caller refreshes the entitlement and
 * is done. There is no session to verify here — the webhook already did, and if
 * it has not landed yet the refresh simply says "not yet".
 */
export function checkoutReturned(search: string): CheckoutReturn | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  const marker = params.get("checkout");
  if (marker === "success") return { kind: "success", sessionId: params.get("session_id") };
  if (marker === "cancelled") return { kind: "cancelled" };
  return null;
}

/**
 * How the app reads its own entitlement from the server.
 *
 * `state/entitlements.svelte.ts` owns the mapping from a row to a capability;
 * this is only the fetch. It is an interface here so that a `WebStore` can be
 * built and tested before the remote reader exists: with no reader, `current()`
 * answers none — never a grant.
 */
export interface ServerEntitlement {
  read(): Promise<Entitlement>;
}

/**
 * The `Store` a browser tab has: Checkout for buying, the server for reading.
 *
 * `NativeStore` stays what it is — a shell that has not answered yet. This one
 * answers through the billing service, which is why the same button in the same
 * panel works on Linux, on a phone and in the PWA without a store's permission.
 *
 * `current()` and `restore()` delegate to the injected reader. With none, they
 * say none: the purchase is real and the entitlement is the server's to report,
 * so inventing `active` here would be inventing a receipt.
 */
export class WebStore implements Store {
  readonly token: () => string;
  readonly base: string;
  readonly open: (url: string) => Promise<void> | void;
  readonly server: ServerEntitlement | null;
  readonly fetch: typeof fetch | undefined;

  constructor(options: {
    token: () => string;
    server?: ServerEntitlement | null;
    base?: string;
    open?: (url: string) => Promise<void> | void;
    fetch?: typeof fetch;
  }) {
    this.token = options.token;
    this.server = options.server ?? null;
    this.base = options.base ?? billingUrl();
    this.open = options.open ?? openExternal;
    this.fetch = options.fetch;
  }

  /** What is for sale, priced by Stripe and fetched from the service. */
  async products(): Promise<Product[]> {
    const base = this.base.replace(/\/$/, "");
    if (base === "") throw new CheckoutError("billing_unreachable", "no billing service is configured");
    const call = this.fetch ?? fetch;
    const response = await call(`${base}/plans`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new CheckoutError("billing_unreachable", `plans answered ${response.status}`);
    const body = await readJson(response);
    const plans = Array.isArray(body?.plans) ? body.plans : [];
    const products: Product[] = [];
    for (const plan of plans) {
      const key = plan?.id;
      if (key !== "monthly" && key !== "yearly") continue;
      if (typeof plan.price !== "string") continue;
      if (plan.period !== "month" && plan.period !== "year") continue;
      products.push({ id: productIdOf(key), price: plan.price, period: plan.period });
    }
    return products;
  }

  /**
   * Opens Checkout. The answer is "not bought yet", because it is not: the row
   * is written by the webhook, and the refresh on return is what turns it on.
   */
  async purchase(id: string): Promise<Receipt> {
    const plan = planKeyOf(id);
    if (plan === null) {
      return noEntitlement(`${id} is not a HardlySyncing product`);
    }
    await openCheckout({ plan, token: this.token(), base: this.base, fetch: this.fetch, open: this.open });
    return { state: "none", productId: id, expiresAt: null, reason: CHECKOUT_OPENED };
  }

  /** There is nothing to restore: the row is the receipt, and it is the server's. */
  async restore(): Promise<Receipt> {
    return this.current();
  }

  /** Where the subscription stands, as the server tells it. */
  async current(): Promise<Entitlement> {
    if (this.server === null) {
      return noEntitlement("this build has no way to read an entitlement from the server");
    }
    return this.server.read();
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (text === "") return null;
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
