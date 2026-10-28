/**
 * Getting the archive out of the app.
 *
 * The same three shells `lib/feeds-io` answers for OPML, and for the same
 * reason: "export" is a different gesture in a browser tab, in the native
 * window and on a phone, and the reader has to be told which one happened.
 *
 * - the native window: a Save dialog, then `files::save_bytes` writes the zip
 *   where the reader put it (WebKitGTK ignores an anchor download, so a blob URL
 *   produces no file at all);
 * - a phone: the share sheet, whose Save to Files is the phone's own prompt;
 * - a browser tab: the anchor download every browser understands.
 *
 * There is no clipboard fallback here the way there is for OPML: a zip of JSON
 * is not something a reader can paste anywhere, so a shell that can do none of
 * the three says so instead of pretending.
 */
import { ARCHIVE_FILE_NAME } from "../api/local/sync-archive";

/** What to put on the line under the buttons: the file, and what happened. */
export interface ArchiveFileResult {
  /** The file that was written, or null when nothing was. */
  name: string | null;
  /** One sentence, never empty. */
  note: string;
}

/** Whether the app is inside its own window rather than a browser tab. */
function inWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined"
  );
}

/** A phone or a tablet: a sandboxed webview with no downloads folder of its own. */
function onPhone(): boolean {
  return typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Bytes as base64, which is the only shape a Tauri command's JSON argument can
 * carry a `Uint8Array` in.
 *
 * Chunked, because `String.fromCharCode(...bytes)` on a whole archive is a
 * spread of tens of thousands of arguments and some engines refuse it outright.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

/** The anchor-and-blob download every browser understands. */
function anchorDownload(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/**
 * The native save dialog, then a real write.
 *
 * `plugin:dialog|save` is the dialog plugin's own command, called through
 * `invoke` so the frontend keeps one Tauri dependency. The path it answers with
 * is the ONLY path written to. `null` means the reader closed the dialog: a
 * cancel, not a failure.
 */
async function saveThroughDialog(name: string, bytes: Uint8Array): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>("plugin:dialog|save", {
    options: {
      defaultPath: name,
      filters: [{ name: "HardlyReader archive", extensions: ["zip"] }],
    },
  });
  if (!path) return null;
  return await invoke<string>("save_bytes", { path, contentsBase64: toBase64(bytes) });
}

/** The share sheet, which is the only way a file leaves a phone. */
async function shareThroughSheet(name: string, bytes: Uint8Array): Promise<boolean> {
  const file = new File([bytes as BlobPart], name, { type: "application/zip" });
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) !== true) return false;
  try {
    await nav.share({ files: [file], title: name });
    return true;
  } catch {
    return false;
  }
}

/** Writes the archive out, saying what it held and where it went. */
export async function saveArchiveFile(
  bytes: Uint8Array,
  label: string,
  name: string = ARCHIVE_FILE_NAME,
): Promise<ArchiveFileResult> {
  if (bytes.length === 0) return { name: null, note: "There was nothing to export yet." };

  if (!inWindow()) {
    anchorDownload(name, bytes);
    return { name, note: `Exported ${label} to ${name}.` };
  }

  if (onPhone()) {
    if (await shareThroughSheet(name, bytes)) {
      return { name, note: `Exported ${label} — saved from the share sheet as ${name}.` };
    }
  } else {
    try {
      const saved = await saveThroughDialog(name, bytes);
      if (saved === null) return { name: null, note: "Export cancelled — no file was written." };
      return { name, note: `Exported ${label} to ${saved}.` };
    } catch (error) {
      return {
        name: null,
        note: error instanceof Error ? error.message : "The window could not save the archive.",
      };
    }
  }

  return {
    name: null,
    note: "This window can neither save a file nor share one, so the archive was not written.",
  };
}
