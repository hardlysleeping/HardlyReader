/**
 * Category icons: the reader's choices, and whether to guess the rest.
 *
 * Keyed by **label**, not by id: ids are per server, and a category that
 * survives a re-import keeps its name, which is the thing a reader recognises.
 * The shape on the wire is `{ auto: true, map: { "Tech News": "cpu" } }` — two
 * levels, so it survives `prefs-sync`'s depth bound with room to spare (a
 * `{name, keywords}` entry per icon would be depth 4, which is exactly what the
 * topics store had to find out).
 *
 * The precedence rule, once: an explicit choice always wins; with `auto` on, an
 * unmapped label gets `guessIcon(label)`; with `auto` off, an unmapped label
 * gets nothing. Turning auto off is therefore a real choice rather than a no-op.
 *
 * `guessIcon` is a pure function of the label, so it is not cached: a cache
 * would be a second source of truth about a category's icon, and the whole point
 * of "auto" is that it costs nothing to recompute.
 */

import { guessIcon } from "../lib/category-icon";
import { hasIcon, iconsFromValue, type IconChoices } from "../lib/icons/index";

const STORAGE_KEY = "hardlyreader.icons.v1";

/** Kept small: the wire allows 64 keys per record, and a reader has far fewer. */
const MAX_ICONS = 60;

export class IconsState {
  /** Labels with a glyph the reader chose. */
  map = $state<Record<string, string>>({});
  /** Whether a label with no choice gets a guessed glyph. */
  auto = $state(true);

  /** At least once: the defaults are not coming back. */
  #settled = false;

  /**
   * The glyph for a category, or null for "draw none".
   *
   * An explicit choice is honoured even when the set no longer knows the name
   * (an icon removed from the curated list) by returning null rather than the
   * guess: the reader asked for a picture, and a different picture is not it.
   */
  iconFor(label: string): string | null {
    const chosen = this.map[label];
    if (chosen !== undefined) return hasIcon(chosen) ? chosen : null;
    return this.auto ? guessIcon(label) : null;
  }

  /** A choice from the picker. */
  setIcon(label: string, name: string | null): void {
    const next = { ...this.map };
    if (name === null) delete next[label];
    else next[label] = name;
    if (Object.keys(next).length > MAX_ICONS) return;
    this.map = next;
    this.#write();
  }

  /** Back to the guess for one label. */
  resetIcon(label: string): void {
    if (this.map[label] === undefined) return;
    this.setIcon(label, null);
  }

  /** Every label back to a guess. */
  resetAll(): void {
    if (Object.keys(this.map).length === 0) return;
    this.map = {};
    this.#write();
  }

  setAuto(on: boolean): void {
    if (this.auto === on) return;
    this.auto = on;
    this.#write();
  }

  load(): void {
    if (this.#settled) return;
    this.#settled = true;
    const stored = this.#read();
    if (stored !== null) {
      this.map = stored.map;
      this.auto = stored.auto;
    }
  }

  /** The `icons` namespace value. */
  snapshot(): Record<string, unknown> {
    return { auto: this.auto, map: { ...this.map } };
  }

  /**
   * Take the account's choices.
   *
   * A value that carries no `map` object leaves this device alone — an older
   * client that has never heard of this namespace must not be able to erase a
   * choice by writing nothing.
   */
  adopt(value: Record<string, unknown>): void {
    const read = iconsFromValue(value);
    if (read === null) return;
    this.#settled = true;
    this.map = read.map;
    this.auto = read.auto;
    this.#write();
  }

  #read(): IconChoices | null {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      return iconsFromValue(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  #write(): void {
    try {
      globalThis.localStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify({ auto: this.auto, map: this.map }),
      );
    } catch {
      // A browser with storage off still gets icons for this session; the
      // account's copy is the durable one.
    }
  }
}

export const icons = new IconsState();
