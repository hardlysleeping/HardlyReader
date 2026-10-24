/**
 * Where you were when you last closed the app.
 *
 * A reader that opens on the Reading list every time makes you walk back to the
 * feed you were in the middle of, and if a post was open, reopen it. So the
 * place is written whenever it changes — the feed being browsed, the post that
 * was open, and the feed unfolded in the one-column layout — and read back at
 * sign-in.
 *
 * Two rules keep it honest. It is per account (the storage key carries the
 * server and the user), so one login never resumes in another's feed. And it is
 * a hint, not an instruction: a feed that has since been deleted falls back to
 * the Reading list, and a post that is no longer in the first page simply is not
 * reopened. Nothing here calls the network; it is a shape and a key.
 */

export interface Place {
  /** The stream that was open. Null means nothing has been remembered yet. */
  streamId: string | null;
  /** Its title, so the sidebar can say where it is before the stream loads. */
  streamTitle: string;
  /** The post that was open, if one was. */
  articleId: string | null;
  /** The feed unfolded in place, in the one-column layout. */
  expandedFeedId: string | null;
}

export const EMPTY_PLACE: Place = {
  streamId: null,
  streamTitle: "",
  articleId: null,
  expandedFeedId: null,
};

/** Per account, like the sidebar's own preferences. */
export function placeKey(serverUrl: string, email: string): string {
  return `hardlyreader:place:${serverUrl}|${email}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
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
  };
}
