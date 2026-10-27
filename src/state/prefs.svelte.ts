/**
 * The account's copy of the reader's remembered settings.
 *
 * Local storage stays the render source. This module is the second hop: it
 * reads the account's copy once per sign-in, merges it with what this device
 * already had, and sends a debounced write after a change. Nothing on screen
 * waits for it, and nothing on screen fails because of it:
 *
 * - No adapter, no route, a read-only session, a refused token, a server on
 *   fire — every one of those means the same thing here. The local value stands,
 *   the queue is dropped or left for later, and not one word is shown. A reader
 *   who has never had a second device must not learn that this exists.
 * - A session token, a password or an address never enters the document. What
 *   travels is four namespaces of preferences; the record is keyed by the
 *   account's hashed slug, and the values are the same fields the local keys
 *   already hold.
 *
 * The merge is `lib/prefs-sync`: per-namespace provenance, newer wins, a tie
 * keeps the local value, and a namespace this device has never compared is
 * adopted from the account rather than imposed on it. That last rule is what
 * makes a first launch on a new phone safe — it cannot clobber the desktop's
 * settings with its own defaults.
 *
 * Change detection is by value, not by a subscription: `observe()` compares the
 * stores' snapshots with what was last recorded. A store therefore needs no
 * knowledge of syncing, and adopting the account's copy cannot bounce straight
 * back out as a local change.
 */
import type { Session } from "../api/freshrss";
import { transport } from "../api/transport";
import {
  ApiError,
  getPreferences,
  putPreferences,
  supportsExtensionRoutes,
  type PreferencesWrite,
} from "../api/hardlyread";
import { scopedKey } from "../lib/account-key";
import {
  PREFS_NAMESPACES,
  PrefsQueue,
  emptyPrefs,
  mergePreferences,
  newerThan,
  nextPrefsStamp,
  parseLocalPreferences,
  sameValue,
  withEntry,
  type PrefsDoc,
  type PrefsNamespace,
  type PrefsSendOutcome,
  type PrefsValue,
} from "../lib/prefs-sync";
import { reading } from "./reading.svelte";
import { search } from "./search.svelte";
import { theme } from "./theme.svelte";

/**
 * This device's record for one account: the stamps it has seen, and the values
 * that go with them. Keyed by the hashed account slug, never by an address.
 */
const RECORD_KEY = "hardlyreader.prefs-sync.v1";

/** A change is sent after this long, so a slider drag is one write, not forty. */
const DEBOUNCE_MS = 700;

/** A failed write is tried again, backing off, while the session lives. */
const RETRY_BASE_MS = 4000;
const RETRY_MAX_MS = 60000;

/** What each namespace writes and how it takes a value from the account. */
interface PrefsStore {
  snapshot(): PrefsValue;
  adopt(value: PrefsValue): void;
}

const STORES: Record<PrefsNamespace, PrefsStore> = {
  reading: { snapshot: () => reading.snapshot(), adopt: (value) => reading.adopt(value) },
  theme: { snapshot: () => theme.snapshot(), adopt: (value) => theme.adopt(value) },
  search: { snapshot: () => search.snapshot(), adopt: (value) => search.adopt(value) },
};

export class PrefsSync {
  /**
   * Settles when the start-time read has been merged. Nothing on screen waits
   * for it; it exists so "read once at sign-in" is observable rather than a
   * hope.
   */
  landed: Promise<void> = Promise.resolve();

  private session: Session | null = null;

  private local: PrefsDoc = emptyPrefs();

  private remote: PrefsDoc = emptyPrefs();

  /**
   * Whether this device has ever completed a read for this account. Until it
   * has, a local change carries no stamp: it is kept, but it cannot claim to be
   * newer than the account's copy.
   */
  private pulled = false;

  private route: "unknown" | "available" | "missing" | "readonly" = "unknown";

  private readonly queue = new PrefsQueue();

  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Writes go out one at a time, in the order the changes were made. */
  private chain: Promise<void> = Promise.resolve();

  /** One retry after a refusal, so a genuine newer copy is not fought over. */
  private retries = 0;

  private attempts = 0;

  private observed = false;

  private detach: (() => void) | null = null;

  /**
   * The read in flight, so a change arriving while the start-time read is still
   * out waits on that one instead of racing a second merge over the same
   * document.
   */
  private pulling: Promise<boolean> | null = null;

  /** Starts syncing one account. Safe to call again: it stops the old one first. */
  start(session: Session): void {
    this.stop();
    this.session = session;
    this.observed = true;

    const record = this.readRecord(session);
    this.local = this.snapshotDoc(record);
    this.writeRecord();

    if (typeof window !== "undefined") {
      const wake = (): void => {
        this.attempts = 0;
        this.push();
      };
      window.addEventListener("online", wake);
      this.detach = () => window.removeEventListener("online", wake);
    }

    // A server that could never carry the adapter is not worth a request.
    if (!supportsExtensionRoutes(session)) {
      this.route = "missing";
      return;
    }

    this.landed = this.pull()
      .then(() => undefined)
      .catch(() => undefined);
  }

