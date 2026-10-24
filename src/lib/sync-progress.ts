/**
 * Sync progress, in numbers someone can read.
 *
 * A sync is a handful of fetches, so the honest unit is the fetch: five of them,
 * whatever the account's size. The bar is not decoration — it says which step is
 * running, how many are done and what percentage that is, because "it is doing
 * something" is not the same as "it is two thirds done".
 *
 * The number is only worth showing if it is true, so the counting lives here
 * rather than in the reader: a step lands when its fetch delivers, a step that
 * failed never lands, and the same step cannot land twice however many syncs are
 * in flight at once.
 */

export interface SyncState {
  active: boolean;
  done: number;
  total: number;
  /** The fetch in flight, in the app's words. Empty when nothing is running. */
  step: string;
}

export const SYNC_IDLE: SyncState = { active: false, done: 0, total: 0, step: "" };

export type SyncStepId = "feeds" | "tags" | "counts" | "extension" | "posts";

export interface SyncStep {
  id: SyncStepId;
  /** The step's name, for a report of what finished. */
  label: string;
  /** What is happening while its fetch is in flight: the words on screen. */
  doing: string;
}

/**
 * One sync: feeds, tags, unread counts, extension state, then the open posts.
 *
 * `doing` is prose rather than a name in capitals because it is read in the
 * middle of a sentence in the bar ("2/5 steps · loading tags").
 */
export const SYNC_STEPS: readonly SyncStep[] = [
  { id: "feeds", label: "Feeds", doing: "loading feeds" },
  { id: "tags", label: "Tags", doing: "loading tags" },
  { id: "counts", label: "Unread counts", doing: "counting unread" },
  { id: "extension", label: "Extension state", doing: "reading extension state" },
  { id: "posts", label: "Posts", doing: "loading posts" },
];

export const SYNC_TOTAL = SYNC_STEPS.length;

const DOING = new Map<SyncStepId, string>(SYNC_STEPS.map((step) => [step.id, step.doing]));

/**
 * What a fetch tells the counter. Called by whoever makes the request, at the
 * moment it starts and at the moment it settles — never in advance, so the
 * label can only ever name a fetch that is really in flight.
 */
export interface SyncReport {
  start(id: SyncStepId): void;
  land(id: SyncStepId): void;
  fail(id: SyncStepId): void;
}

export interface SyncTracker extends SyncReport {
  /** The readout as it stands, as an immutable snapshot. */
  readonly state: SyncState;
  /** Starts a sync, or joins the one already running. */
  begin(): SyncState;
  start(id: SyncStepId): SyncState;
  land(id: SyncStepId): SyncState;
  fail(id: SyncStepId): SyncState;
  /** Closes one sync; the readout ends with the last one. */
  finish(): SyncState;
}

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
  // The unit, not just the fraction: "2/5" next to a post list reads like five
  // posts. A sync is five fetches, and saying so is the whole point of counting
  // them.
  return `${Math.min(state.done, state.total)}/${state.total} steps`;
}

/** Names the step for a tooltip or a screen reader. */
export function syncDescription(state: SyncState): string {
  if (!state.active) return "Sync now";
  const count =
    state.total <= 0
      ? "starting"
      : `${Math.min(state.done, state.total)} of ${state.total} steps, ${percentOf(state.done, state.total)} percent`;
  // The step comes first because it is the part that changes: "loading tags"
  // answers "what is it doing" before the count answers "how far".
  return state.step ? `Syncing, ${state.step}: ${count}` : `Syncing: ${count}`;
}

/**
 * A counter that can only be moved by a fetch that really finished.
 *
 * Three rules, and they are the whole reason this is not a number in the
 * reader:
 *
 * - `done` is the size of a set of step ids, so it cannot pass `total` and one
 *   step cannot be counted twice — two overlapping syncs fetch the same five
 *   things, and the count is steps, not requests.
 * - A step that failed never lands, so a broken sync ends short instead of
 *   being rounded up to a full one.
 * - The named step is the oldest fetch still in flight. It is always a fetch
 *   that is really running; when none is, there is nothing to name.
 */
export function createSyncTracker(): SyncTracker {
  /** Syncs in flight. A manual sync and a watch-triggered one can overlap. */
  let runs = 0;
  /** The steps whose fetch has delivered in this run. */
  const landed = new Set<SyncStepId>();
  /** The steps whose fetch is in flight, in the order they really started. */
  let pending: SyncStepId[] = [];
  let active = false;

  const doing = (): string => (pending.length === 0 ? "" : (DOING.get(pending[0]) ?? ""));
  const snapshot = (): SyncState => ({
    active,
    done: landed.size,
    total: SYNC_TOTAL,
    step: doing(),
  });

  return {
    get state() {
      return snapshot();
    },

    begin() {
      if (runs === 0) {
        // A fresh sync is a fresh count: a fraction that started at last run's
        // total would claim work this run has not done.
        landed.clear();
        pending = [];
        active = true;
      }
      // Joining a running sync changes nothing: it shares the same five steps.
      runs += 1;
      return snapshot();
    },

    start(id) {
      if (runs === 0 || landed.has(id) || pending.includes(id)) return snapshot();
      pending = [...pending, id];
      return snapshot();
    },

    land(id) {
      // A step that already landed, or a fetch that belongs to a sync that is
      // over, must not move the number.
      if (runs === 0 || landed.has(id)) return snapshot();
      landed.add(id);
      pending = pending.filter((step) => step !== id);
      return snapshot();
    },

    fail(id) {
      if (runs === 0) return snapshot();
      // A failure is not a completion: the step stops being the one named on
      // screen, and `done` stays where it was. The caller already surfaces the
      // error; the readout just declines to pretend the step passed.
      pending = pending.filter((step) => step !== id);
      return snapshot();
    },

    finish() {
      if (runs > 0) runs -= 1;
      if (runs === 0) {
        active = false;
        pending = [];
      }
      // `done` is left exactly where the fetches put it, so a sync that lost a
      // step ends at 4/5 rather than at a tidy lie.
      return snapshot();
    },
  };
}
