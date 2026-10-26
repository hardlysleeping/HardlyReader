/**
 * Where you were when you last closed the app.
 *
 * A reader that opens on the Reading list every time makes you walk back to the
 * feed you were in the middle of, and if a post was open, reopen it. So the
 * place is written whenever it changes — the feed being browsed, the post that
 * was open, and the feed unfolded in the one-column layout — and read back at
 * sign-in.
 *
 * Two rules keep it honest. It is per account, and the account is named by the
 * same slug as everything else in `localStorage` — a hash of the server and the
 * address, neither of which appears in the key — so one login never resumes in
 * another's feed without a key saying whose it is. And it is a hint, not an
 * instruction: a feed that has since been deleted falls back to the Reading
 * list, and a post that is no longer in the first page simply is not reopened.
 * Nothing here calls the network; it is a shape and a key.
 */

import { scopedKey, type AccountIdentity, type KeyStore } from "./account-key";

export interface Place {
  /** The stream that was open. Null means nothing has been remembered yet. */
  streamId: string | null;
  /** Its title, so the sidebar can say where it is before the stream loads. */
  streamTitle: string;
  /** The post that was open, if one was. */
  articleId: string | null;
  /** The feed unfolded in place, in the one-column layout. */
  expandedFeedId: string | null;
  /** Pixels scrolled into the open post, so it reopens on the same line. */
  articleScroll: number;
  /** Pixels scrolled into the list, so the rows are where they were. */
  listScroll: number;
}

export const EMPTY_PLACE: Place = {
  streamId: null,
  streamTitle: "",
  articleId: null,
  expandedFeedId: null,
  articleScroll: 0,
  listScroll: 0,
};

/** The base the place lives under; the account is appended as its slug. */
export const PLACE_BASE = "hardlyreader:place";

/** Per account, like the sidebar's own preferences — by slug, not by name. */
export function placeKey(account: AccountIdentity): string {
  return scopedKey(PLACE_BASE, account);
}

/**
 * What a build before the slug wrote: `hardlyreader:place:<server>|<email>`.
 *
 * Only used to adopt a place already on the device, and only for the account it
 * names. The old blob is left in place, like every other pre-scoping key, so a
 * downgrade still finds it.
 */
export function legacyPlaceKey(account: AccountIdentity): string {
  return `${PLACE_BASE}:${account.serverUrl}|${account.email}`;
}

/**
 * The stored place for this account, adopting the pre-slug key once.
 *
 * Unlike the device-wide preference keys, this one needs no "who claimed it
 * first" bookkeeping: the old key spelled the account out, so a blob found under
 * it can only be this account's.
 */
export function readPlace(storage: KeyStore | undefined, account: AccountIdentity | null): Place {
  if (!storage || account === null) return { ...EMPTY_PLACE };
  const key = placeKey(account);
  const own = get(storage, key);
  if (own !== null) return parseOrEmpty(own);

  const legacy = get(storage, legacyPlaceKey(account));
  if (legacy === null) return { ...EMPTY_PLACE };
  try {
    // Copied forward so the next launch reads the slug key directly.
    storage.setItem(key, legacy);
  } catch {
    /* full or blocked: the value is still this launch's to resume from */
  }
  return parseOrEmpty(legacy);
}

function parseOrEmpty(raw: string): Place {
  try {
    return parsePlace(JSON.parse(raw));
  } catch {
    return { ...EMPTY_PLACE };
  }
}

function get(storage: KeyStore, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Stores where the reader was. Storage that is full or blocked just means the
 * app opens on the Reading list, so failure is silent by design.
 */
export function writePlace(
  storage: KeyStore | undefined,
  account: AccountIdentity | null,
  place: Place,
): void {
  if (!storage || account === null) return;
  try {
    storage.setItem(placeKey(account), JSON.stringify(place));
  } catch {
    /* preferences just do not persist */
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A scroll offset: a finite number of pixels, never negative. */
function pixels(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Reads a stored place, tolerating anything.
 *
 * A stored value can be from an older build or hand-edited, and a malformed one
 * must not cost the user their session: unknown fields are dropped, and a post
 * without a stream is dropped too, because a post cannot be resumed without the
 * feed it came from.
 */
export function parsePlace(value: unknown): Place {
  if (typeof value !== "object" || value === null) return { ...EMPTY_PLACE };
  const raw = value as Record<string, unknown>;
  const streamId = text(raw.streamId);
  if (streamId === null) return { ...EMPTY_PLACE, expandedFeedId: text(raw.expandedFeedId) };
  return {
    streamId,
    streamTitle: text(raw.streamTitle) ?? "Feed",
    articleId: text(raw.articleId),
    expandedFeedId: text(raw.expandedFeedId),
    articleScroll: pixels(raw.articleScroll),
    listScroll: pixels(raw.listScroll),
  };
}
