/**
 * Buzz: the sidebar's section, and the stories Pane 2 draws.
 *
 * One entry point, by the owner's call: the ⚡ above Reading list opens the
 * section, the section's rows are topics, and the only way to narrow is a topic
 * row. There is deliberately no per-category ⚡ (a control you misclick while
 * reaching for the category) and no `feed` scope — one feed cannot converge with
 * itself, so a feed is never a Buzz.
 *
 * A topic is a pre-filter over the same window, never a second engine: the items
 * are fetched once per reload, narrowed by `matchesTopic`, and only then handed
 * to `buildBuzz`, which never learns that topics exist.
 *
 * Buzz state is temporary UI state. It is not synced, not saved, and does not
 * move `reader.activeStream` — leaving Buzz is a boolean, which is why there is
 * nothing to restore and no "back to what you were reading" to get wrong.
 */

import type { StreamItem } from "../api/freshrss";
import { READING_LIST } from "../api/freshrss";
import { BUZZ_MAX_ITEMS, buildBuzz, feedCounts, type BuzzStory } from "../lib/buzz";
import { matchesTopic, type BuzzTopic } from "../lib/topics";
import { reader } from "./reader.svelte";
import { topics } from "./topics.svelte";

/** A window older than this is refetched when Buzz is looked at again. */
const STALE_MS = 5 * 60 * 1000;

export interface BuzzFeed {
  id: string;
  title: string;
  /** The feed's own picture, when FreshRSS has fetched one. */
  icon: string | null;
  items: number;
}

/** The cache key for "no topic": the whole window. */
const ALL = "*";

export class BuzzState {
  /** True while the sidebar's Buzz section is open and Pane 2 draws stories. */
  active = $state(false);
  /** The topic Pane 2 is narrowed to, or null for the whole window. */
  topicId = $state<string | null>(null);
  stories = $state<BuzzStory[]>([]);
  /** The story whose coverage is on screen, or null. */
  storyId = $state<string | null>(null);
  /**
   * Which topic rows are showing their feeds. Collapsed by default, so the
   * section opens as a list of names with a row of icons. A peek, not a
   * selection: it survives open/close/selectTopic and is never synced.
   */
  expanded = $state<Set<string>>(new Set());
  loading = $state(false);
  error = $state<string | null>(null);

  /** The fetched window, narrowed to the feeds Pane 1 is showing. */
  #window: StreamItem[] = [];
  #loadedAt = 0;
  /** Clustered stories per topic, and the feeds carrying them, per reload. */
  #storiesFor = new Map<string, BuzzStory[]>();
  #feedsFor = new Map<string, BuzzFeed[]>();
  /** A load that has been superseded must not paint. */
  #generation = 0;
  #abort: AbortController | null = null;

  /** The selected topic, resolved from the topics list. */
  get topic(): BuzzTopic | null {
    return topics.byId(this.topicId);
  }

  /** The story whose coverage is on screen. */
  get story(): BuzzStory | null {
    if (this.storyId === null) return null;
    return this.stories.find((one) => one.id === this.storyId) ?? null;
  }

  /** Pane 3 draws coverage, not an article. */
  get coverageOpen(): boolean {
    return this.active && this.story !== null;
  }

  /** How many stories qualified, for the section's own heading. */
  get count(): number {
    return this.stories.length;
  }

  /** `feedsFor(topicId)`, for the selected topic only. */
  get feeds(): BuzzFeed[] {
    return this.topicId === null ? [] : this.feedsFor(this.topicId);
  }

