/**
 * OPML in and out, as an action rather than a control.
 *
 * The file handling used to live in the sidebar's footer, because that was the
 * only place a feed list came in or went out. It is not any more: on a phone
 * held upright the footer gives those two controls up so the tree can start
 * 40-odd pixels higher, and they move into `Settings → Feeds`. Two copies of
 * "read the file, subscribe, say what happened" is how the two surfaces end up
 * wording the same outcome differently, so the reading, the subscribing and the
 * sentence live here once, and each surface only draws a button.
 *
 * The download and the clipboard are in here too, for the same reason: the
 * native window's caveat (WebKitGTK saves a blob only if the shell handles it,
 * and this shell does not) is a fact about the app, not about the sidebar.
 */
import { buildOpml, opmlFileName, parseOpml, type OpmlFeed, type OpmlFolder } from "./opml";

/** What to put on the line under the controls: the file in play, and what happened. */
export interface FeedsFileResult {
  /** The file that was read or written. `null` when there was nothing to write. */
  name: string | null;
  /** One sentence, never empty: an import says what landed, an export where it went. */
  note: string;
}

/** The shape both entry points of `reader` answer with. */
export interface SubscribeOutcome {
  added: readonly unknown[];
  failed: readonly { error?: string }[];
}

/** A folder tree, as OPML writes it. */
export interface FeedFolder {
  label: string;
  feeds: readonly { title: string; url: string }[];
}

/**
 * Reads a chosen file and subscribes to what is in it.
 *
 * Folders come with it, because an import that drops them is a worse list than
 * the one the user brought. Never throws: a file that is not OPML, or a server
 * that refuses a feed, is an answer on the same line as a successful import.
 */
export async function importFeedsFile(
  file: File,
  subscribe: (feeds: readonly OpmlFeed[]) => Promise<SubscribeOutcome>,
): Promise<FeedsFileResult> {
  const name = file.name;
  try {
    const feeds = parseOpml(await file.text());
    const result = await subscribe(feeds);
    const folders = new Set(
      feeds.map((feed) => feed.category).filter((label): label is string => label !== undefined),
    );
    if (result.failed.length === 0) {
      const feedsPart = `Imported ${result.added.length} feed${result.added.length === 1 ? "" : "s"}`;
      const foldersPart =
        folders.size > 0 ? ` into ${folders.size} folder${folders.size === 1 ? "" : "s"}` : "";
      return { name, note: `${feedsPart}${foldersPart}.` };
    }
    const failed = result.failed[0]?.error ?? "";
    return { name, note: `Imported ${result.added.length}, ${result.failed.length} failed — ${failed}` };
  } catch (error) {
    return { name, note: error instanceof Error ? error.message : String(error) };
  }
}

/** The anchor-and-blob download every browser understands. */
function saveFile(name: string, xml: string): void {
  const blob = new Blob([xml], { type: "text/x-opml" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Whether the app is inside its own window rather than a browser tab. */
function inWindow(): boolean {
  return typeof window !== "undefined" && typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

/**
 * Writes the feed list out as OPML, folders and all.
 *
 * The native Linux window is the exception the sentence has to carry: WebKitGTK
 * only saves a download if the shell handles it, and this shell does not, so
 * there the file also goes to the clipboard rather than claiming a file that
 * never appeared.
 */
export async function exportFeedsOpml(
  categories: readonly FeedFolder[],
): Promise<FeedsFileResult> {
  const folders: OpmlFolder[] = categories.map((category) => ({
    label: category.label,
    feeds: category.feeds.map((feed) => ({ title: feed.title, url: feed.url })),
  }));
  const total = folders.reduce((count, folder) => count + folder.feeds.length, 0);
  if (total === 0) return { name: null, note: "There are no feeds to export yet." };

  const name = opmlFileName(new Date());
  const xml = buildOpml(folders);
  saveFile(name, xml);

  const feeds = `${total} feed${total === 1 ? "" : "s"}`;
  if (!inWindow()) return { name, note: `Exported ${feeds} to ${name}.` };

  let copied = false;
  try {
    await navigator.clipboard.writeText(xml);
    copied = true;
  } catch {
    copied = false;
  }
  return {
    name,
    note: copied
      ? `Exported ${feeds}. If no file appeared, the OPML is on your clipboard.`
      : `Exported ${feeds} to ${name} — if no file appeared, the window could not save it.`,
  };
}
