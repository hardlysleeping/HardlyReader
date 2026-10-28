/**
 * Which layer owns a feature, decided per feature rather than per app.
 *
 * The old shape was one switch: "FreshRSS profile" or "paid cloud", as if every feature wanted the
 * same answer. It does not. The Old Reader will happily keep feeds, folders, read marks and stars,
 * and has nowhere to put a hidden category, a pinned category, a custom feed order, the sidebar
 * indent or a reading position. FreshRSS with the extensions has somewhere to put all of them.
 * A local library owns everything and mirrors it through a provider if the reader pays.
 *
 * So the question is never "which profile am I in" but **"does this backend support this feature, and
 * if not, is there a paid sync to carry it, and if not, does it stay on this device"**:
 *
 *     backend supports it  → the backend is authoritative
 *     not supported + paid → the cloud snapshot is authoritative for that feature
 *     not supported, free  → the feature stays local to this device
 *
 * That is why `docs/authority.md` calls these HardlyReader features with two adapters rather than
 * FreshRSS features: the feature is ours, the adapter is whatever can store it. Nothing here is
 * provider-specific, and a future service that supports some of the extras simply reports more
 * `true`s and gets them for free.
 */

/** The features whose authority can differ. Names are nouns, not UI labels. */
export type Feature =
  | "subscriptions"
  | "readState"
  | "starred"
  | "categories"
  | "categoryOrder"
  | "feedOrder"
  | "hiddenCategories"
  | "pinnedCategories"
  | "preferences"
  | "readingPosition";

export type Capabilities = Record<Feature, boolean>;

/** Where the truth for one feature lives. */
export type Authority = "backend" | "cloud" | "local";

const ALL: Feature[] = [
  "subscriptions",
  "readState",
  "starred",
  "categories",
  "categoryOrder",
  "feedOrder",
  "hiddenCategories",
  "pinnedCategories",
  "preferences",
  "readingPosition",
];

/** The four things every GReader-speaking service can do. Nothing extended. */
export const GREADER_CAPABILITIES: Capabilities = {
  subscriptions: true,
  readState: true,
  starred: true,
  categories: true,
  categoryOrder: false,
  feedOrder: false,
  hiddenCategories: false,
  pinnedCategories: false,
  preferences: false,
  readingPosition: false,
};

/**
 * FreshRSS *with* the Hardly Read extensions.
 *
 * Everything extended is supported, which is exactly why a FreshRSS reader never needs a
 * subscription: their server can already carry all of it.
 */
export const FRESHRSS_EXTENSION_CAPABILITIES: Capabilities = {
  ...GREADER_CAPABILITIES,
  categoryOrder: true,
  feedOrder: true,
  hiddenCategories: true,
  pinnedCategories: true,
  preferences: true,
  readingPosition: true,
};

/**
 * A library on this device.
 *
 * Everything is `true` because the backend *is* the local database: it owns every feature, and a
 * paid provider mirrors that database rather than replacing its authority.
 */
export const LOCAL_CAPABILITIES: Capabilities = {
  subscriptions: true,
  readState: true,
  starred: true,
  categories: true,
  categoryOrder: true,
  feedOrder: true,
  hiddenCategories: true,
  pinnedCategories: true,
  preferences: true,
  readingPosition: true,
};

/** Fills what a backend did not declare with the GReader baseline, so a partial map is safe. */
export function withDefaults(declared: Partial<Capabilities> | undefined): Capabilities {
  return { ...GREADER_CAPABILITIES, ...(declared ?? {}) };
}

/** Every feature, in a stable order — for a settings readout or a test's benefit. */
export function features(): Feature[] {
  return [...ALL];
}

/**
 * The one decision the rest of the app should ask.
 *
 * `paid` is passed in rather than imported: this module is pure, so a test can walk every
 * combination without an entitlement, a store or a network.
 */
export function resolveAuthority(
  feature: Feature,
  input: { capabilities: Partial<Capabilities>; paid: boolean },
): Authority {
  if (withDefaults(input.capabilities)[feature]) return "backend";
  return input.paid ? "cloud" : "local";
}

/** Resolve several at once, for a screen that shows the whole answer. */
export function resolveAll(input: {
  capabilities: Partial<Capabilities>;
  paid: boolean;
}): Record<Feature, Authority> {
  const out = {} as Record<Feature, Authority>;
  for (const feature of ALL) out[feature] = resolveAuthority(feature, input);
  return out;
}

/**
 * One line for the UI: what the paid tier actually adds for *this* backend.
 *
 * A FreshRSS-with-extensions reader has nothing to gain, and saying so is the honest answer rather
 * than showing them an upgrade for something their server already does. A local reader gains
 * cross-device mirroring of a library they already own. An Old Reader reader gains the extras.
 */
export function upgradePitch(input: {
  capabilities: Partial<Capabilities>;
  paid: boolean;
  /** Whether a server sits behind this backend at all. */
  server: boolean;
}): "nothing" | "mirror" | "extras" {
  // A library on this device owns everything already and still has only one device's copy of it,
  // so what the paid tier adds is the mirror — not another authority, and not a missing feature.
  if (!input.server) return "mirror";
  const caps = withDefaults(input.capabilities);
  const missing = ALL.filter((feature) => !caps[feature]);
  // A server that carries every extended feature needs nothing bought for it.
  if (missing.length === 0) return "nothing";
  return "extras";
}
