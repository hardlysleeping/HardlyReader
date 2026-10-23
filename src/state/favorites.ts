/**
 * Favorites: the view cycle and optimistic writes.
 *
 * Pure functions so the cycle order and the merge rules can be exercised
 * outside a Svelte runtime. The write rule itself is `./write`; this file only
 * says what the favorites state looks like while one is in flight.
 */
import {
  type FavoriteMutationResult,
  type FavoriteView,
  type FavoritesState,
} from "../api/hardlyread";
import { applyOptimisticWrite, type WriteOutcome } from "./write";

export type FavoritesWriteOutcome = WriteOutcome<FavoritesState>;

/** The header cycles in this order, and only in this order. */
export const FAVORITE_VIEW_CYCLE: readonly FavoriteView[] = ["all", "only", "without"];

export const FAVORITE_VIEW_LABELS: Record<FavoriteView, string> = {
  all: "All",
  only: "Favorites",
  without: "No favorites",
};

/**
 * The view the header's next click asks for.
 *
 * An unknown stored value falls back to the first entry rather than throwing:
 * the server is allowed to grow a view this build has never heard of, and a
 * dead control is worse than a wrong-looking one.
 */
export function nextFavoriteView(view: FavoriteView): FavoriteView {
  const index = FAVORITE_VIEW_CYCLE.indexOf(view);
  return FAVORITE_VIEW_CYCLE[(index + 1) % FAVORITE_VIEW_CYCLE.length];
}

/** The label the control shows for a view. */
export function favoriteViewLabel(view: FavoriteView): string {
  return FAVORITE_VIEW_LABELS[view];
}

/**
 * The state to draw while a favorite/unfavorite is in flight.
 *
 * An id the extension never reported is left alone, by identity: the row was
 * not the server's to begin with, and inventing a category would draw
 * something that cannot be confirmed.
 */
export function withCategoryFavorite(
  state: FavoritesState,
  id: number,
  favorite: boolean,
): FavoritesState {
  if (!state.categories.some((category) => category.id === id)) return state;

  const ids = favorite
    ? [...state.ids.filter((entry) => entry !== id), id].sort((a, b) => a - b)
    : state.ids.filter((entry) => entry !== id);

  return {
    ...state,
    ids,
    categories: state.categories.map((category) =>
      category.id === id ? { ...category, favorite } : category,
    ),
  };
}

/** The state to draw while a view change is in flight. */
export function withFavoritesView(state: FavoritesState, view: FavoriteView): FavoritesState {
  if (!state.available) return state;
  return { ...state, view };
}

/**
 * Applies `optimistic` straight away, then hands the answer to `commit`.
 *
 * `changed: false` is an ordinary success: the server was already there. Only
 * a failure with no favorites block attached rolls the screen back.
 */
export async function applyFavoritesWrite(
  current: FavoritesState,
  optimistic: FavoritesState,
  commit: (state: FavoritesState) => void,
  write: () => Promise<FavoriteMutationResult>,
): Promise<FavoritesWriteOutcome> {
  return applyOptimisticWrite(
    current,
    optimistic,
    commit,
    async () => {
      const result = await write();
      return { changed: result.changed, state: result.favorites };
    },
    (error) => error.favorites,
  );
}
