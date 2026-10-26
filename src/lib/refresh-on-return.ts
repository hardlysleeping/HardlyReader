/**
 * What coming back to the window is worth.
 *
 * A window that has been in the background for an hour is showing an hour-old
 * list, and the first thing anyone does with it is scroll. So returning to it
 * refreshes — but only when that is worth five requests: a glance at another
 * window and back is not. Five minutes is the default because that is roughly
 * when FreshRSS's own crawler has produced something new.
 *
 * `never` is the third answer and it is a narrow one: it silences this path
 * only. Opening the app still syncs, and the interval timer in `auto-sync` is a
 * different setting that keeps its own answer, because a reader who does not
 * want a fetch on every return has not asked for a stale morning either.
 *
 * The rules are here, away from Svelte, so a corrupt preference and a threshold
 * can be tested without a browser.
 */

/** The thresholds offered, in minutes. */
export const REFRESH_ON_RETURN_MINUTES = [5, 10, 30] as const;

export type RefreshMinutes = (typeof REFRESH_ON_RETURN_MINUTES)[number];

export type RefreshOnReturn =
  /** Refresh when the data is at least this old. */
  | { kind: "after"; minutes: RefreshMinutes }
  /** Refresh on every return, however brief. */
  | { kind: "always" }
  /** Leave the return path alone. A launch still syncs. */
  | { kind: "never" };

/**
 * Five minutes.
 *
 * Long enough that switching windows costs nothing, short enough that the list
 * on screen is the list that exists. The same threshold the app would use
 * anyway, made visible so it can be changed.
 */
export const REFRESH_ON_RETURN_DEFAULT: RefreshOnReturn = { kind: "after", minutes: 5 };

/** One of the offered thresholds, from whatever was stored. */
function minutesOf(value: unknown): RefreshMinutes | null {
  const minutes = typeof value === "string" ? Number(value) : value;
  if (typeof minutes !== "number") return null;
  return (REFRESH_ON_RETURN_MINUTES as readonly number[]).includes(minutes)
    ? (minutes as RefreshMinutes)
    : null;
}

export function isRefreshMinutes(value: unknown): value is RefreshMinutes {
  return minutesOf(value) !== null;
}

/**
 * Whatever was stored, read back as a setting that exists.
 *
 * Anything unrecognisable — an older build's shape, a hand-edited blob, a
 * missing field on a fresh install — lands on the default rather than on a
 * reading of the app nobody chose. A threshold that quietly became "never"
 * because its key was misspelt is exactly the sort of silence this avoids.
 */
export function parseRefreshOnReturn(value: unknown): RefreshOnReturn {
  if (typeof value !== "object" || value === null) return { ...REFRESH_ON_RETURN_DEFAULT };
  const saved = value as { kind?: unknown; minutes?: unknown };
  if (saved.kind === "always") return { kind: "always" };
  if (saved.kind === "never") return { kind: "never" };
  const minutes = minutesOf(saved.minutes);
  return minutes === null ? { ...REFRESH_ON_RETURN_DEFAULT } : { kind: "after", minutes };
}

/** The choices the settings row draws, in the order it draws them. */
export function refreshOnReturnChoices(): RefreshOnReturn[] {
  return [
    ...REFRESH_ON_RETURN_MINUTES.map((minutes): RefreshOnReturn => ({ kind: "after", minutes })),
    { kind: "always" },
    { kind: "never" },
  ];
}

/** "After 5 minutes" / "Always" / "Never" — the sentence a choice is named by. */
export function refreshOnReturnLabel(preference: RefreshOnReturn): string {
  if (preference.kind === "always") return "Always";
  if (preference.kind === "never") return "Never";
  return `After ${preference.minutes} minutes`;
}

/** The button's word: "5m" / "10m" / "30m" / "Always" / "Never". */
export function refreshOnReturnShort(preference: RefreshOnReturn): string {
  return preference.kind === "after" ? `${preference.minutes}m` : refreshOnReturnLabel(preference);
}

/** Whether a choice is the one now set, so the row can mark it. */
export function sameRefreshOnReturn(a: RefreshOnReturn, b: RefreshOnReturn): boolean {
  if (a.kind === "after" && b.kind === "after") return a.minutes === b.minutes;
  return a.kind === b.kind;
}

/**
 * How recent a load has to be for opening the app to count as synced.
 *
 * Thirty seconds: long enough to cover the launch load itself when it lands,
 * short enough that a paint from disk hours ago is not mistaken for one.
 */
export const LAUNCH_GRACE_MS = 30_000;

/**
 * Whether opening the app is worth a sync.
 *
 * This is not the preference's question and does not consult it. `never` is
 * about returning to a window; opening the app on last week's posts is a
 * different failure, and the answer to it is always the same.
 */
export function refreshDueOnLaunch(
  lastSyncAt: number,
  now: number = Date.now(),
  graceMs: number = LAUNCH_GRACE_MS,
): boolean {
  if (!(lastSyncAt > 0)) return true;
  return now - lastSyncAt > graceMs;
}

/**
 * Whether coming back to the window is worth a sync.
 *
 * `lastSyncAt` is when this window last pulled from the server — a sync, or the
 * launch load that counts as one. Zero means nothing has ever landed, which is
 * as stale as data gets: the app is showing whatever it found on disk.
 *
 * `never` answers false here and nowhere else. Everything that decides when the
 * app fetches is not this function.
 */
export function refreshDueOnReturn(
  preference: RefreshOnReturn,
  lastSyncAt: number,
  now: number = Date.now(),
): boolean {
  const setting = parseRefreshOnReturn(preference);
  if (setting.kind === "never") return false;
  if (setting.kind === "always") return true;
  if (!(lastSyncAt > 0)) return true;
  return now - lastSyncAt >= setting.minutes * 60_000;
}
