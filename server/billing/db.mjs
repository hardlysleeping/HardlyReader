/**
 * The three things the billing service asks Postgres, and the two ways it asks.
 *
 * There is one rule underneath all of it: the webhook never decides which reader
 * an event belongs to. `applyEvent` hands the *customer* to the database, and the
 * database looks up the reader that checkout creation linked there. A body that
 * names a user id is a body that could name any user id, so no code path in this
 * service reads one.
 *
 * Two implementations, one contract:
 *
 * - `SupabaseDb` talks to a Supabase project over PostgREST with the
 *   `service_role` key — the deployed shape, and the only one that ever holds a
 *   secret;
 * - `PsqlDb` runs the *same* SQL (`apply_stripe_event`, the same tables) through
 *   `psql` in a throwaway container, so the suite exercises the real function
 *   rather than a JavaScript impression of it.
 *
 * Both are wrapped around `supabase/schema.sql`, which owns the semantics:
 * spending the event id, refusing an unknown customer, refusing a late delivery.
 * Neither class below re-implements those decisions — they would drift.
 */

/** What one applied event turned into, as `apply_stripe_event` reports it. */
export const OUTCOMES = [
  /** The row was written. */
  "applied",
  /** This event id was already applied; nothing changed. */
  "duplicate",
  /** Delivered late: a newer event already decided, so this one lost. */
  "stale",
  /** No reader is linked to this customer. Never guessed. */
  "unknown_customer",
  /** Another shop owns a live row and this event would have revoked it. */
  "kept_other_source",
];

/** An error from the database, with a code short enough to log and to branch on. */
export class BillingDbError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "BillingDbError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * The deployed transport: Supabase's REST API, service key, no SDK.
 *
 * `fetch` is injected because the suite has no network and because a dependency
 * on a global that may not exist is a failure that only shows up in production.
 */
export class SupabaseDb {
  constructor({ url, serviceKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
    if (!url) throw new BillingDbError("config", "SUPABASE_URL is not set");
    if (!serviceKey) throw new BillingDbError("config", "SUPABASE_SERVICE_KEY is not set");
    if (typeof fetchImpl !== "function") throw new BillingDbError("config", "no fetch available");
    this.url = url.replace(/\/$/, "");
    this.serviceKey = serviceKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** The Stripe customer this reader already has, or null. */
  async customerOf(userId) {
    const body = await this.request(
      "GET",
      `/rest/v1/stripe_customers?user_id=eq.${encodeURIComponent(userId)}&select=customer_id`,
    );
    const rows = Array.isArray(body) ? body : [];
    const first = rows[0];
    return typeof first?.customer_id === "string" ? first.customer_id : null;
  }

  /**
   * Links a customer to a reader, once.
   *
   * Called only from checkout creation, with a user id that came from a verified
   * JWT. The upsert is on `user_id`, so buying a second time reuses the same
   * customer instead of creating a second identity at Stripe.
   */
  async linkCustomer(userId, customerId) {
    await this.request("POST", "/rest/v1/stripe_customers", {
      body: [{ user_id: userId, customer_id: customerId }],
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });
  }

  /** One event, one transaction. See `apply_stripe_event` in the schema. */
  async applyEvent({ eventId, type, created, customerId, cloudSync, expiresAtMs }) {
    const body = await this.request("POST", "/rest/v1/rpc/apply_stripe_event", {
      body: {
        p_event_id: eventId,
        p_event_type: type,
        p_event_created: created,
        p_customer: customerId,
        p_cloud_sync: cloudSync,
        p_expires_at: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      },
    });
    // PostgREST returns a scalar function's result as a JSON string.
    const outcome = typeof body === "string" ? body : String(body ?? "");
    if (!OUTCOMES.includes(outcome)) {
      throw new BillingDbError("unexpected_result", `apply_stripe_event said "${outcome}"`);
    }
    return outcome;
  }

  async request(method, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.url}${path}`, {
        method,
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(options.headers ?? {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new BillingDbError(
          "http",
          `${method} ${path} → ${response.status}: ${text.slice(0, 300)}`,
        );
      }
      if (text === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (cause) {
      if (cause instanceof BillingDbError) throw cause;
      throw new BillingDbError("network", `${method} ${path} failed: ${String(cause)}`, cause);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The suite's transport: the same SQL, through `psql` in a container.
 *
 * It exists so the tests can be about the *schema* — the unique index on the
 * event id, the `for update` on the customer row, the `greatest()` watermark —
 * rather than about a mock that agrees with whatever the test asserts. A
 * `docker` binary and a running Postgres are the only prerequisites; the suite
 * says so and skips rather than failing when they are missing.
 */
export class PsqlDb {
  constructor({ container, user = "postgres", database = "postgres", exec = defaultExec }) {
    this.container = container;
    this.user = user;
    this.database = database;
    this.exec = exec;
  }

  async customerOf(userId) {
    const out = await this.sql(
      `select coalesce(customer_id, '') from public.stripe_customers where user_id = :'user_id'::uuid;`,
      { user_id: userId },
    );
    return out === "" ? null : out;
  }

  async linkCustomer(userId, customerId) {
    await this.sql(
      `insert into public.stripe_customers (user_id, customer_id)
       values (:'user_id'::uuid, :'customer_id')
       on conflict (user_id) do update set customer_id = excluded.customer_id;`,
      { user_id: userId, customer_id: customerId },
    );
  }

  async applyEvent({ eventId, type, created, customerId, cloudSync, expiresAtMs }) {
    const outcome = await this.sql(
      `select public.apply_stripe_event(
         :'event_id', :'event_type', :'created'::bigint, :'customer',
         :'cloud_sync'::boolean, nullif(:'expires_at', '')::timestamptz);`,
      {
        event_id: eventId,
        event_type: type,
        created: String(created),
        customer: customerId,
        cloud_sync: cloudSync ? "true" : "false",
        expires_at: expiresAtMs === null ? "" : new Date(expiresAtMs).toISOString(),
      },
    );
    if (!OUTCOMES.includes(outcome)) {
      throw new BillingDbError("unexpected_result", `apply_stripe_event said "${outcome}"`);
    }
    return outcome;
  }

  /** Runs one statement and returns its single scalar, trimmed. */
  async sql(statement, variables = {}) {
    const args = [
      "exec",
      "-i",
      this.container,
      "psql",
      "-U",
      this.user,
      "-d",
      this.database,
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
    ];
    // psql quotes `:'name'` itself, so a value never becomes SQL.
    for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
    args.push("-f", "-");
    try {
      const output = await this.exec("docker", args, statement);
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join("");
    } catch (cause) {
      throw new BillingDbError("sql", String(cause), cause);
    }
  }
}

/** `docker exec` with SQL on stdin, as a promise. */
function defaultExec(file, args, input) {
  return new Promise((resolve, reject) => {
    // Imported lazily so the module can be loaded in a browser build of the
    // suite that only wants `SupabaseDb`.
    import("node:child_process").then(({ execFile }) => {
      const child = execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout);
      });
      child.stdin?.end(input);
    }, reject);
  });
}
