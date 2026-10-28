/**
 * Which layer owns a feature, decided per feature rather than per app.
 *
 * The old shape was one switch: "FreshRSS profile" or "paid cloud", as if every feature wanted the
 * does not. The Old Reader will happily keep feeds, folders, read marks and stars,
 * and has nowhere to put a hidden category, a pinned category, a custom feed order or the sidebar
 * indent. FreshRSS with the extensions has somewhere to put all of those — but not where the
 * reader was: no adapter has a route for the place, so it stays on this device on every backend.
 * A local library owns everything and mirrors it through a provider if the reader pays.
 *
 * So the question is never "which profile am I in" but **"does this backend support this feature, and
 * if not, is there a paid sync to carry it, and if not, does it stay on this device"**:
 *
 *     backend supports it  → the backend is authoritative
 *     not supported + paid → the cloud snapshot is authoritative for that feature
 *     not supported, free  → the feature stays local to this device
 *
 * "Backend supports it" is a claim, and a claim can be wrong in two directions: a server
 * can answer `404` for a route it never had, or answer nothing at all because it is
 * restarting. Those are different (`CapabilityState`), and only the first is allowed to
 * move a feature — an unreachable server keeps whatever the last answer said, because
 * handing its features to the cloud for the length of a restart creates a second
 * authority that outlives the restart.
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

/**
 * What one feature's answer is worth, when the answer came from a check rather than
 * from a declaration.
 *
 * Three states, because a FreshRSS extension can be in three of them and only one of
 * the three means "this server cannot":
 *
 * - `supported` — something answered, and the route is there.
 * - `unsupported` — something answered, and the route is *not* there: a `404`, an
 *   extension that is installed but disabled, an adapter older than the route. The
 *   server replied; the reply was no.
 * - `unknown` — nothing answered: a `5xx` while the server restarts, a timeout, an
 *   offline server, a proxy error page. There is no evidence either way, and treating
 *   this as `unsupported` would hand a feature the server owns to the cloud, so when
 *   the server came back there would be two copies of the truth.
 */
export type CapabilityState = "supported" | "unsupported" | "unknown";

/**
 * Per-feature states, as one attempt answered them.
 *
 * Absent means "not asked": a report is what a check covers, never a whole backend. A
 * *declaration* is `ReaderBackend.capabilities` (`src/api/backend.ts`); a report is what
 * a probe measured.
 */
export type CapabilityReport = Partial<Record<Feature, CapabilityState>>;

/**
 * One attempt to measure a backend, and what kind of answer it was.
 *
 * `outcome` is the part the states cannot say: `answer` means the adapter replied (so
 * every state in the report is real), `missing` means the route family is not there at
 * all, and `unreachable` means nothing replied — every state is `unknown` and the last
 * good read still stands.
 */
export interface CapabilityAnswer {
  report: CapabilityReport;
  outcome: "answer" | "missing" | "unreachable";
}


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
 * Everything extended the adapter has a route for is supported, which is exactly why a FreshRSS
 * reader never needs a subscription: their server can already carry it.
 *
 * The reading position is the exception, and it is left inheriting `false` from
 * `GREADER_CAPABILITIES` on purpose. `/v1/positions` carries the arrangement — the category and
 * feed order — and never where the reader was; `/v1/preferences` carries reading, theme and search
 * settings, not a place; and there is no third route. The place itself is `lib/place`, keyed per
 * account in device storage, which is where it has always actually been. A `true` here would be a
 * declaration the adapter cannot honour: the app would believe a server had the place while the
 * only copy of it sat in this browser's storage (`docs/sync-invariants.md` #13/#14).
 *
 * Giving the extension the route is the other way to answer that, and it is a version, not a flag:
 * a place block on `/v1/positions` (or a `/v1/place`) bumps `HardlyReadApi::API_VERSION` and
 * appends a row to `ADAPTER_ROUTES` in the same change. Until then this stays `false`, and
 * `capabilitiesFromState` measures the place `unsupported` at every adapter version.
 */
