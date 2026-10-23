/**
 * Pins: what the user wants at the top of the sidebar.
 *
 * A marked category is one thing. When Favorite Categories is enabled the mark
 * is the extension's favourite, so the FreshRSS web sidebar agrees with this
 * app; without it the same mark is kept in this app's local storage, because
 * there is nowhere else for it to live. Only the storage differs. Feeds have no server-side home for
 * a pin — `priority` already belongs to Hidden and Favorite Categories — so feed
 * pins are always local.
 *
 * Everything here is pure, so ordering and filtering are testable without a
 * browser or a server.
 */

/** The three pin views, in the order the sidebar cycles them. */
export type PinView = "all" | "only" | "without";

export const PIN_VIEW_CYCLE: readonly PinView[] = ["all", "only", "without"];

/** The favourites extension's own words for its three states. */
export const PIN_VIEW_LABELS: Record<PinView, string> = {
  all: "Mixed",
  only: "Pinned",
  without: "Unpinned",
};

export function nextPinView(view: PinView): PinView {
  const index = PIN_VIEW_CYCLE.indexOf(view);
  return PIN_VIEW_CYCLE[(index + 1) % PIN_VIEW_CYCLE.length] ?? "all";
}

export function isPinView(value: unknown): value is PinView {
  return value === "all" || value === "only" || value === "without";
}

/** What is kept on this device. Labels for categories, stream ids for feeds. */
export interface LocalPins {
  categories: string[];
  feeds: string[];
  view: PinView;
}

export function emptyPins(): LocalPins {
  return { categories: [], feeds: [], view: "all" };
}

/** Parses whatever local storage held, discarding anything malformed. */
export function parsePins(raw: unknown): LocalPins {
  if (typeof raw !== "object" || raw === null) return emptyPins();
  const value = raw as Record<string, unknown>;
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    categories: strings(value.categories),
    feeds: strings(value.feeds),
    view: isPinView(value.view) ? value.view : "all",
  };
}

/** Adds or removes one entry, keeping pin order (newest pin last). */
export function withPinned(list: readonly string[], key: string, pinned: boolean): string[] {
  const rest = list.filter((entry) => entry !== key);
  return pinned ? [...rest, key] : rest;
}

interface Group<F> {
  label: string;
  feeds: F[];
}

/**
 * Applies the pin view, then puts pinned categories first and pinned feeds first
 * within each category. Both sorts are stable, so the existing alphabetical
 * order survives inside each band.
 */
export function arrangeByPins<F extends { id: string; title: string }, G extends Group<F>>(
  groups: readonly G[],
  view: PinView,
  isCategoryMarked: (label: string) => boolean,
  isFeedPinned: (id: string) => boolean,
): G[] {
  const filtered = groups.filter((group) => {
    if (view === "all") return true;
    const marked = isCategoryMarked(group.label);
    return view === "only" ? marked : !marked;
  });

  // One band, not two: a marked category is a marked category, whether the
  // server calls it a favourite or this device holds the mark because the
  // extension is not installed. Marked categories come first, then the rest by
  // name; marked feeds come first inside each category.
  return filtered
    .map((group) => ({
      ...group,
      feeds: [...group.feeds].sort(
        (a, b) =>
          Number(isFeedPinned(b.id)) - Number(isFeedPinned(a.id)) || a.title.localeCompare(b.title),
      ),
    }))
    .sort(
      (a, b) =>
        Number(isCategoryMarked(b.label)) - Number(isCategoryMarked(a.label)) ||
        a.label.localeCompare(b.label),
    );
}
