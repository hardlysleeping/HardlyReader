/**
 * The two-mode half of the search field.
 *
 * One toggle, two searches: names the server can look up, or the authors of the
 * posts the app has already loaded. Names only, and only over the network in
 * the people mode — a lookup is a request, so typing in either other mode has
 * to stay local: the feed filter it has always been, or a filter over an index
 * built from posts already in hand. The toggle is session state and is
 * deliberately not remembered — a mode that fires a request every time typing
 * pauses should be asked for, not inherited from a previous run.
 *
 * Availability is not a request either. It arrives with `/v1/state`, which the
 * app already reads once on startup, and the API layer records it per account
 * (see `src/lib/people.ts`). It is read synchronously here, so the field is
 * drawn with the toggle already in it on the first frame of every start —
 * always drawn; availability picks which search it turns on, not whether the
 * control exists.
 */
import { addPerson, searchPeople } from "../api/hardlyread";
import { transport } from "../api/transport";
import type { Session } from "../api/freshrss";
import {
  authorIndexOf,
  filterAuthors,
  observeAvailability,
  peopleScope,
  readRememberedAvailability,
  secondMode,
  type Author,
  type Person,
  type SearchMode,
  type SecondMode,
} from "../lib/people";
import type { BylineSource } from "../lib/byline";

/** How long typing rests before a lookup goes out, in milliseconds. */
const DEBOUNCE_MS = 220;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PeopleState {
  /** The toggle. Off until asked for, this session. */
  enabled = $state(false);

  /** The last answer, in the order the server ranked it. */
  results = $state<Person[]>([]);

  /**
   * Author rows, built from the posts the app already holds.
   *
   * Filled by `indexAuthors` from the reader's own post list — never fetched.
   * `authors` is the whole index, ranked; the filter the field applies is a
   * read over it, so typing costs a scan and nothing else.
   */
  authors = $state<Author[]>([]);

  /**
   * What the index was built from, so it is rebuilt when the held posts change
   * and not once per keystroke. Identity is the test: the reader replaces the
   * array when a page lands or a stream is opened, and leaves it alone when
   * only the field changes.
   */
  private indexed: readonly BylineSource[] | null = null;

  /**
   * Rebuilds the author index if the post list is not the one it was built from.
   *
   * Called from the view that holds the posts, on every change to them: a page
   * of older posts adds authors to the list without a request being made, and a
   * different stream replaces them. Nothing here debounces, because nothing
   * here is expensive until the list itself changes.
   */
  indexAuthors(posts: readonly BylineSource[]): void {
    if (posts === this.indexed) return;
    this.indexed = posts;
    this.authors = authorIndexOf(posts);
  }

  /** The rows one query narrows the index to. Pure, local, and immediate. */
  authorMatches(query: string): Author[] {
    return filterAuthors(this.authors, query);
  }

  /** A lookup is in flight. */
  busy = $state(false);

  /** The one name being added, so a second press cannot write twice. */
  adding = $state<string | null>(null);

  /**
   * A failure worth reading. An empty list on its own is not a failure — it
   * means nothing matched, which is a normal answer.
   */
  note = $state<string | null>(null);

  /** What `/v1/state` has said for each account this session. */
  private answers = $state<Record<string, boolean>>({});

  private delay: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;

  /**
   * The text the current results answer.
   *
   * Reactive, not bookkeeping: a row is only drawn once this matches what is
   * typed, so the field has to re-render on the answer itself and not merely on
   * the list it brought with it.
   */
  private asked = $state("");

  constructor() {
    observeAvailability((scope, available) => {
      this.answers = { ...this.answers, [scope]: available };
    });
  }

  /**
   * Does this account's server offer the lookup?
   *
   * Synchronous so it can be asked during render: the remembered answer from a
   * previous start is what the field paints from, and the live answer replaces
   * it as soon as the state request lands.
   */
  availableFor(session: Session | null): boolean {
    if (session === null) return false;
    const scope = peopleScope(session.serverUrl, session.email);
    return this.answers[scope] ?? readRememberedAvailability(scope);
  }

  /**
   * The second search this account has.
   *
   * Availability picks which one it is, never whether there is one: names where
   * the server answers the lookup, the account's own authors where it does not.
   * This is also what the field's own wording asks for while it is off.
   */
  secondFor(session: Session | null): SecondMode {
    return secondMode(this.availableFor(session));
  }

  /**
   * What the toggle means for this account, right now.
   *
   * One question, one answer, so the field never has to combine the toggle with
   * availability itself: off is the feed filter, on is whichever second search
   * this account has.
   */
  modeFor(session: Session | null): SearchMode {
    if (!this.enabled) return "feeds";
    return secondMode(this.availableFor(session));
  }

  /**
   * Turns the toggle on or off.
   *
   * Switching off drops everything the toggle brought with it, so the field is
   * exactly the feed filter again rather than a list with leftovers in it.
   */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.cancel();
    this.asked = "";
    this.results = [];
    this.note = null;
  }

  /**
   * Follows the field, in the mode the toggle means.
   *
   * Called on every keystroke and debounced here: the previous request is
   * abandoned before a new one is sent, so an answer to "ant" cannot land under
   * "antonio" and a fast typist starts one lookup, not six. Any mode other than
   * people leaves without a request — the feed filter and the author mode are
   * both local.
   */
  watch(query: string, session: Session | null, mode: SearchMode): void {
    const text = query.trim();
    if (mode !== "people" || session === null || text === "") {
      this.cancel();
      this.asked = "";
      this.results = [];
      this.note = null;
      return;
    }
    if (text === this.asked) return;
    this.cancel();
    this.delay = setTimeout(() => {
      void this.look(text, session);
    }, DEBOUNCE_MS);
  }

  /** True once `query` has an answer of its own, so a row is never drawn early. */
  settled(query: string): boolean {
    return this.asked !== "" && this.asked === query.trim();
  }

  /**
   * Adds one name, which subscribes it on the server.
   *
   * One write, no retry: a retry after a lost response would ask for the same
   * subscription twice. The caller re-reads the sidebar on success so the new
   * feed is in the tree behind the results rather than only in this list.
   */
  async add(session: Session | null, name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (session === null || trimmed === "" || this.adding !== null) return false;
    this.adding = trimmed;
    this.note = null;
    try {
      const result = await addPerson(transport, session, trimmed);
      if (!result.ok) {
        this.note = result.message;
        return false;
      }
      this.results = this.results.map((person) =>
        person.name === trimmed ? { ...person, added: true } : person,
      );
      return true;
    } catch (error) {
      this.note = message(error);
      return false;
    } finally {
      this.adding = null;
    }
  }

  private cancel(): void {
    if (this.delay !== null) {
      clearTimeout(this.delay);
      this.delay = null;
    }
    this.controller?.abort();
    this.controller = null;
    this.busy = false;
  }

  private async look(text: string, session: Session): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.busy = true;
    try {
      const answer = await searchPeople(transport, session, text, controller.signal);
      if (controller.signal.aborted) return;
      this.asked = text;
      this.results = answer.people;
      this.note = answer.message;
    } catch (error) {
      if (controller.signal.aborted) return;
      // A lookup that broke is not a list: the rows are dropped and the reason
      // is shown, because "nothing matched" would be a lie the user could act on.
      this.asked = text;
      this.results = [];
      this.note = message(error);
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.busy = false;
      }
    }
  }
}

export const people = new PeopleState();
