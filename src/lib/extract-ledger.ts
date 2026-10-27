/**
 * What the extractor remembers between posts, and between launches.
 *
 * Two things are worth keeping, and neither is the article:
 *
 * 1. **A page that refused us.** A paywall, a 403, a cookie wall and a timeout
 *    all cost a request, and the same page costs it again on the next post, and
 *    again after a restart. So a failure is written down with a retry time
 *    derived from *why* it failed — a publisher that says no will keep saying no
 *    for a week, a network that timed out may be back in ten minutes — and
 *    `extractFor()` does not request a parked URL until that time has passed. An
 *    explicit press is not an automatic retry: it asks with `force`, which is
 *    what makes "try again" mean something.
 * 2. **What the reader decided about one article.** The account-wide switch says
 *    "extract every post"; the toolbar says "this one". A choice outlives the
 *    next post, the next launch and the next sync, because it is about *this*
 *    entry — so it is stored by entry id, never in the reading preferences
 *    (those travel between devices; an entry id means nothing on another
 *    account's reader).
 *
 * The blob is device data with an account scope: entry ids are only unique
 * inside an account, so a second login on the same device must not inherit the
 * first one's choices. It is not synced and it is safe to lose — a lost ledger
 * costs one fetch per parked page, which is exactly what the app did before it
 * existed.
 */

import {
  readAccountValue,
  storedAccount,
  writeAccountValue,
  type AccountIdentity,
  type KeyStore,
} from "./account-key";

/** Why a page did not become an article. The reason decides the retry time. */
export type FailureKind = "unreachable" | "refused" | "thin";

/** What the reader asked for on one entry. `null` means "the automatic rule". */
export type BodyChoice = "feed" | "article";

/** The key this lives under, scoped to the signed-in account. */
export const EXTRACT_LEDGER_KEY = "hardlyreader.extract.v1";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long a failure stands before the page may be asked again.
 *
 * - **unreachable** — a timeout, DNS, CORS, offline, or a 5xx. Transient by
 *   nature: ten minutes, so a reader who was on a flaky connection does not
 *   stare at feed text for a day.
 * - **refused** — a 4xx, a non-HTML content type, an oversized page. The
 *   publisher answered and the answer was no; a week is the honest guess at how
 *   long a paywall or a bot wall takes to change, and the press on "¶" is the way
 *   past it anyway.
 * - **thin** — the page arrived and held no article (a cookie notice, a paywall
 *   stub). Same publisher markup tomorrow, so a day.
 */
export const RETRY_AFTER: Record<FailureKind, number> = {
  unreachable: 10 * MINUTE,
  refused: 7 * DAY,
  thin: 24 * HOUR,
};

/** Enough parked pages to cover a heavy reading week, small enough to store. */
const MAX_FAILURES = 200;

/** Choices are tiny and are the reader's own decisions, so they get more room. */
const MAX_CHOICES = 500;

/** One parked page. `at` is when it failed; `retryAt` is when it may be asked again. */
export interface Failure {
  kind: FailureKind;
  at: number;
  retryAt: number;
}

interface StoredChoice {
  choice: BodyChoice;
  at: number;
}

interface Stored {
  failures: Record<string, Failure>;
  /** Keyed by entry id: the choice is about one post, not about a feed. */
  choices: Record<string, StoredChoice>;
}

/**
 * No `localStorage` — a Node test, a blocked store, a private window — still gets
 * a working ledger for the life of the process. It remembers nothing across a
 * launch, which is exactly what having no storage means.
 */
const memory = new Map<string, string>();

function memoryStore(): KeyStore {
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  };
}

export interface LedgerOptions {
  /** Where the blob lives. Omitted means this device's `localStorage`. */
  storage?: KeyStore | null;
  /** Whose choices these are. Omitted means whoever is signed in right now. */
  account?: AccountIdentity | null;
}

