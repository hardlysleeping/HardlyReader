/**
 * The one paid feature: HardlyReader Sync.
 *
 * Syncing a local library between devices is sold as a single subscription —
 * $0.99 a month or $9.99 a year, the same subscription group — and it unlocks
 * every cloud provider at once. There is **one** capability in here,
 * `cloudSync`, and it is the only thing anything is allowed to check. No
 * `hasICloudPurchase`, no `hasDrivePurchase`, no per-provider flag: the moment a
 * second flag exists, the two prices start unlocking different halves of the
 * feature, and the person who paid for "sync" has to read a marketing page to
 * find out which half they bought.
 *
 * Free forever, and deliberately not mentioned by this file:
 *
 * - `ReaderBackend` and everything behind it — GReader, FreshRSS, Miniflux,
 *   tt-rss, the local library, reading, search, extraction.
 *
 * `docs/authority.md` is the rule behind that: a profile has one authority. A
 * FreshRSS profile keeps FreshRSS and its extensions, is free, and never asks
 * this file anything; a local profile is authoritative locally, and the paid
 * provider only mirrors it. `cloudSync` gates the provider, never a reader.
 *
 * An entitlement is a *capability*, not a session. `cloudSync === false` means
 * one thing — no new sync writes — and nothing else:
 *
 * - **nothing local is touched.** No deletion, no read-only reader, no logout,
 *   no "your library is locked" screen. The posts on this device are the
 *   reader's own, and a lapsed card does not make them hostages;
 * - **`src/api/local/sync.ts` never learns about billing.** It moves a document
 *   when it is asked to. The gate lives at the call site, above it, so an
 *   expired subscription stops the asking rather than teaching the sync engine
 *   about money.
 *
 * The seam is `Store`: products, purchase, restore, current. Three
 * implementations — `FakeStore` for the suite, `NativeStore` for a desktop shell
 * that will one day answer, and `RemoteStore`, which is the one that matters:
 * it asks **the server** and nothing else. The entitlement is a row
 * (`supabase/schema.sql`) with a `select`-only policy for its owner and no write
 * policy at all, so a client cannot invent a receipt however hard it tries. A
 * build with no project configured falls back to `NativeStore`, which throws the
 * named `no_store_here` and lands as `cloudSync === false`. A store that is
 * missing must never look like a purchase.
 */

/** The two prices of the same subscription. Both grant the same capability. */
export const SYNC_MONTHLY = "hardlyreader.sync.monthly";
export const SYNC_YEARLY = "hardlyreader.sync.yearly";

/**
 * The capability itself, as a server row reports it.
 *
 * A row in `entitlements` says *that* the reader owns Sync, never which price
 * they paid: `source` is the payment provider's business and `docs/accounts-and-
 * entitlements.md` forbids the app from branching on it. So the answer names the
 * capability rather than a price, and `purchase()` still sells only the two
 * ids above — this constant is a grant, not something for sale.
 */
export const SYNC_CAPABILITY = "hardlyreader.sync";

/** Everything the shop may sell, and nothing else. */
export const SYNC_PRODUCTS: readonly string[] = [SYNC_MONTHLY, SYNC_YEARLY];

/** Whether an id is one of the two this feature sells. */
export function isSyncProduct(id: string | null): boolean {
  return id !== null && SYNC_PRODUCTS.includes(id);
}

/**
 * Whether an id names something that may grant the capability.
 *
 * The two prices, and the capability itself — the last of which a server row
 * reports because a row knows ownership and not price. Deliberately *not* what
 * `purchase()` accepts: a client that asked to buy `hardlyreader.sync` would be
 * asking for a capability without naming a price, and nothing is sold that way.
 */
export function isSyncGrant(id: string | null): boolean {
  return id === SYNC_CAPABILITY || isSyncProduct(id);
}

/** A row the settings panel can draw, in the store's own words. */
export interface Product {
  id: string;
  /** What the store says it costs — already formatted, never reformatted here. */
  price: string;
  period: "month" | "year";
}

