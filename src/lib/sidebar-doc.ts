/**
 * The sidebar and the reading place, as documents that travel.
 *
 * A FreshRSS profile has two authorities behind these already: the extension
 * answers for hidden categories, pins and the indent, and the reader's own copy
 * answers for the arrangement. A local profile has only the second one — the
 * device — so this is the shape that carries it between two local libraries, and
 * it is deliberately the same shape `reader.svelte.ts` already persists under
 * `PREFS_BASE`. One document, written for whichever authority is in charge.
 *
 * Two documents, not one, and the reason is stamps. The arrangement (hidden
 * categories, pins, views, indent, the two orders) changes when the reader
 * decides something. The place changes whenever they move: every feed opened,
 * every post selected. Stamping them together would mean scrolling on the phone
 * outvoted a pin made on the desktop — the conflict this file exists to avoid —
 * so they carry their own marks and merge independently.
 *
 * Nothing here reads a store, a server or a DOM: it parses, compares and
 * describes, so the unit harness can hold it to the rules directly.
 */
import type { Place } from "./place";

/**
 * How many entries one list may carry.
 *
 * A document is uploaded every time it changes, and a reader with a thousand
 * feeds is a reader whose order is a thousand ids. The cap is a bound on what a
 * corrupt or hostile file can make this build draw, not a limit anyone reaches:
 * a sidebar with more rows than this has stopped being a sidebar.
 */
const MAX_LIST = 2000;

/** A label or an id this build is willing to carry. */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 512 ? value : null;
}

/** A list of labels, in the order the sidebar draws them. */
function texts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const clean = text(entry);
    if (clean === null || out.includes(clean)) continue;
    out.push(clean);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/**
 * The arrangement, as both authorities keep it.
 *
 * The two views are stored as the keys the app already uses, not as the words
 * on the button, so a stored document keeps its meaning when a label is
 * reworded. An unknown view is dropped rather than guessed at: the default is
 * the view that hides nothing.
 */
export interface SidebarDoc {
  /** Hidden category labels. */
  hidden: string[];
  /** Which of the extension's three views the eye is on. */
  hiddenView: "hidden" | "revealed" | "only";
  /** Pinned category labels. */
  pins: string[];
  /** Pinned stream ids — feeds, which have no server-side home for a pin. */
  pinFeeds: string[];
  /** Which of the pin filter's three states is in force. */
  pinView: "all" | "only" | "without";
  /** Feed indent, in pixels; null when the reader has never moved it. */
  indentPx: number | null;
  /** Feed order, outermost first. */
  feedOrder: string[];
  /** Category order, outermost first. */
  categoryOrder: string[];
}

const HIDDEN_VIEWS = ["hidden", "revealed", "only"] as const;
const PIN_VIEWS = ["all", "only", "without"] as const;

export function hiddenViewOf(value: unknown): SidebarDoc["hiddenView"] {
  return (HIDDEN_VIEWS as readonly string[]).includes(value as string)
    ? (value as SidebarDoc["hiddenView"])
    : "hidden";
}

export function pinViewOf(value: unknown): SidebarDoc["pinView"] {
  return (PIN_VIEWS as readonly string[]).includes(value as string)
    ? (value as SidebarDoc["pinView"])
    : "all";
}

/** A sidebar nothing has been decided about. */
export function emptySidebar(): SidebarDoc {
  return {
    hidden: [],
    hiddenView: "hidden",
    pins: [],
    pinFeeds: [],
    pinView: "all",
    indentPx: null,
    feedOrder: [],
    categoryOrder: [],
  };
}

function indentOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 200
    ? Math.round(value)
    : null;
}

/**
 * Reads whatever a document held.
 *
 * Tolerant field by field and never inventing: a list that is not a list is
 * empty, an unknown view is the default, an indent outside a sane range is no
 * indent. A value that is not an object at all is `null`, which the caller
 * treats as "this device has said nothing" rather than "the sidebar is empty" —
 * the difference between not knowing and knowing there is nothing.
 */
export function parseSidebar(raw: unknown): SidebarDoc | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    hidden: texts(value.hidden),
    hiddenView: hiddenViewOf(value.hiddenView),
    pins: texts(value.pins),
    pinFeeds: texts(value.pinFeeds),
    pinView: pinViewOf(value.pinView),
    indentPx: indentOf(value.indentPx),
    feedOrder: texts(value.feedOrder),
    categoryOrder: texts(value.categoryOrder),
  };
}

