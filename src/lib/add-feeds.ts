/**
 * Adding several feeds at once.
 *
 * Pasting a list of URLs is the common case for anyone moving an account over,
 * and one-at-a-time entry turns that into a chore. The parsing lives here so the
 * rules can be tested without a server: one URL per line, blank lines ignored,
 * duplicates dropped, and everything else passed to FreshRSS exactly as written
 * rather than guessed at or rewritten.
 */

/** What a bulk add actually did, so the form can report it honestly. */
export interface AddFeedsResult {
  added: string[];
  failed: { url: string; error: string }[];
}

/**
 * The URLs in a pasted block, in the order they were written.
 *
 * Lines are the unit because that is what a list of feeds looks like when it is
 * copied out of another reader. Whitespace-only lines vanish, and a URL already
 * seen is dropped: subscribing twice to the same feed is a round-trip that can
 * only end in the server's duplicate error, which reads like a failure.
 */
export function parseFeedUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (url === "") continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

/** True when a paste would turn the one-line field into a list. */
export function isMultiLine(text: string): boolean {
  return /\r?\n/.test(text.trimEnd());
}

/**
 * What to tell the reader after a bulk add.
 *
 * One failure returns the server's own words unchanged, which is what the form
 * showed before bulk entry existed; mixing in counts there would bury an
 * actionable message behind arithmetic. Several outcomes get a count first and
 * the first failure after it, because the useful question is "what do I fix",
 * not "how many were there".
 */
export function addFeedsMessage(result: AddFeedsResult): string | null {
  const { added, failed } = result;
  if (added.length === 0 && failed.length === 0) return null;
  if (failed.length === 0) {
    return added.length === 1 ? null : `Added ${added.length} feeds.`;
  }
  if (failed.length === 1 && added.length === 0) return failed[0].error;
  const feeds = failed.length === 1 ? "1 feed" : `${failed.length} feeds`;
  const addedPart = added.length === 0 ? "" : `Added ${added.length}, `;
  const first = failed[0];
  return `${addedPart}${feeds} failed — ${first.url}: ${first.error}`;
}
