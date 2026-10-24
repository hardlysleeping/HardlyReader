/**
 * Optimistic writes for hidden-categories state.
 *
 * The rule itself lives in `./write`; this file is the hidden-categories
 * binding of it — the optimistic state to draw, and which part of a failing
 * answer is authoritative.
 */
import {
  type HiddenCategoriesState,
  type HiddenView,
  type MutationResult,
} from "../api/hardlyread";
import { applyOptimisticWrite, type WriteOutcome } from "./write";

export type HiddenWriteOutcome = WriteOutcome<HiddenCategoriesState>;

/**
 * The state to draw while a hide/show is in flight.
 *
 * An id the extension never reported is left alone — the menu does not offer
 * such a row, and inventing a category would draw something the server cannot
 * confirm. `state` is returned by identity in that case.
 */
export function withCategoryHidden(
  state: HiddenCategoriesState,
  id: number,
  hidden: boolean,
): HiddenCategoriesState {
  if (!state.categories.some((category) => category.id === id)) return state;

  const hiddenIds = hidden
    ? [...state.hiddenIds.filter((entry) => entry !== id), id].sort((a, b) => a - b)
    : state.hiddenIds.filter((entry) => entry !== id);

  return {
    ...state,
    hiddenIds,
    categories: state.categories.map((category) =>
      category.id === id ? { ...category, hidden } : category,
    ),
  };
}

/** The state to draw while a view change is in flight. */
export function withView(state: HiddenCategoriesState, view: HiddenView): HiddenCategoriesState {
  if (!state.available) return state;
  return { ...state, view, effectiveView: view };
}

/**
 * Applies `optimistic` straight away, then hands the answer to `commit`.
 *
 * `current` is the pre-write state, kept so a stateless failure can put it
 * back. Calls are ordered: optimistic, then exactly one final state.
 */
export async function applyHiddenWrite(
  current: HiddenCategoriesState,
  optimistic: HiddenCategoriesState,
  commit: (state: HiddenCategoriesState) => void,
  write: () => Promise<MutationResult>,
): Promise<HiddenWriteOutcome> {
  return applyOptimisticWrite(
    current,
    optimistic,
    commit,
    async () => {
      const result = await write();
      return { changed: result.changed, state: result.hiddenCategories };
    },
    (error) => error.state,
  );
}
