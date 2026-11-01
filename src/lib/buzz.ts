/**
 * Buzz: the stories more than one feed is telling.
 *
 * Pure, deterministic, and offline. Given a window of posts and a clock reading
 * it returns the clusters at least two distinct feeds carry, ranked by coverage.
 * No model, no network, no `localStorage`, no clock read except the `now`
 * parameter: the same items and the same `now` produce the same stories, in the
 * same order, on every machine. That is what makes it testable, and it is also
 * what makes it trustworthy — a reader can see *why* a story is first (three
 * feeds carried it) without being shown a score.
 *
 * The unit of meaning here is a fingerprint: the post's title terms weighted
 * three times, its summary terms once. Two posts are the same story when the
 * cosine similarity of their fingerprints clears `BUZZ_MATCH_THRESHOLD`.
 */

import type { StreamItem } from "../api/freshrss";
import { plainPreview } from "./format";

/** How far back a story may reach. Older posts are not "happening now". */
export const BUZZ_WINDOW_MS = 48 * 60 * 60 * 1000;

/** The most posts one Buzz pass will look at, newest first. */
export const BUZZ_MAX_ITEMS = 500;

/** Cosine similarity at which two fingerprints are the same story. */
export const BUZZ_MATCH_THRESHOLD = 0.6;

/** A story needs this many distinct feeds before it is Buzz. */
export const BUZZ_MIN_SOURCES = 2;

/** "Several sources arriving recently": the momentum window. */
export const BUZZ_MOMENTUM_MS = 6 * 60 * 60 * 1000;

/**
 * Words that carry no story.
 *
 * English function words, plus the RSS boilerplate every feed writes around the
 * only sentence that differs: `new`, `launch`, `today`, `week`, `first`,
 * `update`, `report`. `announce` is deliberately absent — the brief put it on
 * the boilerplate list, but a word that names the shape of a story ("Announces
 * a delay") carries information nobody else's headline will, so dropping it
 * makes two different announcements look alike.
 */
const STOP_WORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been",
  "before", "but", "by", "can", "could", "did", "do", "does", "for", "from", "had", "has",
  "have", "he", "her", "here", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just",
  "me", "more", "most", "my", "no", "not", "now", "of", "on", "one", "only", "or", "our", "out",
  "over", "she", "should", "so", "some", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "those", "to", "too", "up", "was", "we", "were", "what", "when",
  "where", "which", "who", "why", "will", "with", "would", "you", "your",
  // Boilerplate, not meaning.
  "new", "launch", "launches", "today", "week", "first", "update", "updates", "report", "reports",
]);

export interface BuzzFingerprint {
  id: string;
  feedId: string;
  published: number;
  /** Term → weighted count. Title terms carry ×3, summary terms ×1. */
  terms: Map<string, number>;
}

export interface BuzzStory {
  /** The representative article's id — stable across rebuilds of the same story. */
  id: string;
  /** The representative article's own title. Buzz never writes a headline. */
  title: string;
  /** Newest first. */
  articles: StreamItem[];
  /** Distinct feed ids, first appearance order. */
  feedIds: string[];
  sourceCount: number;
  /** Epoch ms of the newest article. */
  newest: number;
  /**
   * Distinct feeds inside `BUZZ_MOMENTUM_MS`. Drawn on the row ("+4 recently")
   * and never ranked on: the ranking is coverage, one number, visible.
   */
  recentSources: number;
}

/**
 * Fingerprints are keyed by item id and kept between passes: a refresh
 * re-fingerprints only the posts that are new. Capped because a long session
 * with a 500-item window would otherwise keep every post it had ever seen.
 */
const fingerprints = new Map<string, BuzzFingerprint>();
const FINGERPRINT_CACHE_MAX = 2_000;

/** HTML to the words that matter: lowercased, alphanumeric, no stop words. */
export function normalise(text: string): string[] {
  if (!text) return [];
  // `plainPreview` is the app's one HTML→line function, so a title and a
  // summary are read the same way the list reads them.
  const plain = plainPreview(text, 2_000).toLowerCase();
  const words: string[] = [];
  for (const word of plain.split(/[^a-z0-9]+/)) {
    if (word.length < 2) continue;
    if (STOP_WORDS.has(word)) continue;
    words.push(word);
  }
  return words;
}

export function fingerprint(item: StreamItem): BuzzFingerprint {
  const cached = fingerprints.get(item.id);
  if (cached !== undefined) return cached;
  const terms = new Map<string, number>();
  for (const term of normalise(item.title ?? "")) terms.set(term, (terms.get(term) ?? 0) + 3);
  const body = plainPreview(item.summary?.content ?? item.content?.content, 300);
  for (const term of normalise(body)) terms.set(term, (terms.get(term) ?? 0) + 1);
  const made: BuzzFingerprint = {
    id: item.id,
    feedId: item.origin?.streamId ?? "",
    published: item.published ?? 0,
    terms,
  };
  if (fingerprints.size >= FINGERPRINT_CACHE_MAX) fingerprints.clear();
  fingerprints.set(item.id, made);
  return made;
}

/**
 * Inverse document frequency over this window only: `ln(1 + N / df)`.
 *
 * No corpus and no saved statistics, so the same window always weighs the same.
 * A term every post uses ("apple" during an Apple event) counts for little; a
 * term two posts share counts for a lot, which is exactly the pair worth
 * joining.
 */
