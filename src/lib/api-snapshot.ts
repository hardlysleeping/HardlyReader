/**
 * The extension state this account last saw, kept where the first frame reads it.
 *
 * `loadApiState` is a request, and the window draws before it answers. Until it
 * does, the sidebar knows nothing about which categories are hidden, which are
 * pinned, how far the feed rows are indented or whether the curtain is down — so
 * every launch drew the hidden categories first and swept them away when the
 * answer landed. On a locked account that is not a flicker: the rows the lock
 * exists to cover were on screen for the length of a round trip.
 *
 * So the last state a read gave this account is stored beside its other
 * preferences and read back synchronously while the session is being set up.
 *
 * It is not a secret. It is what the server already tells every client of this
 * account — names, numeric ids, a view, an indent. What it must never be is
 * authority: a live read replaces it, and a read that comes back
 * `route_not_found` deletes it, because a server that has lost the extension
 * would otherwise be drawn from a cache forever.
 *
 * Keys are `<slug>|hardlyreader.apistate.v1`, the account scoping every
 * preference here uses (`lib/account-key`): no address in a key, and a second
 * login has a snapshot of its own.
 */

import { readAccountValue, writeAccountValue, type KeyStore } from "./account-key";
import {
  parseFavorites,
  parseSidebarIndent,
  parseState,
  type FavoritesState,
  type HiddenCategoriesState,
  type SidebarIndentState,
} from "../api/hardlyread";

export const API_SNAPSHOT_KEY = "hardlyreader.apistate.v1";

/** The three blocks one `/v1/state` read answers with, as they were drawn. */
export interface ApiSnapshotState {
  hiddenCategories: HiddenCategoriesState;
  favorites: FavoritesState;
  sidebarIndent: SidebarIndentState;
}

/** What one read left behind. */
export interface ApiSnapshot extends ApiSnapshotState {
  /**
   * When that read landed, in ms.
   *
   * Recorded, never enforced: there is no age past which this is thrown away.
   * The snapshot is always drawn with a live read already on its way, and
   * dropping an old one would put the hidden categories back on screen for the
   * length of that read — the one thing it exists to prevent. The stamp is here
   * so a sidebar that looks a week old can be explained.
   */
  savedAt: number;
}

/**
 * Whether this server has the adapter at all, as far as one launch can tell.
 *
 * `absent` is not a fault: an ordinary FreshRSS has no Hardly Read. `unknown`
 * is not an answer — the read has not landed, or the last one failed for a
 * reason that says nothing about the server.
 */
export type AddOnState = "connected" | "absent" | "unknown";

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * A stored blob, read back with the tolerance the live path uses.
 *
 * Each block has to be there and has to say whether it was available: a blob
 * missing that bit is not a state this build wrote, so it is not drawn. Every
 * field inside a block is normalised by the same parser that reads the wire —
 * a cache can therefore never say something the server could not.
 */
export function parseApiSnapshot(raw: unknown): ApiSnapshot | null {
  const saved = record(raw);
  if (saved === null) return null;
  const hidden = record(saved.hiddenCategories);
  const favorites = record(saved.favorites);
  const indent = record(saved.sidebarIndent);
  if (hidden === null || typeof hidden.available !== "boolean") return null;
  if (favorites === null || typeof favorites.available !== "boolean") return null;
  if (indent === null || typeof indent.available !== "boolean") return null;
  const at = saved.savedAt;
  return {
    hiddenCategories: parseState(hidden),
    favorites: parseFavorites(favorites),
    sidebarIndent: parseSidebarIndent(indent),
    savedAt: typeof at === "number" && Number.isFinite(at) ? at : 0,
  };
}

/** The account's stored snapshot, or null when there is none to trust. */
export function readApiSnapshot(
  storage: KeyStore | undefined,
  account: { readonly serverUrl: string; readonly email: string } | null,
): ApiSnapshot | null {
  if (!storage) return null;
  try {
    const raw = readAccountValue(storage, API_SNAPSHOT_KEY, account);
    if (raw === null) return null;
    return parseApiSnapshot(JSON.parse(raw) as unknown);
  } catch {
    // Corrupt JSON, or storage throwing: both mean "nothing cached", which is
    // the launch the app had before this file existed.
    return null;
  }
}

export function writeApiSnapshot(
  storage: KeyStore | undefined,
  account: { readonly serverUrl: string; readonly email: string } | null,
  state: ApiSnapshotState,
): ApiSnapshot {
  const snapshot: ApiSnapshot = { ...state, savedAt: Date.now() };
  if (!storage) return snapshot;
  try {
    writeAccountValue(storage, API_SNAPSHOT_KEY, account, JSON.stringify(snapshot));
  } catch {
    // Full or blocked storage: this launch still has the state in memory.
  }
  return snapshot;
}

/**
 * Forgets the snapshot, for a server that has answered "no such route".
 *
 * The key is overwritten with `null` rather than removed. `readAccountValue`
 * adopts a pre-scoping blob whenever the scoped key is missing, so removing the
 * key would let an old global snapshot come back as if it were news; a stored
 * `null` is how a cleared snapshot stays cleared.
 */
export function clearApiSnapshot(
  storage: KeyStore | undefined,
  account: { readonly serverUrl: string; readonly email: string } | null,
): void {
  if (!storage) return;
  try {
    writeAccountValue(storage, API_SNAPSHOT_KEY, account, "null");
  } catch {
    // Nothing to do: the next read is a miss either way.
  }
}
