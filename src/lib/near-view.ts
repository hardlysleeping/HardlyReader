/**
 * Tells a row when it is close to being looked at.
 *
 * A view switch used to hand the engine every picture in the list at once: the
 * markup for a card contains an `<img>`, so choosing Cards created sixty of them
 * in one commit and each one started fetching and decoding a full-size photo.
 * `loading="lazy"` does not help there — the images exist, and on a busy commit
 * the engine decodes eagerly to know how big they are.
 *
 * One observer per scroller, with a margin so the next screenful is ready before
 * it arrives. The row decides what to draw from the answer; nothing is measured
 * or cached here.
 */

type Near = (near: boolean) => void;

interface Watcher {
  observer: IntersectionObserver;
  callbacks: Map<Element, Near>;
}

const watchers = new WeakMap<Element, Watcher>();

function watcherFor(root: Element, margin: string): Watcher {
  const existing = watchers.get(root);
  if (existing !== undefined) return existing;
  const callbacks = new Map<Element, Near>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
    },
    { root, rootMargin: margin },
  );
  const watcher: Watcher = { observer, callbacks };
  watchers.set(root, watcher);
  return watcher;
}

export interface NearOptions {
  /** The scroll port the row lives in. */
  root: Element | null;
  /** How far outside it counts as near. */
  margin?: string;
  near: Near;
}

/**
 * `use:near={{ root, near: (isNear) => … }}`
 *
 * Answers immediately on attach with the truth, so a row that is already on
 * screen does not wait for a callback to draw its picture.
 */
export function near(node: Element, options: NearOptions) {
  let watcher: Watcher | null = null;

  const stop = () => {
    if (watcher === null) return;
    watcher.observer.unobserve(node);
    watcher.callbacks.delete(node);
    watcher = null;
  };

  const start = (current: NearOptions) => {
    stop();
    if (current.root === null) {
      current.near(true);
      return;
    }
    watcher = watcherFor(current.root, current.margin ?? "400px 0px");
    watcher.callbacks.set(node, current.near);
    watcher.observer.observe(node);
  };

  start(options);

  return {
    update(next: NearOptions) {
      if (next.root !== options.root) start(next);
      else if (watcher !== null) watcher.callbacks.set(node, next.near);
      options = next;
    },
    destroy() {
      stop();
    },
  };
}
