/**
 * Automatic sync: on launch, and every few hours while the window is open.
 *
 * Off by default. A reader that fetches on its own is a choice, not a default:
 * every sync is five requests against someone else's server, and a reader that
 * does that without being asked is a reader that costs money nobody agreed to.
 *
 * The rules are here, away from Svelte, so the timing can be tested with a
 * driven clock instead of by waiting four hours.
 */

/** The intervals offered, in hours. */
export const AUTO_SYNC_HOURS = [1, 2, 4, 6, 12, 24] as const;

export type AutoSyncHours = (typeof AUTO_SYNC_HOURS)[number];

/** Hourly, because that is what a feed reader's own poller usually does. */
export const AUTO_SYNC_DEFAULT_HOURS: AutoSyncHours = 1;

export function isAutoSyncHours(value: unknown): value is AutoSyncHours {
  return typeof value === "number" && (AUTO_SYNC_HOURS as readonly number[]).includes(value);
}

/** Whatever was stored, read back as a setting that exists. */
export function parseAutoSyncHours(value: unknown): AutoSyncHours {
  const hours = typeof value === "string" ? Number(value) : value;
  return isAutoSyncHours(hours) ? hours : AUTO_SYNC_DEFAULT_HOURS;
}

export function autoSyncMs(hours: AutoSyncHours): number {
  return hours * 60 * 60 * 1000;
}

/** "Every hour" / "Every 4 hours" / "Every 24 hours (daily)". */
export function autoSyncLabel(hours: AutoSyncHours): string {
  if (hours === 1) return "Every hour";
  if (hours === 24) return "Every 24 hours (daily)";
  return `Every ${hours} hours`;
}

export interface AutoSyncOptions {
  /** Read at each tick, not once: a toggle must not need a restart. */
  enabled: () => boolean;
  hours: () => AutoSyncHours;
  /** One sync. A rejected promise is the caller's problem, not the timer's. */
  sync: () => Promise<void> | void;
  /** True while a sync is already running, so two cannot overlap. */
  busy: () => boolean;
  /** False to skip the launch sync (a fresh login has just fetched everything). */
  launch?: boolean;
  /** Injected so a test can drive the clock. */
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface AutoSyncRun {
  /** Stops the timer. Safe to call twice. */
  stop: () => void;
  /** True when a timer is actually running. */
  running: () => boolean;
}

export function startAutoSync(options: AutoSyncOptions): AutoSyncRun {
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => globalThis.setInterval(run, ms) as unknown);
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));

  let handle: unknown = null;
  let stopped = false;

  const fire = (): void => {
    if (stopped || !options.enabled() || options.busy()) return;
    // A rejected sync must not kill the timer: the next one still has to happen.
    void Promise.resolve(options.sync()).catch(() => undefined);
  };

  if (!options.enabled()) {
    // Nothing to schedule: off means off, not a timer that wakes up to do
    // nothing every hour.
    return { stop: () => {}, running: () => false };
  }

  if (options.launch !== false) fire();

  handle = setTimer(fire, autoSyncMs(parseAutoSyncHours(options.hours())));

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
    running: () => handle !== null && !stopped,
  };
}
