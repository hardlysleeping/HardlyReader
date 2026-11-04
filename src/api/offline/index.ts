/**
 * Offline writes, in one import.
 *
 * `WriteJournal` is the queue a reader's read and star marks go into, and
 * `OfflineBackend` is a server backend with that queue in front of it. Nothing
 * here knows what a pane looks like: the reading store asks its backend for a
 * mark, and whether the answer was a request or a row on disk is this
 * directory's business.
 */
export { OfflineBackend, batches, verdictFor } from "./backend";
export { IdbJournalBank, MemoryJournalBank, WriteJournal, markKey } from "./journal";
export type { FlushReport, FlushStop, OfflineBackendOptions } from "./backend";
export type { JournalBank, MarkKind, PendingMark } from "./journal";