  /**
   * The feeds carrying a topic, most active first.
   *
   * From the same window as `stories` (one fetch per reload), so the collapsed
   * row's icons and the expanded feed rows cannot disagree about who is on the
   * topic. Empty for a topic that is not selected, because the section has no
   * reason to count feeds nobody is looking at.
   */
  feedsFor(topicId: string): BuzzFeed[] {
    const known = this.#feedsFor.get(topicId);
    if (known !== undefined) return known;
    const topic = topics.byId(topicId);
    const counts = topic === null ? [] : feedCounts(this.#narrow(topic));
    const meta = this.#feedMeta();
    const made = counts.map((row) => ({
      id: row.id,
      title: meta.get(row.id)?.title ?? "A feed",
      icon: meta.get(row.id)?.icon ?? null,
      items: row.items,
    }));
    this.#feedsFor.set(topicId, made);
    return made;
  }

  /** Show or hide one topic row's feeds. */
  toggleFeeds(topicId: string): void {
    const next = new Set(this.expanded);
    if (next.has(topicId)) next.delete(topicId);
    else next.add(topicId);
    this.expanded = next;
  }

  /** How many stories a topic would show. Once per topic per reload. */
  countFor(topicId: string): number {
    return this.#storiesForTopic(topicId).length;
  }

  /**
   * The only way in: open the section and show the whole window.
   *
   * It does not touch `reader.activeStream`, so whatever the reader was reading
   * is still the stream underneath; leaving Buzz is `close()`, a boolean.
   */
  async open(): Promise<void> {
    // The topics ship with the app, so the section is never empty on a fresh
    // install; `load()` is the guarded one-shot that seeds them.
    topics.load();
    this.active = true;
    this.topicId = null;
    this.storyId = null;
    await this.#reload();
  }

  /** Shut the section. Nothing else to undo. */
  close(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#generation += 1;
    this.active = false;
    this.topicId = null;
    this.storyId = null;
    this.stories = [];
    this.loading = false;
    this.error = null;
  }

  /** A topic row: narrow to it, or back to everything with `null`. */
  async selectTopic(topicId: string | null): Promise<void> {
    if (this.topicId === topicId && this.stories.length > 0) return;
    this.topicId = topicId;
    this.storyId = null;
    if (this.#window.length === 0) await this.#reload();
    else this.stories = this.#storiesForTopic(topicId);
  }

  /** Pane 3: open one story's coverage, or leave it. */
  select(storyId: string | null): void {
    this.storyId = storyId;
  }

  /** ↑/↓ inside Buzz. Holds at the ends, like the post list does. */
  step(delta: -1 | 1): void {
    if (this.stories.length === 0) return;
    const at = this.stories.findIndex((one) => one.id === this.storyId);
    const next = at === -1 ? (delta === 1 ? 0 : this.stories.length - 1) : at + delta;
    const clamped = Math.min(this.stories.length - 1, Math.max(0, next));
    this.storyId = this.stories[clamped].id;
  }

  /**
   * A coverage row was pressed: the reader's own selection, nothing else.
   *
   * Buzz does not own articles — it points at them. Selecting one here is the
   * same act as selecting it in a list, so Pane 3 draws what it always draws.
   */
  openArticle(item: StreamItem): void {
    reader.select(item);
  }

  /** A sync landed, or a topic was added or removed: rebuild if stale. */
  refreshIfStale(at: number = Date.now()): void {
    if (!this.active) return;
    if (this.#loadedAt !== 0 && at - this.#loadedAt < STALE_MS) return;
    void this.#reload();
  }

  /** Forget the clustering, keep the window: a topic changed under it. */
  invalidate(): void {
    this.#storiesFor.clear();
    this.#feedsFor.clear();
    if (!this.active) return;
    this.stories = this.#storiesForTopic(this.topicId);
  }

  async #reload(): Promise<void> {
    const generation = ++this.#generation;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    this.loading = true;
    this.error = null;
    try {
      const items = await reader.recentItems(READING_LIST, BUZZ_MAX_ITEMS, { signal: abort.signal });
      if (generation !== this.#generation) return;
      const visible = this.#visibleFeedIds();
      this.#window = items.filter((item) => {
        const id = item.origin?.streamId;
        return id !== undefined && visible.has(id);
      });
      this.#loadedAt = Date.now();
      this.#storiesFor.clear();
      this.#feedsFor.clear();
      this.stories = this.#storiesForTopic(this.topicId);
    } catch (failure) {
      if (generation !== this.#generation) return;
      this.error = failure instanceof Error ? failure.message : "Buzz could not be loaded";
      this.stories = [];
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  /** The window narrowed by a topic — the engine never sees a topic. */
  #narrow(topic: BuzzTopic): StreamItem[] {
    if (topic.keywords.length === 0) return this.#window;
    const meta = this.#feedMeta();
    return this.#window.filter((item) =>
      matchesTopic(item, topic, meta.get(item.origin?.streamId ?? "")?.title),
    );
  }

  #storiesForTopic(topicId: string | null): BuzzStory[] {
    const key = topicId ?? ALL;
    const known = this.#storiesFor.get(key);
    if (known !== undefined) return known;
    const topic = topics.byId(topicId);
    const made =
      topicId !== null && topic === null ? [] : buildBuzz(topic === null ? this.#window : this.#narrow(topic));
    this.#storiesFor.set(key, made);
    return made;
  }

  /** Every feed id the sidebar is showing: hidden and locked categories are out. */
  #visibleFeedIds(): Set<string> {
    const ids = new Set<string>();
    for (const group of reader.categories) {
      for (const feed of group.feeds) ids.add(feed.id);
    }
    return ids;
  }

  /** Feed id → what the icon strip and the feed rows need to draw it. */
  #feedMeta(): Map<string, { title: string; icon: string | null }> {
    const meta = new Map<string, { title: string; icon: string | null }>();
    for (const group of reader.categories) {
      for (const feed of group.feeds) {
        meta.set(feed.id, { title: feed.title, icon: feed.iconUrl ?? null });
      }
    }
    return meta;
  }
}

export const buzz = new BuzzState();
