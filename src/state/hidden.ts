/**
 * Sidebar filtering for the hidden-categories view.
 *
 * Pure functions so the rules can be exercised outside a Svelte runtime, and so
 * `reader.svelte.ts` holds no policy of its own.
 *
 * The server owns every Strict/Light decision; the app only decides what to
 * draw. Consequences worth knowing:
 *
 * - In Strict mode a hidden category's feeds are pushed out of
 *   `subscription/list` entirely, so the group may never arrive at all. Nothing
 *   here can remove what was never sent.
 * - In `only` and `revealed` the extension suspends enforcement, so the feeds
 *   do come back — which is why these views can actually be built client-side.
 */
import { isHiddenCategory, type HiddenCategoriesState, type HiddenView } from "../api/hardlyread";

/** The extension's own words for its three views, in its own order. */
export const HIDDEN_VIEW_LABELS: Record<HiddenView, string> = {
  hidden: "Hidden",
  revealed: "Revealed",
  only: "Only",
};

/** The view the extension is actually applying; `view` differs while locked. */
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
 * Whether the extension is enforcing the curtain right now.
 *
 * Only the plain `hidden` view enforces anything; `revealed` and `only` suspend
 * enforcement so their rows can be drawn, which is exactly why they must not
 * wear the badge.
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
