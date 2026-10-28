/**
 * Export and import: the reader's own copy of the sync data.
 *
 * The folder a provider mirrors is a good place to keep a library but a bad
 * thing to depend on. So the canonical files `docs/sync-format.md` describes can
 * also leave as one zip the reader owns — `HardlyReader-Sync.zip` — and come
 * back later, or on another device, or into another provider's folder. A backup,
 * a recovery, a migration; all three are the same two operations.
 *
 * Two rules decide everything here.
 *
 * - **The archive is the canonical files, not a new format.** `library.json`,
 *   `state.json`, `preferences.json`, `positions.json`, `tombstones.json` and a
 *   `manifest.json` written last: the same groups the folder's one document
 *   carries, split the way the format document names them. Anyone can read the
 *   zip with `unzip` and see their feeds.
 * - **An import is a sync, not a replace.** The zip is decoded into the same
 *   `SyncSnapshot` the folder path uses, then merged through `mergeSnapshots`
 *   and written through `applySnapshot` — the same rules, the same conflict
 *   resolution, the same refusal to touch an article body. Nothing here writes
 *   over a library: the import adds what the archive has and keeps what this
 *   device has.
 *
 * The manifest is read first and refused loudly: a missing one, a format this
 * build does not know, a newer version, or an encryption it cannot undo are all
 * a sentence that names what was found, and nothing is changed.
 */
import { LocalStorageError } from "./driver";
import {
  SYNC_VERSION,
  integrateSnapshot,
  localSnapshot,
  parseSyncSnapshot,
  type ApplyReport,
  type SnapshotSource,
  type SyncConflict,
  type SyncSnapshot,
} from "./sync";
import { readZip, writeZip, type ZipFile } from "../../lib/zip";

/** What the reader gets, whatever they call it. */
export const ARCHIVE_FILE_NAME = "HardlyReader-Sync.zip";

/** The format identity, and it does not change: a provider has no vote on it. */
export const ARCHIVE_FORMAT = "hardlyreader-sync";

/** v1 is plaintext, and the manifest says so rather than leaving it to be guessed. */
export const ARCHIVE_ENCRYPTION = "none";

/** The manifest's name. Written last, read first. */
export const MANIFEST_FILE = "manifest.json";

/**
 * The files an archive holds, in the order they are written.
 *
 * `manifest.json` is not in this list on purpose: it is written after them, so a
 * half-written archive never promises files it does not carry.
 */
export const ARCHIVE_FILES = [
  "library.json",
  "state.json",
  "preferences.json",
  "positions.json",
  "tombstones.json",
] as const;

/** The manifest, as the vault of everything else. */
export interface ArchiveManifest {
  format: string;
  /** The format version, not a counter of exports. A newer one is refused. */
  version: number;
  /** `none` in v1. An unknown value is refused rather than guessed at. */
  encryption: string;
  /** Seconds. When the export was made. */
  writtenAt: number;
  /** Which device made it, for the line in Settings. */
  device: string;
  /** What else is in the zip, so a truncated archive can be told apart. */
  files: string[];
}

/** How much of the library an archive carries, for one sentence in Settings. */
export interface ArchiveCounts {
  feeds: number;
  folders: number;
  marks: number;
  /** True when the archive carries an arrangement: hidden, pins, indent, order. */
  arranged: boolean;
  /** True when it carries a reading position. */
  placed: boolean;
}

