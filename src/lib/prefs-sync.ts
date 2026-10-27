/**
 * A reader's remembered settings, as a document that can travel.
 *
 * One account has one copy, kept by the adapter's `GET`/`PUT /v1/preferences`.
 * Local storage stays the render source — the app must work with an adapter
 * that has no such route — and the account's copy is what makes a second device
 * open the way the first one was left.
 *
 * The document is a map from a small, fixed set of namespaces (`reading`,
 * `cards`, `theme`, `search`) to `{ updatedAt, value }`. Provenance is per
 * namespace, not per field and not per blob, and that is deliberate:
 *
 * - Per blob would mean a phone that changed the text size yesterday wipes a
 *   theme chosen on the desktop this morning, because the whole document's
 *   stamp is one number.
 * - Per field would mean a stamp on every one of the twenty-odd reading
 *   choices, which is a lot of bookkeeping for a granularity nobody asked for
 *   and a document that grows with every setting added.
 * - Per namespace means two devices editing *different* halves of the app both
 *   keep their change, and two devices editing the same half are decided by the
 *   same rule the server enforces: the newer stamp wins.
 *
 * Within a namespace the whole value is replaced. That is the conservative
 * reading of "last writer wins": a device never invents a field the writer did
 * not send, and a field that was removed on one device is removed everywhere.
 *
 * A tie keeps the local value. The local copy is the one the person is looking
 * at, so a device whose clock agrees to the millisecond with another device's
 * must not have its screen rewritten by a pull it did not ask for.
 *
 * Nothing here knows about a server, a transport or a DOM: merging, stamping,
 * parsing and the offline queue are all testable on their own.
 */

import { nextStamp } from "./positions";

/** The wire version. Bumped only when an older client could read a newer blob wrongly. */
export const PREFS_API_VERSION = 1;

/**
 * What may travel, and nothing else.
 *
 * An allowlist rather than "whatever the server sent": a newer client may store
 * a namespace this build has never heard of, and adopting it would put a value
 * into a store that cannot validate it. Unknown namespaces are ignored on read
 * and never written back, so a round trip through an older build cannot erase
 * them on the server — it simply does not understand them.
 */
export const PREFS_NAMESPACES = ["reading", "cards", "theme", "search"] as const;

export type PrefsNamespace = (typeof PREFS_NAMESPACES)[number];

/** One namespace's fields. Flat in practice; the parser bounds the depth anyway. */
export type PrefsValue = Record<string, unknown>;

export interface PrefsEntry {
  /** When this namespace was last changed, in ms. Decides which copy wins. */
  updatedAt: number;
  value: PrefsValue;
}

export interface PrefsDoc {
  apiVersion: number;
  /** The newest entry's stamp, derived rather than trusted from the wire. */
  updatedAt: number;
  entries: Partial<Record<PrefsNamespace, PrefsEntry>>;
}

/** A fresh, empty document. A new object each call, so callers can own it. */
export function emptyPrefs(): PrefsDoc {
  return { apiVersion: PREFS_API_VERSION, updatedAt: 0, entries: {} };
}

export function isPrefsNamespace(value: unknown): value is PrefsNamespace {
  return typeof value === "string" && (PREFS_NAMESPACES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that must never be copied into an object the app later spreads. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_KEYS = 64;
const MAX_ARRAY = 64;
const MAX_DEPTH = 3;
const MAX_STRING = 2048;

type Plain = { ok: true; value: unknown } | { ok: false };

/**
 * A JSON value this app is willing to carry, or nothing.
 *
 * Bounded on purpose: the adapter's request body has a hard cap, and a theme
 * value is the only thing with a chance of growing. A string, number, boolean
 * or null under the length limit is fine; arrays and objects are rebuilt from
 * scratch, so a key such as `__proto__` and a value such as a function cannot
 * survive a round trip even if a corrupt file or a hostile server sent one.
 */
function plainValue(value: unknown, depth: number): Plain {
  if (value === null || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (typeof value === "string") return value.length <= MAX_STRING ? { ok: true, value } : { ok: false };
  if (depth >= MAX_DEPTH) return { ok: false };

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value.slice(0, MAX_ARRAY)) {
      const clean = plainValue(entry, depth + 1);
      // A list is dropped whole rather than shortened: half an arrangement is
      // not the arrangement.
      if (!clean.ok) return { ok: false };
      out.push(clean.value);
    }
    return { ok: true, value: out };
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key) || key === "" || key.length > 64) continue;
      if (++count > MAX_KEYS) return { ok: false };
      const clean = plainValue(entry, depth + 1);
      if (!clean.ok) continue;
      // defineProperty rather than assignment, so even an own `__proto__` key
      // arriving through a JSON parser cannot reach a prototype.
      Object.defineProperty(out, key, {
        value: clean.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { ok: true, value: out };
  }

  return { ok: false };
}

/** The namespace value, or null when it is not a usable object. */
function cleanValue(value: unknown): PrefsValue | null {
  const clean = plainValue(value, 0);
  if (!clean.ok || !isRecord(clean.value)) return null;
  // An empty object says nothing; treating it as a value would let a broken
  // writer blank a namespace on every device.
  return Object.keys(clean.value).length === 0 ? null : clean.value;
}

function cleanStamp(value: unknown): number {
  const stamp = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(stamp) || stamp <= 0) return 0;
  return Math.round(stamp);
}

