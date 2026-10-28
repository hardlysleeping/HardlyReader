/**
 * Local mode, in one import.
 *
 * The seam is `ReaderBackend`; this directory is the other side of it. Nothing
 * in the app imports this yet — wiring the store to hold a `LocalBackend`
 * instead of calling the GReader functions is a separate change, and it is a
 * change to the store, not to the backend.
 *
 * The two entry points a caller is expected to use:
 *
 *   const backend = await openLocalBackend();   // SQLite on desktop, IDB in a tab
 *   await backend.stream(READING_LIST);
 *
 * `openLocalStore` is there for the same reason at one level down, for code
 * that needs the library rather than the reading interface — an importer, a
 * maintenance script, a test.
 */
import { LocalBackend, type LocalBackendOptions } from "./local-backend";
import { openLocalDatabase, type LocalDatabaseOptions } from "./open";
import { LocalStore } from "./store";

export { LocalBackend } from "./local-backend";
export { LocalStore, localItemId } from "./store";
export { openLocalDatabase, preferredEngine } from "./open";
export { LocalStorageError } from "./driver";
export { MemoryDatabase } from "./memory-db";
export {
  MARK_RETENTION_SECONDS,
  SYNC_FILE_NAME,
  SYNC_VERSION,
  TOMBSTONE_SECONDS,
  applySnapshot,
  buildSnapshot,
  emptySnapshot,
  mergeSnapshots,
  parseSyncSnapshot,
  pruneSnapshot,
  serializeSnapshot,
  syncOnce,
} from "./sync";
export { MemorySyncFolder, NativeSyncFolder, foldersAvailable, syncFolderAt } from "./sync-folder";
export {
  FolderSyncProvider,
  MemorySyncProvider,
  SYNC_PROVIDERS,
  SYNC_PROVIDER_IDS,
  syncProviderAt,
} from "./sync-provider";
export {
  REFRESH_POLICY,
  createRefresher,
  dueFeeds,
  feedDueAt,
  feedIntervalSeconds,
  isFeedDue,
  refreshDueFeeds,
} from "./refresh";
export type { LocalDatabaseOptions } from "./open";
export type { LocalBackendOptions } from "./local-backend";
export type {
  ApplyReport,
  BuildSnapshotOptions,
  SnapshotMerge,
  SnapshotRows,
  SyncConflict,
  SyncPrefs,
  SyncRun,
  SyncRunOptions,
  SyncSnapshot,
  SyncedFeed,
  SyncedFolder,
  SyncedMark,
  SyncedPlace,
  SyncedSidebar,
} from "./sync";
export type { SyncFolder } from "./sync-folder";
export type { SyncProvider, SyncProviderId } from "./sync-provider";
export type {
  FeedFetcher,
  FeedRequest,
  FeedResponse,
  RefreshFailure,
  RefreshOptions,
  RefreshPolicy,
  RefreshReport,
  Refresher,
  RefresherOptions,
  WakeReason,
} from "./refresh";
export type {
  EntryInput,
  EntryPage,
  EntryQuery,
  ExtractionInput,
  FeedCount,
  FetchOutcome,
  ReadingPosition,
  SubscribeOptions,
} from "./store";
export type {
  EntryRow,
  ExtractionRow,
  FeedRow,
  FolderRow,
  LocalEngine,
  LocalRow,
  LocalValue,
  PositionRow,
  TableName,
} from "./schema";
export type { LocalDatabase, WriteOperation } from "./driver";

/** Opens the library this runtime should use. */
export async function openLocalStore(options: LocalDatabaseOptions = {}): Promise<LocalStore> {
  return new LocalStore(await openLocalDatabase(options));
}

/** Opens the library and wraps it in the seam. */
export async function openLocalBackend(
  options: LocalDatabaseOptions & LocalBackendOptions = {},
): Promise<LocalBackend> {
  const store = await openLocalStore(options);
  return new LocalBackend(store, { deviceName: options.deviceName });
}
