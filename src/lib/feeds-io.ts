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
 * The save, the share and the clipboard are in here too, for the same reason:
 * "export" is a different gesture in a browser tab, in the native window and on
 * a phone, and the app has to answer all three the same way from one place.
 */
import { buildOpml, opmlFileName, parseOpml, type OpmlFeed, type OpmlFolder } from "./opml";
import { nativeShareAvailable } from "./platform";

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
function anchorDownload(name: string, xml: string): void {
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

/** A phone or a tablet: a sandboxed webview with no downloads folder of its own. */
function onPhone(): boolean {
  return typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * The native save dialog, then a real write.
 *
 * `plugin:dialog|save` is the dialog plugin's own command; it is called through
 * `invoke` rather than the plugin's JS package so the frontend keeps one Tauri
 * dependency. The path it answers with is the ONLY path written to —
 * `files::save_text` refuses a relative one and stages the bytes before renaming
 * them into place.
 *
 * `null` means the reader closed the dialog: a cancel, not a failure.
 */
async function saveThroughDialog(name: string, xml: string): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>("plugin:dialog|save", {
    options: {
      defaultPath: name,
      filters: [{ name: "OPML", extensions: ["opml"] }],
    },
  });
  if (!path) return null;
  return await invoke<string>("save_text", { path, contents: xml });
}

/**
 * The app's own sheet, carrying the file rather than a link.
 *
 * This is the one that runs in the packaged iOS app, and it runs *first*: the
 * page there is served from `tauri://localhost`, which WebKit does not count as
 * a secure context, so `navigator.canShare` is absent and the Web Share call
 * below can only ever answer "no". The export used to stop at that answer and
 * land on the clipboard — a copy of the XML, in a place with no file in it.
 *
 * The bytes go over the bridge, `share_file` writes them into the app's own
 * cache and hands UIKit the file's URL, and the sheet's "Save to Files" is the
 * phone's own prompt. `false` means the bridge refused; the caller then tries
 * Web Share (a browser tab on a phone has it) and finally the clipboard.
 */
async function shareThroughApp(name: string, xml: string): Promise<boolean> {
  if (!nativeShareAvailable()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("share_file", { name, contents: xml });
    return true;
  } catch {
    return false;
  }
}

/**
 * The share sheet, which is the only way a file leaves a phone.
 *
 * Its "Save to Files" is the phone's own prompt; there is no downloads folder a
 * webview may write to. Answers false when the shell will not share a document,
 * so the caller can fall back to the clipboard instead of claiming a file.
 */
async function shareThroughSheet(name: string, xml: string): Promise<boolean> {
  const file = new File([xml], name, { type: "text/x-opml" });
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) !== true) return false;
  try {
    await nav.share({ files: [file], title: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the feed list out as OPML, folders and all.
 *
 * Three shells, three answers, because "export" means a different gesture in
 * each of them:
 *
 * - the native window: a Save dialog, then the file lands where the reader put
 *   it. Closing the dialog is a cancel, and says so.
 * - a phone: the share sheet, whose Save to Files is the phone's own prompt.
 * - a browser tab: the anchor download every browser understands.
 *
 * When the shell can do neither of the native two, the OPML goes to the
 * clipboard rather than claiming a file that never appeared.
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
  const feeds = `${total} feed${total === 1 ? "" : "s"}`;

  if (!inWindow()) {
    anchorDownload(name, xml);
    return { name, note: `Exported ${feeds} to ${name}.` };
  }

  if (onPhone()) {
    // The app's own sheet first: on iOS it is the only one that exists, and it
    // is the one whose "Save to Files" puts the file where the reader can find
    // it. Web Share is the browser tab's answer, and comes second.
    if (await shareThroughApp(name, xml)) {
      return { name, note: `Exported ${feeds} — choose where to save it.` };
    }
    if (await shareThroughSheet(name, xml)) {
      return { name, note: `Exported ${feeds} — saved from the share sheet.` };
    }
  } else {
    try {
      const saved = await saveThroughDialog(name, xml);
      if (saved === null) return { name: null, note: "Export cancelled — no file was written." };
      return { name, note: `Exported ${feeds} to ${saved}` };
    } catch {
      // Fall through to the clipboard: a dialog that cannot open is not a reason
      // to lose the export.
    }
  }

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
      ? `Exported ${feeds}. The window could not save a file, so the OPML is on your clipboard.`
      : `Exported ${feeds} to ${name} — the window could not save it.`,
  };
}
