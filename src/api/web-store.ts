/**
 * Installing the web store: the one place Checkout and the entitlement meet.
 *
 * `api/billing.ts` composes a `Store` out of Checkout for buying and a server
 * reader for the row. `state/entitlements.svelte.ts` holds the capability and is
 * held to "imports nothing from the app" — and the import would be circular,
 * since `billing.ts` reads `SYNC_MONTHLY`, `SYNC_YEARLY` and `noEntitlement` from
 * it. So neither can perform the composition; this module, which may import
 * both, does it, and `src/main.ts` calls it once before anything mounts.
 *
 * Three rules, and each of them is a purchase that would otherwise be wrong:
 *
 * 1. **Only when this build can sell and can read.** No billing URL, or no
 *    server to read the row from, and the capability keeps the store it already
 *    had (`NativeStore` / `RemoteStore`) exactly as it was. A store that can take
 *    a payment but cannot say whether it landed is worse than one that cannot
 *    take a payment.
 * 2. **One token source.** The purchase's bearer and the read's bearer are both
 *    Supabase's stored session (`storedCloudSession`, `sb-<ref>-auth-token`) —
 *    the same call `RemoteStore` makes for itself. A token from anywhere else
 *    would let the charge and the read disagree about who the reader is.
 * 3. **One refresh on the way back.** A page loaded with `?checkout=` refreshes
 *    the entitlement once, so coming back from Checkout turns sync on without a
 *    reload. No listener, no timer, no second hook: the launch refresh that
 *    `entitlement.watch()` already performs is untouched.
 */
import {
  WebStore,
  billingUrl,
  checkoutReturned,
  type CheckoutReturn,
  type ServerEntitlement,
} from "./billing";
import {
  entitlement as appEntitlement,
  entitlementStore,
  storedCloudSession,
  type Entitlements,
  type Store,
} from "../state/entitlements.svelte";

export interface InstallWebStoreOptions {
  /** The capability to install into. Defaults to the app's one. */
  entitlement?: Entitlements;
  /** The billing service. Defaults to what this build was configured with. */
  base?: string;
  /** The page's query string. Defaults to `location.search`, and to "" off a page. */
  search?: string;
  /** The server the row is read from. Defaults to `entitlementStore()`. */
  reader?: Store | null;
  /** The reader's bearer. Defaults to the stored Supabase session. */
  token?: () => string;
  /** The network and the opener, injected so the suite needs neither. */
  fetch?: typeof fetch;
  open?: (url: string) => Promise<void> | void;
}

/** What the install did, so a caller (and the suite) can see it. */
export interface InstalledWebStore {
  /** The composed store, or null when this build cannot buy. */
  store: WebStore | null;
  /** What `?checkout=` said, when this page is a return from Checkout. */
  checkout: CheckoutReturn | null;
  /** The one refresh a return asks for. Null on an ordinary launch. */
  refreshed: Promise<void> | null;
}

/**
 * One install per capability.
 *
 * The app has one `Entitlements`, and reinstalling it (a second import, a dev
 * reload) must not compose a second store or refresh a second time. Keyed by the
 * capability rather than a module flag so a suite can install into its own.
 */
const installed = new WeakMap<Entitlements, InstalledWebStore>();

/**
 * Composes the web store and points the capability at it, once.
 *
 * Never throws: a build with no configuration, or with no server to read from,
 * simply does nothing and says so in the answer.
 */
export function installWebStore(options: InstallWebStoreOptions = {}): InstalledWebStore {
  const capability = options.entitlement ?? appEntitlement;
  const done = installed.get(capability);
  if (done !== undefined) return done;

  const base = (options.base ?? billingUrl()).trim();
  const reader = options.reader === undefined ? entitlementStore() : options.reader;
  const server = readable(reader) ? reader : null;

  const result: InstalledWebStore = { store: null, checkout: null, refreshed: null };
  installed.set(capability, result);

  // Rule 1. Nothing to sell with, or nothing to read with: the store the
  // capability already has stays exactly as it is.
  if (base === "" || server === null) return result;

  const store = new WebStore({
    base,
    // Rule 2: the same source `RemoteStore` reads, so both halves name one reader.
    token: options.token ?? (() => storedCloudSession()?.token ?? ""),
    server,
    fetch: options.fetch,
    open: options.open,
  });
  capability.use(store);
  result.store = store;

  // Rule 3: notice the return, ask once. The webhook may not have landed yet —
  // then the answer is simply "not yet", and the next launch asks again.
  const checkout = checkoutReturned(options.search ?? currentSearch());
  result.checkout = checkout;
  if (checkout !== null) result.refreshed = capability.refresh();
  return result;
}

/** Whether a store can answer `read()` — the server reader `WebStore` delegates to. */
function readable(store: Store | null): store is Store & ServerEntitlement {
  return store !== null && typeof (store as { read?: unknown }).read === "function";
}

/** The page's query string, or "" in a runtime with no page. */
function currentSearch(): string {
  try {
    return typeof location === "undefined" ? "" : location.search;
  } catch {
    return "";
  }
}
