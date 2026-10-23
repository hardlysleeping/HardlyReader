/**
 * The optimistic-write rule, once, for every block of `/v1/state`.
 *
 * A write is applied to the screen before it is sent, and whatever comes back
 * is what gets drawn:
 *
 * - 2xx: the state in the body is authoritative, `changed` merely says whether
 *   the server had to do anything;
 * - a failure that carries state (409 `convergence_failed`, 423 `locked`): the
 *   server could not converge on what was asked, so its state replaces the
 *   optimistic one — reconcile, never blind rollback;
 * - any other failure: nothing was written, so the pre-write state is restored.
 *
 * The block-specific parts (which field of the error holds the state, which
 * shape the state has) are the caller's, which is why this is generic.
 */
import { ApiError } from "../api/hardlyread";

export type WriteOutcome<S> =
  | { kind: "applied"; changed: boolean | null; state: S }
  | { kind: "reconciled"; status: number; code: string; message: string; state: S }
  | { kind: "failed"; message: string; state: S };

/** What a successful mutation hands back. */
export interface WriteResult<S> {
  changed: boolean | null;
  state: S;
}

/**
 * Applies `optimistic` straight away, then hands exactly one final state to
 * `commit`: the server's, or the pre-write one on a stateless failure.
 *
 * `authoritative` extracts the state a failed write carries, or null when the
 * failure carried none.
 */
export async function applyOptimisticWrite<S>(
  current: S,
  optimistic: S,
  commit: (state: S) => void,
  write: () => Promise<WriteResult<S>>,
  authoritative: (error: ApiError) => S | null,
): Promise<WriteOutcome<S>> {
  commit(optimistic);

  try {
    const result = await write();
    commit(result.state);
    return { kind: "applied", changed: result.changed, state: result.state };
  } catch (error) {
    if (error instanceof ApiError) {
      const state = authoritative(error);
      if (state !== null) {
        commit(state);
        return {
          kind: "reconciled",
          status: error.status,
          code: error.code,
          message: error.message,
          state,
        };
      }
    }

    commit(current);
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
      state: current,
    };
  }
}
