/**
 * The sidebar band's three states, as facts.
 *
 * One row above the stream list carries the hidden filter, the lock and the
 * pin, and the strip at the foot of the sidebar reports what is being shown. The
 * band has three states, and they are not three variations of one row:
 *
 * - `open` — the full band: eye, lock and pin, each with the extension's own
 *   word underneath. The strip reads the hidden count, the ENFORCED badge and
 *   the pinned count.
 * - `locked` — the curtain is down. The row compacts to low-key glyphs and
 *   everything that would say hidden content exists goes with it: the eye, its
 *   word, the count, the ENFORCED badge, and every spoken name. Only the pinned
 *   count remains, because a pin says what to show, not what is in it.
 * - `collapsed` — the row is folded away for the moment. A fold is not a
 *   curtain: nothing about hidden content changes, so the strip keeps reading.
 *
 * Pure, so the rule that a locked account emits nothing about hidden content can
 * be asserted without a browser, and so the components hold no policy of their
 * own. The state itself stays where it lives: `hiddenCount`/`hiddenLocked`/
 * `pinView` on the reader, the fold on `chrome`. This module only decides what is
 * drawn, for both the row and the strip.
 *
 * One authority answers at a time — the extension's store, or this device's own
 * set when there is no extension — and `authority` rides in both models so the
 * eye is never a dead control and the badge can name the one enforcing.
 */
import type { HiddenView } from "../api/hardlyread";
import { HIDDEN_VIEW_LABELS, nextHiddenView, type HiddenAuthority } from "../state/hidden";
import { nextPinView, PIN_VIEW_LABELS, type PinView } from "../state/pins";

export type BandState = "open" | "locked" | "collapsed";

/**
 * Which of the three the band is in.
 *
 * The fold wins over the lock: a band the user put away stays away even when
 * the curtain goes down, because nothing is drawn either way.
 */
export function bandState(collapsed: boolean, locked: boolean): BandState {
  if (collapsed) return "collapsed";
  return locked ? "locked" : "open";
}

/** Everything the band is allowed to know, read from the reader and the chrome. */
export interface BandInput {
  collapsed: boolean;
  locked: boolean;
  /** Whether the extension answers. The eye answers either way — see
   * `authority`, which says where the answer comes from. */
  available: boolean;
  /** Who is enforcing: the extension, or this device's own set. */
  authority: HiddenAuthority;
  view: HiddenView;
  pinnedCount: number;
  pinView: PinView;
}

export interface BandFacts {
  state: BandState;
  /** The row itself: drawn open and locked, gone when folded. */
  row: boolean;
  /**
   * The eye and its words — null while locked and while folded.
   *
   * Locked it is null because the glyph is not drawn either: an eye sitting in a
   * locked band is itself a hint that something is being filtered out.
   *
   * `enabled` is true for either authority: without the extension the eye is not
   * a dead control, it is the same three views with the set kept on this device.
   * `authority` rides along so the word under it can say where the filter lives.
   */
  hidden: { label: string; next: string; enabled: boolean; authority: HiddenAuthority } | null;
  /** Always drawn, always counted: the one number a lock leaves standing. */
  pinnedCount: number;
  /** The pin's word under the glyph. Null while locked — labels drop away. */
  pinLabel: string | null;
  /** Spoken name for the pin, after "Pinned: ". The count alone once locked. */
  pinName: string;
  /** What a press on the pin asks for, in the extension's words. Null while locked. */
  pinNext: string | null;
}

export function bandFacts(input: BandInput): BandFacts {
  const state = bandState(input.collapsed, input.locked);
  const open = state === "open";

  return {
    state,
    row: state !== "collapsed",
    hidden: open
      ? {
          label: HIDDEN_VIEW_LABELS[input.view],
          next: HIDDEN_VIEW_LABELS[nextHiddenView(input.view)],
          // Two answers, one control: the extension's store, or this device's.
          enabled: input.available || input.authority === "local",
          authority: input.authority,
        }
      : null,
    pinnedCount: input.pinnedCount,
    pinLabel: open ? PIN_VIEW_LABELS[input.pinView] : null,
    // While locked the view's own words are not spoken either: one of them is
    // a filter name, and a lock may not say it. The count is not hidden
    // content — it is what the app is showing.
    pinName: open ? PIN_VIEW_LABELS[input.pinView] : String(input.pinnedCount),
    pinNext: open ? PIN_VIEW_LABELS[nextPinView(input.pinView)] : null,
  };
}

/** What the sidebar's own status strip is allowed to say, in the same three states. */
export interface StatusInput {
  locked: boolean;
  available: boolean;
  /** Who is enforcing: the extension, or this device's own set. */
  authority: HiddenAuthority;
  hiddenCount: number;
  /** Whether the authority is enforcing the curtain right now. */
  enforced: boolean;
  pinnedCount: number;
}

export interface StatusFacts {
  /** The count, or null when the curtain is down or nothing answers. */
  hiddenCount: number | null;
  /** The badge. Never worn while locked. */
  enforced: boolean;
  /** Which authority the badge would be naming, so the badge can say it. */
  authority: HiddenAuthority;
  /** The one number a lock leaves standing. */
  pinnedCount: number;
}

/**
 * The strip at the foot of the sidebar: the hidden count, the ENFORCED badge
 * and the pinned count.
 *
 * Same rule as the band, one floor down: a lock takes the hidden half of the
 * strip with it — the count, the badge, and with them any hint that there is
 * hidden content to count — and leaves the pins, which say what to show.
 *
 * The count is the authority's own, whichever it is, and `authority` travels
 * with the badge: ENFORCED by the server and ENFORCED by this device are the
 * same promise about the sidebar and a different promise about every other
 * device, so the badge says which one it is keeping.
 */
export function statusFacts(input: StatusInput): StatusFacts {
  // The curtain is the lock, not the state of the row above: a folded band that
  // is also locked still may not print a count, it just draws no row either.
  const curtain = input.locked;
  const answers = input.available || input.authority === "local";
  return {
    hiddenCount: curtain || !answers ? null : input.hiddenCount,
    enforced: !curtain && answers && input.enforced,
    authority: input.authority,
    pinnedCount: input.pinnedCount,
  };
}