/** What an import did, ready for the panel to say in one line. */
export interface ArchiveImport {
  manifest: ArchiveManifest;
  /** The document as it now stands on this device — the caller keeps it as its base. */
  snapshot: SyncSnapshot;
  conflicts: SyncConflict[];
  applied: ApplyReport;
  /** What the archive itself held, not what landed. */
  counts: ArchiveCounts;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ---------------------------------------------------------------------------
 * Writing
 * ------------------------------------------------------------------------- */

function live(record: { removed: boolean }): boolean {
  return !record.removed;
}

/**
 * The snapshot, split into the canonical files.
 *
 * The split follows `docs/sync-format.md`: subscriptions, folders, the moves and
 * the sidebar's arrangement are the library; marks are state; the settings
 * document is preferences; where the reader was is positions; and everything
 * that was deleted is a tombstone, so a device that was away cannot resurrect
 * it. The whole arrangement stays in one record — hidden, pins, indent, both
 * orders — because it is one decision, and splitting it across two files would
 * be two chances to restore half of it.
 */
export function archiveFiles(snapshot: SyncSnapshot, now: Date = new Date()): ZipFile[] {
  const feeds: Record<string, unknown> = {};
  const tombstoneFeeds: Record<string, unknown> = {};
  for (const [url, record] of Object.entries(snapshot.feeds)) {
    (live(record) ? feeds : tombstoneFeeds)[url] = record;
  }
  const folders: Record<string, unknown> = {};
  const tombstoneFolders: Record<string, unknown> = {};
  for (const [name, record] of Object.entries(snapshot.folders)) {
    (live(record) ? folders : tombstoneFolders)[name] = record;
  }

  const library = {
    feeds,
    folders,
    redirects: snapshot.redirects,
    sidebar: snapshot.sidebar,
  };
  const tombstones = { feeds: tombstoneFeeds, folders: tombstoneFolders };

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: SYNC_VERSION,
    encryption: ARCHIVE_ENCRYPTION,
    writtenAt: Math.floor(now.getTime() / 1000),
    device: snapshot.device,
    files: [...ARCHIVE_FILES],
  };

  return [
    { name: "library.json", data: encoder.encode(JSON.stringify(library)) },
    { name: "state.json", data: encoder.encode(JSON.stringify({ marks: snapshot.marks })) },
    { name: "preferences.json", data: encoder.encode(JSON.stringify(snapshot.prefs)) },
    { name: "positions.json", data: encoder.encode(JSON.stringify(snapshot.place)) },
    { name: "tombstones.json", data: encoder.encode(JSON.stringify(tombstones)) },
    // Last, so a file that stopped halfway through is an archive without a
    // manifest — which is a refusal with a sentence, not a partial import.
    { name: MANIFEST_FILE, data: encoder.encode(JSON.stringify(manifest)) },
  ];
}

/** The zip, as bytes. */
export function buildArchive(snapshot: SyncSnapshot, now: Date = new Date()): Uint8Array {
  return writeZip(archiveFiles(snapshot, now), now);
}

/**
 * This device's library as an archive.
 *
 * Exactly the document a sync would have written to a folder — same builder,
 * same stamps — so an export can never disagree with what the reader's other
 * device already holds. It answers the document as well as the bytes, because
 * the line under the button has to say what went into the zip.
 */
export async function exportArchive(options: SnapshotSource): Promise<ArchiveExport> {
  const now = secondsOf(options.now);
  const snapshot = await localSnapshot(options);
  return {
    bytes: buildArchive(snapshot, new Date(now * 1000)),
    snapshot,
    counts: countsOf(snapshot),
  };
}

/** What an export wrote, and what it held. */
export interface ArchiveExport {
  bytes: Uint8Array;
  snapshot: SyncSnapshot;
  counts: ArchiveCounts;
}

/* ---------------------------------------------------------------------------
 * Reading
 * ------------------------------------------------------------------------- */

