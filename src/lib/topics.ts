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
 * Ten topics, not a taxonomy: enough that one of them is usually right, few
 * enough that the section is scannable. Every list is wide rather than clever,
 * because a topic that matches nothing is indistinguishable from a broken
 * feature, while a topic that matches too much is one keyword away from right.
 */
export const DEFAULT_TOPICS: BuzzTopic[] = [
  { id: "breaking-news", name: "Breaking News", keywords: [] },
  {
    id: "tech",
    name: "Tech",
    keywords: ["tech", "technology", "apple", "google", "microsoft", "chip", "silicon", "software", "hardware", "android", "ios", "linux"],
  },
  { id: "ai", name: "AI", keywords: ["ai", "artificial intelligence", "llm", "model", "openai", "anthropic", "gemini", "neural"] },
  { id: "science", name: "Science", keywords: ["science", "study", "research", "physics", "space", "nasa", "climate", "biology"] },
  { id: "comics", name: "Comics", keywords: ["comic", "comics", "manga", "graphic novel", "marvel", "dc", "image comics", "webtoon"] },
  { id: "film", name: "Film", keywords: ["film", "movie", "cinema", "trailer", "box office", "series", "season"] },
  { id: "music", name: "Music", keywords: ["music", "album", "song", "tour", "band", "single", "remix", "ep"] },
  { id: "games", name: "Games", keywords: ["game", "games", "gaming", "playstation", "xbox", "nintendo", "steam", "release date"] },
  { id: "money", name: "Money", keywords: ["market", "stocks", "economy", "inflation", "price", "earnings", "funding", "ipo"] },
  { id: "design", name: "Design", keywords: ["design", "typeface", "font", "ui", "ux", "brand", "logo", "illustration", "blender"] },
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
