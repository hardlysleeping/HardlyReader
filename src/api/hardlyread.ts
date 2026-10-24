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
 *   GET /v1/positions                -> { apiVersion, updatedAt, categories[], feeds[] }
 *   PUT /v1/positions                <- { updatedAt, categories[], feeds[] }
 *                                       an older stamp is refused `409 stale_positions`,
 *                                       carrying only the winning `updatedAt`
 *   GET /v1/people?q=                -> { enabled, people: [{ name, added }] }
 *   POST /v1/people                  <- { "name": "…" }  (one write, never retried)
 *
 * `peopleAvailable` is additive on `/v1/state`, appended after the keys above:
 * a server without the capability simply omits it, which reads as false.
 *
 * Auth rides the existing GoogleLogin credential from `clientLogin()`. No
 * second password, nothing new to store.
 *
 * Why `categories[]` exists at all: GReader only ever exposes category labels
 * (`user/-/label/Technology`), never FreshRSS's numeric category id — and the
 * PUT route needs that id. `categoryIdForLabel()` is the bridge.
 */
import { normalizeApiPath, normalizeServerUrl, type Session, type Transport } from "./freshrss";
import { mergePositions, nextStamp, parsePositions, positionsBody, type Positions } from "../lib/positions";
import { parseAddPerson, parsePeopleList, parsePeopleStatus, recordAvailability, type Person } from "../lib/people";

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
  /**
   * True when this server offers the person lookup. Not a block like the three
   * above — the capability is a yes/no, and everything else about a lookup is
   * answered by its own route.
   */
  peopleAvailable: boolean;
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
  /**
   * The response body as it arrived, when it was JSON.
   *
   * A refusal is not always a dead end: `409 stale_positions` carries the
   * stamp of the arrangement that won, which is the whole point of the answer.
   * Callers that need it read it from here instead of guessing.
   */
  body: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    state: HiddenCategoriesState | null = null,
    favorites: FavoritesState | null = null,
    body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.state = state;
    this.favorites = favorites;
    this.body = body;
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

/**
 * Whether this server can carry the adapter at all.
 *
 * The adapter is an extension *inside FreshRSS*: its routes are served by
 * FreshRSS's own `misc.php`, out of a directory FreshRSS owns. Any other
 * GReader server answers those paths with whatever its front controller does —
 * a 404 if we are lucky, a login page or an SPA shell if we are not — so an
 * extension-backed route is never requested unless this session's GReader prefix
 * is FreshRSS's `greader.php`. A session saved before prefixes existed has no
 * field and therefore means FreshRSS, which is why it is treated as one.
 *
 * The check is on the prefix and not on a product name: a FreshRSS installed in
 * a subdirectory or behind a proxy still ends in `greader.php`, and no other
 * server does. `404 route_not_found` from the adapter itself remains the second
 * line of defence, and it is the one that covers an older FreshRSS.
 */
export function supportsExtensionRoutes(session: Session): boolean {
  return /\/greader\.php$/i.test(normalizeApiPath(session.apiPath));
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
    // Absent is false, never a guess: an older server has no such route, and a
    // toggle that offered itself there would fail the moment it was used.
    peopleAvailable: body.peopleAvailable === true,
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
    body,
  );
}

interface RequestOptions {
  method: "GET" | "PUT" | "POST";
  body?: Record<string, unknown>;
  /** For callers that can be overtaken — a keystroke cancels the one before it. */
  signal?: AbortSignal;
}

async function request(
  transport: Transport,
  session: Session,
  path: string,
  options: RequestOptions,
): Promise<Record<string, unknown>> {
  // One choke point for the whole extension surface: every route below goes
  // through here, so nothing extension-backed can leave the client for a server
  // that could not have the adapter. A 404 is the answer the callers already
  // understand as `available: false`.
  if (!supportsExtensionRoutes(session)) {
    throw new ApiError(
      404,
      "route_not_found",
      `The ${EXTENSION_NAME} adapter is a FreshRSS extension and this server is not FreshRSS`,
    );
  }
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
    signal: options.signal,
  });

  const body = await bodyOf(response);
  if (!response.ok) {
    throw failure(response.status, body);
  }
  return body;
}

/**
 * True when the answer says the route is not there at all.
 *
 * `404 route_not_found` is what an adapter that predates `/v1/positions`
 * answers. It is not a failure of the read: it means the account has no
 * arrangement store, so local storage is the only copy and nothing is shown.
 */
export function isRouteMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * The arrangement stored for this account.
 *
 * Throws like every other read — the caller decides what a failure means
 * (`isRouteMissing` for an old adapter, silence for everything else).
 */
export async function getPositions(transport: Transport, session: Session): Promise<Positions> {
  const body = await request(transport, session, "/positions", { method: "GET" });
  return parsePositions(body);
}

/** What a write came to. Never a throw for the two answers that are information. */
export type PositionsWrite =
  /** Accepted: the server now holds this document. */
  | { kind: "stored"; positions: Positions }
  /**
   * Refused because a newer arrangement is already stored. The refusal carries
   * the winning **stamp**, not the winning lists, so the caller reads the
   * arrangement once and takes its word — it never retries its own copy.
   */
  | { kind: "stale"; storedAt: number }
  /** The adapter predates the route: nothing is stored, and nothing will be. */
  | { kind: "missing" };

/**
 * Stores the arrangement, stamp and all.
 *
 * `404` and `409` come back as outcomes rather than exceptions, because both
 * are answers a client acts on: an old adapter means "local only", and a stale
 * write means "somebody else arranged this later, read it". Every other failure
 * is still a throw — a wrong password must not be mistaken for an old server.
 */