export const FRESHRSS_EXTENSION_CAPABILITIES: Capabilities = {
  ...GREADER_CAPABILITIES,
  categoryOrder: true,
  feedOrder: true,
  hiddenCategories: true,
  pinnedCategories: true,
  preferences: true,
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

/**
 * The features a GReader service does not have: exactly the ones the extensions add.
 *
 * Derived rather than listed again, so a feature added to `GREADER_CAPABILITIES` later
 * is not silently probed as if a server had it, and one removed from there is probed
 * without anyone remembering to edit a second list.
 *
 * Membership here means "not part of the GReader baseline", not "some adapter carries
 * it": the reading position is in this list and in no `ADAPTER_ROUTES` row, so it is
 * measured — `capabilitiesFromState` answers `unsupported` for it at every version —
 * while no backend can ever be its authority.
 */
const EXTENDED: Feature[] = ALL.filter((feature) => !GREADER_CAPABILITIES[feature]);

/**
 * The adapter's versions, and the extended features each one answers.
 *
 * `apiVersion` on `/v1/state` is the *adapter's own* version — not the preferences
 * document's (`PREFS_API_VERSION`) and not the extension's marketing version in
 * `metadata.json`. Version 1 is the frozen v1 surface: hidden categories, pins, the
 * arrangement and the preferences document. An adapter that
 * reports no version at all reads as version 0 — old enough that none of the extended
 * routes can be assumed — and its features resolve the way they do for any other
 * GReader server, instead of the app calling a route that is not there and learning
 * `404` at the first write.
 *
 * **The reading position is in no row, on purpose.** There is no adapter version that
 * carries a place: `/v1/positions` is the arrangement (category ids, feed ids) and
 * `/v1/preferences` is three namespaces of settings, so a row claiming the place would
 * describe a route that does not exist. The place lives in `lib/place`, on the device,
 * per account — which is what happens on every backend today.
 *
 * Adding a route means bumping `HardlyReadApi::API_VERSION` in the extension and
 * appending a row here in the same change: an older adapter then *reports fewer
 * capabilities* rather than answering `404` later. That is also how the place would
 * become a backend's, if the extension ever gains a place block.
 *
 * The residual, stated rather than hidden: `API_VERSION` was already 1 when the
 * arrangement and preferences routes were added, so a v1 adapter from before those routes
 * cannot be told apart from one that carries them — both say 1. Such a copy over-claims
 * until its first `404`, which the write path already treats as "local only". No number
 * can separate two copies that report the same one; the rule above is what stops the
 * next route from joining them.
 */
const ADAPTER_ROUTES: readonly { since: number; features: readonly Feature[] }[] = [
  {
    since: 1,
    features: ["hiddenCategories", "pinnedCategories", "categoryOrder", "feedOrder", "preferences"],
  },
];

/**
 * Whether any adapter version has a route for one feature.
 *
 * The reading position has none: `/v1/positions` is the arrangement and `/v1/preferences`
 * is settings, so no backend is *meant* to hold where the reader was — the place is one
 * device's cursor, kept in `lib/place`. That is a different thing from a gap between a
 * server and the app, which is what the paid tier fills, so the pitch below does not count
 * it (`upgradePitch`).
 */
export function adapterCarries(feature: Feature): boolean {
  return ADAPTER_ROUTES.some((row) => row.features.includes(feature));
}

/**
 * The extended features an adapter of this version can answer, at most.
 *
 * A ceiling, not an answer: the two block-level extensions report their own
 * `available` flag, and a version that carries a route can still have it switched off
 * for one account. The ceiling exists so a *version* can never be asked for more than
 * it has.
 */
export function adapterCeiling(apiVersion: number): Feature[] {
  const version = Number.isFinite(apiVersion) ? Math.max(0, Math.trunc(apiVersion)) : 0;
  const out: Feature[] = [];
  for (const row of ADAPTER_ROUTES) {
    if (version < row.since) continue;
    for (const feature of row.features) if (!out.includes(feature)) out.push(feature);
  }
  return out;
}

/**
 * What one `/v1/state` answer measures.
 *
 * Two of the six have their own `available` flag (`hiddenCategories`, `favorites`):
 * they are separate extensions, and an account that disabled one gets a state document
 * with that block reporting `false`. That is a definite answer from a live adapter, so
 * it lowers the capability instead of leaving it unknown — and it must, because
 * "supported" here would make the app write to a route that answers `404`. The other
 * five have no flag on the wire; the version is what says the route is there. One of
 * those five — the reading position — is in no version's ceiling at all, so it reads
 * `unsupported` here whatever the adapter reports.
 *
 * A 200 never produces `unknown`: something replied. Unknown is the absence of an
 * answer, and it is decided in `src/api/hardlyread.ts` where the failure arrives.
 */
export function capabilitiesFromState(answer: {
  apiVersion?: number;
  hiddenCategories?: { available?: boolean };
  favorites?: { available?: boolean };
}): CapabilityReport {
  const ceiling = adapterCeiling(answer.apiVersion ?? 0);
  const report: CapabilityReport = {};
  for (const feature of EXTENDED) {
    const available =
      feature === "hiddenCategories"
        ? answer.hiddenCategories?.available === true
        : feature === "pinnedCategories"
          ? answer.favorites?.available === true
          : true;
    report[feature] = ceiling.includes(feature) && available ? "supported" : "unsupported";
  }
  return report;
}

/**
 * Every extended feature answered with one state.
 *
 * For the two answers that are not about a single route: "this server cannot host the
 * adapter at all" is `unsupported`, and "nothing replied" is `unknown`.
 */
export function wholeReport(state: CapabilityState, which: Feature[] = EXTENDED): CapabilityReport {
  const report: CapabilityReport = {};
  for (const feature of which) report[feature] = state;
  return report;
}

/** Fills what a backend did not declare with the GReader baseline, so a partial map is safe. */
export function withDefaults(declared: Partial<Capabilities> | undefined): Capabilities {
  return { ...GREADER_CAPABILITIES, ...(declared ?? {}) };
}

/** Every feature, in a stable order — for a settings readout or a test's benefit. */
export function features(): Feature[] {
  return [...ALL];
}

/**
 * Folds one check into what we believe, and leaves `unknown` alone.
 *
 * This is the mechanism behind "a failed check does not change authority". A `503` is
 * not evidence that the server lost a feature it had ten seconds ago, so the belief it
 * had ten seconds ago is still the belief; a timeout is not a `404`. Only an *answer* —
 * `supported` or `unsupported` — is allowed to move a feature, which is why the fold
 * has no branch for `unknown` and no way to forget a feature either.
 *
 * `believed` is the declaration from `ReaderBackend.capabilities` on the first run and
 * this function's own output from then on, so the caller keeps one map and never has to
 * tell the two apart.
 */
export function remember(
  believed: Partial<Capabilities>,
  answer: CapabilityReport | undefined,
): Partial<Capabilities> {
  const next: Partial<Capabilities> = { ...believed };
  if (answer === undefined) return next;
  for (const feature of ALL) {
    const state = answer[feature];
    if (state === "supported") next[feature] = true;
    else if (state === "unsupported") next[feature] = false;
  }
  return next;
}

/**
 * The input of every decision below.
 *
 * `paid` is passed in rather than imported: this module is pure, so a test can walk
 * every combination without a store or a network — and nothing on a reading path ever
 * asks a billing question. `capabilities` is the
 * **belief** — a declaration, or the last answer that was an answer, folded through
 * `remember` — never a raw report from an attempt that failed.
 */
export interface AuthorityInput {
  capabilities: Partial<Capabilities>;
  paid: boolean;
  /**
   * What a check answered just now, when one has run.
   *
   * Omitted means "not checked": the belief decides, exactly as it did before checks
   * existed. A report of `unknown` decides nothing, which is the whole of the rule.
   */
  observed?: CapabilityReport;
}

/**
 * The one decision the rest of the app should ask.
 *
 * Three answers in, one answer out, in this order and no other:
 *
 *     an answer of `supported`    → the backend is authoritative
 *     an answer of `unsupported`  → cloud if paid, this device if not
 *     `unknown`, or no check yet  → whatever the belief says, unchanged
 *
 * That third line is the trap this file exists to close: a server that is restarting
 * must not move a feature it owns into the cloud, because when it comes back there
 * would be two writers for one field and the loser would be whichever device nobody was
 * looking at.
 */
export function resolveAuthority(feature: Feature, input: AuthorityInput): Authority {
  const observed = input.observed?.[feature];
  if (observed === "supported") return "backend";
  if (observed === "unsupported") return input.paid ? "cloud" : "local";
  return believedAuthority(feature, input);
}

/** The ladder without a fresh answer: a supported belief keeps the backend. */
function believedAuthority(feature: Feature, input: AuthorityInput): Authority {
  if (withDefaults(input.capabilities)[feature]) return "backend";
  return input.paid ? "cloud" : "local";
}

/**
 * The decision, with the words a screen needs around it.
 *
 * `couldNotCheck` is the permission the UI asks for: it may say "could not check" when
 * a check ran and got nothing back, and it may do that *without* the feature moving —
 * the authority in the same answer is the last good one.
 */
export interface Resolution {
  authority: Authority;
  /** What the check answered: `supported`, `unsupported`, or `unknown` (failed or never run). */
  checked: CapabilityState;
  /** True when a check ran and told us nothing. Never a reason to change the authority. */
  couldNotCheck: boolean;
}

export function explainAuthority(feature: Feature, input: AuthorityInput): Resolution {
  const observed = input.observed?.[feature];
  const authority = resolveAuthority(feature, input);
  if (observed === "supported" || observed === "unsupported") {
    return { authority, checked: observed, couldNotCheck: false };
  }
  return { authority, checked: "unknown", couldNotCheck: input.observed !== undefined };
}

/** Resolve several at once, for a screen that shows the whole answer. */
export function resolveAll(input: AuthorityInput): Record<Feature, Authority> {
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
 *
 * Only a feature some adapter carries is counted as a gap (`adapterCarries`): the reading position
 * has no route anywhere, so it is not a gap between a server and this app — it is one device's
 * cursor, and it is already here. Counting it would offer a provider as the home of a value no
 * backend is meant to hold, and would take the honest "nothing to buy" away from the one reader it
 * is true for.
 */
export function upgradePitch(input: AuthorityInput & {
  /** Whether a server sits behind this backend at all. */
  server: boolean;
}): "nothing" | "mirror" | "extras" {
  // A library on this device owns everything already and still has only one device's copy of it,
  // so what the paid tier adds is the mirror — not another authority, and not a missing feature.
  if (!input.server) return "mirror";
  const caps = withDefaults(input.capabilities);
  const observed = input.observed ?? {};
  // A feature nobody could check is not a feature to sell: "this server may not have it, buy
  // Sync" is a pitch built on a failed request. Only a `supported` belief or an answer of
  // `unsupported` counts as missing.
  const missing = ALL.filter(
    (feature) => !caps[feature] && observed[feature] !== "unknown" && adapterCarries(feature),
  );
  // A server that carries every extended feature needs nothing bought for it.
  if (missing.length === 0) return "nothing";
  return "extras";
}