/**
 * How a subscription stands, in the four states a store can report.
 *
 * `grace` is the store saying "the payment failed and we are retrying"; it still
 * grants, because the person on the other side has not done anything wrong yet.
 * `expired` is the store saying it is over, and it does not.
 */
export type EntitlementState = "none" | "active" | "grace" | "expired";

/** Where a subscription stands, and why, when there is something to say. */
export interface Entitlement {
  state: EntitlementState;
  /**
   * What granted it: one of the two prices, the capability itself when a server
   * row answered (a row records ownership, not a price), or null when nothing did.
   */
  productId: string | null;
  /** When it lapses, in milliseconds; null when the store does not say. */
  expiresAt: number | null;
  /** A sentence to show instead of silence. Null when there is nothing wrong. */
  reason: string | null;
}

/** What a purchase or a restore hands back. Shaped like an `Entitlement`. */
export type Receipt = Entitlement;

/** The whole surface a shop has to provide. Nothing above this line reads a product id. */
export interface Store {
  products(): Promise<Product[]>;
  purchase(id: string): Promise<Receipt>;
  restore(): Promise<Receipt>;
  current(): Promise<Entitlement>;
}

/** No purchase at all: what a fresh install and a browser tab both answer. */
export function noEntitlement(reason: string | null = null): Entitlement {
  return { state: "none", productId: null, expiresAt: null, reason };
}

/**
 * A receipt or a store's answer, read back as an entitlement this app believes.
 *
 * This is the only place the rules live, so a store cannot grant `cloudSync` by
 * asserting it:
 *
 * - an unknown product id grants nothing, and says why — a receipt for something
 *   else is not a receipt for this; `SYNC_CAPABILITY` is the exception, because it
 *   is this feature rather than something else;
 * - `active` and `grace` grant;
 * - an `active` receipt whose date has already passed is `expired` — a stale
 *   cache is the realistic way a lapsed subscription looks, and believing the
 *   word "active" over the calendar is how a device keeps syncing for a month
 *   after the card stopped working. `grace` is not second-guessed this way: the
 *   date on it is the failed payment's, and the store is telling us it still
 *   counts.
 */
export function readEntitlement(source: Entitlement, now: number = Date.now()): Entitlement {
  const productId = source.productId ?? null;
  const reason = source.reason ?? null;
  if (productId === null) {
    return { state: "none", productId: null, expiresAt: null, reason };
  }
  if (!isSyncGrant(productId)) {
    return {
      state: "none",
      productId,
      expiresAt: null,
      reason: reason ?? `${productId} is not a HardlyReader Sync product`,
    };
  }
  if (source.state === "none" || source.state === "expired") {
    return {
      state: source.state === "expired" ? "expired" : "none",
      productId,
      expiresAt: source.expiresAt ?? null,
      reason: reason ?? (source.state === "expired" ? "the subscription has ended" : null),
    };
  }
  if (source.state === "active" && source.expiresAt !== null && source.expiresAt <= now) {
    return {
      state: "expired",
      productId,
      expiresAt: source.expiresAt,
      reason: reason ?? "the subscription has ended",
    };
  }
  return { state: source.state, productId, expiresAt: source.expiresAt ?? null, reason };
}

/** Whether an entitlement has paid for cloud sync. The whole policy, in one line. */
export function grantsCloudSync(entitlement: Entitlement): boolean {
  return entitlement.state === "active" || entitlement.state === "grace";
}

/**
 * The store a build with no shop behind it gets.
 *
 * It calls the Tauri command each answer would come from and turns the shell's
 * "no such command" into `no_store_here`. It is a stub on purpose: the day the
 * Rust side lands, this class does not change shape, only stops throwing. Until
 * then every path through it is a refusal — never a grant.
 */
export class NoStoreHere extends Error {
  readonly code = "no_store_here";

  constructor(where: string) {
    super(`no_store_here: this build has no ${where} store`);
    this.name = "no_store_here";
  }
}