export async function putPositions(
  transport: Transport,
  session: Session,
  positions: Positions,
): Promise<PositionsWrite> {
  try {
    const body = await request(transport, session, "/positions", {
      method: "PUT",
      body: positionsBody(positions),
    });
    // A 200 that still says `stale` (an older adapter's spelling) is the same
    // answer as a 409: the stored copy is not ours.
    if (body.stale === true || body.code === "stale_positions") {
      return { kind: "stale", storedAt: parsePositions(body).updatedAt };
    }
    return { kind: "stored", positions: parsePositions(body) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === "stale_positions") {
      return { kind: "stale", storedAt: parsePositions({ updatedAt: error.body.updatedAt }).updatedAt };
    }
    if (isRouteMissing(error)) return { kind: "missing" };
    throw error;
  }
}

/** The two lists a write carries. Ids only — what the sidebar is drawn from. */
export interface PositionsLists {
  categories: string[];
  feeds: string[];
}

/**
 * Writes the arrangement with the next stamp after `previous`.
 *
 * The stamping lives here, next to the route that compares stamps, so no caller
 * has to remember the rule: strictly increasing, even when the clock has not
 * ticked, because two drags in one millisecond are two writes.
 */
export async function savePositions(
  transport: Transport,
  session: Session,
  lists: PositionsLists,
  previous: number,
): Promise<PositionsWrite> {
  return putPositions(transport, session, {
    updatedAt: nextStamp(previous),
    categories: [...lists.categories],
    feeds: [...lists.feeds],
  });
}

/** What a start-time read came to. */
export type PositionsRead =
  /** Reached the account: `positions` is the winner of the two copies. */
  | { kind: "remote"; positions: Positions }
  /** Reached the account, and the copy in hand is newer. Nothing to adopt. */
  | { kind: "local" }
  /** No route on this adapter: local storage is the only copy. */
  | { kind: "missing" }
  /** Network, auth or server trouble. Local stands; nothing is shown. */
  | { kind: "failed"; error: unknown };

/**
 * Reads the account's copy once and says which one wins.
 *
 * The merge itself is `mergePositions`: newer stamp wins, a tie goes to the
 * copy in hand. This wrapper exists so the reader never has to know whether a
 * failure was "no such route" or "the network is down" — both mean the same
 * thing on screen, which is nothing at all.
 */
export async function reconcilePositions(
  transport: Transport,
  session: Session,
  local: Positions,
): Promise<PositionsRead> {
  try {
    const remote = await getPositions(transport, session);
    const merged = mergePositions(local, remote);
    return merged.source === "remote" ? { kind: "remote", positions: merged.positions } : { kind: "local" };
  } catch (error) {
    return isRouteMissing(error) ? { kind: "missing" } : { kind: "failed", error };
  }
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
  const state = parseApiState(await request(transport, session, "/state", { method: "GET" }));
  // Remembered here, at the one place this response is read. The search field
  // asks synchronously whether the person toggle belongs in it, so on a later
  // start the answer has to be on hand before the first frame rather than after
  // a discovery request. A failed read records nothing: a flaky network must not
  // take a control away from a server that has it.
  recordAvailability(session.serverUrl, session.email, state.peopleAvailable);
  return state;
}

/**
 * The state token, for noticing changes made outside this app.
 *
 * Same state the `/state` call returns, hashed on the server: one short string
 * instead of a payload. Used by the change watch, not by anything that needs to
 * know the state itself.
 */
export async function getRevision(transport: Transport, session: Session): Promise<string> {
  const body = await request(transport, session, "/revision", { method: "GET" });
  const token = (body as { revision?: unknown }).revision;
  return typeof token === "string" ? token : "";
}

/* ---------------------------------------------------------------------------
 * People
 *
 * A name lookup beside the feed search. All three routes sit behind the same
 * capability flag `/v1/state` reports, so a caller holding the flag holds the
 * routes too; a server without the capability answers `404 route_not_found` for
 * every one of them, which is why the toggle is never drawn on a guess and an
 * empty answer here always means "no match" rather than "not installed".
 * ------------------------------------------------------------------------- */

/** What one search answered. `message` is a failure worth showing, never a hint. */
export interface PeopleAnswer {
  enabled: boolean;
  people: Person[];
  message: string | null;
}

/**
 * Is the lookup here at all?
 *
 * Not called on startup: `/v1/state` already says so, and asking twice would be
 * a second round trip for an answer the app has. This is for a caller that
 * wants to re-check without reading the whole state.
 */
export async function getPeopleStatus(transport: Transport, session: Session): Promise<boolean> {
  const body = await request(transport, session, "/people/status", { method: "GET" });
  return parsePeopleStatus(body);
}

/**
 * Names matching `query`, best first, as far as the server is willing to rank.
 *
 * An empty query is not sent: the route would answer with a list nobody asked
 * for, and the field only offers results once something has been typed.
 */
export async function searchPeople(
  transport: Transport,
  session: Session,
  query: string,
  signal?: AbortSignal,
): Promise<PeopleAnswer> {
  const body = await request(transport, session, `/people?q=${encodeURIComponent(query.trim())}`, {
    method: "GET",
    signal,
  });
  return {
    enabled: body.enabled === true,
    people: parsePeopleList(body.people),
    message: typeof body.message === "string" && body.message !== "" ? body.message : null,
  };
}

/**
 * Adds one person, which is a subscription on the server.
 *
 * A single write with no retry: the route subscribes, and a retry after a lost
 * response would ask for the same subscription twice. `ok === false` is an
 * answer, not an exception — the server's own words are passed on.
 */
export async function addPerson(
  transport: Transport,
  session: Session,
  name: string,
): Promise<{ ok: boolean; message: string | null }> {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new RangeError("A person needs a name");
  }
  const body = await request(transport, session, "/people", {
    method: "POST",
    body: { name: trimmed },
  });
  return parseAddPerson(body);
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
