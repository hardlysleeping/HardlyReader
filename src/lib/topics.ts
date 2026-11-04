/**
 * Topics: the words a reader uses to say what a Buzz story is about.
 *
 * A topic is a name and a list of keywords. Nothing else — no feed list, no
 * server state, no model, no category binding. That is what lets it be edited
 * without touching anything: a topic that is wrong is a keyword list that is
 * wrong, and the fix is typing a better word.
 *
 * Pure and DOM-free, so the matcher can be tested without a browser.
 */

import type { StreamItem } from "../api/freshrss";
import { plainPreview } from "./format";

export interface BuzzTopic {
  /** Stable slug from the name; what `buzz.topicId` holds. */
  id: string;
  name: string;
  /** Empty means "everything": that is how Breaking News works. */
  keywords: string[];
}

/**
 * Seeded on first run, then the list is the reader's.
 *
 * Eight topics, not a taxonomy: enough that one of them is usually right, few
 * enough that the section is scannable. Every list is wide rather than clever,
 * because a topic that matches nothing is indistinguishable from a broken
 * feature, while a topic that matches too much is one keyword away from right.
 *
 * The owner cut this down himself: `Money` and `Design` were never the story,
 * `Film` had to cover television too, and `AI` is a word inside Tech rather than
 * a section beside it. A topic is a keyword list, so the fix was words.
 */
export const DEFAULT_TOPICS: BuzzTopic[] = [
  { id: "breaking-news", name: "Breaking News", keywords: [] },
  {
    id: "tech",
    name: "Tech",
    // AI, folded in rather than proposed beside it: a story about a model is a
    // tech story, and two sections matching the same headline made both look
    // approximate.
    keywords: [
      "tech",
      "technology",
      "apple",
      "google",
      "microsoft",
      "chip",
      "silicon",
      "software",
      "hardware",
      "android",
      "ios",
      "linux",
      "ai",
      "artificial intelligence",
      "llm",
      "openai",
      "anthropic",
      "gemini",
      "neural",
    ],
  },
  { id: "science", name: "Science", keywords: ["science", "study", "research", "physics", "space", "nasa", "climate", "biology"] },
  { id: "comics", name: "Comics", keywords: ["comic", "comics", "manga", "graphic novel", "marvel", "dc", "image comics", "webtoon"] },
  {
    id: "film-tv",
    name: "Film/TV",
    keywords: [
      "film",
      "movie",
      "movies",
      "cinema",
      "trailer",
      "box office",
      "tv",
      "television",
      "series",
      "season",
      "episode",
      "streaming",
      "netflix",
      "hbo",
      "sitcom",
    ],
  },
  { id: "music", name: "Music", keywords: ["music", "album", "song", "tour", "band", "single", "remix", "ep"] },
  { id: "games", name: "Games", keywords: ["game", "games", "gaming", "playstation", "xbox", "nintendo", "steam", "release date"] },
  // The market, not "money": a story is about a stock, an index or an earnings
  // call. `price` and `economy` pulled in every product launch and every budget
  // line, which is why this list is the narrow one.
  {
    id: "stock",
    name: "Stock",
    keywords: ["stock", "stocks", "shares", "ticker", "wall street", "nasdaq", "dow", "s&p", "earnings", "ipo", "market"],
  },
];

/** One slug rule, so a topic's id can never disagree with its name. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A whole-word test over the four places a story's subject can be written: the
 * headline, the summary, the feed's own name, and the category labels.
 *
 * Whole words and not substrings, and that single rule is the difference
 * between a topic that works and one that matches everything: `ai` would
 * otherwise match "said", "trail" and "certain", and `art` would match "start".
 * Hyphens, slashes and punctuation are boundaries, so "open-source" and
 * "AI/ML" split the way a reader expects; the text is padded with spaces so a
 * match at either edge is found by the same test.
 */
export function matchesTopic(item: StreamItem, topic: BuzzTopic, feedTitle?: string): boolean {
  if (topic.keywords.length === 0) return true;
  const haystack = [
    item.title ?? "",
    plainPreview(item.summary?.content ?? item.content?.content, 300),
    feedTitle ?? item.origin?.title ?? "",
    (item.categories ?? []).join(" "),
  ]
    .join(" \u0000 ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
  const padded = ` ${haystack} `;
  return topic.keywords.some((keyword) => {
    const needle = keyword.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    if (needle === "") return false;
    return padded.includes(` ${needle} `);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Words from the wire: one comma-separated string, or an array of them. */
function keywordsOf(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<string>();
  const words: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const word = entry.trim().replace(/\s+/g, " ").toLowerCase();
    if (word === "" || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

/** One stored record as a topic, or null when it is not one. */
export function topicOf(value: unknown): BuzzTopic | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (id === "" || name === "") return null;
  return { id, name, keywords: keywordsOf(value.keywords) };
}

/**
 * The `topics` namespace value: `{ topics: [{ id, name, keywords }] }`.
 *
 * Keywords travel as one comma-separated string, not an array, because the sync
 * wire's depth bound is 3 and a nested array is the fourth level —
 * `{topics: [{…}]}` is an object, an array, an object, and `keywords: [...]`
 * inside it is refused. It is refused quietly, per entry, so an array here would
 * have synced every topic's name and silently dropped every topic's words.
 */
export function topicsToValue(list: BuzzTopic[]): Record<string, unknown> {
  return {
    topics: list.map((topic) => ({ id: topic.id, name: topic.name, keywords: topic.keywords.join(", ") })),
  };
}

/**
 * A `topics` value from the account, as a list — or `null` when the value says
 * nothing about topics.
 *
 * `null` and `[]` are different answers: a client that has never heard of this
 * namespace sends no `topics` key, and that must not erase the list, while an
 * empty array is a reader who removed every topic and must be adopted as such.
 */
export function topicsFromValue(value: unknown): BuzzTopic[] | null {
  if (!isRecord(value) || !Array.isArray(value.topics)) return null;
  return value.topics.map(topicOf).filter((topic): topic is BuzzTopic => topic !== null);
}

/** A fresh copy of the shipped topics: seeding must never hand out the constants. */
export function seededTopics(): BuzzTopic[] {
  return DEFAULT_TOPICS.map((topic) => ({ ...topic, keywords: [...topic.keywords] }));
}

/**
 * A name typed into the sidebar, as a topic.
 *
 * The name is required and unique-ish; the keywords are optional (a topic with
 * none is "everything", which is what Breaking News is), comma-separated,
 * trimmed, de-duplicated case-insensitively, and dropped if empty. A repeated
 * name returns `null` rather than a second topic with the same id, because two
 * rows with one id is a list that cannot be edited or deleted reliably.
 */
export function topicFromInput(name: string, keywords: string, existing: BuzzTopic[] = []): BuzzTopic | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed === "") return null;
  const id = slugOf(trimmed);
  if (id === "") return null;
  if (existing.some((topic) => topic.id === id || topic.name.toLowerCase() === trimmed.toLowerCase())) {
    return null;
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of keywords.split(",")) {
    const keyword = raw.trim().replace(/\s+/g, " ").toLowerCase();
    if (keyword === "" || seen.has(keyword)) continue;
    seen.add(keyword);
    list.push(keyword);
  }
  return { id, name: trimmed, keywords: list };
}