/** The document in a fixed key order, so two copies can be compared as text. */
function canonicalSidebar(doc: SidebarDoc): string {
  return JSON.stringify([
    doc.hidden,
    doc.hiddenView,
    doc.pins,
    doc.pinFeeds,
    doc.pinView,
    doc.indentPx,
    doc.feedOrder,
    doc.categoryOrder,
  ]);
}

/**
 * Whether two copies say the same thing, ignoring when they were stamped.
 *
 * `at` is deliberately not part of this: a device that has changed nothing
 * since the last agreement must be recognised as unchanged, or every launch
 * would claim the sidebar had moved and win the next argument by being newer.
 */
export function sameSidebar(a: SidebarDoc, b: SidebarDoc): boolean {
  return canonicalSidebar(a) === canonicalSidebar(b);
}

/** A stable tie-break for two copies changed in the same second. */
export function sidebarTie(a: SidebarDoc, b: SidebarDoc): number {
  return canonicalSidebar(a) < canonicalSidebar(b) ? 1 : -1;
}

/** Nothing has been decided on this device yet. */
export function isEmptySidebar(doc: SidebarDoc): boolean {
  return sameSidebar(doc, emptySidebar());
}

/**
 * The arrangement in the reader's words, for a conflict the panel can show.
 *
 * Counts rather than the labels themselves: a conflict line is one row in a
 * settings sheet, and "4 hidden, 2 pinned" says what was lost without printing
 * a category name the reader has to match by eye.
 */
export function describeSidebar(doc: SidebarDoc): string {
  const parts: string[] = [];
  if (doc.hidden.length > 0) parts.push(`${doc.hidden.length} hidden`);
  if (doc.pins.length > 0) parts.push(`${doc.pins.length} pinned`);
  if (doc.pinFeeds.length > 0) parts.push(`${doc.pinFeeds.length} feeds pinned`);
  if (doc.indentPx !== null) parts.push(`${doc.indentPx}px indent`);
  if (doc.feedOrder.length > 0) parts.push("feed order");
  if (doc.categoryOrder.length > 0) parts.push("category order");
  return parts.length === 0 ? "nothing arranged" : parts.join(", ");
}

/**
 * Where the reader was: the feed, the post, and the line in it.
 *
 * The same shape as `lib/place`'s `Place`, because it is the same fact. On a
 * device that has a library of its own it lives under the account key already;
 * this is how it reaches the second device, so a phone opens where the desktop
 * was left rather than at the Reading list.
 */
export type PlaceDoc = Place;

export function emptyPlace(): PlaceDoc {
  return {
    streamId: null,
    streamTitle: "",
    articleId: null,
    expandedFeedId: null,
    articleScroll: 0,
    listScroll: 0,
  };
}

function pixels(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Reads whatever a document held, or `null` when it held nothing usable. */
export function parsePlaceDoc(raw: unknown): PlaceDoc | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const streamId = text(value.streamId);
  // A post cannot be resumed without the feed it came from, and a document that
  // names neither is a device that has not been anywhere.
  if (streamId === null) return null;
  return {
    streamId,
    streamTitle: text(value.streamTitle) ?? "",
    articleId: text(value.articleId),
    expandedFeedId: text(value.expandedFeedId),
    articleScroll: pixels(value.articleScroll),
    listScroll: pixels(value.listScroll),
  };
}

function canonicalPlace(doc: PlaceDoc): string {
  return JSON.stringify([
    doc.streamId,
    doc.streamTitle,
    doc.articleId,
    doc.expandedFeedId,
    doc.articleScroll,
    doc.listScroll,
  ]);
}

export function samePlace(a: PlaceDoc, b: PlaceDoc): boolean {
  return canonicalPlace(a) === canonicalPlace(b);
}

export function placeTie(a: PlaceDoc, b: PlaceDoc): number {
  return canonicalPlace(a) < canonicalPlace(b) ? 1 : -1;
}

/** In the reader's words: what the losing device was looking at. */
export function describePlace(doc: PlaceDoc): string {
  return doc.streamTitle === "" ? "somewhere" : `"${doc.streamTitle}"`;
}