function parseEntry(raw: unknown, allowUnstamped = false): PrefsEntry | null {
  if (!isRecord(raw)) return null;
  const updatedAt = cleanStamp(raw.updatedAt);
  if (updatedAt === 0 && !allowUnstamped) return null;
  const value = cleanValue(raw.value);
  if (value === null) return null;
  return { updatedAt, value };
}

/**
 * Reads whatever the wire held.
 *
 * Tolerant without being trusting: an unknown namespace, a missing stamp, a
 * scalar where an object belongs and a value that is nothing but poison keys
 * are all dropped, and the rest of the document still arrives. The top-level
 * stamp is derived from the entries that survived, so a document cannot claim
 * to be newer than the values it actually carries.
 */
export function parsePreferences(raw: unknown): PrefsDoc {
  return parseDocument(raw, false);
}

/**
 * Reads this device's own record.
 *
 * Unlike the wire, a stamp of zero is kept: it is how a value that has never
 * been compared with the account is remembered. Such a value is local truth
 * with no provenance — the first successful pull decides whether it travels —
 * and it is never sent as it stands.
 */
export function parseLocalPreferences(raw: unknown): PrefsDoc {
  return parseDocument(raw, true);
}

function parseDocument(raw: unknown, allowUnstamped: boolean): PrefsDoc {
  if (!isRecord(raw)) return emptyPrefs();
  const entriesRaw = isRecord(raw.entries) ? raw.entries : {};

  const entries: Partial<Record<PrefsNamespace, PrefsEntry>> = {};
  for (const namespace of PREFS_NAMESPACES) {
    const entry = parseEntry(entriesRaw[namespace], allowUnstamped);
    if (entry !== null) entries[namespace] = entry;
  }

  return documentOf(entries);
}

/** Builds a document from entries, with the stamp derived from them. */
function documentOf(entries: Partial<Record<PrefsNamespace, PrefsEntry>>): PrefsDoc {
  let updatedAt = 0;
  for (const namespace of PREFS_NAMESPACES) {
    const entry = entries[namespace];
    if (entry !== undefined && entry.updatedAt > updatedAt) updatedAt = entry.updatedAt;
  }
  return { apiVersion: PREFS_API_VERSION, updatedAt, entries };
}

/** One namespace's entry, or null when this document has nothing for it. */
export function entryOf(doc: PrefsDoc, namespace: PrefsNamespace): PrefsEntry | null {
  return doc.entries[namespace] ?? null;
}

/** A copy of `doc` with one namespace replaced. */
export function withEntry(doc: PrefsDoc, namespace: PrefsNamespace, entry: PrefsEntry): PrefsDoc {
  return documentOf({ ...doc.entries, [namespace]: entry });
}

/** A copy of `doc` without one namespace. */
export function withoutEntry(doc: PrefsDoc, namespace: PrefsNamespace): PrefsDoc {
  const entries = { ...doc.entries };
  delete entries[namespace];
  return documentOf(entries);
}

/**
 * The stamp to write with.
 *
 * Strictly greater than the previous one even when the clock has not ticked,
 * because two changes in the same millisecond are two writes and the second
 * must not be refused as stale against the first.
 */
export function nextPrefsStamp(previous: number, now: number = Date.now()): number {
  return nextStamp(previous, now);
}

/** What a merge came to, split so the caller knows what to apply. */
export interface PrefsMerge {
  doc: PrefsDoc;
  /** Namespaces whose value came from `remote`: these have to be adopted. */
  adopted: PrefsNamespace[];
  /** Namespaces the local copy kept, because it was newer or was alone. */
  kept: PrefsNamespace[];
}

/**
 * Which copy of each namespace to keep.
 *
 * Remote wins only when it is strictly newer. A tie keeps the local value, and
 * a namespace the local copy has never held is adopted from the account even
 * at the account's oldest stamp — a device that has never synced has no
 * provenance to prefer, so the account's value is the only claim there is.
 */
