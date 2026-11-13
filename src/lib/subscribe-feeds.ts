/**
 * Subscribing to a list of feeds, through whatever backend is in hand.
 *
 * Adding feeds exists in three places that must behave identically: the sidebar's
 * add form, an OPML import, and — since the phone's share sheet can carry one —
 * a URL handed in from outside the app. They differ only in what they do with
 * the answer (a form that stays open on failure, a sidebar that reloads, a
 * message with no UI at all), so the subscribing itself lives here.
 *
 * The rules are the ones the sidebar already kept, and they are kept because a
 * burst is what FreshRSS is bad at:
 *
 * - **Sequential, never parallel.** Four subscribes at once is a server that
 *   answers three of them and times out on the fourth.
 * - **A failure does not stop the run.** The point of pasting a list is to get
 *   as many in as possible; the failures come back with the server's own words
 *   so they can be fixed and retried without retyping the rest.
 * - **One fetch at the end, only if something was added.** A subscription on a
 *   local library starts empty, so the first thing a new feed shows is "no
 *   articles" and a sync button unless it is fetched now. A backend with no
 *   crawler behind it declares no `fetchNew` and is left alone.
 *
 * What is not here: the sidebar reload, the progress bar, the error banner and
 * the decision to focus the field. Those are one caller's business, and a shared
 * helper that also redrew the sidebar would be a function every caller has to
 * opt out of.
 */
import type { ReaderBackend } from "../api/backend";
import type { AddFeedsResult } from "./add-feeds";

/** One feed to subscribe to. `category` travels as the GReader label. */
export interface FeedEntry {
  url: string;
  title?: string;
  category?: string;
}

/** Reported after each attempt: `done` of `total`, so a form can show a count. */
export type FeedProgress = (done: number, total: number) => void;

/** Reads whatever a thrown value says, without turning a non-Error into "undefined". */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function subscribeFeeds(
  backend: ReaderBackend,
  entries: readonly FeedEntry[],
  onProgress?: FeedProgress,
): Promise<AddFeedsResult> {
  const result: AddFeedsResult = { added: [], failed: [] };

  for (const entry of entries) {
    try {
      await backend.subscribe({ feedUrl: entry.url, title: entry.title, category: entry.category });
      result.added.push(entry.url);
    } catch (error) {
      result.failed.push({ url: entry.url, error: message(error) });
    }
    onProgress?.(result.added.length + result.failed.length, entries.length);
  }

  if (result.added.length > 0 && backend.fetchNew !== undefined) {
    try {
      await backend.fetchNew({ wake: "manual" });
    } catch {
      /* the feed is subscribed; a failed first fetch is the poll's to report */
    }
  }

  return result;
}
