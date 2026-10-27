/**
 * Local mode, on two devices.
 *
 * A local library has no server behind it, so two devices hold two libraries
 * that know nothing about each other. This file is what closes that gap without
 * inventing a server: one small document, written into a folder the reader
 * already trusts with their own files — an iCloud Drive folder, a Google Drive
 * folder, a synced directory on a network share — and merged whenever a device
 * opens it.
 *
 * Four decisions shape everything below.
 *
 * **Reading state travels; the fetching engine does not.** Subscriptions,
 * folders, read and starred marks, and the settings document the server path
 * already syncs (`lib/prefs-sync`). Article bodies, extraction results, `ETag`s,
 * `Last-Modified`, poll times and failure counts stay on the device that
 * polled: the second device fetches the feed itself, and its own validators are
 * its own business. A file that carried article bodies would be a file that
 * grows without bound and syncs every few minutes.
 *
 * **Merging is three-way, against the last agreement.** Each record carries the
 * second it last changed, so a device that has not touched something cannot
 * claim to be newer than a device that has. The base is this device's memory of
 * what both sides last said — kept beside the library, never written to the
 * folder — and it is what turns "the mark is set" into "the mark changed here
 * since we last agreed". Read and starred are merged as two separate registers,
 * so one device marking an article read and the other starring it both keep
 * their change.
 *
 * **A removal is a record, and it is decided rather than raced.** A deleted
 * feed leaves a tombstone with the time it was deleted. An edit on another
 * device — a rename, a refile — is not a re-subscription and does not bring it
 * back; only a device that has *seen* the tombstone can subscribe again. The
 * feed's last known title travels inside the tombstone so a re-subscription can
 * put it back.
 *
 * **A file this build does not understand is never overwritten.** A newer
 * version of the app may have written a document with more in it; refusing to
 * read it is recoverable, and clobbering it is not.
 *
 * Times are `seconds` in the library half, because that is the unit every row
 * of `schema.ts` already counts in. The settings half carries `PrefsDoc`, whose
 * stamps are milliseconds and whose merge rule is the one the server path uses
 * — reusing it is what stops a device syncing by folder and a device syncing by
 * server from disagreeing about the same reading settings.
 */
import {
  emptyPrefs,
  mergePreferences,
  parsePreferences,
  type PrefsDoc,
  type PrefsNamespace,
} from "../../lib/prefs-sync";
import { LocalStorageError } from "./driver";
import type { EntryRow, FeedRow, FolderRow } from "./schema";
import type { LocalStore } from "./store";
import type { SyncFolder } from "./sync-folder";

/**
 * The document's own version.
 *
 * Bumped only when an older build could read a newer document wrongly — a new
 * group is additive and needs no bump, a changed meaning of a field does.
 */
export const SYNC_VERSION = 1;

/**
 * The file inside the reader's chosen folder.
 *
 * `src-tauri/src/sync.rs` owns the name on the writing side; this copy is what
 * the panel shows and what the suite asserts the two against.
 */
export const SYNC_FILE_NAME = "hardlyreader-sync.json";

/** How long a read/star record with no flags left on it is worth carrying. */
export const MARK_RETENTION_SECONDS = 365 * 24 * 60 * 60;

/** How long a removed feed or folder is remembered, so a delete cannot undo itself. */
export const TOMBSTONE_SECONDS = 180 * 24 * 60 * 60;

/** A bound on what a hostile or corrupt document can make this build allocate. */
const MAX_RECORDS = 50_000;

/** A bound on any one string a document may carry. */
const MAX_TEXT = 2048;

/* ---------------------------------------------------------------------------
 * The document
 * ------------------------------------------------------------------------- */

/**
 * One subscription, as it travels.
 *
 * `at` is when this record last changed on the device that wrote it, not when
 * the feed was added, and it is the only field the merge order depends on. A
 * tombstone is the same shape with `removed` set: the title and folder are kept
 * so a re-subscription has something to restore.
 */
export interface SyncedFeed {
  at: number;
  title: string;
  /** Where the title came from: `feed`, `given` or `url`. */
  titleSource: string;
  folder: string | null;
  addedAt: number;
  removed: boolean;
}

/** One folder, including an empty one. */
export interface SyncedFolder {
  at: number;
  createdAt: number;
  removed: boolean;
}

/**
 * What one device says about one article.
 *
 * Read and starred are separate registers with their own times: two devices
 * doing different things to the same post is the ordinary case, not a conflict.
 */
