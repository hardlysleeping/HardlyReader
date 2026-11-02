/**
 * Open fullscreen pictures: which list, which picture, and how the neighbours
 * are asked for.
 *
 * The session holds the **list as drawn** — the frames an `ArticleList` was
 * showing the moment a grid tile was pressed, plus the reader that drew it — so
 * the walk cannot disagree with the grid behind it: same filter, same order, and
 * star/read go through the same reader that drew the tiles.
 *
 * A snapshot rather than a live query on purpose. A stream that refreshes under
 * an open viewer would change what "next" means between two swipes, and a
 * carousel that renumbers itself while a finger is on it is worse than one that
 * finishes the page it started on.
 */
import type { ReaderState } from "./reader.svelte";
import type { StreamItem } from "../api/freshrss";
import { pictures } from "./pictures.svelte";
import { frameAt, frameIndex, prefetchWindow, stepFrame, type Frame } from "../lib/carousel";

export class CarouselState {
  /** The list being walked, and the reader that drew it. Null when closed. */
  session = $state<{ store: ReaderState; frames: Frame<StreamItem>[] } | null>(null);

  /** Where the walk is. */
  index = $state(0);

  /** One picture at a time is a viewer, not a viewer per press. */
  get frame(): Frame<StreamItem> | null {
    const session = this.session;
    if (session === null) return null;
    return frameAt(session.frames, this.index);
  }

  get open(): boolean {
    return this.session !== null;
  }

  /**
   * Opens on this post, walking the frames the list is drawing.
   *
   * A post with no picture is not in the walk, so it opens nothing: the caller
   * has already asked `framesOf`, and asking it to invent a slide here would put
   * the meaning of a tap in two places.
   */
  show(store: ReaderState, frames: Frame<StreamItem>[], id: string): boolean {
    const at = frameIndex(frames, id);
    if (at < 0) return false;
    this.session = { store, frames };
    this.index = at;
    return true;
  }

  close(): void {
    this.session = null;
  }

  /**
   * Asks the cache for the neighbours, so a swipe lands on a picture instead of
   * on the publisher's server. The picture in front is already being drawn.
   */
  warm(): void {
    const session = this.session;
    if (session === null) return;
    for (const frame of prefetchWindow(session.frames, this.index)) {
      if (frame.id === this.frame?.id) continue;
      pictures.preload(frame.url, "full");
    }
  }

  /** Nearest first: this picture, then the ones a swipe could reach. */
  get window(): Frame<StreamItem>[] {
    const session = this.session;
    if (session === null) return [];
    return prefetchWindow(session.frames, this.index);
  }

  step(delta: number): void {
    const session = this.session;
    if (session === null) return;
    const next = stepFrame(session.frames, this.index, delta);
    if (next === null) return;
    this.index = next.index;
  }
}

export const carousel = new CarouselState();
