/**
 * Sidebar chrome: whether the control band is collapsed, whether the pad is on,
 * whether the app syncs by itself.
 *
 * This used to live in the per-account prefs blob, keyed by `serverUrl|email`.
 * That made "stay collapsed" depend on that key being byte-identical across
 * launches — many ways for a purely visual preference to fail. It has its own key
 * now, it is read before the first paint, and the key is a hash of the account
 * (`lib/account-key`): a second login on this device gets its own chrome instead
 * of the first one's.
 *
 * The account is resolved from the stored session at each read and write, not
 * captured once: signing in during this run must start scoping immediately.
 *
 * The storage rules live in `lib/chrome-prefs.ts` so they can be tested without
 * a Svelte compiler.
 */

import { storedAccount, type AccountIdentity } from "../lib/account-key";
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
    const account = this.account();
    this.bandCollapsed = readBandCollapsed(browserStorage(), account);
    this.indentOpen = readIndentOpen(browserStorage(), account);
    this.pinPad = readPinPad(browserStorage(), account);
    this.autoSync = readAutoSync(browserStorage(), account);
    this.autoSyncHours = readAutoSyncHours(browserStorage(), account);
  }

  /** The account this chrome belongs to, or null before sign-in. */
  private account(): AccountIdentity | null {
    return storedAccount(browserStorage());
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
    this.bandCollapsed = readBandCollapsed(browserStorage(), this.account());
  }

  toggleIndentOpen(): void {
    this.indentOpen = !this.indentOpen;
    writeIndentOpen(browserStorage(), this.indentOpen, this.account());
  }

  setPinPad(on: boolean): void {
    if (this.pinPad === on) return;
    this.pinPad = on;
    writePinPad(browserStorage(), on, this.account());
  }

  togglePinPad(): void {
    this.setPinPad(!this.pinPad);
  }

  setAutoSync(on: boolean): void {
    if (this.autoSync === on) return;
    this.autoSync = on;
    writeAutoSync(browserStorage(), on, this.account());
  }

  setAutoSyncHours(hours: AutoSyncHours): void {
    if (this.autoSyncHours === hours) return;
    this.autoSyncHours = hours;
    writeAutoSyncHours(browserStorage(), hours, this.account());
  }

  toggleBand(): void {
    this.bandCollapsed = !this.bandCollapsed;
    writeBandCollapsed(browserStorage(), this.bandCollapsed, this.account());
  }

  setBandCollapsed(collapsed: boolean): void {
    if (this.bandCollapsed === collapsed) return;
    this.bandCollapsed = collapsed;
    writeBandCollapsed(browserStorage(), collapsed, this.account());
  }
}

export const chrome = new ChromeState();

// Read before the first paint: the band renders in the first frame, so a
// preference loaded in onMount would show expanded and then snap closed.
chrome.load();
