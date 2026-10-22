/**
 * Optimistic writes for hidden-categories state.
 *
 * The rule this file exists to enforce: the sidebar changes at once, the write
 * follows, and any answer that carries authoritative state is applied rather
 * than undone. A 409 means the extension could not converge on what was asked;
 * its body holds what is actually true, so that is what gets drawn. Only a
 * failure with no state attached is a rollback — nothing was written, so the
 * state we started from is still the truth.
 */
import {
  ApiError,
  type HiddenCategoriesState,
  type HiddenView,
  type MutationResult,
} from "../api/hardlyread";

export type HiddenWriteOutcome =
  | { kind: "applied"; changed: boolean | null; state: HiddenCategoriesState }
  | { kind: "reconciled"; status: number; code: string; message: string; state: HiddenCategoriesState }
  | { kind: "failed"; message: string; state: HiddenCategoriesState };

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
  commit(optimistic);

  try {
    const result = await write();
    commit(result.hiddenCategories);
    return { kind: "applied", changed: result.changed, state: result.hiddenCategories };
  } catch (error) {
    if (error instanceof ApiError && error.state !== null) {
      commit(error.state);
      return {
        kind: "reconciled",
        status: error.status,
        code: error.code,
        message: error.message,
        state: error.state,
      };
    }

    commit(current);
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
      state: current,
    };
  }
}
