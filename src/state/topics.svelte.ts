/**
 * The reader's topics, as a store.
 *
 * Seeded once and then theirs: the ten shipped names are a starting point, and
 * a deleted topic never comes back. That is why seeding is guarded by a flag
 * rather than by "the list is empty" — an empty list is a decision the reader
 * made, not a first run.
 *
 * The shapes and the rules live in `lib/topics.ts` (`topicsToValue`,
 * `topicsFromValue`, `seededTopics`) so they can be tested without a Svelte
 * compile; this file is the store and the device store behind it.
 */

import {
  seededTopics,
  topicFromInput,
  topicsFromValue,
  topicsToValue,
  type BuzzTopic,
} from "../lib/topics";

const STORAGE_KEY = "hardlyreader.topics.v1";

export class TopicsState {
  list = $state<BuzzTopic[]>([]);

  /** Seeded or adopted at least once: the defaults are not coming back. */
  #settled = false;

  /**
   * Seed on first run, then never again.
   *
   * Read from this device's own store first, because a reader with no account
   * still expects their topics to survive a restart; the account's copy, when
   * there is one, arrives through `adopt` and wins by its own timestamp.
   */
  load(): void {
    if (this.#settled) return;
    this.#settled = true;
    const stored = this.#read();
    if (stored !== null) {
      this.list = stored;
      return;
    }
    this.list = seededTopics();
    this.#write();
  }

  /** A name typed into the sidebar. Refused when it is empty or already there. */
  add(name: string, keywords: string): BuzzTopic | null {
    const made = topicFromInput(name, keywords, this.list);
    if (made === null) return null;
    this.list = [...this.list, made];
    this.#write();
    return made;
  }

  remove(id: string): void {
    const next = this.list.filter((topic) => topic.id !== id);
    if (next.length === this.list.length) return;
    this.list = next;
    this.#write();
  }

  byId(id: string | null): BuzzTopic | null {
    if (id === null) return null;
    return this.list.find((topic) => topic.id === id) ?? null;
  }

  /** The `topics` namespace value. */
  snapshot(): Record<string, unknown> {
    return topicsToValue(this.list);
  }

  /**
   * Take the account's list.
   *
   * A value with no `topics` array leaves this device's list alone: an older
   * client that has never heard of the namespace must not be able to erase the
   * list by writing nothing. An empty array is a real answer and is adopted.
   */
  adopt(value: Record<string, unknown>): void {
    const list = topicsFromValue(value);
    if (list === null) return;
    this.#settled = true;
    this.list = list;
    this.#write();
  }

  #read(): BuzzTopic[] | null {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      return topicsFromValue(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  #write(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(topicsToValue(this.list)));
    } catch {
      // A browser with storage switched off still gets topics for this session;
      // the account's copy is the durable one.
    }
  }
}

export const topics = new TopicsState();
