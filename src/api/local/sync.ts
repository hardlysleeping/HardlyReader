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
 * Which folder, or which service that folder belongs to, is not this file's
 * business: `sync-provider.ts` owns the transport and `syncOnce` asks a
 * `SyncProvider` for the document. That is why nothing below names a path.
 *
 * **What the folder holds is a set of files, not one document.** `manifest.json`
 * names the format and its version and is written last, `library.json`,
 * `state.json`, `preferences.json`, `positions.json`, `tombstones.json` and
 * `devices.json` carry the rest (`docs/sync-format.md`). Splitting them is what
 * makes one device's position write cost one small upload instead of the whole
 * library, and it is the layout a second provider is handed — the engine stays
 * the only thing that knows what a feed is. A provider that cannot address a
 * single file keeps getting the whole document in one write, so the folder-backed
 * v1 and a folder written by v1 both keep working: the set is written from the
 * v1 document on first read, and the old file is left where the reader put it.
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
 * **A stamp is not one number.** A record's second is what a person reads, and
 * it is decided by a clock that can be wrong: a phone ten minutes fast would win
 * every argument it entered, and a device that had been offline for a week would
 * lose edits made after the other device last synced. So a record is ordered by
 * three fields — `(at, rev, by)` — where `rev` is the writing device's own
 * revision counter and `by` is its id, and no change is ever dated earlier than
 * one second past the newest second this device has already seen. `RecordStamp`
 * writes the tie-break down; `writeSecond` says why the clamp is a floor rather
 * than a ceiling.
 *
 * **The id this library syncs under is part of the library.** `sync.device` and
 * `sync.rev` are kept in the library's own `meta` rows, not in memory and not in
 * the profile, so a restart keeps the same id and the same counter: an id that
 * changed per run would reach the other device as a new authority carrying the
 * same history, and a counter that restarted at zero would let this device's
 * oldest record beat its newest.
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
import {
  describePlace,
  describeSidebar,
  emptyPlace,
  emptySidebar,
  isEmptySidebar,
  parsePlaceDoc,
  parseSidebar,
  placeTie,
  samePlace,
  sameSidebar,
  sidebarTie,
  type PlaceDoc,
  type SidebarDoc,
} from "../../lib/sidebar-doc";
import { LocalStorageError } from "./driver";
import type { EntryRow, FeedRow, FolderRow } from "./schema";
import { localItemPrefix, redirectTarget, type LocalStore } from "./store";
import type { SyncProvider } from "./sync-provider";

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
 * What order a record comes in
 * ------------------------------------------------------------------------- */

/**
 * The stamp every record carries: when it changed, in which of the writing
 * device's revisions, and which device wrote it.
 *
 * `at` is the only field a person ever reads — it is what the conflict line in
 * the panel shows — so it stays even though it cannot be trusted alone. On its
 * own it makes a phone whose clock is ten minutes fast win every argument it
 * enters, and it makes a device that has been offline for a week lose edits it
 * made after the other device last synced. So a record is ordered by three
 * fields, in this order, and the order is total:
 *
 * 1. **`at`** — the later second wins. Within a copy this is the writing
 *    device's own clock, which is the best available guess at *when* two
 *    genuinely concurrent edits happened; it is never dated earlier than
 *    `max(seen) + 1` (`writeSecond`), which is what stops a clock in the future
 *    from deciding arguments it never saw.
 * 2. **`rev`** — the writing device's revision counter, advanced once per
 *    document it builds. A second is the resolution of `at`, so two changes by
 *    one device inside one second tie on it; the revision does not. Between
 *    *different* devices the numbers are not comparable — that is what the third
 *    key is for — but comparing them is still a total order, which is all a
 *    tie-break has to be.
 * 3. **`by`** — the device id, compared as a plain string, the larger winning.
 *    Two devices that land on the same second and the same revision must reach
 *    the same answer without knowing which of them is asking; comparing the id
 *    is arbitrary but it is symmetric, and symmetry is the whole requirement.
 *
 * A record with neither `rev` nor `by` was written by a build that had only
 * `at`. It keeps ordering by `at` alone, exactly as it used to — `rev` 0 and
 * `by` `""` lose every tie they enter — and gains both the next time a device
 * writes it.
 */
export interface RecordStamp {
  /** Seconds from the writing device's clock. The field a person reads. */
  at: number;
  /** The writing device's revision when it last changed. 0 in an older document. */
  rev: number;
  /** The id of the device that wrote it. `""` in an older document. */
  by: string;
}

/**
 * Where two stamps stand: positive when `a` is newer, negative when `b` is,
 * zero when they are the same stamp.
 *
 * The three keys are compared in the order {@link RecordStamp} documents.
 * Antisymmetric on purpose — `compareStamps(a, b) === -compareStamps(b, a)` —
 * because two devices merging the same pair from opposite sides must land on the
 * same copy: a rule that said "mine wins" would leave them disagreeing forever.
 */
export function compareStamps(a: RecordStamp, b: RecordStamp): number {
  const [aAt, aRev, aBy] = ordinal(a);
  const [bAt, bRev, bBy] = ordinal(b);
  if (aAt !== bAt) return aAt > bAt ? 1 : -1;
  if (aRev !== bRev) return aRev > bRev ? 1 : -1;
  if (aBy !== bBy) return aBy > bBy ? 1 : -1;
  return 0;
}

/**
 * The three keys, with anything missing read as the zero an older document
 * carries.
 *
 * `parseSyncSnapshot` already fills the gaps, so in the app this is belt and
 * braces — but the comparison has to stay antisymmetric for *every* pair it can
 * be handed, because a pair it answers the same way from both sides is a record
 * the two devices will hand back and forth forever.
 */
function ordinal(stamp: RecordStamp): [number, number, string] {
  const at = Number.isFinite(stamp.at) ? stamp.at : 0;
  const rev = Number.isFinite(stamp.rev) ? stamp.rev : 0;
  const by = typeof stamp.by === "string" ? stamp.by : "";
  return [at, rev, by];
}

/* ---------------------------------------------------------------------------
 * Which device this is
 * ------------------------------------------------------------------------- */

