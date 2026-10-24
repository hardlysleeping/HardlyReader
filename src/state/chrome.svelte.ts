/**
 * Sidebar chrome that is nobody's account data: whether the control band is
 * collapsed.
 *
 * This used to live in the per-account prefs blob, keyed by `serverUrl|email`.
 * That made "stay collapsed" depend on the session having been restored before
 * the first render and on that key being byte-identical across launches — many
 * ways for a purely visual preference to fail. It has its own key now, it is
 * read before the first paint, and a login, a logout or a differently
 * normalised server URL cannot reset it.
 *
 * The storage rules live in `lib/chrome-prefs.ts` so they can be tested without
 * a Svelte compiler.
 */

import type { AutoSyncHours } from "../lib/auto-sync";
import {
  browserStorage,
  readAutoSync,
  readAutoSyncHours,
  readBandCollapsed,
  readIndentOpen,
  readPinPad,
  writeAutoSync,
  writeAutoSyncHours,
  writeBandCollapsed,
  writeIndentOpen,
  writePinPad,
} from "../lib/chrome-prefs";

class ChromeState {
  bandCollapsed = $state(false);

  /**
   * Whether the feed-indent slider is showing. Collapsed by default: the value
   * is worth seeing, the 12px slider track is not.
   */
  indentOpen = $state(false);

  /**
   * Whether the passcode is entered on a tappable number pad.
   *
   * Off unless it was chosen: with a mouse and a keyboard, typing is faster,
   * and this exists for the phone. Device-local like the rest of chrome — it
   * describes the hardware in front of you, not the account.
   */
  pinPad = $state(false);

  /**
   * Whether the app syncs on its own — once at launch, then every few hours.
   *
   * Off by default. Each sync is five requests against the server, and a reader
   * that spends them without being asked is spending something that is not
   * its own. Device-local: it is about this window, not the account.
   */
  autoSync = $state(false);

  /** Hours between automatic syncs. Hourly unless another interval was picked. */
  autoSyncHours = $state<AutoSyncHours>(1);

  load(): void {
    this.bandCollapsed = readBandCollapsed(browserStorage());
    this.indentOpen = readIndentOpen(browserStorage());
    this.pinPad = readPinPad(browserStorage());
    this.autoSync = readAutoSync(browserStorage());
    this.autoSyncHours = readAutoSyncHours(browserStorage());
  }

  /**
   * Shuts the band without touching the stored preference.
   *
   * A lock is a moment, not a choice: folding the band because the curtain went
   * down must not overwrite the fold state the user set for themselves, or
   * unlocking would leave them in a layout they never picked.
   */
  collapseBandForLock(): void {
    if (!this.bandCollapsed) this.bandCollapsed = true;
  }

  /** Back to the fold state the user actually chose. */
  restoreBand(): void {
    this.bandCollapsed = readBandCollapsed(browserStorage());
  }

  toggleIndentOpen(): void {
    this.indentOpen = !this.indentOpen;
    writeIndentOpen(browserStorage(), this.indentOpen);
  }

  setPinPad(on: boolean): void {
    if (this.pinPad === on) return;
    this.pinPad = on;
    writePinPad(browserStorage(), on);
  }

  togglePinPad(): void {
    this.setPinPad(!this.pinPad);
  }

  setAutoSync(on: boolean): void {
    if (this.autoSync === on) return;
    this.autoSync = on;
    writeAutoSync(browserStorage(), on);
  }

  setAutoSyncHours(hours: AutoSyncHours): void {
    if (this.autoSyncHours === hours) return;
    this.autoSyncHours = hours;
    writeAutoSyncHours(browserStorage(), hours);
  }

  toggleBand(): void {
    this.bandCollapsed = !this.bandCollapsed;
    writeBandCollapsed(browserStorage(), this.bandCollapsed);
  }

  setBandCollapsed(collapsed: boolean): void {
    if (this.bandCollapsed === collapsed) return;
    this.bandCollapsed = collapsed;
    writeBandCollapsed(browserStorage(), collapsed);
  }
}

export const chrome = new ChromeState();

// Read before the first paint: the band renders in the first frame, so a
// preference loaded in onMount would show expanded and then snap closed.
chrome.load();
