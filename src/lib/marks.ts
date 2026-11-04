/**
 * One state on a post's categories, forced to a value.
 *
 * A GReader item carries its marks as category ids: `user/-/state/com.google/read`,
 * and a Miniflux spells its own user (`user/1/state/com.google/read`). The
 * register is the `/state/...` tail, never the whole id, so anything that reads or
 * writes a mark has to compare the tail — `isRead`/`isStarred` in
 * `api/freshrss.ts` already do, and this is the writing half of the same rule.
 *
 * It lives on its own because it had two implementations: the reader's overlay for
 * a restored page matched the tail, and the offline backend's overlay for a page
 * the server sent matched the whole id. The second could not remove a state a
 * Miniflux had spelled its own way, so a post un-read while queued still drew as
 * read. One rule, one function, tested against the spelling a real server uses.
 */
export function withState(
  categories: readonly string[],
  state: string,
  value: boolean | undefined,
): string[] {
  if (value === undefined) return [...categories];
  const suffix = suffixOf(state);
  const without = categories.filter((category) => !category.endsWith(suffix));
  return value ? [...without, state] : without;
}

/** `/state/com.google/read` from `user/1/state/com.google/read`. */
function suffixOf(state: string): string {
  const at = state.indexOf("/state/");
  return at === -1 ? state : state.slice(at);
}
