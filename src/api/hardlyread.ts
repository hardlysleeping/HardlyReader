/**
 * HardlyRead v1 API client.
 *
 * This is the extension's own JSON surface, reached through FreshRSS's
 * `misc.php` hook — not the GReader API. GReader cannot express hidden state:
 * hiding rewrites feed priority to -10, which drops the feed out of
 * `subscription/list` entirely, so "hidden" and "deleted" are indistinguishable
 * over there.
 *
 * Wire contract (frozen; implemented by `extensions/xExtension-HardlyRead`):
 *
 *   GET /v1/state                    -> { apiVersion, hiddenCategories, favorites, sidebarIndent }
 *   PUT /v1/hidden-categories/{id}   <- { "hidden": true|false }
 *   PUT /v1/hidden-categories/view   <- { "view": "hidden"|"revealed"|"only" }
 *   PUT /v1/favorites/{id}           <- { "favorite": true|false }
 *   PUT /v1/favorites/view           <- { "view": "all"|"only"|"without" }
 *   PUT /v1/indent                   <- { "px": 0..60 }
 *
 * Auth rides the existing GoogleLogin credential from `clientLogin()`. No
 * second password, nothing new to store.
 *
 * Why `categories[]` exists at all: GReader only ever exposes category labels
 * (`user/-/label/Technology`), never FreshRSS's numeric category id — and the
 * PUT route needs that id. `categoryIdForLabel()` is the bridge.
 */
import { normalizeServerUrl, type Session, type Transport } from "./freshrss";

/**
 * misc.php keys extensions by the metadata `name`, never the entrypoint, and
 * keeps that name as the first path segment.
 */
const EXTENSION_NAME = "Hardly Read";
const API_PREFIX = `/api/misc.php/${encodeURIComponent(EXTENSION_NAME)}/v1`;

export const HIDDEN_VIEWS = ["hidden", "revealed", "only"] as const;
export type HiddenView = (typeof HIDDEN_VIEWS)[number];

export interface HiddenCategory {
  /** FreshRSS numeric category id — the value the PUT route takes. */
  id: number;
  /** Category name, as FreshRSS spells it. Matches the GReader label. */
  name: string;
  hidden: boolean;
}

export interface HiddenCategoriesState {
  /** False when Hidden Categories is not installed or not enabled for the
   * user. Every other field is then a default and must not be trusted. */
  available: boolean;
  mode: string;
  /** Stored view setting. */
  view: HiddenView;
  /** What the extension is actually applying — differs while locked. */
  effectiveView: HiddenView;
  hiddenIds: number[];
  locked: boolean;
  /** Whether a passcode exists. Locking is impossible without one. */
  hasPasscode: boolean;
  categories: HiddenCategory[];
}

export interface ApiState {
  apiVersion: number;
  hiddenCategories: HiddenCategoriesState;
  favorites: FavoritesState;
  sidebarIndent: SidebarIndentState;
}

/* ---------------------------------------------------------------------------
 * Favorites
 *
 * Same extension, different feature: a category is a favorite, and the view
 * decides which categories the server sweeps. `ids` is the authority on
 * membership — `categories` only supplies the id/name pairing the PUT route
 * needs, because GReader cannot tell the app a category's numeric id.
 * ------------------------------------------------------------------------- */

export const FAVORITE_VIEWS = ["all", "only", "without"] as const;
export type FavoriteView = (typeof FAVORITE_VIEWS)[number];

export interface FavoriteCategory {
  /** FreshRSS numeric category id — the value the PUT route takes. */
  id: number;
  name: string;
  favorite: boolean;
}

export interface FavoritesState {
  /** False when Pinned Categories is not installed or not enabled. Every
   * other field is then a default and must not be trusted. */
  available: boolean;
  view: FavoriteView;
  /** Favourited category ids. */
  ids: number[];
  categories: FavoriteCategory[];
}

export interface FavoriteMutationResult {
  /** False when the category was already in that state. */
  changed: boolean | null;
  favorites: FavoritesState;
}