export function idfOf(list: BuzzFingerprint[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const print of list) {
    for (const term of print.terms.keys()) seen.set(term, (seen.get(term) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  const total = list.length;
  for (const [term, df] of seen) idf.set(term, Math.log(1 + total / df));
  return idf;
}

/** TF × IDF, L2-normalised once — so `cosine` is a dot product. */
export function vectorOf(print: BuzzFingerprint, idf: Map<string, number>): Map<string, number> {
  const vector = new Map<string, number>();
  let square = 0;
  for (const [term, count] of print.terms) {
    const weight = count * (idf.get(term) ?? 0);
    if (weight === 0) continue;
    vector.set(term, weight);
    square += weight * weight;
  }
  if (square === 0) return vector;
  const length = Math.sqrt(square);
  for (const [term, weight] of vector) vector.set(term, weight / length);
  return vector;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += weight * other;
  }
  return dot;
}

/**
 * Posts per feed in a slice of the window — "who is on this topic", in one
 * deterministic order.
 *
 * Drops posts with no origin: a post with no stream id has no feed to draw an
 * icon for, and guessing which feed it belongs to would put a mark on a row
 * that feed never earned. Sorted by count desc then id asc, so the collapsed
 * topic row's icons and the expanded feed rows cannot disagree.
 */
export function feedCounts(items: StreamItem[]): { id: string; items: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const id = item.origin?.streamId;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, items]) => ({ id, items }))
    .sort((a, b) => b.items - a.items || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The medoid: the member closest to all the others, which is the one whose own
 * headline the story carries.
 *
 * Membership is always measured against this and never against the member that
 * let something in, so a chain of half-matches cannot drag an unrelated post
 * into a story. Ties go to the newest, then the id, so the choice is stable.
 */
function medoid(
  members: BuzzFingerprint[],
  vectors: Map<string, Map<string, number>>,
): BuzzFingerprint {
  if (members.length === 1) return members[0];
  let best = members[0];
  let bestScore = -1;
  for (const member of members) {
    const own = vectors.get(member.id);
    if (own === undefined) continue;
    let score = 0;
    for (const other of members) {
      if (other.id === member.id) continue;
      const theirs = vectors.get(other.id);
      if (theirs !== undefined) score += cosine(own, theirs);
    }
    const better =
      score > bestScore ||
      (score === bestScore &&
        (member.published > best.published ||
          (member.published === best.published && member.id < best.id)));
    if (better) {
      best = member;
      bestScore = score;
    }
  }
  return best;
}

interface Cluster {
  members: BuzzFingerprint[];
  vectors: Map<string, Map<string, number>>;
  newest: number;
  representative: BuzzFingerprint;
}

/**
 * One pass over the window: cluster, keep what several feeds carry, rank by
 * coverage.
 *
 * Steps, in order, because the order is the guarantee: keep what can be Buzz,
 * newest first; fingerprint; weigh by idf over this window; join each post to
 * the closest story *representative* above the threshold; keep stories with at
 * least two distinct feeds; sort by `sourceCount`, then newest, then id.
 */
export function buildBuzz(items: StreamItem[], now = Date.now()): BuzzStory[] {
  const byId = new Map<string, StreamItem>();
  const window = items
    .filter((item) => {
      if (!item.title || item.title.trim() === "") return false;
      if (!item.origin?.streamId) return false;
      const published = item.published ?? 0;
      return published > 0 && now - published <= BUZZ_WINDOW_MS;
    })
    .sort((a, b) => (b.published ?? 0) - (a.published ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, BUZZ_MAX_ITEMS);

  for (const item of window) byId.set(item.id, item);

  const prints = window.map(fingerprint);
  const idf = idfOf(prints);
  const vectors = new Map<string, Map<string, number>>();
  for (const print of prints) vectors.set(print.id, vectorOf(print, idf));

  const clusters: Cluster[] = [];
  for (const print of prints) {
    const vector = vectors.get(print.id) ?? new Map<string, number>();
    let best: Cluster | null = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      // A story and a post two days apart are not the same story, however
      // similar the words; the window is about when, not just what.
      if (Math.abs(cluster.newest - print.published) > BUZZ_WINDOW_MS) continue;
      const score = cosine(vector, vectors.get(cluster.representative.id) ?? new Map());
      if (score > bestScore) {
        bestScore = score;
        best = cluster;
      }
    }
    if (best !== null && bestScore >= BUZZ_MATCH_THRESHOLD) {
      best.members.push(print);
      best.vectors.set(print.id, vector);
      if (print.published > best.newest) best.newest = print.published;
      best.representative = medoid(best.members, best.vectors);
    } else {
      clusters.push({
        members: [print],
        vectors: new Map([[print.id, vector]]),
        newest: print.published,
        representative: print,
      });
    }
  }

  const stories: BuzzStory[] = [];
  for (const cluster of clusters) {
    const feedIds: string[] = [];
    const recent = new Set<string>();
    const articles: StreamItem[] = [];
    for (const member of cluster.members) {
      const item = byId.get(member.id);
      if (item === undefined) continue;
      articles.push(item);
      if (!feedIds.includes(member.feedId)) feedIds.push(member.feedId);
      if (now - member.published <= BUZZ_MOMENTUM_MS) recent.add(member.feedId);
    }
    if (feedIds.length < BUZZ_MIN_SOURCES) continue;
    const head = byId.get(cluster.representative.id);
    if (head === undefined) continue;
    stories.push({
      id: cluster.representative.id,
      title: head.title ?? "",
      articles,
      feedIds,
      sourceCount: feedIds.length,
      newest: cluster.newest,
      recentSources: recent.size,
    });
  }

  return stories.sort(
    (a, b) =>
      b.sourceCount - a.sourceCount ||
      b.newest - a.newest ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