export function isNoStoreHere(cause: unknown): boolean {
  return cause instanceof Error && (cause as { code?: unknown }).code === "no_store_here";
}

/** The commands a real store will answer. None of them exist yet. */
const NATIVE_COMMANDS = {
  products: "sync_store_products",
  purchase: "sync_store_purchase",
  restore: "sync_store_restore",
  current: "sync_store_current",
} as const;

type NativeCommand = keyof typeof NATIVE_COMMANDS;

export class NativeStore implements Store {
  products(): Promise<Product[]> {
    return this.call<Product[]>("products");
  }

  purchase(id: string): Promise<Receipt> {
    return this.call<Receipt>("purchase", { id });
  }

  restore(): Promise<Receipt> {
    return this.call<Receipt>("restore");
  }

  current(): Promise<Entitlement> {
    return this.call<Entitlement>("current");
  }

  private async call<T>(name: NativeCommand, args?: Record<string, unknown>): Promise<T> {
    if (!isDesktop()) {
      // A browser tab, the PWA, a plain build: there is no shop here and there
      // never will be. Saying so by name is the difference between "not sold
      // here" and "we could not tell whether you paid".
      throw new NoStoreHere(name);
    }
    let invoke: <R>(command: string, args?: Record<string, unknown>) => Promise<R>;
    try {
      ({ invoke } = await import("@tauri-apps/api/core"));
    } catch {
      throw new NoStoreHere(name);
    }
    try {
      return await invoke<T>(NATIVE_COMMANDS[name], args);
    } catch (cause) {
      if (isNoStoreHere(cause)) throw cause;
      const text = String(cause);
      // The shell answers "Command … not found" while the Rust side is still
      // being written; that is a missing store, not a purchase failure. Anything
      // else — a cancellation, a network refusal — travels as itself.
      if (/not found|unknown command|not allowed/i.test(text)) throw new NoStoreHere(name);
      throw cause;
    }
  }
}

function isDesktop(): boolean {
  return typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

/* --------------------------------------------------------------------------
 * The server, which is the only thing that may answer
 * ----------------------------------------------------------------------- */

/**
 * Who this device is signed in as, and the token that proves it.
 *
 * `userId` is the JWT's `sub` — Supabase's `auth.uid()`, the primary key of the
 * one row that decides this. The token is the reader's access token and is sent
 * as the bearer; the app never verifies it, because the server does that, and a
 * client-side "this JWT looks fine" is not evidence of anything.
 */
export interface CloudSession {
  /** `auth.uid()`: whose entitlement is being asked about. */
  userId: string;
  /** The bearer to present. Never logged, never put in a key. */
  token: string;
  /** When the token stops being presentable, in milliseconds; null when unknown. */
  expiresAt?: number | null;
}

/** How a launch finds the session. Null means signed out, which means `none`. */
export type CloudSessionSource = () => CloudSession | null;

/** The network, as this file needs it. Injected so a suite needs no server. */
export type RemoteFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Where the last answer is kept. A `Storage` subset, so a stub can stand in. */
export type EntitlementStorage = Pick<Storage, "getItem" | "setItem">;

/** One key per reader, so two accounts on one device never read each other's answer. */
export const ENTITLEMENT_CACHE_PREFIX = "hardlyreader.entitlement.v1";

/** How long one read may take before it counts as not having been answered. */
const REMOTE_TIMEOUT_MS = 5000;

/**
 * The row, read back as an entitlement.
 *
 * The table is the whole backend: `cloud_sync` and `expires_at`, and nothing
 * else. Three things this deliberately does *not* do:
 *
 * - **it never reads `source`.** Stripe, Apple, Google and a manual grant all end
 *   as the same boolean, and rule 4 of `docs/accounts-and-entitlements.md` says no
 *   code may branch on where the money came from. The query does not even ask for
 *   the column, so it cannot leak into a decision by accident.
 * - **it never reads a price.** A row records ownership, so the answer names
 *   `SYNC_CAPABILITY`; inventing "monthly" from a boolean would put a price in an
 *   answer that does not have one.
 * - **it never treats a missing or malformed row as a grant.** No row is a reader
 *   who has never owned Sync: `none`.
 *
 * `cloud_sync === false` with a date on it is a subscription that has ended — the
 * webhook sets the boolean false when it stops paying, and the date says when it
 * did. With no date there is nothing to have ended, so it is `none`.
 */
export function entitlementFromRow(row: unknown, now: number = Date.now()): Entitlement {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return noEntitlement();
  }
  const fields = row as { cloud_sync?: unknown; expires_at?: unknown };
  const expiresAt = moment(fields.expires_at);
  if (fields.cloud_sync !== true) {
    if (expiresAt === null) return noEntitlement();
    return {
      state: "expired",
      productId: SYNC_CAPABILITY,
      expiresAt,
      reason: "the subscription has ended",
    };
  }
  return { state: "active", productId: SYNC_CAPABILITY, expiresAt, reason: null };
}

