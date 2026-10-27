/**
 * Where a post's text comes from, asked per feed.
 *
 * Three answers, and the reader owns all of them:
 *
 * - **Auto** — the app decides. A feed that publishes the whole piece costs
 *   nothing; a feed that publishes two sentences and a "continue reading" is a
 *   page fetch per post, which is the only way to read it here. So Auto reads
 *   the feed's own markup (`looksTruncated`) and remembers the verdict against
 *   the feed, because the publisher's habit is a property of the feed and not of
 *   one post.
 * - **Feed** — never fetch. For a feed whose extracted version is worse than
 *   what it sends, and for a metered connection.
 * - **Full webpage** — always fetch. The extractor still throws away a thin
 *   result (`chooseBody`), so asking for the page never shows a cookie notice.
 *
 * One post outranks its feed: the ¶ button records a choice for that entry, and
 * `wantsFullText` asks it first. The two are deliberately different facts — a
 * press on one article says something about that article; the feed's answer says
 * something about the publisher.
 */

import { plainText, textLength } from "./extract";
import type { BodyChoice } from "./extract-ledger";

/** The three answers, in the order they are offered. */
export type FullTextMode = "auto" | "feed" | "article";

/** A feed starts on Auto: most feeds send their whole piece. */
export const FULL_TEXT_DEFAULT: FullTextMode = "auto";

export const FULL_TEXT_MODES: readonly FullTextMode[] = ["auto", "feed", "article"];

/**
 * The three words, fixed. "Full webpage" rather than "Article" because the
 * setting is about the source, and the Settings panel's own switch already
 * answers the same question in its own words for the whole account.
 */
export const FULL_TEXT_LABELS: Record<FullTextMode, string> = {
  auto: "Auto",
  feed: "Feed",
  article: "Full webpage",
};

export function isFullTextMode(value: unknown): value is FullTextMode {
  return value === "auto" || value === "feed" || value === "article";
}

/** The stored shape of an answer: only the two absolute ones are written down. */
export function modeFromChoice(choice: BodyChoice | null | undefined): FullTextMode {
  return choice === "feed" || choice === "article" ? choice : FULL_TEXT_DEFAULT;
}

/** And back: Auto is the absence of a stored answer, never a third value. */
export function choiceFromMode(mode: FullTextMode): BodyChoice | null {
  return mode === "feed" || mode === "article" ? mode : null;
}

/**
 * Below this many characters a post is a candidate for "the feed cut it short".
 *
 * Set from what a real article looks like against what a teaser looks like: a
 * teaser is one or two sentences (well under 500), a piece is rarely under a
 * thousand. The number is only ever consulted *with* a marker below — a short
 * post that does not announce itself as a teaser is left alone, because a link
 * post, a quote and a comic page are all legitimately short.
 */
export const TRUNCATED_TEXT = 800;

/**
 * A cut-off end. Feeds write the ellipsis three ways (the character, three dots,
 * the entity) and often inside a bracketed `[ … ]`; a trailing tag is not part
 * of the words, so `…</p>` still ends in an ellipsis.
 */
const CUT_END = /(?:…|\.\.\.|&hellip;|&#8230;|&#x2026;|\[\s*(?:…|\.\.\.|&hellip;)\s*\])\s*(?:<\/[a-z][^>]*>\s*|<br\s*\/?>\s*)*$/i;

/**
 * The words publishers put on the link to the rest of the piece.
 *
 * Matched against a whole anchor's text and against the body's last words, so a
 * sentence that merely mentions reading more is not a marker on its own.
 */
const MORE_WORDS: readonly string[] = [
  "read more",
  "read the rest",
  "read the rest of this article",
  "read the rest of this post",
  "read the full article",
  "read the full story",
  "read the full post",
  "read the whole article",
  "read the whole story",
  "read the whole post",
  "read it all",
  "continue reading",
  "keep reading",
  "read on",
  "full story",
  "full article",
  "view the full article",
  "view full article",
  "see the full article",
];

/** Lower-cased words with tags, entities and link arrows removed. */
function words(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[›»→⟶…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!:]+$/, "")
    .trim();
}

function isMoreWords(text: string): boolean {
  return MORE_WORDS.includes(words(text));
}

/**
 * Does this markup carry a link to the rest of the piece?
 *
 * The anchor is the usual place ("Read more →"), but a few feeds print the words
 * with no link at all, so the body's own last words count too.
 */
export function hasMoreMarker(html: string): boolean {
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (isMoreWords(match[1])) return true;
  }
  const tail = words(plainText(html)).slice(-40);
  return MORE_WORDS.some((word) => tail.endsWith(word));
}

/**
 * Whether this post's own markup says the feed cut it short.
 *
 * Two things together, never one: a short body *and* a marker. Either alone is
 * too easy to be wrong about — plenty of short posts are whole, and plenty of
 * long ones end in an ellipsis because the writer used one.
 */
export function looksTruncated(html: string): boolean {
  if (textLength(html) >= TRUNCATED_TEXT) return false;
  return CUT_END.test(html) || hasMoreMarker(html);
}

/** Everything the decision needs, gathered by the caller. */
export interface FullTextQuestion {
  /** What the reader pressed on this one post, if anything. */
  post: BodyChoice | null;
  /** The feed's own answer. */
  feed: FullTextMode;
  /** Settings → Reader view: fetch every post that has a link. */
  accountWide: boolean;
  /** Auto has already found this feed sending cut-off posts. */
  remembered: boolean;
  /** The feed's own HTML for this post. */
  html: string;
}

/**
 * Whether a page should be fetched for this post.
 *
 * The order is the whole rule:
 *
 * 1. **This post's own press** — absolute, both ways. It is what the ¶ button
 *    writes, and it is the only thing that can contradict both the feed and the
 *    account without changing either.
 * 2. **The feed's answer** — `feed` and `article` are just as absolute.
 * 3. **Auto** — the account-wide switch (it promises every post), then what Auto
 *    remembers about this feed, then this post's own markup. The remembered
 *    verdict is an accelerator, not a veto: a post whose text is cut short is
 *    fetched even for a feed Auto has not seen truncate before.
 */
export function wantsFullText(question: FullTextQuestion): boolean {
  if (question.post !== null) return question.post === "article";
  if (question.feed === "feed") return false;
  if (question.feed === "article") return true;
  return question.accountWide || question.remembered || looksTruncated(question.html);
}
