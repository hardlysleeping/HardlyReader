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
 *   GET /v1/state                    -> { apiVersion, hiddenCategories }
 *   PUT /v1/hidden-categories/{id}   <- { "hidden": true|false }
 *   PUT /v1/hidden-categories/view   <- { "view": "hidden"|"revealed"|"only" }
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
  categories: HiddenCategory[];
}

export interface ApiState {
  apiVersion: number;
  hiddenCategories: HiddenCategoriesState;
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
  /** Authoritative state carried by 409/423 bodies, else null. */
  state: HiddenCategoriesState | null;

  constructor(status: number, code: string, message: string, state: HiddenCategoriesState | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.state = state;
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
    categories: categoryList(raw.categories),
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
  return new ApiError(status, code, message, isRecord(body.hiddenCategories) ? parseState(body.hiddenCategories) : null);
}

interface RequestOptions {
  method: "GET" | "PUT";
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
 * The numeric FreshRSS id for a GReader label or label stream id, or null when
 * the extension does not know that category (unknown name, `Uncategorized`, or
 * Hidden Categories not installed).
 */
export function categoryIdForLabel(state: HiddenCategoriesState, labelOrStreamId: string): number | null {
  const label = labelOf(labelOrStreamId);
  if (label === "") return null;

  const exact = state.categories.find((category) => category.name === label);
  if (exact) return exact.id;

  // FreshRSS category names are unique case-insensitively; the label the
  // GReader API echoes back may still differ in case from the stored name.
  const folded = label.toLocaleLowerCase();
  const loose = state.categories.find((category) => category.name.toLocaleLowerCase() === folded);
  return loose ? loose.id : null;
}

/** True when the label/id names a hidden category according to the server. */
export function isHiddenCategory(state: HiddenCategoriesState, labelOrStreamId: string): boolean {
  if (!state.available) return false;
  const id = categoryIdForLabel(state, labelOrStreamId);
  return id !== null && state.hiddenIds.includes(id);
}