/* ---------------------------------------------------------------------------
 * Sidebar indent
 *
 * Purely cosmetic, and the server is the only place the setting lives. A
 * missing or malformed value falls back rather than throwing: an indentation
 * is never worth a broken sidebar.
 * ------------------------------------------------------------------------- */

export const SIDEBAR_INDENT_FALLBACK_PX = 12;
export const SIDEBAR_INDENT_MIN_PX = 0;
/** The extension's own cap (`SidebarIndentExtension::MAX_INDENT`). */
export const SIDEBAR_INDENT_MAX_PX = 60;

export interface SidebarIndentState {
  available: boolean;
  /** Extra left padding for feed rows, already clamped. */
  px: number;
  /** The extension's cap, so the control can be sized from the server. */
  max: number;
}

export interface MutationResult {
  /** False when the category was already in that state. */
  changed: boolean | null;
  hiddenCategories: HiddenCategoriesState;
}

/** Error raised for any non-2xx answer from the v1 API. */
export class ApiError extends Error {
  /** HTTP status. */
  status: number;
  /** Machine-readable `error.code`, e.g. `convergence_failed`. */
  code: string;
  /** Authoritative hidden-categories state carried by 409/423 bodies, else null. */
  state: HiddenCategoriesState | null;
  /** Authoritative favorites state carried by a favorites failure, else null. */
  favorites: FavoritesState | null;

  constructor(
    status: number,
    code: string,
    message: string,
    state: HiddenCategoriesState | null = null,
    favorites: FavoritesState | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.state = state;
    this.favorites = favorites;
  }

