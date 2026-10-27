/**
 * One place that decides what a key means.
 *
 * Arrow keys here are a navigation tree, not a list: Up/Down move between
 * *feeds* in every pane mode, Right enters (feed -> its posts -> the post), and
 * Left backs out one level. That is the owner's specification, and it differs
 * from most readers, where Up/Down walk articles. Article movement is Space,
 * the Up/Down buttons and scrolling.
 */

export type KeyIntent =
  | { type: "stream"; delta: -1 | 1 }
  | { type: "first" }
  | { type: "last" }
  | { type: "enter" }
  | { type: "back" }
  | { type: "page"; direction: -1 | 1; advance: boolean }
  | { type: "escape" }
  | { type: "none" };

export interface KeyContext {
  /** Focus is in an input, textarea or contenteditable: never steal a key. */
  typing: boolean;
  /** The context menu is open and owns its own keys. */
  menuOpen: boolean;
  hasArticle: boolean;
  atArticleStart: boolean;
  atArticleEnd: boolean;
  /**
   * Keyboard focus is inside the article pane — the third pane, once Right has
   * handed it over. Up/Down there are the pane's own scroll, not the post list's
   * walk: a reader who has stepped into the article is moving the page, and a
   * key that silently swapped the article under them would be a different
   * action from the one the pane shows.
   */
  inArticle: boolean;
}

export function resolveKey(key: string, ctx: KeyContext): KeyIntent {
  if (ctx.typing || ctx.menuOpen) return { type: "none" };

  // Inside the article pane the arrows and Home/End belong to the page: the
  // scroller is focused and natively scrolls, so claiming them here would swap
  // the article instead of moving through it.
  if (ctx.inArticle && (key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End")) {
    return { type: "none" };
  }

  switch (key) {
    case "ArrowDown":
      return { type: "stream", delta: 1 };
    case "ArrowUp":
      return { type: "stream", delta: -1 };
    case "ArrowRight":
    case "Enter":
      return { type: "enter" };
    case "ArrowLeft":
      return { type: "back" };
    case "Home":
      return { type: "first" };
    case "End":
      return { type: "last" };
    case "Escape":
      return { type: "escape" };
    case " ":
      if (!ctx.hasArticle) return { type: "enter" };
      // Scrolled to the end and still pressing Space: that is a request for the
      // next article, which is the same thing the Down button does.
      return ctx.atArticleEnd
        ? { type: "page", direction: 1, advance: true }
        : { type: "page", direction: 1, advance: false };
    case "Spacebar": // older WebKit
      return resolveKey(" ", ctx);
    default:
      return { type: "none" };
  }
}

/** Shift+Space pages backwards, and advances backwards at the top. */
export function resolveShiftKey(key: string, ctx: KeyContext): KeyIntent {
  if (ctx.typing || ctx.menuOpen) return { type: "none" };
  if (key !== " " && key !== "Spacebar") return resolveKey(key, ctx);
  if (!ctx.hasArticle) return { type: "enter" };
  return ctx.atArticleStart
    ? { type: "page", direction: -1, advance: true }
    : { type: "page", direction: -1, advance: false };
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    element.isContentEditable === true
  );
}