  /** Signs out of the account's copy. Local values stay where they are. */
  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.detach?.();
    this.detach = null;
    this.observed = false;
    this.session = null;
    this.queue.clear();
    this.local = emptyPrefs();
    this.remote = emptyPrefs();
    this.pulled = false;
    this.route = "unknown";
    this.retries = 0;
    this.attempts = 0;
    this.pulling = null;
  }

  /**
   * Notices a change and schedules a write.
   *
   * Called from an effect that reads every snapshot, so any store's change
   * re-runs it. Comparing values rather than listening for assignments is what
   * keeps adopting the account's copy from being mistaken for a local edit.
   */
  observe(): void {
    // Read every snapshot before the early return: the effect that calls this
    // has to depend on the stores even while a session is still starting, or it
    // would never run again for the first change.
    const current = {} as Record<PrefsNamespace, PrefsValue>;
    for (const namespace of PREFS_NAMESPACES) {
      current[namespace] = STORES[namespace].snapshot();
    }

    if (!this.observed || this.session === null) return;

    const changed: PrefsNamespace[] = [];
    for (const namespace of PREFS_NAMESPACES) {
      if (!sameValue(this.local.entries[namespace]?.value, current[namespace])) {
        changed.push(namespace);
      }
    }
    if (changed.length === 0) return;

    let doc = this.snapshotDoc(this.local);
    for (const namespace of changed) {
      // A never-synced device stamps nothing: the value is saved locally and
      // waits for the first read to say whether it is allowed to travel.
      const updatedAt = this.pulled ? nextPrefsStamp(doc.updatedAt) : 0;
      doc = withEntry(doc, namespace, { updatedAt, value: current[namespace] });
    }
    this.local = doc;
    this.writeRecord();
    this.schedule();
  }

  /** Reads the account's copy once and keeps the newer value of each namespace. */
  private pull(): Promise<boolean> {
    if (this.pulling !== null) return this.pulling;
    const run = this.pullNow().finally(() => {
      if (this.pulling === run) this.pulling = null;
    });
    this.pulling = run;
    return run;
  }

  private async pullNow(): Promise<boolean> {
    const session = this.session;
    if (session === null) return false;
    if (this.route === "missing" || this.route === "readonly") return false;

    let remote: PrefsDoc;
    try {
      remote = await getPreferences(transport, session);
    } catch (error) {
      if (this.session !== session) return false;
      this.noteReadFailure(error);
      return false;
    }
    if (this.session !== session) return false;

    this.route = "available";
    this.remote = remote;
    this.pulled = true;

    const merged = mergePreferences(this.snapshotDoc(this.local), remote);
    this.applyAdopted(merged.adopted, remote);

    // What this device held without provenance has now been compared: it either
    // lost to the account (and is gone from `merged`) or survived because the
    // account had nothing for it. The survivors get a stamp, so they can travel.
    // The merged document, not the stores: a change made while this read was in
    // flight is still in the store and is picked up by `observe()` with a fresh
    // stamp, whereas recording the store here would file it under an old one.
    let doc = merged.doc;
    for (const namespace of PREFS_NAMESPACES) {
      const entry = doc.entries[namespace];
      if (entry !== undefined && entry.updatedAt <= 0) {
        doc = withEntry(doc, namespace, {
          updatedAt: nextPrefsStamp(doc.updatedAt),
          value: entry.value,
        });
      }
    }
    this.local = doc;
    this.writeRecord();

    // A device that changed something while offline has a genuinely newer value
    // and no other chance to send it: the next launch would merge it away from
    // the queue. One write, only when it is behind.
    if (newerThan(doc, remote).length > 0) this.schedule(0);
    return true;
  }

  private noteReadFailure(error: unknown): void {
    if (!(error instanceof ApiError)) return;
    if (error.status === 404) this.route = "missing";
    else if ([403, 405, 501, 503].includes(error.status)) this.route = "readonly";
  }

  private schedule(delay = DEBOUNCE_MS): void {
    if (this.session === null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const session = this.session;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.session === session) this.push();
    }, delay);
  }

  private push(): void {
    const session = this.session;
    if (session === null) return;
    if (this.route === "missing" || this.route === "readonly") return;
    this.chain = this.chain.then(() => this.pushNow(session)).catch(() => undefined);
  }

  private async pushNow(session: Session): Promise<void> {
    if (this.session !== session) return;
    this.retries = 0;

    // Nothing is stamped before the first read: sending it would let a device
    // that has never seen the account overwrite it. Read first, then write.
    // A read still in flight from sign-in counts as "not yet": wait for that
    // one rather than racing it, so the first change is compared, not guessed.
    if (!this.pulled || this.pulling !== null) {
      const pulled = await this.pull();
      if (!pulled || this.session !== session) return;
    }
    if (this.route !== "available") return;

    // Carries every namespace at its newest stamp, including the account's own
    // values for the halves this device did not touch.
    const doc = mergePreferences(this.stampedDoc(), this.remote).doc;
    if (doc.updatedAt <= 0) return;

    this.queue.enqueue(doc);
    const outcome = await this.queue.flush((entry) => this.send(session, entry));
    if (this.session !== session) return;

    if (outcome === "offline") this.scheduleRetry();
    else this.attempts = 0;
  }

  private async send(session: Session, doc: PrefsDoc): Promise<PrefsSendOutcome> {
    let write: PreferencesWrite;
    try {
      write = await putPreferences(transport, session, doc);
    } catch (error) {
      if (this.session !== session) return "stop";
      // A rejected token will not start working because we asked again. The
      // local values are untouched, and signing in again starts a new session.
      if (error instanceof ApiError && error.status === 401) return "stop";
      return "retry";
    }
    if (this.session !== session) return "stop";

    switch (write.kind) {
      case "missing":
        this.route = "missing";
        return "stop";
      case "readOnly":
        this.route = "readonly";
        return "stop";
      case "stored":
        this.route = "available";
        this.absorb(write.doc);
        return "sent";
      case "stale":
        return this.onStale(write.doc);
    }
  }

  /**
   * Another device wrote later than this one.
   *
   * Merged rather than retried blindly: the account's copy is adopted where it
   * is newer, and only a namespace this device genuinely holds newer is sent
   * again — once. A second refusal is the server settling the disagreement;
   * after that the account's copy wins for the namespaces it holds, and a tied
   * namespace keeps what is already on screen.
   */
  private onStale(remote: PrefsDoc): PrefsSendOutcome {
    this.route = "available";

    const merged = mergePreferences(this.stampedDoc(), remote);
    this.applyAdopted(merged.adopted, remote);
    this.local = merged.doc;
    this.writeRecord();

    if (newerThan(merged.doc, remote).length > 0 && this.retries < 1) {
      this.retries += 1;
      this.queue.enqueue(merged.doc);
      return "sent";
    }

    this.absorb(remote);
    return "sent";
  }

  /** Keeps whichever copy of each namespace is newer. */
  private absorb(remote: PrefsDoc): void {
    this.remote = remote;
    const merged = mergePreferences(this.snapshotDoc(this.local), remote);
    this.applyAdopted(merged.adopted, remote);
    this.local = merged.doc;
    this.writeRecord();
  }

  private applyAdopted(namespaces: PrefsNamespace[], doc: PrefsDoc): void {
    for (const namespace of namespaces) {
      const entry = doc.entries[namespace];
      if (entry !== undefined) STORES[namespace].adopt(entry.value);
    }
  }

  /**
   * This device's current values with the stamps already recorded for them.
   *
   * Every namespace is present, even one with a zero stamp: the value is real,
   * it just has no provenance yet.
   */
  private snapshotDoc(stamps: PrefsDoc): PrefsDoc {
    let doc = emptyPrefs();
    for (const namespace of PREFS_NAMESPACES) {
      doc = withEntry(doc, namespace, {
        updatedAt: stamps.entries[namespace]?.updatedAt ?? 0,
        value: STORES[namespace].snapshot(),
      });
    }
    return doc;
  }

  /** The same, with any unpulled value given a stamp so it can be sent. */
  private stampedDoc(): PrefsDoc {
    let doc = this.snapshotDoc(this.local);
    for (const namespace of PREFS_NAMESPACES) {
      const entry = doc.entries[namespace];
      if (entry !== undefined && entry.updatedAt <= 0) {
        doc = withEntry(doc, namespace, {
          updatedAt: nextPrefsStamp(doc.updatedAt),
          value: entry.value,
        });
      }
    }
    return doc;
  }

  private scheduleRetry(): void {
    if (this.session === null) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this.attempts, 4));
    this.attempts += 1;
    this.schedule(delay);
  }

  /** This device's stamps and values for one account, or nothing it can read. */
  private readRecord(session: Session): PrefsDoc {
    this.pulled = false;
    if (typeof localStorage === "undefined") return emptyPrefs();
    try {
      const raw = localStorage.getItem(scopedKey(RECORD_KEY, session));
      if (raw === null) return emptyPrefs();
      const saved = JSON.parse(raw) as { pulled?: unknown };
      this.pulled = saved.pulled === true;
      return parseLocalPreferences(saved);
    } catch {
      // A corrupt record is not worth a dialog; the stores' own keys still hold
      // the values, and the account's copy will be read afresh.
      return emptyPrefs();
    }
  }

  private writeRecord(): void {
    if (typeof localStorage === "undefined" || this.session === null) return;
    try {
      localStorage.setItem(
        scopedKey(RECORD_KEY, this.session),
        JSON.stringify({
          pulled: this.pulled,
          entries: Object.fromEntries(
            PREFS_NAMESPACES.flatMap((namespace) => {
              const entry = this.local.entries[namespace];
              return entry === undefined
                ? []
                : [[namespace, { updatedAt: entry.updatedAt, value: entry.value }] as const];
            }),
          ),
        }),
      );
    } catch {
      // Full or blocked storage: the stores still hold the values, and the
      // worst case is a first sync that looks like a first sync again.
    }
  }
}

export const prefs = new PrefsSync();