/**
 * Where the identity is kept: in the library's own `meta` rows, never the file.
 *
 * The document's `device` field is a *name* — what the panel shows and what a
 * person reads. These two are the machine's half: an id nobody has to read, and
 * the count of revisions this library has written.
 */
export const META_DEVICE_KEY = "sync.device";
export const META_REV_KEY = "sync.rev";

/** The identity a library syncs under. */
export interface DeviceIdentity {
  /** Opaque, stable for the life of the library, and not a label. */
  id: string;
  /** The revision this build is writing in. Advanced once per document built. */
  rev: number;
}

/** A device id: unique and unmemorable, because nothing depends on reading it. */
function mintDeviceId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `device-${random}`;
}

/**
 * The id this library syncs under, minted once and then kept.
 *
 * In the library rather than in memory, because a device id that changed would
 * read on the other device as a *new authority*: the same history would arrive
 * under a name nobody had seen, `compareStamps` would start answering
 * differently between two copies of it, and every conflict would look like a
 * newcomer's. A reinstall that keeps the library therefore keeps the id; one
 * that rebuilds the library mints a new one, which is honest, because it is a
 * new library.
 */
export async function libraryDeviceId(store: LocalStore): Promise<string> {
  const kept = await store.meta(META_DEVICE_KEY);
  if (kept !== null && kept.trim() !== "") return kept;
  const minted = mintDeviceId();
  await store.setMeta(META_DEVICE_KEY, minted);
  return minted;
}

/**
 * The revision this build may write in, and the id to write it under.
 *
 * Advanced once per document built, so every record one build changes shares a
 * revision — a document is one revision of this device — and stored in the
 * library *before* the document is written anywhere, so a crash between the two
 * can skip a revision number but can never reuse one. A counter that restarted
 * at zero on every launch would let this device's oldest record outrank its
 * newest, which is the wrong clock's failure arrived at from the other side.
 */
export async function nextDeviceIdentity(store: LocalStore): Promise<DeviceIdentity> {
  const id = await libraryDeviceId(store);
  const kept = await store.meta(META_REV_KEY);
  const last = Math.max(0, Math.floor(Number(kept)) || 0);
  const rev = last + 1;
  await store.setMeta(META_REV_KEY, String(rev));
  return { id, rev };
}

/* ---------------------------------------------------------------------------
 * The document
 * ------------------------------------------------------------------------- */

/**
 * One subscription, as it travels.
 *
 * `at` is when this record last changed on the device that wrote it, not when
 * the feed was added, and it is the field a person reads; `rev` and `by` are
 * what settle an order between two records (`RecordStamp`). A tombstone is the
 * same shape with `removed` set: the title and folder are kept so a
 * re-subscription has something to restore.
 */
export interface SyncedFeed extends RecordStamp {
  title: string;
  /** Where the title came from: `feed`, `given` or `url`. */
  titleSource: string;
  folder: string | null;
  addedAt: number;
  removed: boolean;
}

/** One folder, including an empty one. */
export interface SyncedFolder extends RecordStamp {
  createdAt: number;
  removed: boolean;
}

/**
 * A feed that moved, as it travels.
 *
 * The key is the address the feed was subscribed at; `to` is where it answers
 * now, and `at` is when the device that wrote the record learned the move. It is
 * a *fact about the web* rather than a preference, which is why one device
 * seeing it is enough and why the record outlives the subscription that found
 * it: a device still holding the old address follows it instead of subscribing
 * a second copy. Because it is a fact, `at` is the poll's own second rather than
 * a stamp taken when the document was built; `rev` and `by` name the device that
 * learned it, and only settle a tie between two different targets for one
 * address.
 */
export interface SyncedRedirect extends RecordStamp {
  to: string;
}

/**
 * What one device says about one article.
 *
 * Read and starred are separate registers with their own times: two devices
 * doing different things to the same post is the ordinary case, not a conflict.
 * The revision and the device id belong to the record rather than to a register
 * — a mark is written as one record, and both registers are read from the same
 * document — so they settle a tie between two copies of it (`RecordStamp`).
 */
export interface SyncedMark {
  read: boolean;
  readAt: number;
  starred: boolean;
  starredAt: number;
  /** The revision of the last write to either register. 0 in an older document. */
  rev: number;
  /** The device that made that write. `""` in an older document. */
  by: string;
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
  /**
   * Feeds that moved, keyed by the address they were subscribed at.
   *
   * A group of its own rather than a field on `feeds`: the feed's record has
   * *become* the new address, and the old one has to outlive it or the device
   * that never fetched would subscribe a second copy. Additive — a build that
   * does not read this group still reads every other one, so it needs no
   * version bump.
   */
  redirects: Record<string, SyncedRedirect>;
  marks: Record<string, SyncedMark>;
  /** The settings document the server path also carries. */
  prefs: PrefsDoc;
  /**
   * The sidebar as this device arranged it, with the second it was arranged.
   *
   * One record holding the whole arrangement, because the arrangement is one
   * decision: interleaving two devices' orders would put the phone's third feed
   * in the desktop's second slot and leave neither device's list as the reader
   * drew it. `null` means this device has said nothing — different from an empty
   * sidebar, which is a reader who hid nothing.
   */
  sidebar: SyncedSidebar | null;
  /** Where this device was reading, and when it was there last. */
  place: SyncedPlace | null;
}

/** The arrangement and its stamp. */
export interface SyncedSidebar extends SidebarDoc, RecordStamp {}

/** A reading place and its stamp. */
export interface SyncedPlace extends PlaceDoc, RecordStamp {}

