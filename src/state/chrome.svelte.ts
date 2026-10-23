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

import {
  browserStorage,
  readBandCollapsed,
  readIndentOpen,
  writeBandCollapsed,
  writeIndentOpen,
} from "../lib/chrome-prefs";

class ChromeState {
  bandCollapsed = $state(false);

  /**
   * Whether the feed-indent slider is showing. Collapsed by default: the value
   * is worth seeing, the 12px slider track is not.
   */
  indentOpen = $state(false);

  load(): void {
    this.bandCollapsed = readBandCollapsed(browserStorage());
    this.indentOpen = readIndentOpen(browserStorage());
  }

  toggleIndentOpen(): void {
    this.indentOpen = !this.indentOpen;
    writeIndentOpen(browserStorage(), this.indentOpen);
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