function secondsOf(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One sentence, and it names what is wrong with the file. */
function refuse(reason: string): never {
  throw new LocalStorageError(`${reason} Nothing was changed.`);
}

/**
 * The manifest, read first and refused loudly.
 *
 * Every refusal names what was found rather than what was expected, because the
 * reader has one line in a settings sheet and a file they chose themselves: "this
 * archive is version 3 and this build reads 1" tells them to update, while "invalid
 * archive" tells them nothing.
 */
function readManifest(files: Map<string, Uint8Array>): ArchiveManifest {
  const raw = files.get(MANIFEST_FILE);
  if (raw === undefined) {
    refuse("That zip has no manifest.json, so it is not a HardlyReader archive.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch {
    refuse("The archive's manifest.json is not readable JSON.");
  }
  if (!isRecord(parsed)) refuse("The archive's manifest.json is not a document this build reads.");

  if (parsed.format !== ARCHIVE_FORMAT) {
    refuse(
      `The archive's manifest names the format ${JSON.stringify(parsed.format)}, not ` +
        `"${ARCHIVE_FORMAT}".`,
    );
  }
  const version = typeof parsed.version === "number" ? parsed.version : 0;
  if (version === 0) refuse("The archive's manifest has no version this build can read.");
  if (version > SYNC_VERSION) {
    refuse(
      `The archive was written by a newer version of HardlyReader (format ${version}; this ` +
        `build reads ${SYNC_VERSION}). Update this device, or the newer copy's data will be ` +
        "read wrongly.",
    );
  }
  const encryption = typeof parsed.encryption === "string" ? parsed.encryption : "";
  if (encryption !== ARCHIVE_ENCRYPTION) {
    refuse(
      encryption === ""
        ? "The archive's manifest does not say whether it is encrypted."
        : `The archive is encrypted with ${JSON.stringify(encryption)}, which this build cannot read.`,
    );
  }

  const listed = Array.isArray(parsed.files)
    ? parsed.files.filter((name): name is string => typeof name === "string")
    : [];
  for (const name of ARCHIVE_FILES) {
    if (!listed.includes(name)) {
      refuse(`The archive's manifest does not list ${name}.`);
    }
    if (!files.has(name)) {
      refuse(`The archive has a manifest for ${name} but the file is not in the zip.`);
    }
  }

  return {
    format: ARCHIVE_FORMAT,
    version,
    encryption,
    writtenAt: typeof parsed.writtenAt === "number" ? parsed.writtenAt : 0,
    device: typeof parsed.device === "string" ? parsed.device : "",
    files: listed,
  };
}

/** One JSON file from the zip, refused by name when it is not what it should be. */
function readFile(files: Map<string, Uint8Array>, name: string, shape: "object" | "any"): unknown {
  const raw = files.get(name);
  if (raw === undefined) refuse(`The archive has no ${name}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch {
    refuse(`${name} in the archive is not readable JSON.`);
  }
  if (shape === "object" && !isRecord(parsed)) {
    refuse(`${name} in the archive is not a document this build reads.`);
  }
  return parsed;
}

/**
 * The archive, decoded into the same document the folder path carries.
 *
 * The pieces are put back into one `SyncSnapshot` and handed to
 * `parseSyncSnapshot`, so the records are read — and a document written by a
 * newer build refused — by exactly the code that reads a folder. A file that
 * arrived from a writer this build does not know is therefore not a second
 * parser with its own bugs.
 */
export async function readArchive(bytes: Uint8Array): Promise<{
  manifest: ArchiveManifest;
  snapshot: SyncSnapshot;
}> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(bytes);
  } catch (error) {
    refuse(
      `That file is not a HardlyReader archive — ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }

  const manifest = readManifest(files);
  const library = readFile(files, "library.json", "object") as Record<string, unknown>;
  const state = readFile(files, "state.json", "object") as Record<string, unknown>;
  const preferences = readFile(files, "preferences.json", "object");
  const positions = readFile(files, "positions.json", "any");
  const tombstones = readFile(files, "tombstones.json", "object") as Record<string, unknown>;

  const deletedFeeds = isRecord(tombstones.feeds) ? tombstones.feeds : {};
  const deletedFolders = isRecord(tombstones.folders) ? tombstones.folders : {};
  const liveFeeds = isRecord(library.feeds) ? library.feeds : {};
  const liveFolders = isRecord(library.folders) ? library.folders : {};

  // A live subscription wins over a tombstone for the same key: the same rule
  // the merge uses, and the only reading that cannot delete a feed the archive
  // also says is here.
  const document = {
    version: manifest.version,
    device: manifest.device,
    writtenAt: manifest.writtenAt,
    feeds: { ...deletedFeeds, ...liveFeeds },
    folders: { ...deletedFolders, ...liveFolders },
    redirects: isRecord(library.redirects) ? library.redirects : {},
    marks: isRecord(state.marks) ? state.marks : {},
    prefs: preferences,
    sidebar: library.sidebar ?? null,
    place: positions,
  };

  try {
    return { manifest, snapshot: parseSyncSnapshot(JSON.stringify(document)) };
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Merges an archive into this device's library.
 *
 * The whole point of the card: an import runs the engine. This device's document
 * is built, the archive's is merged in with the same conflict rules a folder
 * sync uses, and the result is written through `applySnapshot` — so a feed this
 * device has is moved rather than duplicated, an article body is never touched,
 * a mark for a post this device has not fetched is kept in the document instead
 * of refused, and nothing the reader owns disappears because a zip arrived.
 *
 * `base` is the last agreement, so a device that has synced before gets the
 * honest three-way merge; a device that has not passes null and the same rules
 * settle the two copies on their stamps.
 */
export async function importArchive(
  options: SnapshotSource & { bytes: Uint8Array },
): Promise<ArchiveImport> {
  const { manifest, snapshot: incoming } = await readArchive(options.bytes);
  const local = await localSnapshot(options);
  const merged = await integrateSnapshot(options, local, incoming);
  return {
    manifest,
    snapshot: merged.snapshot,
    conflicts: merged.conflicts,
    applied: merged.applied,
    counts: countsOf(incoming),
  };
}

/** What an archive holds, counted the way the panel's line says it. */
export function countsOf(snapshot: SyncSnapshot): ArchiveCounts {
  const feeds = Object.values(snapshot.feeds).filter(live).length;
  const folders = Object.values(snapshot.folders).filter(live).length;
  const marks = Object.values(snapshot.marks).filter(
    (record) => record.read || record.starred,
  ).length;
  const sidebar = snapshot.sidebar;
  return {
    feeds,
    folders,
    marks,
    arranged:
      sidebar !== null &&
      (sidebar.hidden.length > 0 ||
        sidebar.pins.length > 0 ||
        sidebar.pinFeeds.length > 0 ||
        sidebar.indentPx !== null ||
        sidebar.feedOrder.length > 0 ||
        sidebar.categoryOrder.length > 0),
    placed: snapshot.place !== null,
  };
}

/** "1 feed", "4 folders" — a count with its noun, never "1 feeds". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What an archive holds, in a settings line. */
export function describeCounts(counts: ArchiveCounts): string {
  const parts = [plural(counts.feeds, "feed"), plural(counts.folders, "folder")];
  if (counts.marks > 0) parts.push(plural(counts.marks, "mark"));
  if (counts.arranged) parts.push("the sidebar's arrangement");
  if (counts.placed) parts.push("a reading position");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * What an import did, in one line.
 *
 * Counts what landed and counts what did not: a mark for an article this device
 * has never fetched is not a failure, but it is not a mark here either, and a
 * line that said "imported 37 marks" while 30 of them waited would be the kind
 * of half-truth this app does not print. A disagreement resolved by the merge is
 * named too, because it is the one thing the reader might want to look at.
 */
export function describeImport(result: ArchiveImport): string {
  const { applied, conflicts, counts } = result;
  const landed = applied.feedsAdded.length + applied.foldersAdded.length + applied.marksApplied;
  const conflictsPart =
    conflicts.length === 0
      ? ""
      : ` ${plural(conflicts.length, "record")} differed and the newer copy was kept.`;

  if (landed === 0) {
    const nothing = applied.marksSkipped > 0
      ? `Nothing new arrived: the archive's ${plural(applied.marksSkipped, "mark")} are for posts this device has not fetched yet.`
      : "The archive held nothing this device did not already have.";
    return `${nothing}${conflictsPart}`;
  }

  const parts: string[] = [];
  if (applied.feedsAdded.length > 0) parts.push(plural(applied.feedsAdded.length, "feed"));
  if (applied.foldersAdded.length > 0) parts.push(plural(applied.foldersAdded.length, "folder"));
  if (applied.feedsMoved.length > 0) parts.push(`${plural(applied.feedsMoved.length, "feed")} refiled`);
  if (applied.feedsRemoved.length > 0) parts.push(plural(applied.feedsRemoved.length, "feed") + " removed");
  if (applied.foldersRemoved.length > 0) parts.push(plural(applied.foldersRemoved.length, "folder") + " removed");
  if (applied.marksApplied > 0) parts.push(plural(applied.marksApplied, "mark"));

  const sentence =
    parts.length === 1
      ? `Imported ${parts[0]} from the archive`
      : `Imported ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]} from the archive`;
  const waiting =
    applied.marksSkipped > 0
      ? `; ${plural(applied.marksSkipped, "mark")} kept for posts this device has not fetched`
      : "";
  const held = counts.feeds === 0 ? " (the archive held no feeds)" : "";
  return `${sentence}${waiting}${held}.${conflictsPart}`;
}
