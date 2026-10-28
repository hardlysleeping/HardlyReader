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
 * The seam is `Store`: products, purchase, restore, current. Two
 * implementations — `FakeStore` for the suite, `NativeStore` for a desktop shell
 * that will one day answer. Until then `NativeStore` throws the named
 * `no_store_here`, which lands as `cloudSync === false`. A store that is missing
 * must never look like a purchase.
 */

/** The two prices of the same subscription. Both grant the same capability. */
export const SYNC_MONTHLY = "hardlyreader.sync.monthly";
export const SYNC_YEARLY = "hardlyreader.sync.yearly";

/** Everything the shop may sell, and nothing else. */
export const SYNC_PRODUCTS: readonly string[] = [SYNC_MONTHLY, SYNC_YEARLY];

/** Whether an id is one of the two this feature sells. */
export function isSyncProduct(id: string | null): boolean {
  return id !== null && SYNC_PRODUCTS.includes(id);
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
  /** The product that granted it, or null when nothing did. */
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
 *   else is not a receipt for this;
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
  if (!isSyncProduct(productId)) {
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

  constructor(store: Store = new NativeStore()) {
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