/** A document with nothing in it, for a folder that has never been written. */
export function emptySnapshot(device = "", writtenAt = 0): SyncSnapshot {
  return {
    version: SYNC_VERSION,
    device,
    writtenAt,
    feeds: {},
    folders: {},
    redirects: {},
    marks: {},
    prefs: emptyPrefs(),
    sidebar: null,
    place: null,
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

/**
 * A revision counter, or 0.
 *
 * An older document has no `rev` at all, and a hand-written one may have
 * anything. Zero is the right absence: it loses every tie, so a record that was
 * never stamped with a revision can only win on its own second — which is
 * exactly the behaviour this field was added to improve on, not to break.
 */
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** The ordering stamp a record carries, with an older document's gaps filled in. */
function parseStamp(raw: Record<string, unknown>): RecordStamp {
  return { at: stamp(raw.at), rev: revision(raw.rev), by: text(raw.by) ?? "" };
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
    ...parseStamp(raw),
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
    ...parseStamp(raw),
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
    rev: revision(raw.rev),
    by: text(raw.by) ?? "",
  };
}

/**
 * A move, if the document carried a usable one.
 *
 * Without a target there is nothing to follow, and without a stamp the record
 * cannot be ordered against another device's — so either omission drops the
 * record rather than keeping a half-fact the merge would have to guess about.
 */
function parseRedirect(raw: unknown): SyncedRedirect | null {
  if (!isRecord(raw)) return null;
  const to = text(raw.to);
  const order = parseStamp(raw);
  if (to === null || to.trim() === "" || order.at === 0) return null;
  return { to, ...order };
}

/**
 * The arrangement, if the document carried one with a stamp.
 *
 * A record with no stamp is dropped: it has no provenance, so it cannot be
 * compared with another device's copy, and keeping it would let a hand-edited
 * or half-written file win a merge it never entered. Everything else about the
 * record is parsed by `lib/sidebar-doc`, which drops what it cannot read and
 * keeps the rest.
 */
function parseSyncedSidebar(raw: unknown): SyncedSidebar | null {
  const order = isRecord(raw) ? parseStamp(raw) : null;
  if (order === null || order.at === 0) return null;
  const doc = parseSidebar(raw);
  return doc === null ? null : { ...doc, ...order };
}

function parseSyncedPlace(raw: unknown): SyncedPlace | null {
  const order = isRecord(raw) ? parseStamp(raw) : null;
  if (order === null || order.at === 0) return null;
  const doc = parsePlaceDoc(raw);
  return doc === null ? null : { ...doc, ...order };
}

/**
 * The refusal for a folder (or a document) this build is too old for.
 *
 * One sentence for both, because it is one situation: the reader has two
 * devices, one of them newer, and the only safe instruction is to update the
 * older one. Reading a newer document wrongly and writing the result back is how
 * a newer device's data gets erased.
 */
function refuseNewerVersion(where: string, label: string, version: number): LocalStorageError {
  return new LocalStorageError(
    `The sync ${where} was written by a newer version of HardlyReader (${label} ${version}). ` +
      "Update this device, or the newer one's changes will be overwritten.",
  );
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
    redirects: {},
    marks: {},
    prefs: parsePreferences(parsed.prefs),
    sidebar: parseSyncedSidebar(parsed.sidebar),
    place: parseSyncedPlace(parsed.place),
  };

  const groups = [
    ["feeds", snapshot.feeds, parseFeed] as const,
    ["folders", snapshot.folders, parseFolder] as const,
    ["redirects", snapshot.redirects, parseRedirect] as const,
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
 * One feed, one identity
 * ------------------------------------------------------------------------- */

/**
 * A move as a row hands it over: the target and the second it was learned. The
 * ordering fields follow when the document is built (`buildSnapshot`), which is
 * the only place that knows which device is writing — so they are optional here
 * and are filled with the losing values (0 and `""`) if a row ever wins a tie.
 */
export type RedirectRowRecord = { to: string; at: number; rev?: number; by?: string };

/**
 * Every move any of these copies knows, with the newer record winning.
 *
 * A redirect is a fact, so the union is the whole merge rule: a device that has
 * seen the move adds it, and two devices that name different targets for the
 * same address are settled by which one learned it later. Nothing is lost in
 * either case — the older target stays in the file as the previous record of
 * the same address, and the next poll from either device resolves the chain.
 */
function unionRedirects(
  ...sources: readonly (Record<string, RedirectRowRecord> | undefined)[]
): Record<string, SyncedRedirect> {
  const union: Record<string, SyncedRedirect> = {};
  for (const source of sources) {
    for (const [from, record] of Object.entries(source ?? {})) {
      const earlier = union[from];
      if (earlier === undefined || compareStamps(stampOf(record), earlier) >= 0) {
        union[from] = { to: record.to, at: record.at, rev: record.rev ?? 0, by: record.by ?? "" };
      }
    }
  }
  return union;
}

/** The ordering stamp of a move that may have come from a row rather than a document. */
function stampOf(record: RedirectRowRecord): RecordStamp {
  return { at: record.at, rev: record.rev ?? 0, by: record.by ?? "" };
}

/** Two records for one feed, after a move put them under one key. */
function mergeMovedFeed(a: SyncedFeed, b: SyncedFeed): SyncedFeed {
  // A live subscription beats a tombstone at the address it moved away from:
  // that tombstone is one device noticing its own key had changed, not a reader
  // deleting anything.
  if (a.removed !== b.removed) return a.removed ? b : a;
  return compareStamps(a, b) >= 0 ? a : b;
}

/** Two mark records for one article, after a move put them under one id. */
function mergeMovedMark(a: SyncedMark, b: SyncedMark): SyncedMark {
  // Both ids name the same article, so the flags are a union: a reader who
  // starred it under the old id has starred it. The stamp is whichever copy was
  // written last, because that is the one the record now describes.
  const newer = compareStamps(
    { at: Math.max(a.readAt, a.starredAt), rev: a.rev, by: a.by },
    { at: Math.max(b.readAt, b.starredAt), rev: b.rev, by: b.by },
  ) >= 0
    ? a
    : b;
  return {
    read: a.read || b.read,
    readAt: Math.max(a.readAt, b.readAt),
    starred: a.starred || b.starred,
    starredAt: Math.max(a.starredAt, b.starredAt),
    rev: newer.rev,
    by: newer.by,
  };
}

/**
 * The same document, with every address in it already at the end of its chain.
 *
 * A move applies to everything keyed by a feed: the subscription, and every
 * article id that feed minted. Doing it as one pass over the whole document —
 * rather than at each of the places that read a key — is what keeps a moved feed
 * *one* feed with *one* set of marks in the file, instead of one of each per
 * address.
 *
 * It is deliberately tolerant: a chain that comes back to where it started is
 * not a move and is dropped, and records that collide are merged rather than
 * raced.
 */
export function followRedirects(snapshot: SyncSnapshot): SyncSnapshot {
  const known: Record<string, SyncedRedirect> = {};
  for (const [from, record] of Object.entries(snapshot.redirects ?? {})) {
    const to = redirectTarget(snapshot.redirects ?? {}, record.to);
    if (to === from) continue;
    const earlier = known[from];
    if (earlier === undefined || compareStamps(record, earlier) >= 0) {
      known[from] = { to, at: record.at, rev: record.rev, by: record.by };
    }
  }
  const document: SyncSnapshot = { ...snapshot, redirects: known };
  if (Object.keys(known).length === 0) return document;

  const prefixes = Object.keys(known).map((from) => ({
    from: localItemPrefix(from),
    to: localItemPrefix(known[from]?.to ?? from),
  }));

  document.feeds = {};
  for (const [url, record] of Object.entries(snapshot.feeds)) {
    const key = redirectTarget(known, url);
    const existing = document.feeds[key];
    document.feeds[key] = existing === undefined ? record : mergeMovedFeed(existing, record);
  }

  document.marks = {};
  for (const [id, record] of Object.entries(snapshot.marks)) {
    let key = id;
    for (const prefix of prefixes) {
      if (!id.startsWith(prefix.from)) continue;
      key = `${prefix.to}${id.slice(prefix.from.length)}`;
      break;
    }
    const existing = document.marks[key];
    document.marks[key] = existing === undefined ? record : mergeMovedMark(existing, record);
  }

  return document;
}

/* ---------------------------------------------------------------------------
 * Building this device's copy
 * ------------------------------------------------------------------------- */

/** The rows a snapshot is built from, so the build can be proved without a store. */
export interface SnapshotRows {
  feeds: readonly FeedRow[];
  folders: readonly FolderRow[];
  entries: readonly Pick<EntryRow, "key" | "read" | "starred" | "stored_at">[];
  /**
   * The moves this device knows, keyed by the address a feed was subscribed at.
   *
   * They travel because the other device has to be able to follow a feed it has
   * not fetched: a phone that is asleep while a site moves would otherwise
   * subscribe the new address beside the old one on its next wake. The store
   * knows the target and the second it learned it; the ordering stamp is added
   * by `buildSnapshot`, which is the only place that knows which device is
   * writing.
   */
  redirects: Record<string, RedirectRowRecord>;
}

export interface BuildSnapshotOptions {
  rows: SnapshotRows;
  /** What both sides last agreed on, or null before the first sync. */
  base: SyncSnapshot | null;
  prefs: PrefsDoc;
  device: string;
  now?: number;
  /**
   * The identity this library writes under, from `nextDeviceIdentity`.
   *
   * Absent, a build has no revision to write and falls back to the `device`
   * label with revision 0 — the pre-revision behaviour, which is what a caller
   * with no library behind it (an import's dry run, a test of the merge alone)
   * should get. A caller that has a library always passes it, because the id is
   * what makes this device's records tell apart from another's.
   */
  identity?: DeviceIdentity;
  /**
   * The sidebar as this device has arranged it, or null when it cannot say.
   *
   * A caller that has no sidebar to offer passes null and the agreement's copy
   * is carried forward untouched — silence must not read as "the reader
   * unhid everything".
   */
  sidebar?: SidebarDoc | null;
  /** Where this device was, or null when it has not been anywhere. */
  place?: PlaceDoc | null;
}

function seconds(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

/**
 * The newest second any record in this copy has already spoken at.
 *
 * `writtenAt` is deliberately not considered: that field says when the *copy*
 * was written, it is never merged, and `buildSnapshot` compares a row's arrival
 * against it — letting a peer's clock in here would make every newly fetched
 * article look older than the agreement, which is the arrival rule's one job.
 */
function newestSecond(snapshot: SyncSnapshot | null): number {
  if (snapshot === null) return 0;
  let newest = 0;
  const consider = (record: { at: number } | null | undefined) => {
    if (record !== null && record !== undefined && record.at > newest) newest = record.at;
  };
  for (const record of Object.values(snapshot.feeds)) consider(record);
  for (const record of Object.values(snapshot.folders)) consider(record);
  for (const record of Object.values(snapshot.redirects)) consider(record);
  for (const record of Object.values(snapshot.marks)) {
    if (record.readAt > newest) newest = record.readAt;
    if (record.starredAt > newest) newest = record.starredAt;
  }
  consider(snapshot.sidebar);
  consider(snapshot.place);
  return newest;
}

/**
 * The second this device may date a change at.
 *
 * Two failures meet here, and this is the smallest rule that answers both.
 *
 * A device whose clock runs fast used to win every argument it entered: its
 * records were stamped ten minutes into everyone else's future, so later edits
 * on a correct device lost to them for ten minutes. So a change is never dated
 * earlier than one second past the newest second this device has already seen —
 * `max(seen) + 1`, the rule a Lamport clock applies — and an edit made *after*
 * seeing another device's copy therefore always outranks it, whatever either
 * clock says. A fast clock can still date its own first document into the
 * future; it cannot keep winning once a device has answered it, and every
 * answer advances the sequence by a second rather than by the skew.
 *
 * Clamping *down* instead — cutting the stamp off at what has already been seen
 * — does not work for the other half of the trap. A device that has been
 * offline for a week has a correct clock and has seen nothing for a week, and
 * its edits must beat the ones it never saw. Keeping the local clock as the
 * floor is what preserves that; `max` is what puts the sequence above it.
 */
function writeSecond(clock: number, seen: number): number {
  return seen <= 0 ? clock : Math.max(clock, seen + 1);
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
 * had, unchanged, keeps the whole stamp it was agreed by — its second, its
 * revision and its device — so a device that has done nothing cannot win an
 * argument with a device that has. A record that differs from the agreement, or
 * is new, is stamped here: this device's next revision, its own id, and a second
 * that is its clock but never earlier than one second past what it has already
 * seen (`writeSecond`).
 *
 * A feed or folder the agreement had and the library no longer does is a
 * removal, stamped the same way; its last known name travels inside the
 * tombstone so a re-subscription elsewhere has something to restore. Marks are
 * only carried while they say something (`read`, `starred`) or are still recent
 * enough to be worth remembering as an unmark.
 */
export function buildSnapshot(options: BuildSnapshotOptions): SyncSnapshot {
  const clock = seconds(options.now);
  const identity: DeviceIdentity = options.identity ?? { id: options.device, rev: 0 };
  const now = writeSecond(clock, newestSecond(options.base));
  // The moves this device knows, and the ones it last agreed to. The base is
  // read *through* them, so a subscription the agreement still holds under the
  // old address is recognised as the feed that is now here — otherwise the
  // carry-forward below would read its own moved key as a removal.
  const redirects = unionRedirects(options.base?.redirects, options.rows.redirects);
  const base =
    options.base === null ? null : followRedirects({ ...options.base, redirects });
  const snapshot = emptySnapshot(options.device, clock);
  snapshot.redirects = stampRedirects(redirects, base?.redirects ?? null, identity);

  for (const row of options.rows.feeds) {
    const record: SyncedFeed = {
      at: now,
      rev: identity.rev,
      by: identity.id,
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
    const record: SyncedFolder = {
      at: now,
      rev: identity.rev,
      by: identity.id,
      createdAt: row.created_at,
      removed: false,
    };
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
        rev: identity.rev,
        by: identity.id,
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
    let changed = false;

    if (agreed.read !== read) {
      if (read || !fresh) {
        readAt = now;
        changed = true;
      } else read = agreed.read;
    }
    if (agreed.starred !== starred) {
      if (starred || !fresh) {
        starredAt = now;
        changed = true;
      } else starred = agreed.starred;
    }

    // A record this build did not touch keeps the stamp it was agreed with: the
    // revision and the id belong to whoever actually wrote it, and carrying
    // this device's name on it would make an agreement look like a claim.
    const record: SyncedMark = changed
      ? { read, readAt, starred, starredAt, rev: identity.rev, by: identity.id }
      : { read, readAt, starred, starredAt, rev: agreed.rev, by: agreed.by };
    // An unmark is worth carrying for a while — it is how a star removed here
    // reaches the other device — but not forever.
    const lastMark = Math.max(record.readAt, record.starredAt);
    if (!read && !starred && clock - lastMark > MARK_RETENTION_SECONDS) continue;
    snapshot.marks[row.key] = record;
  }

  // Everything the agreement knew that this device does not holds a removal or
  // a mark for an article it never fetched; both still have to travel.
  for (const [url, record] of Object.entries(base?.feeds ?? {})) {
    if (snapshot.feeds[url] !== undefined) continue;
    snapshot.feeds[url] = record.removed
      ? record
      : { ...record, removed: true, at: now, rev: identity.rev, by: identity.id };
  }
  for (const [name, record] of Object.entries(base?.folders ?? {})) {
    if (snapshot.folders[name] !== undefined) continue;
    snapshot.folders[name] = record.removed
      ? record
      : { ...record, removed: true, at: now, rev: identity.rev, by: identity.id };
  }
  for (const [id, record] of Object.entries(base?.marks ?? {})) {
    if (snapshot.marks[id] === undefined) snapshot.marks[id] = record;
  }

  snapshot.prefs = options.prefs;
  snapshot.sidebar = stampSidebar(
    options.sidebar === undefined ? undefined : options.sidebar,
    base?.sidebar ?? null,
    { at: now, rev: identity.rev, by: identity.id },
  );
  snapshot.place = stampPlace(options.place === undefined ? undefined : options.place, base?.place ?? null, {
    at: now,
    rev: identity.rev,
    by: identity.id,
  });
  return pruneSnapshot(followRedirects(snapshot), clock);
}

/**
 * The moves this copy carries, with the stamp of whichever device learned them.
 *
 * A move is a fact about the web rather than something the reader chose, so its
 * `at` is the poll's own second — that is when this device learned it, and
 * restamping it to the build's second would keep a six-month-old move alive for
 * another six months. `rev` and `by` only say who learned it, and settle a tie
 * between two different targets for one address. A move already in the
 * agreement rides along with the stamp it was agreed by, so nothing about it
 * changes when a device that did nothing syncs.
 */
function stampRedirects(
  redirects: Record<string, SyncedRedirect>,
  agreed: Record<string, SyncedRedirect> | null,
  identity: DeviceIdentity,
): Record<string, SyncedRedirect> {
  const stamped: Record<string, SyncedRedirect> = {};
  for (const [from, record] of Object.entries(redirects)) {
    const earlier = agreed?.[from];
    const known =
      earlier !== undefined &&
      earlier.to === record.to &&
      earlier.at === record.at &&
      earlier.rev > 0 &&
      earlier.by !== "";
    stamped[from] = known ? earlier : { ...record, rev: identity.rev, by: identity.id };
  }
  return stamped;
}

/**
 * The arrangement, stamped honestly.
 *
 * Three cases, and they are different: the caller said nothing (`undefined`) and
 * the agreement's copy rides along with the time it was agreed by; the caller
 * said something, and one that matches the agreement is *unchanged* and keeps
 * the earlier stamp — otherwise every launch would let a device that has done
 * nothing outvote the device that rearranged the sidebar; and anything else is
 * stamped now, because this is the first second this device can honestly claim
 * it changed.
 *
 * An arrangement with nothing in it is still a decision — a reader who unhid
 * every category and unpinned every feed must reach the other device — so it is
 * carried, not dropped. `null` is what says "nothing to say".
 */
function stampSidebar(
  doc: SidebarDoc | null | undefined,
  agreed: SyncedSidebar | null,
  stampNow: RecordStamp,
): SyncedSidebar | null {
  if (doc === null || doc === undefined) return agreed;
  if (agreed !== null && sameSidebar(agreed, doc)) return agreed;
  if (isEmptySidebar(doc) && agreed === null) {
    // A device that has never arranged anything says nothing; the first real
    // decision is what travels.
    return null;
  }
  return { ...doc, ...stampNow };
}

/** The place, by the same three cases. */
function stampPlace(
  doc: PlaceDoc | null | undefined,
  agreed: SyncedPlace | null,
  stampNow: RecordStamp,
): SyncedPlace | null {
  if (doc === null || doc === undefined) return agreed;
  if (agreed !== null && samePlace(agreed, doc)) return agreed;
  return { ...doc, ...stampNow };
}

/** Drops what has outlived its usefulness: old tombstones, old unmarks, old moves. */
export function pruneSnapshot(snapshot: SyncSnapshot, now: number): SyncSnapshot {
  const pruned: SyncSnapshot = { ...snapshot, feeds: {}, folders: {}, redirects: {}, marks: {} };
  for (const [url, record] of Object.entries(snapshot.feeds)) {
    if (record.removed && now - Math.max(record.at, 1) > TOMBSTONE_SECONDS) continue;
    pruned.feeds[url] = record;
  }
  for (const [name, record] of Object.entries(snapshot.folders)) {
    if (record.removed && now - Math.max(record.at, 1) > TOMBSTONE_SECONDS) continue;
    pruned.folders[name] = record;
  }
  for (const [from, record] of Object.entries(snapshot.redirects)) {
    // A move is remembered as long as a tombstone is. Shorter, and a device that
    // has been away would subscribe the old address again; longer, and the file
    // carries addresses nobody has fetched in half a year.
    if (now - Math.max(record.at, 1) > TOMBSTONE_SECONDS) continue;
    pruned.redirects[from] = record;
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
  group: "feed" | "folder" | "mark" | "prefs" | "sidebar" | "place";
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
  /** True when the arrangement that survived came from the folder's copy. */
  adoptedSidebar: boolean;
  /** True when the reading place that survived came from the folder's copy. */
  adoptedPlace: boolean;
}

/**
 * Which of three copies of a record wins.
 *
 * `none` is the ordinary case: unchanged on both sides. `device` and `folder`
 * say only one side moved, which is not a conflict. Two changed copies of the
 * same record are — and the newer record wins by its whole stamp (`at`, then
 * `rev`, then the device id — `RecordStamp`), with the dropped line kept so the
 * reader can be told what did not travel.
 *
 * `order` is asked for the whole stamp rather than its second, because two
 * records can share a second and still be ordered; `tie` is only reached when
 * the stamps are identical, which is a record written twice by one device in one
 * revision — the last case where a comparison on the values themselves is all
 * there is left.
 */
type Choice = { kept: "device" | "folder" | "none"; both: boolean };

function choose<T>(
  local: T | undefined,
  remote: T | undefined,
  base: T | undefined,
  same: (a: T, b: T) => boolean,
  order: (record: T) => RecordStamp,
  tie: (a: T, b: T) => number,
): Choice {
  if (local === undefined || remote === undefined) {
    return { kept: local === undefined ? "folder" : "device", both: false };
  }
  if (same(local, remote)) {
    // The same value from both sides is not a disagreement; the newer stamp is
    // the one worth carrying forward so a third device sees one answer.
    return { kept: compareStamps(order(local), order(remote)) >= 0 ? "device" : "folder", both: false };
  }
  if (base !== undefined && same(local, base)) return { kept: "folder", both: false };
  if (base !== undefined && same(remote, base)) return { kept: "device", both: false };

  const difference = compareStamps(order(local), order(remote));
  if (difference !== 0) return { kept: difference > 0 ? "device" : "folder", both: true };
  // The same stamp on both sides, and they still disagree: a stable comparison
  // of the records themselves rather than "the one I read first", so both
  // devices settle on the same copy instead of flapping.
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
  localInput: SyncSnapshot,
  remoteInput: SyncSnapshot,
  baseInput: SyncSnapshot | null,
): SnapshotMerge {
  // Every copy is read through the moves any of them knows, before a single
  // record is compared. Two devices that disagree only about the *address* of a
  // feed have not disagreed about the feed, and merging them as two
  // subscriptions is exactly the duplicate this exists to prevent.
  const redirects = unionRedirects(baseInput?.redirects, localInput.redirects, remoteInput.redirects);
  const local = followRedirects({ ...localInput, redirects });
  const remote = followRedirects({ ...remoteInput, redirects });
  const base = baseInput === null ? null : followRedirects({ ...baseInput, redirects });

  const conflicts: SyncConflict[] = [];
  const merged = emptySnapshot(local.device, local.writtenAt);
  merged.redirects = local.redirects;

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

    const choice = choose(mine, theirs, base?.feeds[url], sameFeed, (record) => record, feedTie);
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

    const choice = choose(mine, theirs, base?.folders[name], sameFolder, (record) => record, folderTie);
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
      rev: 0,
      by: "",
    };
    let any = false;
    const winners: RecordStamp[] = [];

    for (const field of ["read", "starred"] as const) {
      const atKey = field === "read" ? "readAt" : "starredAt";
      const mineAt = mine?.[atKey] ?? 0;
      const theirsAt = theirs?.[atKey] ?? 0;
      const mineValue = mine?.[field] ?? false;
      const theirsValue = theirs?.[field] ?? false;

      // The registers are compared by the same stamp as a whole record: the
      // second the register moved, then the revision it moved in, then which
      // device wrote it. The revision and the id belong to the mark rather than
      // to the register (a mark is written as one record), which is why they are
      // read from the record on each side — including the side that has no
      // record at all, where they are the zeroes an older document carries.
      const mineStamp: RecordStamp = { at: mineAt, rev: mine?.rev ?? 0, by: mine?.by ?? "" };
      const theirsStamp: RecordStamp = {
        at: theirsAt,
        rev: theirs?.rev ?? 0,
        by: theirs?.by ?? "",
      };

      let from: "device" | "folder";
      if (compareStamps(mineStamp, theirsStamp) === 0) {
        // The same stamp on both sides: the flag itself breaks the tie, so both
        // devices agree.
        from = Number(mineValue) >= Number(theirsValue) ? "device" : "folder";
      } else {
        from = compareStamps(mineStamp, theirsStamp) > 0 ? "device" : "folder";
      }
      const value = from === "device" ? mineValue : theirsValue;
      const when = from === "device" ? mineAt : theirsAt;

      if (value) {
        record[field] = true;
        record[atKey] = when;
      } else if (when > 0) {
        record[atKey] = when;
      }
      if (value || when > 0) {
        any = true;
        // The register that won, so the record's own stamp can name whichever
        // copy carried the newer of its two registers — never "whichever side
        // was asked first".
        winners.push(from === "device" ? mineStamp : theirsStamp);
      }
    }

    if (any) {
      const newest = winners.reduce((a, b) => (compareStamps(b, a) > 0 ? b : a));
      record.rev = newest.rev;
      record.by = newest.by;
      merged.marks[id] = record;
    }
  }

  const prefsMerge = mergePreferences(local.prefs, remote.prefs);
  merged.prefs = prefsMerge.doc;
  for (const namespace of prefsMerge.adopted) {
    conflicts.push({ group: "prefs", key: namespace, kept: "folder", dropped: "this device's copy" });
  }

  const sidebarChoice = choose(
    local.sidebar ?? undefined,
    remote.sidebar ?? undefined,
    base?.sidebar ?? undefined,
    sameSidebar,
    (record) => record,
    sidebarTie,
  );
  const sidebarAdopted = sidebarChoice.kept === "folder";
  merged.sidebar = sidebarAdopted ? remote.sidebar : local.sidebar;
  if (sidebarChoice.both) {
    const loser = sidebarAdopted ? local.sidebar : remote.sidebar;
    conflicts.push({
      group: "sidebar",
      key: "sidebar",
      kept: sidebarAdopted ? "folder" : "device",
      dropped: loser === null ? "nothing arranged" : describeSidebar(loser),
    });
  }

  const placeChoice = choose(
    local.place ?? undefined,
    remote.place ?? undefined,
    base?.place ?? undefined,
    samePlace,
    (record) => record,
    placeTie,
  );
  const placeAdopted = placeChoice.kept === "folder";
  merged.place = placeAdopted ? remote.place : local.place;
  if (placeChoice.both) {
    const loser = placeAdopted ? local.place : remote.place;
    conflicts.push({
      group: "place",
      key: "place",
      kept: placeAdopted ? "folder" : "device",
      dropped: loser === null ? "nowhere" : describePlace(loser),
    });
  }

  return {
    snapshot: merged,
    conflicts,
    adoptedPrefs: prefsMerge.adopted,
    adoptedSidebar: sidebarAdopted && merged.sidebar !== null,
    adoptedPlace: placeAdopted && merged.place !== null,
  };
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
  /** Feeds this library moved to another address, as `old → new`. */
  feedsRedirected: string[];
  foldersAdded: string[];
  foldersRemoved: string[];
  /** Marks written, and marks for articles this device does not hold. */
  marksApplied: number;
  marksSkipped: number;
}

/**
 * Writes a merged document into this device's library.
 *
 * Only the five things that travel are touched. An article's body is never
 * rewritten, an extraction is never dropped, and a feed's poll memory is left
 * exactly as this device had it — a feed adopted from the folder arrives with
 * nothing fetched, which is the truth: this device has not fetched it yet. A
 * feed the folder says has moved is moved rather than added, with its articles
 * and their marks, so the move cannot become a second subscription here.
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
    feedsRedirected: [],
    foldersAdded: [],
    foldersRemoved: [],
    marksApplied: 0,
    marksSkipped: 0,
  };

  // The moves first, and before anything is compared: this library may still
  // hold a feed under the address the other device has just left, and
  // subscribing the new one beside it is the duplicate the move exists to
  // prevent. The store's own rewrite carries the articles and their marks.
  for (const [from, record] of Object.entries(snapshot.redirects)) {
    const to = redirectTarget(snapshot.redirects, record.to);
    if (to === from) continue;
    if ((await store.feed(from)) === null) continue;
    if ((await store.followRedirect(from, to)) === to) {
      report.feedsRedirected.push(`${from} → ${to}`);
    }
  }

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

/**
 * The settings half, injected so this module needs no runes store of its own.
 *
 * Three halves rather than one, because they are three different decisions with
 * three different rhythms: the settings namespaces, the arrangement, and where
 * the reader was. A device that has nothing to say about one of them leaves its
 * half out and the other device's copy rides through untouched.
 */
export interface SyncPrefs {
  /** This device's document, with the stamps it has already recorded. */
  local: PrefsDoc;
  /** Takes the namespaces whose value came from the folder's copy. */
  adopt(doc: PrefsDoc, namespaces: PrefsNamespace[]): void;
  /** The sidebar as this device arranged it, or null when it has none to offer. */
  sidebar?: { local: SidebarDoc | null; adopt(doc: SidebarDoc): void };
  /** Where this device was, or null when it has not been anywhere. */
  place?: { local: PlaceDoc | null; adopt(doc: PlaceDoc): void };
}

export interface SyncRunOptions {
  store: LocalStore;
  /**
   * Where the document lives. This file does not know or care: a provider reads
   * it and writes it back, and the folder it happens to be is `sync-provider.ts`'s
   * business.
   */
  provider: SyncProvider;
  /** What to call this device in the document. */
  device: string;
  /** The last agreement, or null before the first sync. */
  base: SyncSnapshot | null;
  prefs: SyncPrefs;
  now?: number;
  /**
   * The identity to write under, or absent to take the library's own.
   *
   * See `SnapshotSource.identity`: only a test names devices, and a real run
   * always lets `nextDeviceIdentity` read the library's id and advance its
   * revision.
   */
  identity?: DeviceIdentity;
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
 * Reads the provider, merges both libraries and writes the result back.
 *
 * The order matters: the library is brought up to date *before* the document is
 * written, so a device that crashes mid-sync leaves the provider holding a
 * document it has not yet applied rather than the other way round — which is
 * the recoverable direction, because the next run merges it again. A provider
 * whose read throws therefore reaches nothing at all: the library is untouched
 * because nothing has been applied yet, and the provider is untouched because
 * nothing has been written.
 *
 * Two transports, one merge. A provider that can address a single file gets the
 * canonical file set and only the files whose bytes changed; one that only has
 * `read`/`write` gets the whole document in one write, exactly as v1 did. The
 * merge, the stamps and the tombstones are the same code either way, which is
 * what makes the folder and the document two encodings of one library rather
 * than two formats to keep in step.
 *
 * A document whose content the merge did not change is not rewritten. Cloud
 * folders upload every write, and a device that opens the app ten times a day
 * should not cost ten uploads of a document nothing changed in.
 */
export async function syncOnce(options: SyncRunOptions): Promise<SyncRun> {
  const now = seconds(options.now);
  const local = await localSnapshot({ ...options, now });

  const raw = await options.provider.read();
  const remote = raw === null ? null : parseSyncSnapshot(raw);
  const merged = await integrateSnapshot({ ...options, now }, local, remote);

  const unchanged = remote !== null && sameContent(remote, merged.snapshot);
  if (!unchanged) await options.provider.write(serializeSnapshot(merged.snapshot));

  return {
    snapshot: merged.snapshot,
    conflicts: merged.conflicts,
    applied: merged.applied,
    unchanged,
  };
}

/* ---------------------------------------------------------------------------
 * One document in, one library out
 * ------------------------------------------------------------------------- */

/**
 * What building and merging a document needs, without saying where it came from.
 *
 * A folder sync and an archive import are the same operation with a different
 * transport: both build this device's document, merge another one into it with
 * the same rules, and write the result through `applySnapshot`. The transport is
 * the only difference, so it is the only thing the two callers do differently.
 */
export interface SnapshotSource {
  store: LocalStore;
  /** What to call this device in the document it builds. */
  device: string;
  /** The last agreement, or null. An import has none: an archive is a stranger. */
  base: SyncSnapshot | null;
  prefs: SyncPrefs;
  now?: number;
  /**
   * The identity to write under, or absent to take the library's own.
   *
   * There is one reason to pass it: a caller that is testing the ordering wants
   * to name two devices rather than learn two random ids. Everything with a
   * library behind it lets `nextDeviceIdentity` answer, because the whole point
   * of the id is that it is the library's rather than the caller's.
   */
  identity?: DeviceIdentity;
}

/** The rows this device's document is built from, read once. */
async function readRows(store: LocalStore): Promise<SnapshotRows> {
  return {
    feeds: await store.feeds(),
    folders: await store.folders(),
    entries: await store.entryFlags(),
    redirects: await store.redirects(),
  };
}

/**
 * This device's document, as the library stands right now.
 *
 * The library half is `buildSnapshot`'s business; this only gathers what it
 * reads, so an export writes exactly what a sync would have written, and the
 * two cannot drift into different ideas of what this device has.
 */
export async function localSnapshot(options: SnapshotSource): Promise<SyncSnapshot> {
  // The identity comes from the library, not from the caller: the id has to be
  // the same one tomorrow (`nextDeviceIdentity`), and the revision has to be
  // higher than the last document this library wrote.
  const identity = options.identity ?? (await nextDeviceIdentity(options.store));
  return buildSnapshot({
    rows: await readRows(options.store),
    base: options.base,
    prefs: options.prefs.local,
    device: options.device,
    now: seconds(options.now),
    identity,
    sidebar: options.prefs.sidebar === undefined ? undefined : options.prefs.sidebar.local,
    place: options.prefs.place === undefined ? undefined : options.prefs.place.local,
  });
}

/**
 * A stamped record without its stamp — for the state a device keeps.
 *
 * A reader's arrangement and their reading place are the reader's; the second,
 * the revision and the device on the record are the document's. Handing the
 * stamp to `adopt` would put another device's name in this device's own state,
 * where it would then be carried back out by the next build as though this
 * device had written it.
 */
function arrangementOf<T extends object>(record: T & RecordStamp): T {
  const readable = { ...record } as T & Partial<RecordStamp>;
  delete readable.at;
  delete readable.rev;
  delete readable.by;
  return readable as T;
}

/**
 * Merges a document into this device's library and adopts the settings it won.
 *
 * The three-way merge, the settings rule and the write are one sequence and
 * live in one place, because a second copy of them is a second set of conflict
 * rules — which is exactly what an import must not be. Nothing here is
 * transport: the caller decodes the document and decides where it came from.
 *
 * The returned document is this device's new copy — the caller that has a
 * provider writes it back, and the caller that imported one (an archive is not
 * a place) keeps it for the report and writes nothing.
 */
export async function integrateSnapshot(
  options: SnapshotSource,
  local: SyncSnapshot,
  remote: SyncSnapshot | null,
): Promise<{ snapshot: SyncSnapshot; conflicts: SyncConflict[]; applied: ApplyReport }> {
  const now = seconds(options.now);
  const merged = mergeSnapshots(local, remote ?? emptySnapshot(), options.base);

  options.prefs.adopt(merged.snapshot.prefs, merged.adoptedPrefs);
  // Only the half the other device decided is taken: a value that survived from
  // this device is already on screen, and re-applying it would be a write to the
  // reader's own settings on every sync. What is handed over is the arrangement
  // itself, without the stamp the document carries on it: the revision and the
  // device belong to the record, and a device that stored them as part of what
  // the reader arranged would be storing somebody else's name in its own state.
  if (merged.adoptedSidebar && merged.snapshot.sidebar !== null) {
    options.prefs.sidebar?.adopt(arrangementOf(merged.snapshot.sidebar));
  }
  if (merged.adoptedPlace && merged.snapshot.place !== null) {
    options.prefs.place?.adopt(arrangementOf(merged.snapshot.place));
  }
  const applied = await applySnapshot(options.store, merged.snapshot);

  return {
    snapshot: { ...merged.snapshot, device: options.device, writtenAt: now },
    conflicts: merged.conflicts,
    applied,
  };
}