  /** The token was rejected: the caller has to sign in again. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

/** A fresh "no extension" state. Fresh arrays each call, so callers can own it. */
export function unavailableState(): HiddenCategoriesState {
  return {
    available: false,
    mode: "",
    view: "hidden",
    effectiveView: "hidden",
    hiddenIds: [],
    locked: false,
    hasPasscode: false,
    categories: [],
  };
}

export function apiUrl(serverUrl: string, path: string): string {
  return `${normalizeServerUrl(serverUrl)}${API_PREFIX}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isView(value: unknown): value is HiddenView {
  return typeof value === "string" && (HIDDEN_VIEWS as readonly string[]).includes(value);
}

function isFavoriteView(value: unknown): value is FavoriteView {
  return typeof value === "string" && (FAVORITE_VIEWS as readonly string[]).includes(value);
}

function integerList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const id = typeof entry === "number" ? entry : Number.NaN;
    if (Number.isInteger(id) && id > 0) out.push(id);
  }
  return out;
}

function categoryList(value: unknown): HiddenCategory[] {
  if (!Array.isArray(value)) return [];
  const out: HiddenCategory[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "number" ? entry.id : Number.NaN;
    if (!Number.isInteger(id) || id <= 0) continue;
    out.push({
      id,
      name: typeof entry.name === "string" ? entry.name : "",
      hidden: entry.hidden === true,
    });
  }
  return out;
}

/**
 * Normalises the `hiddenCategories` block.
 *
 * Tolerant on read, strict on write: an older or partial server must not crash
 * the sidebar, but a malformed value never becomes an undefined view.
 */
export function parseState(raw: unknown): HiddenCategoriesState {
  if (!isRecord(raw) || raw.available !== true) {
    return unavailableState();
  }

  const view = isView(raw.view) ? raw.view : "hidden";
  return {
    available: true,
    mode: typeof raw.mode === "string" ? raw.mode : "",
    view,
    effectiveView: isView(raw.effectiveView) ? raw.effectiveView : view,
    hiddenIds: integerList(raw.hiddenIds),
    locked: raw.locked === true,
    hasPasscode: raw.hasPasscode === true,
    categories: categoryList(raw.categories),
  };
}

/** A fresh "no favorites extension" state. */
export function unavailableFavorites(): FavoritesState {
  return { available: false, view: "all", ids: [], categories: [] };
}

function favoriteCategoryList(value: unknown): FavoriteCategory[] {
  if (!Array.isArray(value)) return [];
  const out: FavoriteCategory[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "number" ? entry.id : Number.NaN;
    if (!Number.isInteger(id) || id <= 0) continue;
    out.push({
      id,
      name: typeof entry.name === "string" ? entry.name : "",
      favorite: entry.favorite === true,
    });
  }
  return out;
}

/** Normalises the `favorites` block, with the same tolerance as `parseState`. */
export function parseFavorites(raw: unknown): FavoritesState {
  if (!isRecord(raw) || raw.available !== true) {
    return unavailableFavorites();
  }

  return {
    available: true,
    view: isFavoriteView(raw.view) ? raw.view : "all",
    ids: integerList(raw.ids),
    categories: favoriteCategoryList(raw.categories),
  };
}

/**
 * A server-supplied indent, clamped to something a sidebar can survive.
 *
 * Anything that is not a finite number falls back; a real number is rounded
 * and held between the two bounds, so a value in the thousands cannot push the
 * feed titles off the right edge.
 */
export function clampIndentPx(value: unknown, max = SIDEBAR_INDENT_MAX_PX): number {
  const px = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(px)) return SIDEBAR_INDENT_FALLBACK_PX;
  return Math.min(Math.max(Math.round(px), SIDEBAR_INDENT_MIN_PX), max);
}

/** Normalises the `sidebarIndent` block. Unavailable reports the fallback. */
export function parseSidebarIndent(raw: unknown): SidebarIndentState {
  if (!isRecord(raw) || raw.available !== true) {
    return { available: false, px: SIDEBAR_INDENT_FALLBACK_PX, max: SIDEBAR_INDENT_MAX_PX };
  }
  // The server's own cap wins when it reports one: a client that invents a
  // larger range would send values the extension silently clamps.
  const max =
    typeof raw.max === "number" && Number.isFinite(raw.max) && raw.max > 0
      ? Math.min(Math.round(raw.max), SIDEBAR_INDENT_MAX_PX)
      : SIDEBAR_INDENT_MAX_PX;
  return { available: true, px: clampIndentPx(raw.px, max), max };
}

/** The whole `/v1/state` body. Unknown keys are ignored, missing ones default. */
export function parseApiState(raw: unknown): ApiState {
  const body = isRecord(raw) ? raw : {};
  return {
    apiVersion: typeof body.apiVersion === "number" ? body.apiVersion : 0,
    hiddenCategories: parseState(body.hiddenCategories),
    favorites: parseFavorites(body.favorites),
    sidebarIndent: parseSidebarIndent(body.sidebarIndent),
  };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A proxy error page or an empty 502 has no JSON; the status is the story.
    return {};
  }
}

function failure(status: number, body: Record<string, unknown>): ApiError {
  const error = isRecord(body.error) ? body.error : {};
  const code = typeof error.code === "string" && error.code !== "" ? error.code : `http_${status}`;
  const fallback = status === 401 ? "Token rejected by server" : `Request failed (HTTP ${status})`;
  const message = typeof error.message === "string" && error.message !== "" ? error.message : fallback;
  return new ApiError(
    status,
    code,
    message,
    isRecord(body.hiddenCategories) ? parseState(body.hiddenCategories) : null,
    isRecord(body.favorites) ? parseFavorites(body.favorites) : null,
  );
}

interface RequestOptions {
  method: "GET" | "PUT" | "POST";
  body?: Record<string, unknown>;
}

async function request(
  transport: Transport,
  session: Session,
  path: string,
  options: RequestOptions,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `GoogleLogin auth=${session.token}`,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await transport(apiUrl(session.serverUrl, path), {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const body = await bodyOf(response);
  if (!response.ok) {
    throw failure(response.status, body);
  }
  return body;
}

/** Reads hidden state. Never 409s; 401 means the credential is dead. */
export async function getState(transport: Transport, session: Session): Promise<HiddenCategoriesState> {
  const body = await request(transport, session, "/state", { method: "GET" });
  return parseState(body.hiddenCategories);
}

/**
 * Reads every block of `/v1/state` in one request.
 *
 * One call, not three: the extension builds all of them from the same user
 * configuration, and three round trips could each see a different snapshot.
 */
export async function getApiState(transport: Transport, session: Session): Promise<ApiState> {
  return parseApiState(await request(transport, session, "/state", { method: "GET" }));
}

/**
 * Sets one category's hidden flag explicitly.
 *
 * Explicit state, never a toggle: the server is told what the answer should
 * be, so a lost response cannot invert the user's intent on retry.
 */
export async function setCategoryHidden(
  transport: Transport,
  session: Session,
  categoryId: number,
  hidden: boolean,
): Promise<MutationResult> {
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    throw new RangeError(`Category id must be a positive integer, got ${String(categoryId)}`);
  }
  if (typeof hidden !== "boolean") {
    throw new TypeError("hidden must be a boolean");
  }

  const body = await request(transport, session, `/hidden-categories/${categoryId}`, {
    method: "PUT",
    body: { hidden },
  });
  return {
    changed: typeof body.changed === "boolean" ? body.changed : null,
    hiddenCategories: parseState(body.hiddenCategories),
  };
}

/** Sets the hidden-categories view. Locked state answers 423 with the state. */
export async function setView(
  transport: Transport,
  session: Session,
  view: HiddenView,
): Promise<MutationResult> {
  if (!isView(view)) {
    throw new RangeError(`Unknown view: ${String(view)}`);
  }

  const body = await request(transport, session, "/hidden-categories/view", {
    method: "PUT",
    body: { view },
  });
  return {
    changed: typeof body.changed === "boolean" ? body.changed : null,
    hiddenCategories: parseState(body.hiddenCategories),
  };
}

/**
 * Locks the curtain. The extension refuses when no passcode is set (409
 * `passcode_required`), which is why the app asks for a passcode first.
 */
export async function lockHidden(transport: Transport, session: Session): Promise<MutationResult> {
  const body = await request(transport, session, "/lock", { method: "POST" });
  return {
    changed: typeof body.changed === "boolean" ? body.changed : null,
    hiddenCategories: parseState(body.hiddenCategories),
  };
}

/**
 * Unlocks with the passcode. A wrong code is 403 `wrong_passcode`; the state
 * submitted with the error is still authoritative, so the client stays in sync.
 */
export async function unlockHidden(
  transport: Transport,
  session: Session,
  passcode: string,
): Promise<MutationResult> {
  if (typeof passcode !== "string" || passcode === "") {
    throw new RangeError("A passcode is required to unlock");
  }
  const body = await request(transport, session, "/unlock", {
    method: "POST",
    body: { passcode },
  });
  return {
    changed: typeof body.changed === "boolean" ? body.changed : null,
    hiddenCategories: parseState(body.hiddenCategories),
  };
}

/**
 * Sets or clears the passcode. An empty string disables locking, matching the
 * extension's settings form; the digits-only rule is enforced server-side.
 */
export async function setHiddenPasscode(
  transport: Transport,
  session: Session,
  passcode: string,
): Promise<MutationResult> {
  const body = await request(transport, session, "/passcode", {
    method: "PUT",
    body: { passcode },
  });
  return {
    changed: typeof body.changed === "boolean" ? body.changed : null,
    hiddenCategories: parseState(body.hiddenCategories),
  };
}

/**
 * Sets one category's favorite flag explicitly.
 *
 * `changed: false` is a success, not a no-op to retry: the server is already
 * in the state that was asked for.
 */
export async function setCategoryFavorite(
  transport: Transport,
  session: Session,
  categoryId: number,
  favorite: boolean,
): Promise<FavoriteMutationResult> {
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    throw new RangeError(`Category id must be a positive integer, got ${String(categoryId)}`);
  }
  if (typeof favorite !== "boolean") {
    throw new TypeError("favorite must be a boolean");
  }

  const body = await request(transport, session, `/favorites/${categoryId}`, {
    method: "PUT",
    body: { favorite },
  });
  return {
    changed: typeof body.changed === "boolean" ? body.changed : null,
    favorites: parseFavorites(body.favorites),
  };
}

/** Sets the favorites view. */
export async function setFavoritesView(
  transport: Transport,
  session: Session,
  view: FavoriteView,
): Promise<FavoriteMutationResult> {
  if (!isFavoriteView(view)) {
    throw new RangeError(`Unknown favorites view: ${String(view)}`);
  }

  const body = await request(transport, session, "/favorites/view", {
    method: "PUT",
    body: { view },
  });
  return {
    changed: typeof body.changed === "boolean" ? body.changed : null,
    favorites: parseFavorites(body.favorites),
  };
}

/* ---------------------------------------------------------------------------
 * Label -> numeric id
 *
 * GReader hands the app labels; the PUT route wants ids. These are the only
 * two places that translation happens.
 * ------------------------------------------------------------------------- */

export const LABEL_PREFIX = "user/-/label/";

/** The bare label behind a GReader category stream id. */
export function labelOf(streamId: string): string {
  return streamId.startsWith(LABEL_PREFIX) ? streamId.slice(LABEL_PREFIX.length) : streamId;
}

/**
 * The numeric id behind a label, given a list of `{ id, name }` entries.
 *
 * Exact match first, then a case-insensitive one: FreshRSS category names are
 * unique case-insensitively, but the label the GReader API echoes back may
 * still differ in case from the stored name.
 */
function idForLabel(entries: { id: number; name: string }[], labelOrStreamId: string): number | null {
  const label = labelOf(labelOrStreamId);
  if (label === "") return null;

  const exact = entries.find((entry) => entry.name === label);
  if (exact) return exact.id;

  const folded = label.toLocaleLowerCase();
  const loose = entries.find((entry) => entry.name.toLocaleLowerCase() === folded);
  return loose ? loose.id : null;
}

/**
 * The numeric FreshRSS id for a GReader label or label stream id, or null when
 * the extension does not know that category (unknown name, `Uncategorized`, or
 * Hidden Categories not installed).
 */
export function categoryIdForLabel(state: HiddenCategoriesState, labelOrStreamId: string): number | null {
  return idForLabel(state.categories, labelOrStreamId);
}

/** The same lookup against the favorites block's id/name pairs. */
export function favoriteIdForLabel(state: FavoritesState, labelOrStreamId: string): number | null {
  return idForLabel(state.categories, labelOrStreamId);
}

/** True when the label/id names a favourite according to the server. */
export function isFavoriteCategory(state: FavoritesState, labelOrStreamId: string): boolean {
  if (!state.available) return false;
  const id = favoriteIdForLabel(state, labelOrStreamId);
  return id !== null && state.ids.includes(id);
}

/** True when the label/id names a hidden category according to the server. */
export function isHiddenCategory(state: HiddenCategoriesState, labelOrStreamId: string): boolean {
  if (!state.available) return false;
  const id = categoryIdForLabel(state, labelOrStreamId);
  return id !== null && state.hiddenIds.includes(id);
}

/**
 * Writes the sidebar indent.
 *
 * The extension owns the setting, so this is the same integer its own sidebar
 * slider writes — the website and the app cannot drift apart. Sent as an
 * integer because the route rejects strings and floats: a slider reading "20"
 * is a client bug, not a value to coerce.
 */
export async function setIndent(
  transport: Transport,
  session: Session,
  px: number,
): Promise<{ changed: boolean | null; sidebarIndent: SidebarIndentState }> {
  if (!Number.isInteger(px) || px < SIDEBAR_INDENT_MIN_PX || px > SIDEBAR_INDENT_MAX_PX) {
    throw new RangeError(`Indent must be an integer in ${SIDEBAR_INDENT_MIN_PX}..${SIDEBAR_INDENT_MAX_PX}, got ${String(px)}`);
  }

  const body = await request(transport, session, "/indent", { method: "PUT", body: { px } });
  return {
    changed: typeof body.changed === "boolean" ? body.changed : null,
    sidebarIndent: parseSidebarIndent(body.sidebarIndent),
  };
}
