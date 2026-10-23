/**
 * Sync progress, in numbers someone can read.
 *
 * A sync is a handful of fetches, so the honest unit is the fetch: five of them,
 * whatever the account's size. The bar is not decoration — it says which step is
 * running, how many are done and what percentage that is, because "it is doing
 * something" is not the same as "it is two thirds done".
 */

export interface SyncState {
  active: boolean;
  done: number;
  total: number;
  /** The fetch in flight, in the app's words. */
  step: string;
}

export const SYNC_IDLE: SyncState = { active: false, done: 0, total: 0, step: "" };

/** One sync: feeds, tags, unread counts, extension state, then the open posts. */
export const SYNC_TOTAL = 5;

export function percentOf(done: number, total: number): number {
  if (total <= 0) return 0;
  const ratio = Math.min(Math.max(done / total, 0), 1);
  return Math.round(ratio * 100);
}

/**
 * "2/5 · 40%" — the count and the percentage, as asked for. Before the step
 * count is known (the first fetch is still running) there is no honest fraction
 * to show, so it names the step instead of printing "0/0 · 0%".
 */
export function syncReadout(state: SyncState): string {
  if (state.total <= 0) return state.step ? `${state.step}…` : "Syncing…";
  return `${Math.min(state.done, state.total)}/${state.total} · ${percentOf(state.done, state.total)}%`;
}

/** Names the step for a tooltip or a screen reader. */
export function syncDescription(state: SyncState): string {
  if (!state.active) return "Sync now";
  const step = state.step ? ` ${state.step.toLowerCase()}` : "";
  if (state.total <= 0) return `Syncing${step}, starting`;
  return `Syncing${step}, ${Math.min(state.done, state.total)} of ${state.total} done, ${percentOf(state.done, state.total)} percent`;
}