export interface SyncedMark {
  read: boolean;
  readAt: number;
  starred: boolean;
  starredAt: number;
}

/** The whole shared document. */
export interface SyncSnapshot {
  version: number;
  /** Which device wrote this copy last. Shown in the panel; never merged. */
  device: string;
  /** Seconds. When this copy was written. Never merged. */
  writtenAt: number;
  feeds: Record<string, SyncedFeed>;
  folders: Record<string, SyncedFolder>;
  marks: Record<string, SyncedMark>;
  /** The settings document the server path also carries. */
  prefs: PrefsDoc;
}

/** A document with nothing in it, for a folder that has never been written. */
export function emptySnapshot(device = "", writtenAt = 0): SyncSnapshot {
  return {
    version: SYNC_VERSION,
    device,
    writtenAt,
    feeds: {},
    folders: {},
    marks: {},
    prefs: emptyPrefs(),
  };
}

/* ---------------------------------------------------------------------------
 * Reading a document back
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string this build is willing to keep, or null. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : null;
}

/** Whole seconds, never negative, never a fraction, never `NaN`. */
function stamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function flag(value: unknown): boolean {
  return value === true;
}

function parseFeed(raw: unknown): SyncedFeed | null {
  if (!isRecord(raw)) return null;
  const title = text(raw.title);
  const titleSource = text(raw.titleSource);
  if (title === null || titleSource === null) return null;
  const folder = raw.folder === null ? null : text(raw.folder);
  if (raw.folder !== null && folder === null) return null;
  return {
    at: stamp(raw.at),
    title,
    titleSource,
    folder,
    addedAt: stamp(raw.addedAt),
    removed: flag(raw.removed),
  };
}

function parseFolder(raw: unknown): SyncedFolder | null {
  if (!isRecord(raw)) return null;
  return {
    at: stamp(raw.at),
    createdAt: stamp(raw.createdAt),
    removed: flag(raw.removed),
  };
}

function parseMark(raw: unknown): SyncedMark | null {
  if (!isRecord(raw)) return null;
  return {
    read: flag(raw.read),
    readAt: stamp(raw.readAt),
    starred: flag(raw.starred),
    starredAt: stamp(raw.starredAt),
  };
}

/**
 * Reads whatever the folder held.
 *
 * Tolerant about *shape* and strict about *version*: a record this build cannot
 * make sense of is dropped and the rest of the document still arrives, but a
 * document written by a newer build is refused outright — reading it wrongly
 * and writing the result back is how a newer device's data gets erased.
 */
export function parseSyncSnapshot(raw: string): SyncSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalStorageError(
      "The sync file is not readable — it is not the document HardlyReader writes. " +
        "Nothing was changed; move the file aside to start a new one.",
    );
  }
  if (!isRecord(parsed)) {
    throw new LocalStorageError("The sync file is not a HardlyReader document. Nothing was changed.");
  }

  const version = typeof parsed.version === "number" ? parsed.version : 0;
  if (version > SYNC_VERSION) {
    throw new LocalStorageError(
      `The sync file was written by a newer version of HardlyReader (document ${version}). ` +
        "Update this device, or the newer one's changes will be overwritten.",
    );
  }

  const snapshot: SyncSnapshot = {
    version: SYNC_VERSION,
    device: text(parsed.device) ?? "",
    writtenAt: stamp(parsed.writtenAt),
    feeds: {},
    folders: {},
    marks: {},
    prefs: parsePreferences(parsed.prefs),
  };

  const groups = [
    ["feeds", snapshot.feeds, parseFeed] as const,
    ["folders", snapshot.folders, parseFolder] as const,
    ["marks", snapshot.marks, parseMark] as const,
  ];
  for (const [name, into, parse] of groups) {
    const group = isRecord(parsed[name]) ? parsed[name] : {};
    let kept = 0;
    for (const [key, value] of Object.entries(group)) {
      if (kept >= MAX_RECORDS) break;
      if (key === "" || key.length > MAX_TEXT) continue;
      const record = parse(value);
      if (record === null) continue;
      into[key] = record as never;
      kept += 1;
    }
  }

  return snapshot;
}

/** The document as it goes into the folder. Compact: a cloud folder syncs every byte. */
export function serializeSnapshot(snapshot: SyncSnapshot): string {
  return JSON.stringify(snapshot);
}