/** A timestamp from the row, in milliseconds. A date Postgres cannot parse is no date. */
function moment(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The claims this file needs out of a JWT, read without believing them. */
function jwtClaims(token: string): { sub: string | null; expiresAt: number | null } {
  const parts = token.split(".");
  if (parts.length !== 3) return { sub: null, expiresAt: null };
  try {
    const payload = JSON.parse(base64Url(parts[1])) as { sub?: unknown; exp?: unknown };
    return {
      sub: typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null,
      expiresAt: typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null,
    };
  } catch {
    return { sub: null, expiresAt: null };
  }
}

/** Base64url to text, without an import: `atob` is in every webview and in Node. */
function base64Url(part: string): string {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/** The shape `supabase-js` leaves in storage. Only two fields are read. */
interface StoredCloudAuth {
  access_token?: unknown;
  expires_at?: unknown;
  user?: { id?: unknown };
}

/**
 * The session this device has stored, read the way `supabase-js` wrote it.
 *
 * `supabase-js` keeps its session under `sb-<project-ref>-auth-token`, as JSON
 * with `access_token` and the expiry. That is the one source: a second store of
 * our own would be a second answer to "who is this", and the two would drift.
 *
 * Nothing here is trusted to prove anything — a session restored from a
 * `localStorage` blob is a claim, and the row it can read is what RLS allows that
 * claim to see. A token with no `sub` names nobody, so it is no session at all.
 */
export function storedCloudSession(
  storage: EntitlementStorage | null = deviceStorage(),
  projectUrl: string = envValue("PUBLIC_SUPABASE_URL"),
): CloudSession | null {
  if (storage === null) return null;
  const ref = projectRef(projectUrl);
  if (ref === "") return null;
  const raw = storage.getItem(`sb-${ref}-auth-token`);
  if (raw === null) return null;
  let stored: StoredCloudAuth;
  try {
    stored = JSON.parse(raw) as StoredCloudAuth;
  } catch {
    return null;
  }
  if (stored === null || typeof stored !== "object") return null;
  const token = typeof stored.access_token === "string" ? stored.access_token : "";
  if (token === "") return null;
  const claims = jwtClaims(token);
  const userId = claims.sub ?? (typeof stored.user?.id === "string" ? stored.user.id : "");
  if (userId === "") return null;
  const expiresAt =
    claims.expiresAt ??
    (typeof stored.expires_at === "number" && Number.isFinite(stored.expires_at) ? stored.expires_at * 1000 : null);
  return { userId, token, expiresAt };
}

/** The project ref in a Supabase URL: the first label of the host. */
function projectRef(projectUrl: string): string {
  const match = /^https?:\/\/([^.^/]+)\./i.exec(projectUrl.trim());
  return match === null ? "" : match[1];
}

/** A build-time public value, or "" in a runtime that has no `import.meta.env`. */
function envValue(name: string): string {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
    const value = env?.[name];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** `localStorage` when this runtime has one. A webview always does; a suite may not. */
function deviceStorage(): EntitlementStorage | null {
  try {
    if (typeof localStorage !== "undefined" && localStorage !== null) return localStorage;
  } catch {
    /* a runtime that has one but refuses it */
  }
  return null;
}

/** What one read of the table came back with. */
type RemoteRead =
  | { ok: true; rows: unknown[] }
  | { ok: false; reason: string; cached: boolean };

export interface RemoteStoreOptions {
  /** `https://<ref>.supabase.co` — the project the row lives in. */
  url: string;
  /** The publishable anon key. Public by design: RLS is what protects the row. */
  anonKey: string;
  /** How the session is found. Defaults to `storedCloudSession` on this device. */
  session?: CloudSessionSource;
  /**
   * The network. Defaults to `fetch`.
   *
   * Supabase's REST API answers with permissive CORS — that is how `supabase-js`
   * works from any browser — so a plain `fetch` is right here, unlike the reader's
   * own FreshRSS server, which `api/transport` sends through the shell's http
   * plugin because it sends no such headers.
   */
  request?: RemoteFetch;
  /** Where the last answer is kept. Null disables the cache. */
  storage?: EntitlementStorage | null;
  /** The clock, for the suite. */
  now?: () => number;
  /** How long a read may take, in milliseconds. */
  timeoutMs?: number;
}

/**
 * The store that asks the server. There is no other source of truth.
 *
 * One `GET` against `entitlements`, filtered to `auth.uid()`, with the reader's
 * JWT as the bearer. The `user_id=eq.` filter in the query is a convenience, not
 * the protection: the policy in `supabase/schema.sql` is what decides that a
 * reader can see nothing but their own row, and there is **no write policy at
 * all**, so no client can set `cloud_sync` even with a hand-crafted request. This
 * class never issues anything but a `GET`; `tests/unit/entitlement-source.mjs`
 * holds it to that.
 *
 * The four rules it keeps, in the order things go wrong:
 *
 * 1. **Signed out is `none`.** No session means no identity to ask about, and a
 *    cache belonging to whoever used this device last is never read.
 * 2. **A failure is `none`, never `active`.** A 500, a timeout, an answer that is
 *    not a list: the reader is told nothing was proved, and the local library
 *    carries on untouched.
 * 3. **The last answer survives going offline, per reader.** A successful read is
 *    cached under the user id; a reader who launches on a plane with no network
 *    keeps the subscription they had — bounded by `expires_at`, because the cached
 *    answer is put back through `readEntitlement` with the clock of *this* launch.
 *    A lapsed card therefore stops granting at the moment it lapses, offline or
 *    not.
 * 4. **A refused credential is not a cached grant.** 401/403 means the server
 *    would not accept this session: that is `none`, and the cache is left alone
 *    rather than consulted — a token the server has disowned is not the reader
 *    proving who they are. A token that has merely passed its own expiry, with no
 *    network to refresh it, is the *offline* case, not the refused one, so it may
 *    read the cache.
 */
export class RemoteStore implements Store {
  private readonly url: string;
  private readonly anonKey: string;
  private readonly session: CloudSessionSource;
  private readonly request: RemoteFetch;
  private readonly storage: EntitlementStorage | null;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: RemoteStoreOptions) {
    this.url = options.url.trim().replace(/\/+$/, "");
    this.anonKey = options.anonKey.trim();
    this.storage = options.storage === undefined ? deviceStorage() : options.storage;
    this.session = options.session ?? (() => storedCloudSession(this.storage, this.url));
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? REMOTE_TIMEOUT_MS;
  }

  /**
   * Nothing is for sale through this seam.
   *
   * The two prices are bought in a web checkout with the reader's user id in the
   * reference; the app cannot charge a card and the server will not take a write.
   * An empty offer is the truth, and the panel draws its own prices above it.
   */
  async products(): Promise<Product[]> {
    return [];
  }

  /** There is no in-app purchase: a press is answered with a sentence, not a charge. */
  async purchase(id: string): Promise<Receipt> {
    void id;
    return noEntitlement("HardlyReader Sync is bought on the web — this app cannot charge a card");
  }

  /**
   * Restore means the same thing here as launch does: ask the server again.
   *
   * A reader who paid on another device has the row already; there is no receipt
   * to hand back and nothing to unlock locally.
   */
  async restore(): Promise<Receipt> {
    return this.current();
  }

  /**
   * The same answer as `current()`, under the name `WebStore` asks for.
   *
   * `api/billing.ts` composes a `Store` out of Checkout for buying and a server
   * reader for the row (`ServerEntitlement`). This class is that reader, and the
   * alias is here so the composition is a wiring line rather than a second adapter
   * that could drift from this one.
   */
  read(): Promise<Entitlement> {
    return this.current();
  }

  async current(): Promise<Entitlement> {
    const now = this.now();
    let session: CloudSession | null;
    try {
      session = this.session();
    } catch {
      session = null;
    }
    if (session === null || session.userId.trim() === "") {
      // Signed out: no identity, so no answer and no cache. Rule 1.
      return noEntitlement("this device is not signed in to HardlyReader Sync");
    }
    const userId = session.userId.trim();

    if (typeof session.expiresAt === "number" && session.expiresAt <= now) {
      // The token has run out here, where there is no network to refresh it. That
      // is the offline launch, not a refused credential: the last answer stands.
      return (
        this.cached(userId, now) ??
        noEntitlement("the session has expired — connect to check the subscription")
      );
    }

    const read = await this.fetchRow(userId, session.token);
    if (!read.ok) {
      // Rule 2 first, rule 3 second: a transient failure may be answered by the
      // cache, and everything else is a plain no.
      return read.cached
        ? (this.cached(userId, now) ?? noEntitlement(`could not check the subscription: ${read.reason}`))
        : noEntitlement(read.reason);
    }

    // A row, or none: either way the server has now answered, so this is the
    // answer to remember.
    const raw = entitlementFromRow(read.rows[0] ?? null, now);
    this.remember(userId, raw);
    return readEntitlement(raw, now);
  }

  /** One `GET`, and the three ways it can come back. */
  private async fetchRow(userId: string, token: string): Promise<RemoteRead> {
    const query = `select=cloud_sync,expires_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), this.timeoutMs);
    try {
      const response = await this.request(`${this.url}/rest/v1/entitlements?${query}`, {
        method: "GET",
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: stop.signal,
      });
      if (response.status === 401 || response.status === 403) {
        // The server disowned this credential. Rule 4: no cached grant.
        return { ok: false, reason: "the server would not accept this session", cached: false };
      }
      if (!response.ok) {
        // 5xx and 429 are "ask again later", which is what the cache is for; a 404
        // means the project or the table is not there, which is not.
        return {
          ok: false,
          reason: `the server answered ${response.status}`,
          cached: response.status >= 500 || response.status === 429 || response.status === 408,
        };
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        return { ok: false, reason: "the answer was not a list of entitlements", cached: false };
      }
      return { ok: true, rows: body };
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "AbortError";
      return {
        ok: false,
        reason: timedOut ? `the server did not answer within ${this.timeoutMs}ms` : failure(cause),
        cached: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The last answer for this reader, put back through the calendar. */
  private cached(userId: string, now: number): Entitlement | null {
    if (this.storage === null) return null;
    const raw = this.storage.getItem(`${ENTITLEMENT_CACHE_PREFIX}.${userId}`);
    if (raw === null) return null;
    try {
      const saved = JSON.parse(raw) as {
        userId?: unknown;
        state?: unknown;
        productId?: unknown;
        expiresAt?: unknown;
      };
      // The key says whose answer this is; the value says it again. Both, always:
      // one renamed or copied key must not hand one reader another's subscription.
      if (saved.userId !== userId) return null;
      if (saved.state !== "active" && saved.state !== "grace" && saved.state !== "expired" && saved.state !== "none") {
        return null;
      }
      return readEntitlement(
        {
          state: saved.state,
          productId: typeof saved.productId === "string" ? saved.productId : null,
          expiresAt: typeof saved.expiresAt === "number" ? saved.expiresAt : null,
          reason: null,
        },
        now,
      );
    } catch {
      return null;
    }
  }

  /** Remembers one answer for one reader. A cache that cannot be written is not an error. */
  private remember(userId: string, entitlement: Entitlement): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(
        `${ENTITLEMENT_CACHE_PREFIX}.${userId}`,
        JSON.stringify({
          userId,
          state: entitlement.state,
          productId: entitlement.productId,
          expiresAt: entitlement.expiresAt,
        }),
      );
    } catch {
      /* a full or refusing storage leaves the app working, just not offline */
    }
  }
}

/**
 * The store this build gets: the server when a project is configured, and the
 * shell's stub otherwise.
 *
 * `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` are public values (see
 * `docs/supabase-setup.md`); a build without them has no project to ask, which is
 * `no_store_here` and not an unproved subscription.
 */
export function entitlementStore(): Store {
  const url = envValue("PUBLIC_SUPABASE_URL");
  const anonKey = envValue("PUBLIC_SUPABASE_ANON_KEY");
  if (url !== "" && anonKey !== "") return new RemoteStore({ url, anonKey });
  return new NativeStore();
}

/**
 * The store the suite drives: grant, expire, grace, refuse — on demand.
 *
 * It holds one receipt, because that is what a shop holds. `grant()` is a
 * purchase that already happened, `expire()` and `grace()` move the same
 * subscription to where a store would eventually put it, and `fail` makes the
 * next answer a throw so "the store did not answer" can be tested without a
 * network.
 */
export class FakeStore implements Store {
  /** How many times `current()` was asked. Proves a refresh happened. */
  asked = 0;
  /** The ids `purchase()` was asked for, in order. */
  purchases: string[] = [];
  /** How many times `restore()` was asked. */
  restores = 0;
  /** An error to throw instead of answering. Null answers normally. */
  fail: string | null = null;

  private receipt: Receipt | null;

  constructor(receipt: Receipt | null = null) {
    this.receipt = receipt;
  }

  async products(): Promise<Product[]> {
    this.refuse();
    return [
      { id: SYNC_MONTHLY, price: "$0.99", period: "month" },
      { id: SYNC_YEARLY, price: "$9.99", period: "year" },
    ];
  }

  async purchase(id: string): Promise<Receipt> {
    this.refuse();
    this.purchases.push(id);
    this.receipt = { state: "active", productId: id, expiresAt: null, reason: null };
    return this.receipt;
  }

  async restore(): Promise<Receipt> {
    this.refuse();
    this.restores += 1;
    return this.receipt ?? noEntitlement();
  }

  async current(): Promise<Entitlement> {
    this.refuse();
    this.asked += 1;
    return this.receipt ?? noEntitlement();
  }

  /** A subscription that is paid up, optionally until a given moment. */
  grant(id: string = SYNC_MONTHLY, expiresAt: number | null = null): void {
    this.receipt = { state: "active", productId: id, expiresAt, reason: null };
  }

  /** A subscription the store says is over. */
  expire(id: string = SYNC_MONTHLY, expiresAt: number | null = null): void {
    this.receipt = {
      state: "expired",
      productId: id,
      expiresAt,
      reason: "the subscription has ended",
    };
  }

  /** A payment that failed and is being retried: still theirs. */
  grace(id: string = SYNC_MONTHLY, expiresAt: number | null = null): void {
    this.receipt = { state: "grace", productId: id, expiresAt, reason: null };
  }

  /** A receipt for something this app does not sell. */
  unknownReceipt(id: string = "someone.else.thing"): void {
    this.receipt = { state: "active", productId: id, expiresAt: null, reason: null };
  }

  private refuse(): void {
    if (this.fail !== null) throw new Error(this.fail);
  }
}

/**
 * The capability, as the app holds it.
 *
 * Read `cloudSync` and nothing else. `state` and `reason` are for the one screen
 * that explains the subscription; `offer` is what the store says it sells. None
 * of them is a second gate.
 */
export class Entitlements {
  /** The only capability anything checks. */
  cloudSync = $state(false);

  /** Where the subscription stands — for wording, never for gating. */
  state = $state<EntitlementState>("none");

  /** Why there is no cloud sync, when a person would want to know. */
  reason = $state<string | null>(null);

  /** Whether this build has a store at all: false in a browser, and until the shell answers. */
  available = $state(false);

  /** What the store sells, once `loadProducts()` has asked. */
  offer = $state<Product[]>([]);

  /** A purchase or a refresh in flight. */
  busy = $state(false);

  private store: Store;

  constructor(store: Store = entitlementStore()) {
    this.store = store;
  }

  /** Points the capability at another store. The suite's door; the app has one. */
  use(store: Store): void {
    this.store = store;
  }

  /**
   * Asks the store where the subscription stands, and believes only its answer.
   *
   * Never throws: a launch hook and a visibility listener both call this, and a
   * store that is missing, offline or confused must leave the app running with
   * cloud sync off — which is exactly what a store that could not be asked has
   * proven.
   */
  async refresh(): Promise<void> {
    this.busy = true;
    try {
      this.adopt(readEntitlement(await this.store.current()));
      this.available = true;
    } catch (cause) {
      // False, never true: an unanswered question is not a purchase.
      this.adopt(noEntitlement());
      this.available = !isNoStoreHere(cause);
      this.reason = this.available ? failure(cause) : null;
    } finally {
      this.busy = false;
    }
  }

  /** What can be bought here, for the row that offers it. */
  async loadProducts(): Promise<void> {
    try {
      this.offer = await this.store.products();
      this.available = true;
    } catch (cause) {
      this.offer = [];
      this.available = !isNoStoreHere(cause);
      this.reason = this.available ? failure(cause) : null;
    }
  }

  /** Buys one of the two prices. An id this app does not sell is refused before the store hears about it. */
  async purchase(id: string): Promise<boolean> {
    if (!isSyncProduct(id)) {
      // Refused without touching what is already granted: a caller naming the
      // wrong id is a bug, not a reason to drop someone's subscription.
      this.reason = `${id} is not a HardlyReader Sync product`;
      return false;
    }
    return this.ask(() => this.store.purchase(id));
  }

  /** Asks the store to hand back a purchase made on another device or before a reinstall. */
  async restore(): Promise<boolean> {
    return this.ask(() => this.store.restore());
  }

  /**
   * Checks at launch and whenever the window comes back.
   *
   * A lapsed subscription is discovered on the first look after it lapses, not
   * on the next restart: a window left open for a week is the normal case on a
   * desktop, and the store's answer can change underneath it. Returns the
   * teardown, so the component that installed the listener removes it.
   */
  watch(): () => void {
    void this.refresh();
    if (typeof document === "undefined") return () => {};
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void this.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }

  private async ask(receipt: () => Promise<Receipt>): Promise<boolean> {
    this.busy = true;
    try {
      this.adopt(readEntitlement(await receipt()));
      this.available = true;
      return this.cloudSync;
    } catch (cause) {
      this.adopt(noEntitlement());
      this.available = !isNoStoreHere(cause);
      this.reason = this.available ? failure(cause) : null;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** The one place `cloudSync` is written. */
  private adopt(entitlement: Entitlement): void {
    this.state = entitlement.state;
    this.cloudSync = grantsCloudSync(entitlement);
    this.reason = entitlement.reason;
  }
}

/** An error, said in one line, for the row that shows it. */
function failure(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.trim() === "" ? "the store did not answer" : text;
}

/** The app's one entitlement. */
export const entitlement = new Entitlements();
