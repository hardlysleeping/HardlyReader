/**
 * Stripe, the five calls this shop actually makes.
 *
 * The four requests are form-encoded `POST`s and one `GET` — five now that the
 * portal is here — and the
 * signature check (the part an SDK would be genuinely useful for) is already in
 * `signature.mjs` as twenty lines of `node:crypto`. A dependency here would be
 * updated by somebody else's release schedule, which is how a payment path
 * breaks on a Tuesday.
 *
 * The secret key is held by this class and by nothing else: never passed to a
 * response, never logged, never in an error message. `FakeStripe` is the suite's
 * double, and it records what it was asked for so the tests can assert on the
 * request rather than on the shape of a real response.
 */

export class StripeError extends Error {
  constructor(message, { status = 0, code = "stripe" } = {}) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.code = code;
  }
}

/** The live API, over `fetch`. */
export class StripeApi {
  constructor({ secretKey, apiBase = "https://api.stripe.com", fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    if (!secretKey) throw new StripeError("STRIPE_SECRET_KEY is not set", { code: "config" });
    if (typeof fetchImpl !== "function") throw new StripeError("no fetch available", { code: "config" });
    this.secretKey = secretKey;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * A Stripe customer for one reader.
   *
   * `metadata.supabase_user_id` is set here as well as in the link table. The
   * link table is the authority — a webhook never reads this metadata to decide
   * who paid — but a human looking at the Stripe dashboard should be able to see
   * which reader a customer is, and support questions are answered by humans.
   *
   * The idempotency key is the reader's id: two presses of the button at the
   * same moment create one customer, not two.
   */
  async createCustomer({ userId, email = null }) {
    const form = new URLSearchParams();
    form.set("metadata[supabase_user_id]", userId);
    if (email !== null) form.set("email", email);
    const customer = await this.post("/v1/customers", form, `hr-customer-${userId}`);
    return customer.id;
  }

  /**
   * A Checkout Session for one of the two prices.
   *
   * `client_reference_id` and the subscription metadata both carry the reader's
   * id, so a payment is attributable from the Stripe side too. They are not what
   * grants anything: the grant is decided by the customer link written before
   * this call. It is `mode=subscription`, so Stripe owns renewal, dunning and
   * cancellation, and no card data ever reaches the app.
   */
  async createCheckoutSession({ customerId, priceId, userId, successUrl, cancelUrl }) {
    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("customer", customerId);
    form.set("client_reference_id", userId);
    form.set("line_items[0][price]", priceId);
    form.set("line_items[0][quantity]", "1");
    form.set("subscription_data[metadata][supabase_user_id]", userId);
    form.set("success_url", successUrl);
    form.set("cancel_url", cancelUrl);
    const session = await this.post("/v1/checkout/sessions", form);
    if (typeof session.url !== "string" || !/^https:\/\//.test(session.url)) {
      throw new StripeError("checkout session came back without a url", { code: "no_url" });
    }
    return { id: String(session.id ?? ""), url: session.url };
  }

  /**
   * A Stripe billing-portal session, so the reader can cancel what they bought.
   *
   * The portal is Stripe's page: cancelling, changing the card and downloading an
   * invoice all happen there, and this service only ever holds the URL. It exists
   * because deleting an account that is still being charged is refused
   * (`delete_my_account()` answers `cancel_first`), and a refusal has to point
   * somewhere: this is the somewhere.
   *
   * `customer` comes from the link table, never from the request, so a token can
   * only reach the portal of the reader it belongs to. The return URL is the
   * app's own origin, for the same reason checkout's is.
   */
  async createBillingPortalSession({ customerId, returnUrl }) {
    const form = new URLSearchParams();
    form.set("customer", customerId);
    form.set("return_url", returnUrl);
    const session = await this.post("/v1/billing_portal/sessions", form);
    if (typeof session.url !== "string" || !/^https:\/\//.test(session.url)) {
      throw new StripeError("portal session came back without a url", { code: "no_url" });
    }
    return { id: String(session.id ?? ""), url: session.url };
  }

  /** The subscription as it stands, for the events whose body is not one. */
  async getSubscription(id) {
    return this.get(`/v1/subscriptions/${encodeURIComponent(id)}`);
  }

  /** A price, for the offer row. Prices live at Stripe; the app never has one. */
  async getPrice(id) {
    return this.get(`/v1/prices/${encodeURIComponent(id)}`);
  }

  async post(path, form, idempotencyKey = null) {
    return this.request("POST", path, {
      body: form.toString(),
      contentType: "application/x-www-form-urlencoded",
      idempotencyKey,
    });
  }

  async get(path) {
    return this.request("GET", path);
  }

  async request(method, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        Authorization: `Bearer ${this.secretKey}`,
        Accept: "application/json",
      };
      if (options.contentType) headers["Content-Type"] = options.contentType;
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
      const response = await this.fetch(`${this.apiBase}${path}`, {
        method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        // Stripe's own message, never the request, and never the key.
        const message =
          parsed?.error?.message ?? `stripe answered ${response.status} for ${path}`;
        throw new StripeError(message, {
          status: response.status,
          code: parsed?.error?.code ?? parsed?.error?.type ?? "http",
        });
      }
      if (parsed === null) throw new StripeError(`stripe answered ${path} with no body`);
      return parsed;
    } catch (cause) {
      if (cause instanceof StripeError) throw cause;
      throw new StripeError(`${method} ${path} failed: ${String(cause)}`, { code: "network" });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The suite's Stripe: a customer, a session, and subscriptions keyed by id.
 *
 * `subscriptions` can be set directly, which is how a test says "this customer's
 * subscription is past due with a period that ended yesterday" without inventing
 * an HTTP response for it.
 */
export class FakeStripe {
  constructor({ subscriptions = {}, prices = {}, fail = null } = {}) {
    this.subscriptions = subscriptions;
    this.prices = prices;
    /** A message to throw instead of answering. Null answers normally. */
    this.fail = fail;
    this.customers = [];
    this.sessions = [];
    this.portals = [];
    this.priceCalls = 0;
    this.customerCounter = 0;
  }

  async createCustomer({ userId, email = null }) {
    this.refuse();
    this.customerCounter += 1;
    const id = `cus_test_${this.customerCounter}`;
    this.customers.push({ id, userId, email });
    return id;
  }

  async createCheckoutSession(params) {
    this.refuse();
    const id = `cs_test_${this.sessions.length + 1}`;
    this.sessions.push({ id, ...params });
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }

  async getSubscription(id) {
    this.refuse();
    const subscription = this.subscriptions[id];
    if (subscription === undefined) throw new StripeError(`no subscription ${id}`, { status: 404 });
    return subscription;
  }

  /** Stripe's own portal page, so a reader can cancel where the card is. */
  async createBillingPortalSession(params) {
    this.refuse();
    const id = `bps_test_${this.portals.length + 1}`;
    this.portals.push({ id, ...params });
    return { id, url: `https://billing.stripe.com/p/session/${id}` };
  }

  async getPrice(id) {
    this.refuse();
    this.priceCalls += 1;
    const price = this.prices[id];
    if (price === undefined) throw new StripeError(`no price ${id}`, { status: 404 });
    return price;
  }

  refuse() {
    if (this.fail !== null) throw new StripeError(this.fail, { code: "test" });
  }
}
