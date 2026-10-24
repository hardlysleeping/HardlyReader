/**
 * Watching for changes made somewhere else.
 *
 * The website writes the same extension state this app reads: hiding a category,
 * pinning one, changing the pinned view, locking. None of that goes through the
 * API the app talks to, so the app cannot be told about it — it can only ask.
 *
 * Asking the whole state every few seconds would be wasteful. Asking for a
 * short token, and fetching the state only when the token moves, costs one
 * small request per interval and gives a click on the website a latency of at
 * most one interval.
 *
 * Rules:
 *
 * - **The first answer is the baseline.** Watching starts by learning what the
 *   state is, not by reloading it — the app has just loaded it.
 * - **Nothing is polled while the window is hidden.** A background window
 *   cannot show the result, so it should not be spending the user's battery or
 *   the server's time. Becoming visible again polls at once rather than waiting
 *   out the rest of the interval.
 * - **Nothing is polled while a sync is running.** That sync is already talking
 *   to the server; a second answer landing mid-flight would be noise.
 * - **Failures back off.** A server that is down or unreachable should not be
 *   asked every four seconds forever; the interval doubles to a ceiling and
 *   returns to normal on the first success.
 * - The clock is injected so the tests can assert the intervals instead of
 *   waiting for them.
 */

/** Normal interval: a click on the website shows up within this long. */
export const CHANGE_POLL_MS = 4_000;

/** Ceiling for the backoff after failures. */
export const CHANGE_POLL_MAX_MS = 60_000;

export interface ChangeWatchOptions {
  /** Reads the current token. Rejecting is treated as "not now". */
  read: () => Promise<string>;
  /** Called with the new token when it differs from the last one seen. */
  onChange: (token: string) => void;
  /** True while work that already touches the server is in flight. */
  busy?: () => boolean;
  /** False while the window is hidden. */
  visible?: () => boolean;
  intervalMs?: number;
  maxIntervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ChangeWatch {
  /** Polls now instead of at the end of the current interval. */
  kick: () => void;
  stop: () => void;
  running: () => boolean;
  /** The last token seen, for tests and for showing a "last checked" time. */
  known: () => string | null;
}

export function startChangeWatch(options: ChangeWatchOptions): ChangeWatch {
  const interval = options.intervalMs ?? CHANGE_POLL_MS;
  const maxInterval = options.maxIntervalMs ?? CHANGE_POLL_MAX_MS;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let handle: unknown = null;
  let stopped = false;
  let known: string | null = null;
  let delay = interval;
  let pending = false;

  function schedule() {
    if (stopped) return;
    handle = setTimer(tick, delay);
  }

  function cancel() {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  }

  function tick() {
    handle = null;
    if (stopped || pending) return;
    // Neither of these is a failure: the answer is simply not wanted yet, so the
    // interval is left alone and the next tick asks again.
    if (options.visible?.() === false || options.busy?.() === true) {
      schedule();
      return;
    }
    pending = true;
    void Promise.resolve()
      .then(options.read)
      .then((token) => {
        pending = false;
        if (stopped) return;
        delay = interval;
        if (known === null) {
          known = token;
        } else if (token !== known) {
          known = token;
          options.onChange(token);
        }
      })
      .catch(() => {
        pending = false;
        if (stopped) return;
        delay = Math.min(delay * 2, maxInterval);
      })
      .finally(() => {
        if (!stopped) schedule();
      });
  }

  // The baseline read is a poll like any other; the first answer only teaches
  // the watcher what "unchanged" looks like.
  schedule();

  return {
    kick: () => {
      if (stopped) return;
      cancel();
      tick();
    },
    stop: () => {
      stopped = true;
      cancel();
    },
    running: () => !stopped,
    known: () => known,
  };
}