export function mergePreferences(local: PrefsDoc, remote: PrefsDoc): PrefsMerge {
  const entries: Partial<Record<PrefsNamespace, PrefsEntry>> = {};
  const adopted: PrefsNamespace[] = [];
  const kept: PrefsNamespace[] = [];

  for (const namespace of PREFS_NAMESPACES) {
    const mine = local.entries[namespace];
    const theirs = remote.entries[namespace];

    if (mine === undefined && theirs === undefined) continue;
    if (mine === undefined) {
      entries[namespace] = theirs;
      adopted.push(namespace);
      continue;
    }
    if (theirs === undefined) {
      entries[namespace] = mine;
      kept.push(namespace);
      continue;
    }
    if (theirs.updatedAt > mine.updatedAt) {
      entries[namespace] = theirs;
      adopted.push(namespace);
    } else {
      entries[namespace] = mine;
      kept.push(namespace);
    }
  }

  return { doc: documentOf(entries), adopted, kept };
}

/** Namespaces the local copy holds a strictly newer value for than `remote`. */
export function newerThan(local: PrefsDoc, remote: PrefsDoc): PrefsNamespace[] {
  const out: PrefsNamespace[] = [];
  for (const namespace of PREFS_NAMESPACES) {
    const mine = local.entries[namespace];
    if (mine === undefined) continue;
    const theirs = remote.entries[namespace];
    if (theirs === undefined || mine.updatedAt > theirs.updatedAt) out.push(namespace);
  }
  return out;
}

/** True when two documents say the same thing, stamps and all. */
export function samePreferences(a: PrefsDoc, b: PrefsDoc): boolean {
  for (const namespace of PREFS_NAMESPACES) {
    const mine = a.entries[namespace];
    const theirs = b.entries[namespace];
    if (mine === undefined || theirs === undefined) {
      if (mine !== theirs) return false;
      continue;
    }
    if (mine.updatedAt !== theirs.updatedAt) return false;
    if (JSON.stringify(mine.value) !== JSON.stringify(theirs.value)) return false;
  }
  return true;
}

/** The body a write sends. Only stamped entries travel: zero is not a claim. */
export function preferencesBody(doc: PrefsDoc): Record<string, unknown> {
  return {
    apiVersion: PREFS_API_VERSION,
    updatedAt: doc.updatedAt,
    entries: Object.fromEntries(
      PREFS_NAMESPACES.flatMap((namespace) => {
        const entry = doc.entries[namespace];
        return entry === undefined || entry.updatedAt <= 0
          ? []
          : [[namespace, { updatedAt: entry.updatedAt, value: entry.value }] as const];
      }),
    ),
  };
}

/** What a send came to, as the queue needs to hear it. */
export type PrefsSendOutcome =
  /** Stored. The queue moves on. */
  | "sent"
  /** Could not be sent now — network, server trouble. The entry stays at the head. */
  | "retry"
  /** The server can never take this: no route, or a read-only session. Drop it. */
  | "stop";

export type PrefsFlushOutcome = "drained" | "offline" | "stopped";

/**
 * Writes waiting for a server that is not there yet.
 *
 * Every entry is a full snapshot, so the queue is allowed to forget the oldest
 * one when it grows past its limit: the newest snapshot already carries every
 * namespace the older ones did, with stamps at least as new. That is what makes
 * a long offline stretch cheap rather than a growing pile of near-copies.
 *
 * Flushing is sequential — the server compares stamps, and two writes racing
 * would let the older one be refused for no reason the user caused. A failure
 * leaves the head in place and stops, so the next flush resumes exactly where
 * this one did; an answer of "stop" means the account cannot hold prefs at all,
 * and keeping the queue would only retry a known impossibility.
 */
export class PrefsQueue {
  private docs: PrefsDoc[] = [];

  private readonly limit: number;

  constructor(limit = 20) {
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 20;
  }

  get size(): number {
    return this.docs.length;
  }

  /** The entry a flush would send next, or null when there is nothing waiting. */
  peek(): PrefsDoc | null {
    return this.docs.length === 0 ? null : this.docs[0];
  }

  /** Adds a snapshot. Older snapshots beyond the limit are dropped. */
  enqueue(doc: PrefsDoc): void {
    this.docs.push(doc);
    while (this.docs.length > this.limit) this.docs.shift();
  }

  clear(): void {
    this.docs = [];
  }

  async flush(send: (doc: PrefsDoc) => Promise<PrefsSendOutcome>): Promise<PrefsFlushOutcome> {
    while (this.docs.length > 0) {
      const head = this.docs[0];
      const outcome = await send(head);
      if (outcome === "retry") return "offline";
      if (outcome === "stop") {
        this.docs = [];
        return "stopped";
      }
      this.docs.shift();
    }
    return "drained";
  }
}

/* ---------------------------------------------------------------------------
 * Comparing what is on screen with what was last recorded
 *
 * The stores know nothing about the account; the controller reads them. These
 * two helpers are what let a change be noticed without a store importing the
 * sync and without a second writer inside any store.
 * ------------------------------------------------------------------------- */

/** True when two namespace values say the same thing. */
export function sameValue(a: PrefsValue | undefined, b: PrefsValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
