/**
 * Pins: what the user wants at the top of the sidebar.
 *
 * A pinned category is stored on the server when Favorite Categories is enabled
 * (the extension's "favorite" is the pin, so the FreshRSS web sidebar agrees),
 * and in this app's local storage otherwise. Feeds have no server-side home for
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
  isCategoryPinned: (label: string) => boolean,
  isFeedPinned: (id: string) => boolean,
  isFavourite: (label: string) => boolean = () => false,
): G[] {
  const filtered = groups.filter((group) => {
    if (view === "all") return true;
    const pinned = isCategoryPinned(group.label);
    return view === "only" ? pinned : !pinned;
  });

  // Favourites float above everything, then this device's pins, then the rest.
  // A favourite is a server fact and a pin is local, so they rank separately
  // instead of one standing in for the other.
  const rank = (favourite: boolean, pinned: boolean): number => (favourite ? 0 : pinned ? 1 : 2);
  return filtered
    .map((group) => ({
      ...group,
      feeds: [
        ...group.feeds,
      ].sort(
        (a, b) => rank(false, isFeedPinned(a.id)) - rank(false, isFeedPinned(b.id)) ||
          a.title.localeCompare(b.title),
      ),
    }))
    .sort(
      (a, b) =>
        rank(isFavourite(a.label), isCategoryPinned(a.label)) -
          rank(isFavourite(b.label), isCategoryPinned(b.label)) ||
        a.label.localeCompare(b.label),
    );
}