export interface ExtractLedger {
  /** The failure standing for this URL, or null once its retry time has passed. */
  failure(url: string, now?: number): Failure | null;
  /** Whether an automatic fetch of this URL should be skipped. */
  parked(url: string, now?: number): boolean;
  record(url: string, kind: FailureKind, now?: number): void;
  /** The page answered after all: forget what it did before. */
  forgive(url: string): void;
  /** What the reader chose for this entry, or null for the automatic rule. */
  choice(entryId: string): BodyChoice | null;
  remember(entryId: string, choice: BodyChoice, now?: number): void;
  forget(entryId: string): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isKind(value: unknown): value is FailureKind {
  return value === "unreachable" || value === "refused" || value === "thin";
}

/** Only what this module writes is read back: a corrupt or foreign field is dropped. */
function scanFailures(value: unknown): Record<string, Failure> {
  const out: Record<string, Failure> = {};
  if (!isObject(value)) return out;
  for (const [url, entry] of Object.entries(value)) {
    if (!isObject(entry) || !isKind(entry.kind)) continue;
    if (typeof entry.at !== "number" || typeof entry.retryAt !== "number") continue;
    out[url] = { kind: entry.kind, at: entry.at, retryAt: entry.retryAt };
  }
  return out;
}

function scanChoices(value: unknown): Record<string, StoredChoice> {
  const out: Record<string, StoredChoice> = {};
  if (!isObject(value)) return out;
  for (const [id, entry] of Object.entries(value)) {
    if (!isObject(entry)) continue;
    if (entry.choice !== "feed" && entry.choice !== "article") continue;
    out[id] = { choice: entry.choice, at: typeof entry.at === "number" ? entry.at : 0 };
  }
  return out;
}

/** The oldest entries go first, so a cap trims what is least likely to be needed. */
function trim<T extends { at: number }>(entries: Record<string, T>, max: number): void {
  const keys = Object.keys(entries);
  if (keys.length <= max) return;
  keys
    .sort((a, b) => entries[a].at - entries[b].at)
    .slice(0, keys.length - max)
    .forEach((key) => delete entries[key]);
}

/**
 * One ledger over one store.
 *
 * The account is resolved per operation rather than once, because a ledger
 * created before sign-in must not keep answering for the previous login: choices
 * are per account, and entry ids from two accounts are not the same entry.
 */
export function createExtractLedger(options: LedgerOptions = {}): ExtractLedger {
  const store = (): KeyStore => {
    if (options.storage !== undefined) return options.storage ?? memoryStore();
    if (typeof localStorage === "undefined") return memoryStore();
    return localStorage;
  };

  const who = (storage: KeyStore): AccountIdentity | null =>
    options.account !== undefined ? options.account : storedAccount(storage);

  function read(storage: KeyStore): Stored {
    const raw = readAccountValue(storage, EXTRACT_LEDGER_KEY, who(storage));
    if (raw === null) return { failures: {}, choices: {} };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed)) return { failures: {}, choices: {} };
      return { failures: scanFailures(parsed.failures), choices: scanChoices(parsed.choices) };
    } catch {
      // A corrupt blob is worth less than the defaults it replaces.
      return { failures: {}, choices: {} };
    }
  }

  function write(storage: KeyStore, data: Stored, now: number): void {
    // Expired failures are dropped on the way out rather than kept as history:
    // there is nothing to learn from a page that may be asked again tomorrow.
    for (const [url, failure] of Object.entries(data.failures)) {
      if (failure.retryAt <= now) delete data.failures[url];
    }
    trim(data.failures, MAX_FAILURES);
    trim(data.choices, MAX_CHOICES);
    writeAccountValue(storage, EXTRACT_LEDGER_KEY, who(storage), JSON.stringify(data));
  }

  return {
    failure(url, now = Date.now()) {
      const storage = store();
      const found = read(storage).failures[url];
      if (!found) return null;
      return found.retryAt > now ? found : null;
    },

    parked(url, now = Date.now()) {
      const storage = store();
      const found = read(storage).failures[url];
      return found !== undefined && found.retryAt > now;
    },

    record(url, kind, now = Date.now()) {
      const storage = store();
      const data = read(storage);
      data.failures[url] = { kind, at: now, retryAt: now + RETRY_AFTER[kind] };
      write(storage, data, now);
    },

    forgive(url) {
      const storage = store();
      const data = read(storage);
      if (data.failures[url] === undefined) return;
      delete data.failures[url];
      write(storage, data, Date.now());
    },

    choice(entryId) {
      return read(store()).choices[entryId]?.choice ?? null;
    },

    remember(entryId, choice, now = Date.now()) {
      const storage = store();
      const data = read(storage);
      data.choices[entryId] = { choice, at: now };
      write(storage, data, now);
    },

    forget(entryId) {
      const storage = store();
      const data = read(storage);
      if (data.choices[entryId] === undefined) return;
      delete data.choices[entryId];
      write(storage, data, Date.now());
    },
  };
}

/**
 * The app's own ledger: `localStorage`, whoever is signed in, the real clock.
 *
 * Deliberately not a cached singleton bound to one account — `who()` is asked on
 * every call, so signing in as someone else does not leave the previous login's
 * choices in force.
 */
export const ledger = createExtractLedger();