/* ---------------------------------------------------------------------------
 * Building this device's copy
 * ------------------------------------------------------------------------- */

/** The rows a snapshot is built from, so the build can be proved without a store. */
export interface SnapshotRows {
  feeds: readonly FeedRow[];
  folders: readonly FolderRow[];
  entries: readonly Pick<EntryRow, "key" | "read" | "starred" | "stored_at">[];
}

export interface BuildSnapshotOptions {
  rows: SnapshotRows;
  /** What both sides last agreed on, or null before the first sync. */
  base: SyncSnapshot | null;
  prefs: PrefsDoc;
  device: string;
  now?: number;
}

function seconds(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

/**
 * The same subscription, ignoring when it was last touched.
 *
 * `at` is deliberately not part of this: a record that has not changed since the
 * last agreement must be recognised as unchanged even though the device building
 * the snapshot would date it differently. When two copies say the same thing,
 * the newer `at` rides along — it is the one thing worth keeping from the copy
 * that moved more recently.
 */
function sameFeed(a: SyncedFeed, b: SyncedFeed): boolean {
  return (
    a.title === b.title &&
    a.titleSource === b.titleSource &&
    a.folder === b.folder &&
    a.addedAt === b.addedAt &&
    a.removed === b.removed
  );
}

function sameFolder(a: SyncedFolder, b: SyncedFolder): boolean {
  return a.createdAt === b.createdAt && a.removed === b.removed;
}

/**
 * This device's half of the next merge.
 *
 * The interesting part is what `at` means. A record the last agreement already
 * had, unchanged, keeps the time it was agreed by — so a device that has done
 * nothing cannot win an argument with a device that has. A record that differs
 * from the agreement, or is new, is stamped now, because this is the first
 * moment this device can honestly say when it changed.
 *
 * A feed or folder the agreement had and the library no longer does is a
 * removal, stamped now; its last known name travels inside the tombstone so a
 * re-subscription elsewhere has something to restore. Marks are only carried
 * while they say something (`read`, `starred`) or are still recent enough to be
 * worth remembering as an unmark.
 */
export function buildSnapshot(options: BuildSnapshotOptions): SyncSnapshot {
  const now = seconds(options.now);
  const base = options.base;
  const snapshot = emptySnapshot(options.device, now);

  for (const row of options.rows.feeds) {
    const record: SyncedFeed = {
      at: now,
      title: row.title,
      titleSource: row.title_source,
      folder: row.folder,
      addedAt: row.added_at,
      removed: false,
    };
    const agreed = base?.feeds[row.key];
    snapshot.feeds[row.key] = agreed !== undefined && sameFeed(agreed, record) ? agreed : record;
  }

  for (const row of options.rows.folders) {
    const record: SyncedFolder = { at: now, createdAt: row.created_at, removed: false };
    const agreed = base?.folders[row.key];
    snapshot.folders[row.key] = agreed !== undefined && sameFolder(agreed, record) ? agreed : record;
  }

  for (const row of options.rows.entries) {
    const agreed = base?.marks[row.key];
    if (agreed === undefined) {
      const read = row.read === 1;
      const starred = row.starred === 1;
      // A post nobody has marked is not worth a record; it will get one the
      // moment it is read or starred.
      if (!read && !starred) continue;
      snapshot.marks[row.key] = {
        read,
        readAt: read ? now : 0,
        starred,
        starredAt: starred ? now : 0,
      };
      continue;
    }

    // An article that arrived on this device after the last agreement has never
    // been compared, and its unread state is what a fetch writes, not something
    // the reader did. Reporting it as an unmark would delete the mark the other
    // device put there — so an arrival inherits the agreement, and only a mark
    // the reader added, or an unmark of an article that was already here, is a
    // change worth a stamp.
    const fresh = row.stored_at >= (base?.writtenAt ?? 0);
    let read = row.read === 1;
    let starred = row.starred === 1;
    let readAt = agreed.readAt;
    let starredAt = agreed.starredAt;

    if (agreed.read !== read) {
      if (read || !fresh) readAt = now;
      else read = agreed.read;
    }
    if (agreed.starred !== starred) {
      if (starred || !fresh) starredAt = now;
      else starred = agreed.starred;
    }

    const record: SyncedMark = { read, readAt, starred, starredAt };
    // An unmark is worth carrying for a while — it is how a star removed here
    // reaches the other device — but not forever.
    const lastMark = Math.max(record.readAt, record.starredAt);
    if (!read && !starred && now - lastMark > MARK_RETENTION_SECONDS) continue;
    snapshot.marks[row.key] = record;
  }

  // Everything the agreement knew that this device does not holds a removal or
  // a mark for an article it never fetched; both still have to travel.
  for (const [url, record] of Object.entries(base?.feeds ?? {})) {
    if (snapshot.feeds[url] !== undefined) continue;
    snapshot.feeds[url] = record.removed ? record : { ...record, removed: true, at: now };
  }
  for (const [name, record] of Object.entries(base?.folders ?? {})) {
    if (snapshot.folders[name] !== undefined) continue;
    snapshot.folders[name] = record.removed ? record : { ...record, removed: true, at: now };
  }
  for (const [id, record] of Object.entries(base?.marks ?? {})) {
    if (snapshot.marks[id] === undefined) snapshot.marks[id] = record;
  }

  snapshot.prefs = options.prefs;
  return pruneSnapshot(snapshot, now);
}

/** Drops what has outlived its usefulness: old tombstones and old unmarks. */
export function pruneSnapshot(snapshot: SyncSnapshot, now: number): SyncSnapshot {
  const pruned: SyncSnapshot = { ...snapshot, feeds: {}, folders: {}, marks: {} };
  for (const [url, record] of Object.entries(snapshot.feeds)) {
    if (record.removed && now - Math.max(record.at, 1) > TOMBSTONE_SECONDS) continue;
    pruned.feeds[url] = record;
  }
  for (const [name, record] of Object.entries(snapshot.folders)) {
    if (record.removed && now - Math.max(record.at, 1) > TOMBSTONE_SECONDS) continue;
    pruned.folders[name] = record;
  }
  for (const [id, record] of Object.entries(snapshot.marks)) {
    const last = Math.max(record.readAt, record.starredAt);
    if (!record.read && !record.starred && now - last > MARK_RETENTION_SECONDS) continue;
    pruned.marks[id] = record;
  }
  return pruned;
}

/* ---------------------------------------------------------------------------
 * Merging two copies
 * ------------------------------------------------------------------------- */

/** One disagreement, in the reader's words, for the panel and the log. */
export interface SyncConflict {
  group: "feed" | "folder" | "mark" | "prefs";
  key: string;
  /** Whose value survived: this device's, or the folder's. */
  kept: "device" | "folder";
  /** What the losing copy said, in a line. */
  dropped: string;
}

export interface SnapshotMerge {
  snapshot: SyncSnapshot;
  conflicts: SyncConflict[];
  /** Settings namespaces whose value came from the folder's copy. */
  adoptedPrefs: PrefsNamespace[];
}

/**
 * Which of three copies of a record wins.
 *
 * `none` is the ordinary case: unchanged on both sides. `device` and `folder`
 * say only one side moved, which is not a conflict. Two changed copies of the
 * same record are — and the newer record wins, with the dropped line kept so
 * the reader can be told what did not travel.
 */
type Choice = { kept: "device" | "folder" | "none"; both: boolean };

function choose<T>(
  local: T | undefined,
  remote: T | undefined,
  base: T | undefined,
  same: (a: T, b: T) => boolean,
  at: (record: T) => number,
  tie: (a: T, b: T) => number,
): Choice {
  if (local === undefined || remote === undefined) {
    return { kept: local === undefined ? "folder" : "device", both: false };
  }
  if (same(local, remote)) {
    // The same value from both sides is not a disagreement; the newer stamp is
    // the one worth carrying forward so a third device sees one answer.
    return { kept: at(local) >= at(remote) ? "device" : "folder", both: false };
  }
  if (base !== undefined && same(local, base)) return { kept: "folder", both: false };
  if (base !== undefined && same(remote, base)) return { kept: "device", both: false };

  const localAt = at(local);
  const remoteAt = at(remote);
  if (localAt !== remoteAt) return { kept: localAt > remoteAt ? "device" : "folder", both: true };
  // Same second on both sides: a stable comparison rather than "the one I read
  // first", so both devices settle on the same copy instead of flapping.
  return { kept: tie(local, remote) >= 0 ? "device" : "folder", both: true };
}

function feedTie(a: SyncedFeed, b: SyncedFeed): number {
  return a.title.localeCompare(b.title) || Number(a.removed) - Number(b.removed);
}

function folderTie(a: SyncedFolder, b: SyncedFolder): number {
  return Number(a.removed) - Number(b.removed) || a.createdAt - b.createdAt;
}

function description(record: SyncedFeed | SyncedFolder | SyncedMark): string {
  if ("title" in record) return record.removed ? "removed" : `"${record.title}"`;
  if ("createdAt" in record) return record.removed ? "removed" : "kept";
  const parts: string[] = [];
  if (record.read) parts.push("read");
  if (record.starred) parts.push("starred");
  return parts.length === 0 ? "not marked" : parts.join(", ");
}

/**
 * Merges this device's copy with the folder's.
 *
 * The library half is three-way per record. The settings half is handed to
 * `mergePreferences`, the rule the server path already applies, so a reader who
 * uses both a folder and a FreshRSS account gets one answer about text size
 * rather than two.
 */
export function mergeSnapshots(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  base: SyncSnapshot | null,
): SnapshotMerge {
  const conflicts: SyncConflict[] = [];
  const merged = emptySnapshot(local.device, local.writtenAt);

  const feedKeys = new Set([
    ...Object.keys(local.feeds),
    ...Object.keys(remote.feeds),
    ...Object.keys(base?.feeds ?? {}),
  ]);
  for (const url of feedKeys) {
    const mine = local.feeds[url];
    const theirs = remote.feeds[url];
    // A tombstone is a decision, not a stale copy: a rename or a refile on the
    // other device is not a re-subscription and must not undo a delete. Only a
    // device that has seen the tombstone can bring the feed back.
    if (mine !== undefined && theirs !== undefined && mine.removed !== theirs.removed) {
      const resurrect = base?.feeds[url]?.removed === true;
      const kept = resurrect
        ? mine.removed
          ? "folder"
          : "device"
        : mine.removed
          ? "device"
          : "folder";
      const chosen = kept === "device" ? mine : theirs;
      merged.feeds[url] = chosen;
      conflicts.push({
        group: "feed",
        key: url,
        kept,
        dropped: resurrect ? "removed" : `"${(kept === "device" ? theirs : mine).title}"`,
      });
      continue;
    }

    const choice = choose(mine, theirs, base?.feeds[url], sameFeed, (record) => record.at, feedTie);
    const chosen = choice.kept === "folder" ? theirs : mine;
    if (chosen === undefined) continue;
    merged.feeds[url] = chosen;
    if (choice.both) {
      const dropped = choice.kept === "device" ? theirs : mine;
      conflicts.push({
        group: "feed",
        key: url,
        kept: choice.kept === "none" ? "device" : choice.kept,
        dropped: dropped === undefined ? "" : description(dropped),
      });
    }
  }

  const folderKeys = new Set([
    ...Object.keys(local.folders),
    ...Object.keys(remote.folders),
    ...Object.keys(base?.folders ?? {}),
  ]);
  for (const name of folderKeys) {
    const mine = local.folders[name];
    const theirs = remote.folders[name];
    if (mine !== undefined && theirs !== undefined && mine.removed !== theirs.removed) {
      const resurrect = base?.folders[name]?.removed === true;
      const kept = resurrect === (mine.removed === false) ? "device" : "folder";
      merged.folders[name] = kept === "device" ? mine : theirs;
      conflicts.push({
        group: "folder",
        key: name,
        kept,
        dropped: resurrect ? "removed" : "kept",
      });
      continue;
    }

    const choice = choose(
      mine,
      theirs,
      base?.folders[name],
      sameFolder,
      (record) => record.at,
      folderTie,
    );
    const chosen = choice.kept === "folder" ? theirs : mine;
    if (chosen === undefined) continue;
    merged.folders[name] = chosen;
    if (choice.both) {
      const dropped = choice.kept === "device" ? theirs : mine;
      conflicts.push({
        group: "folder",
        key: name,
        kept: choice.kept === "none" ? "device" : choice.kept,
        dropped: dropped === undefined ? "" : description(dropped),
      });
    }
  }

  const markKeys = new Set([
    ...Object.keys(local.marks),
    ...Object.keys(remote.marks),
    ...Object.keys(base?.marks ?? {}),
  ]);
  for (const id of markKeys) {
    const mine = local.marks[id];
    const theirs = remote.marks[id];
    const record: SyncedMark = {
      read: false,
      readAt: 0,
      starred: false,
      starredAt: 0,
    };
    let any = false;

    for (const field of ["read", "starred"] as const) {
      const atKey = field === "read" ? "readAt" : "starredAt";
      const mineAt = mine?.[atKey] ?? 0;
      const theirsAt = theirs?.[atKey] ?? 0;
      const mineValue = mine?.[field] ?? false;
      const theirsValue = theirs?.[field] ?? false;

      let from: "device" | "folder";
      if (mineAt === theirsAt) {
        // Same instant: the flag itself breaks the tie, so both devices agree.
        from = Number(mineValue) >= Number(theirsValue) ? "device" : "folder";
      } else {
        from = mineAt > theirsAt ? "device" : "folder";
      }
      const value = from === "device" ? mineValue : theirsValue;
      const when = from === "device" ? mineAt : theirsAt;

      if (value) {
        record[field] = true;
        record[atKey] = when;
      } else if (when > 0) {
        record[atKey] = when;
      }
      if (value || when > 0) any = true;
    }

    if (any) merged.marks[id] = record;
  }

  const prefsMerge = mergePreferences(local.prefs, remote.prefs);
  merged.prefs = prefsMerge.doc;
  for (const namespace of prefsMerge.adopted) {
    conflicts.push({ group: "prefs", key: namespace, kept: "folder", dropped: "this device's copy" });
  }

  return { snapshot: merged, conflicts, adoptedPrefs: prefsMerge.adopted };
}

/* ---------------------------------------------------------------------------
 * Putting the merged copy into the library
 * ------------------------------------------------------------------------- */

/** What one merge changed here, so the panel can say so and the suite can assert it. */
export interface ApplyReport {
  feedsAdded: string[];
  feedsRemoved: string[];
  feedsMoved: string[];
  /** Feeds whose name came from the folder's copy. */
  feedsRenamed: string[];
  foldersAdded: string[];
  foldersRemoved: string[];
  /** Marks written, and marks for articles this device does not hold. */
  marksApplied: number;
  marksSkipped: number;
}

/**
 * Writes a merged document into this device's library.
 *
 * Only the four things that travel are touched. An article's body is never
 * rewritten, an extraction is never dropped, and a feed's poll memory is left
 * exactly as this device had it — a feed adopted from the folder arrives with
 * nothing fetched, which is the truth: this device has not fetched it yet.
 *
 * A mark for an article this device does not hold is skipped rather than
 * refused. The document keeps it, so it lands on the device that does have the
 * post; refusing the whole sync over it would mean one device's unread article
 * could stop the other device's subscriptions from arriving.
 */
export async function applySnapshot(
  store: LocalStore,
  snapshot: SyncSnapshot,
): Promise<ApplyReport> {
  const report: ApplyReport = {
    feedsAdded: [],
    feedsRemoved: [],
    feedsMoved: [],
    feedsRenamed: [],
    foldersAdded: [],
    foldersRemoved: [],
    marksApplied: 0,
    marksSkipped: 0,
  };

  const [feeds, folders] = await Promise.all([store.feeds(), store.folders()]);
  const byUrl = new Map(feeds.map((feed) => [feed.key, feed]));
  const folderNames = new Set(folders.map((folder) => folder.key));

  for (const [name, record] of Object.entries(snapshot.folders)) {
    if (record.removed) {
      if (!folderNames.has(name)) continue;
      if (await store.forgetFolder(name)) report.foldersRemoved.push(name);
      continue;
    }
    if (folderNames.has(name)) continue;
    if (await store.ensureFolder(name)) report.foldersAdded.push(name);
  }

  for (const [url, record] of Object.entries(snapshot.feeds)) {
    const held = byUrl.get(url);
    if (record.removed) {
      if (held === undefined) continue;
      await store.unsubscribe(url);
      report.feedsRemoved.push(url);
      continue;
    }

    if (held === undefined) {
      await store.subscribe(url, {
        // A placeholder title is not a choice: adopting it as one would freeze
        // the host name forever, so a URL-sourced title is left for the first
        // fetch to replace, exactly as a feed added here would be.
        title: record.titleSource === "url" ? undefined : record.title,
        folder: record.folder,
      });
      report.feedsAdded.push(url);
      continue;
    }

    if ((held.folder ?? null) !== record.folder) {
      await store.moveFeed(url, record.folder, held.folder);
      report.feedsMoved.push(url);
    }

    // The name is part of what travels: a feed renamed on the tablet is renamed
    // here, with the source it came with, so a placeholder stays replaceable.
    if (held.title !== record.title || held.title_source !== record.titleSource) {
      if (await store.renameFeed(url, record.title, record.titleSource)) {
        report.feedsRenamed.push(url);
      }
    }
  }

  const flags = await store.entryFlags();
  const held = new Map(flags.map((row) => [row.key, row]));
  const wanted = {
    read: new Set<string>(),
    unread: new Set<string>(),
    starred: new Set<string>(),
    unstarred: new Set<string>(),
  };
  for (const [id, record] of Object.entries(snapshot.marks)) {
    const row = held.get(id);
    if (row === undefined) {
      // Nothing here to mark: the document keeps it for the device that has the
      // article. Counted so the panel can say how much of the file is not for
      // this library.
      report.marksSkipped += 1;
      continue;
    }
    if (record.read !== (row.read === 1)) (record.read ? wanted.read : wanted.unread).add(id);
    if (record.starred !== (row.starred === 1))
      (record.starred ? wanted.starred : wanted.unstarred).add(id);
  }

  for (const [ids, read] of [
    [wanted.read, true],
    [wanted.unread, false],
  ] as const) {
    if (ids.size === 0) continue;
    await store.setRead([...ids], read);
    report.marksApplied += ids.size;
  }
  for (const [ids, starred] of [
    [wanted.starred, true],
    [wanted.unstarred, false],
  ] as const) {
    if (ids.size === 0) continue;
    await store.setStarred([...ids], starred);
    report.marksApplied += ids.size;
  }

  return report;
}

/* ---------------------------------------------------------------------------
 * One sync
 * ------------------------------------------------------------------------- */

/** The settings half, injected so this module needs no runes store of its own. */
export interface SyncPrefs {
  /** This device's document, with the stamps it has already recorded. */
  local: PrefsDoc;
  /** Takes the namespaces whose value came from the folder's copy. */
  adopt(doc: PrefsDoc, namespaces: PrefsNamespace[]): void;
}

export interface SyncRunOptions {
  store: LocalStore;
  folder: SyncFolder;
  /** What to call this device in the document. */
  device: string;
  /** The last agreement, or null before the first sync. */
  base: SyncSnapshot | null;
  prefs: SyncPrefs;
  now?: number;
}

export interface SyncRun {
  /**
   * The document as it now stands — and this device's new base. Persist it;
   * without it the next sync cannot tell a local change from an old value.
   */
  snapshot: SyncSnapshot;
  conflicts: SyncConflict[];
  applied: ApplyReport;
  /** True when the folder already said exactly this, so nothing was written. */
  unchanged: boolean;
}

/** What a document says, ignoring who wrote it and when. */
function sameContent(a: SyncSnapshot, b: SyncSnapshot): boolean {
  return (
    JSON.stringify({ ...a, device: "", writtenAt: 0 }) ===
    JSON.stringify({ ...b, device: "", writtenAt: 0 })
  );
}

/**
 * Reads the folder, merges both libraries and writes the result back.
 *
 * The order matters: the library is brought up to date *before* the file is
 * written, so a device that crashes mid-sync leaves the folder holding a
 * document it has not yet applied rather than the other way round — which is
 * the recoverable direction, because the next run merges it again.
 *
 * A file whose content the merge did not change is not rewritten. Cloud folders
 * upload every write, and a device that opens the app ten times a day should not
 * cost ten uploads of a document nothing changed in.
 */
export async function syncOnce(options: SyncRunOptions): Promise<SyncRun> {
  const now = seconds(options.now);
  const rows: SnapshotRows = {
    feeds: await options.store.feeds(),
    folders: await options.store.folders(),
    entries: await options.store.entryFlags(),
  };

  const local = buildSnapshot({
    rows,
    base: options.base,
    prefs: options.prefs.local,
    device: options.device,
    now,
  });

  const raw = await options.folder.read();
  const remote = raw === null ? null : parseSyncSnapshot(raw);
  const merged = mergeSnapshots(local, remote ?? emptySnapshot(), options.base);

  options.prefs.adopt(merged.snapshot.prefs, merged.adoptedPrefs);
  const applied = await applySnapshot(options.store, merged.snapshot);

  const snapshot: SyncSnapshot = { ...merged.snapshot, device: options.device, writtenAt: now };
  const unchanged = remote !== null && sameContent(remote, snapshot);
  if (!unchanged) await options.folder.write(serializeSnapshot(snapshot));

  return { snapshot, conflicts: merged.conflicts, applied, unchanged };
}
