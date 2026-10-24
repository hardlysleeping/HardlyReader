/**
 * Searching for a person by name, alongside the feeds.
 *
 * A name lookup is a different shape of result from a feed: the server answers
 * with names it recognises and whether each one is already subscribed, so a row
 * is either "open the feed I already have" or "add this one". Nothing here
 * touches the network — the wire shapes and the remembered availability are
 * plain functions so they can be argued with in a test.
 *
 * Availability is remembered per account and read synchronously. The search
 * field decides on its very first render whether the person toggle exists, and
 * a control that appears a moment after the field does reads as a glitch; so the
 * answer to the one state request is written here and used by the next start.
 */
import { bylineOf, type BylineSource } from "./byline";

/** One row of an answer: a name, and whether it is already subscribed. */
export interface Person {
  name: string;
  added: boolean;
}

/** Key holding which accounts' servers offer the lookup. */
export const PEOPLE_PREF_KEY = "hardlyreader.people.v1";

/**
 * One account on one server, so two logins never inherit each other's answer.
 * Trailing slashes are dropped because the same server is spelled both ways.
 */
export function peopleScope(serverUrl: string, user: string): string {
  return `${serverUrl.replace(/\/+$/, "")}|${user}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The list from a search answer.
 *
 * Tolerant on purpose: a row without a usable name is dropped rather than drawn
 * as an empty line, a repeated name is only shown once (the server ranks, and a
 * duplicate would be two rows that do the same thing), and `added` defaults to
 * false so a partial answer never claims a subscription the user may not have.
 */
export function parsePeopleList(raw: unknown): Person[] {
  const rows = isRecord(raw) ? raw.people : raw;
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const out: Person[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (name === "") continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, added: row.added === true });
  }
  return out;
}

/** `GET /people/status` — is the capability here at all? */
export function parsePeopleStatus(raw: unknown): boolean {
  return isRecord(raw) && raw.enabled === true;
}

/**
 * The answer to an add, which is one write.
 *
 * `ok` is the only thing that says it worked; the message is the server's own
 * words and is worth showing verbatim, so it is kept whenever it is a string.
 */
export function parseAddPerson(raw: unknown): { ok: boolean; message: string | null } {
  if (!isRecord(raw)) return { ok: false, message: null };
  return {
    ok: raw.ok === true,
    message: typeof raw.message === "string" && raw.message !== "" ? raw.message : null,
  };
}

/* ---------------------------------------------------------------------------
 * What the list shows while the toggle is on
 * ------------------------------------------------------------------------- */

/**
 * The one thing the list says in people mode.
 *
 * The toggle is exclusive: while it is on the feed tree is not drawn at all, so
 * the whole of that space belongs to one of these five answers. They are kept
 * apart on purpose. A failure must never read as "nothing matched", because
 * only one of the two is worth acting on; a prompt is not an empty result; and
 * a name must not be drawn under text it does not answer.
 */
export type PeoplePanel = "prompt" | "waiting" | "names" | "nothing" | "failed";

export interface PeoplePanelInput {
  /** What is in the field. */
  query: string;
  /** The current results answer this exact text. */
  settled: boolean;
  /** How many rows the answer holds. */
  count: number;
  /** A failure worth reading, or null. */
  note: string | null;
}

export function peoplePanel(input: PeoplePanelInput): PeoplePanel {
  if (input.query.trim() === "") return "prompt";
  // Before the answer for this exact text, whatever is held belongs to an
  // earlier query: waiting is honest, stale rows are not.
  if (!input.settled) return "waiting";
  if (input.count > 0) return "names";
  if (input.note !== null) return "failed";
  return "nothing";
}

/* ---------------------------------------------------------------------------
 * Which search the one toggle turns on
 * ------------------------------------------------------------------------- */

/**
 * The two searches the single toggle switches between, plus the off state.
 *
 * The control is always in the field: what it searches depends on the account,
 * never on whether the user is allowed to see the control. Where the server
 * answers the name lookup it searches names; where it does not, the same toggle
 * is an author search over the posts the app has already loaded.
 */
export type SecondMode = "people" | "author";
export type SearchMode = "feeds" | SecondMode;

/** What the toggle turns on, for a server that does — or does not — answer the
 *  name lookup. */
export function secondMode(available: boolean): SecondMode {
  return available ? "people" : "author";
}

/* ---------------------------------------------------------------------------
 * Authors, from the posts the app already holds
 *
 * No lookup is possible here: an author search reads the post list the app has
 * loaded (and re-reads it when more arrives) and nothing else. That is a
 * deliberate limit — the answer is instant, costs no request, and says plainly
 * what it covers: the posts you have been reading.
 * ------------------------------------------------------------------------- */

/** One row of an author answer: the name as first seen, and its post count. */
export interface Author {
  name: string;
  count: number;
}

/** Author mode is built on the loaded posts, and is wired now. */
export const AUTHOR_SEARCH_WIRED = true;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The name a loaded post is filed under, or "" when it has none of its own.
 *
 * `bylineOf` already decides which name a post is *called*: the post's own
 * author when it has one that is not the feed's own name, the feed's title
 * otherwise. Asking that question of the post and of a post carrying only its
 * feed's name is enough to tell a person from a feed publishing under its own
 * name — so the judgement stays in `byline.ts` instead of growing a second
 * opinion here about when two names are the same.
 */
export function authorNameOf(item: BylineSource): string {
  const author = clean(item.author);
  if (author === "") return "";
  return bylineOf(item) === bylineOf({ origin: item.origin }) ? "" : author;
}

/**
 * The distinct authors of a set of posts, most posts first.
 *
 * Names are matched case-insensitively and keep the spelling they were first
 * seen with, so "ada lovelace" and "Ada Lovelace" are one row rather than two.
 * Posts with no author of their own are not indexed under their feed's name;
 * `authorNameOf` is what decides that. Equal counts are ordered by name, so the
 * list does not reshuffle between two loads of the same posts.
 */
export function authorIndexOf(posts: readonly BylineSource[]): Author[] {
  const rows = new Map<string, Author>();
  for (const post of posts) {
    const name = authorNameOf(post);
    if (name === "") continue;
    const key = name.toLocaleLowerCase();
    const found = rows.get(key);
    if (found === undefined) rows.set(key, { name, count: 1 });
    else found.count += 1;
  }
  return [...rows.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * The rows one query narrows the index to.
 *
 * A plain case-insensitive substring, so "ada" finds "Ada Lovelace" and "love"
 * finds her too. The order is the index's own: the query chooses rows, it never
 * re-ranks them. An empty query is the whole index, so the caller can decide
 * what an untouched field looks like instead of the filter inventing one.
 */
export function filterAuthors(index: readonly Author[], query: string): Author[] {
  const text = query.trim().toLocaleLowerCase();
  if (text === "") return index.slice();
  return index.filter((author) => author.name.toLocaleLowerCase().includes(text));
}

/**
 * What author mode says about what is typed.
 *
 * There is no wait state: the answer is already in hand, so it is drawn on the
 * same keystroke. Nor is an empty answer a failure — it is the honest sentence
 * "not in what is loaded", which is a narrower claim than "no such person" and
 * the only one this mode can make.
 */
export type AuthorPanel = "prompt" | "names" | "nothing";

export function authorPanel(query: string, count: number): AuthorPanel {
  if (query.trim() === "") return "prompt";
  return count > 0 ? "names" : "nothing";
}

/**
 * What a press of the toggle does to the text in the field.
 *
 * Off ends the search with the mode, so the field is emptied: the feed list
 * comes back whole instead of filtered by a query that was typed for another
 * search. On keeps whatever is typed — a name typed before the toggle is still
 * the name being looked for, and the mode that just took over should read it
 * rather than make it be typed again.
 */
export function toggleTurn(enabled: boolean, query: string): { enabled: boolean; query: string } {
  if (enabled) return { enabled: false, query: "" };
  return { enabled: true, query };
}

/**
 * The whole of what a press of the toggle does, filter included.
 *
 * The text rule above is the same one; this adds the other thing the press owns:
 * turning the search off puts the list back the way it was, so an author the
 * posts were narrowed to is let go with it. Turning it on keeps what is in the
 * field — and the filter it returns is the one already there, which is none,
 * because off is what clears it.
 */
export function toggleSearch(state: {
  enabled: boolean;
  query: string;
  author: string | null;
}): { enabled: boolean; query: string; author: string | null } {
  const turn = toggleTurn(state.enabled, state.query);
  return { enabled: turn.enabled, query: turn.query, author: turn.enabled ? state.author : null };
}

/* ---------------------------------------------------------------------------
 * Remembered availability
 *
 * Written when the state request answers, read before anything else on the next
 * start. Every access is best effort: no storage (unit tests, private modes) or
 * a corrupt value simply means "not known yet", which draws no control at all.
 * ------------------------------------------------------------------------- */

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** An answer only ever becomes true, and a stored map is never trusted blindly. */
export function readRememberedAvailability(scope: string, store = storage()): boolean {
  if (store === undefined || scope === "") return false;
  try {
    const raw = store.getItem(PEOPLE_PREF_KEY);
    if (raw === null) return false;
    const saved: unknown = JSON.parse(raw);
    return isRecord(saved) && saved[scope] === true;
  } catch {
    return false;
  }
}

/**
 * The callback a live view installs so a fresh answer redraws without waiting
 * for a restart. There is at most one view; a second registration replaces it
 * rather than leaving a stale one behind.
 */
type AvailabilitySink = (scope: string, available: boolean) => void;

let sink: AvailabilitySink | null = null;

export function observeAvailability(fn: AvailabilitySink | null): void {
  sink = fn;
}

/**
 * Records what one state answer said about this account.
 *
 * Called from the single `/state` read rather than from a request of its own: a
 * second round trip to find out whether the toggle belongs in the field would
 * be a control that arrives late, and the state response already carries the
 * answer.
 */
export function recordAvailability(
  serverUrl: string,
  user: string,
  available: boolean,
  store = storage(),
): void {
  const scope = peopleScope(serverUrl, user);
  if (store !== undefined) {
    try {
      const raw = store.getItem(PEOPLE_PREF_KEY);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      const saved: Record<string, boolean> = isRecord(parsed) ? { ...parsed } as Record<string, boolean> : {};
      saved[scope] = available;
      store.setItem(PEOPLE_PREF_KEY, JSON.stringify(saved));
    } catch {
      // Best effort: the live answer below still applies for this session.
    }
  }
  sink?.(scope, available);
}
