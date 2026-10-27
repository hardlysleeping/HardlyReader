/**
 * Sidebar filtering for the hidden-categories view.
 *
 * Pure functions so the rules can be exercised outside a Svelte runtime, and so
 * `reader.svelte.ts` holds no policy of its own.
 *
 * ## Two authorities, never both
 *
 * There is one question here — which categories are hidden — and exactly one
 * place that answers it:
 *
 * - **The extension answers** (`state.available`): its store, its view and its
 *   lock decide, exactly as before. The device's own set is not read, not
 *   merged and not written.
 * - **The extension does not answer**: this device's own set decides — the same
 *   three views, the same filter, stored per account in the same prefs blob as
 *   the pins. The only thing that is skipped is the server write, because there
 *   is no server for it to go to.
 *
 * Never merge the two. A merge would make the same category hidden in one place
 * and not the other, and the first launch with the extension installed would
 * then show rows that the extension has never heard of. `resolveHidden` is the
 * whole of the rule: extension present means the extension's block, byte for
 * byte; extension absent means a block built from this device's labels.
 *
 * ## What the server still owns
 *
 * - In Strict mode a hidden category's feeds are pushed out of
 *   `subscription/list` entirely, so the group may never arrive at all. Nothing
 *   here can remove what was never sent — which is why the device's own set
 *   leaves `subscriptions` alone: its rows are never dropped to begin with, so a
 *   reveal is simply the filter letting them through again.
 * - In `only` and `revealed` the extension suspends enforcement, so the feeds
 *   do come back — which is why these views can actually be built client-side.
 */
import {
  HIDDEN_VIEWS,
  isHiddenCategory,
  type HiddenCategoriesState,
  type HiddenView,
} from "../api/hardlyread";

/** The extension's own words for its three views, in its own order. */
export const HIDDEN_VIEW_LABELS: Record<HiddenView, string> = {
  hidden: "Hidden",
  revealed: "Revealed",
  only: "Only",
};

/**
 * Which authority is deciding what is hidden right now.
 *
 * `local` is not a degraded `extension`: it is the whole feature with the store
 * somewhere else, and it is what every ordinary FreshRSS install gets.
 */
export type HiddenAuthority = "extension" | "local";

/** What this device keeps, for a server with no extension to ask. */
export interface LocalHidden {
  /** Category labels, as the sidebar spells them — the same key the pins use,
   * because a category's numeric id is something only a server hands out. */
  categories: string[];
  /** The view the eye is on. */
  view: HiddenView;
}

export function emptyHidden(): LocalHidden {
  return { categories: [], view: "hidden" };
}

/** Parses whatever local storage held, discarding anything malformed. */
export function parseHidden(raw: unknown): LocalHidden {
  if (typeof raw !== "object" || raw === null) return emptyHidden();
  const value = raw as Record<string, unknown>;
  return {
    categories: Array.isArray(value.categories)
      ? value.categories.filter((entry): entry is string => typeof entry === "string")
      : [],
    view: isHiddenView(value.view) ? value.view : "hidden",
  };
}

function isHiddenView(value: unknown): value is HiddenView {
  return typeof value === "string" && (HIDDEN_VIEWS as readonly string[]).includes(value);
}

/** Adds or removes one label, keeping list order (newest hide last). */
export function withHidden(list: readonly string[], label: string, hidden: boolean): string[] {
  const rest = list.filter((entry) => entry !== label);
  return hidden ? [...rest, label] : rest;
}

/** Whether this device's own set holds `label`. The extension is never asked. */
export function isLocallyHidden(local: LocalHidden, label: string): boolean {
  return local.categories.includes(label);
}

/** Who decides. The extension when it answers at all — locked or not. */
export function hiddenAuthority(server: HiddenCategoriesState): HiddenAuthority {
  return server.available ? "extension" : "local";
}

/**
 * The block everything downstream is filtered by.
 *
 * Extension present: the extension's own state, returned as it came, so every
 * consumer sees exactly what the server said. Extension absent: a block built
 * from this device's labels, shaped like the extension's so the view rules, the
 * count and the band need no second code path.
 *
 * `available` on the local block means "this block is the authority and must be
 * obeyed", not "the extension is installed" — the reader answers that question
 * from the extension's own block, which is a different field.
 *
 * The synthetic ids are negative and belong to no server: they exist so
 * `isHiddenCategory` and the row menu can look a label up the same way they do
 * everywhere else. Nothing with one of these ids is ever sent anywhere.
 */
export function resolveHidden(
  server: HiddenCategoriesState,
  local: LocalHidden,
): HiddenCategoriesState {
  if (server.available) return server;
  const categories = local.categories.map((label, index) => ({
    id: -(index + 1),
    name: label,
    hidden: true,
  }));
  return {
    available: true,
    mode: "local",
    view: local.view,
    // No lock without a passcode to keep, so the stored view is the applied one.
    effectiveView: local.view,
    hiddenIds: categories.map((category) => category.id),
    locked: false,
    hasPasscode: false,
    categories,
  };
}

/** The view the authority is actually applying; `view` differs while locked. */
export function effectiveView(state: HiddenCategoriesState): HiddenView {
  return state.available ? state.effectiveView : "hidden";
}

/** What one press on the eye asks for: the next view in the extension's order. */
export function nextHiddenView(view: HiddenView): HiddenView {
  const order: HiddenView[] = ["hidden", "revealed", "only"];
  const index = order.indexOf(view);
  return order[(index + 1) % order.length] ?? "hidden";
}

/**
 * Whether the curtain is enforcing right now.
 *
 * Only the plain `hidden` view enforces anything; `revealed` and `only` suspend
 * enforcement so their rows can be drawn, which is exactly why they must not
 * wear the badge. Whatever answers — extension or this device — the badge is
 * only truthful when it is asked the same question, so the caller passes the
 * resolved block and not the extension's block alone.
 */
export function enforcing(state: HiddenCategoriesState): boolean {
  return state.available && effectiveView(state) === "hidden";
}

/** Whether a labelled group should be drawn in the sidebar. */
export function showsCategory(state: HiddenCategoriesState, label: string): boolean {
  if (!state.available) return true;
  const hidden = isHiddenCategory(state, label);
  switch (effectiveView(state)) {
    case "revealed":
      return true;
    case "only":
      return hidden;
    default:
      return !hidden;
  }
}

/** The subset of `groups` the current view should show. */
export function visibleGroups<T extends { label: string }>(
  groups: T[],
  state: HiddenCategoriesState,
): T[] {
  if (!state.available) return groups;
  return groups.filter((group) => showsCategory(state, group.label));
}
