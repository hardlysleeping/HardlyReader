/**
 * Which glyph a category gets when nobody has chosen one.
 *
 * Free, deterministic and local: no model, no network, no clock. The question it
 * answers is "does this name look like it is about something a picture can say",
 * and the honest answer is often "no" — `null` is a real result and draws
 * nothing, because a wrong-but-plausible glyph (a star for a feed called "Star
 * Wars") is worse than no glyph at all.
 *
 * Two halves:
 *
 * 1. **Keywords.** Every glyph carries its own name plus Lucide's tags
 *    (`ICON_KEYWORDS`, generated). A name adds synonyms a tag list cannot know —
 *    nobody tags a chip drawing "tech news" — and a small bonus for the words
 *    people actually call a category.
 * 2. **A person's name** (`user`). The owner's rule: *"if a category seems like
 *    a name for a person like first and last name it should have a profile
 *    icon"*. It is structural, not a dictionary of names, and it only runs when
 *    the keywords scored nothing — so a topic always beats a guess about a
 *    person, and `Comics Weekly` is comics rather than a person called Comics
 *    Weekly.
 *
 * Determinism is part of the contract: the same label always gets the same
 * glyph, and a tie is broken by the curated order of the set rather than by
 * object iteration, so adding a glyph can change an answer only if it outranks
 * the old one.
 */

import { ICON_KEYWORDS, ICON_NAMES } from "./icons";

/**
 * Words a category is called that no glyph is tagged with.
 *
 * Each maps to glyphs, in preference order; a hit is worth an exact keyword hit
 * (3), because this table exists precisely because the tags missed it.
 */
const SYNONYMS: Record<string, string[]> = {
  ai: ["bot", "sparkles", "cpu"],
  llm: ["bot", "brain"],
  chatbot: ["bot"],
  tech: ["cpu", "laptop", "smartphone"],
  gadget: ["smartphone", "cpu"],
  hardware: ["cpu", "laptop"],
  software: ["code", "terminal"],
  code: ["code", "terminal"],
  programming: ["code", "terminal"],
  dev: ["code", "terminal"],
  crypto: ["bitcoin", "chart-line", "wallet"],
  blockchain: ["blocks", "bitcoin"],
  comics: ["book-open", "image", "drama"],
  comic: ["book-open", "image"],
  manga: ["book-open", "drama"],
  anime: ["tv", "drama", "video"],
  webtoon: ["book-open", "image"],
  movies: ["film", "clapperboard", "popcorn"],
  movie: ["film", "clapperboard"],
  cinema: ["film", "clapperboard"],
  tv: ["tv"],
  shows: ["tv"],
  series: ["tv"],
  photography: ["camera", "image"],
  photo: ["camera", "image"],
  photos: ["camera", "image"],
  design: ["palette", "pen-tool", "shapes"],
  type: ["type"],
  fonts: ["type"],
  typography: ["type"],
  illustration: ["brush", "palette"],
  art: ["palette", "brush"],
  drawing: ["pencil", "brush"],
  music: ["music", "headphones", "disc-3"],
  audio: ["headphones", "mic"],
  podcast: ["podcast", "mic"],
  podcasts: ["podcast", "mic"],
  video: ["video", "clapperboard"],
  youtube: ["video"],
  books: ["book", "book-open", "library"],
  reading: ["book-open"],
  literature: ["book"],
  writing: ["notebook-pen", "pencil"],
  science: ["flask-conical", "atom", "microscope"],
  research: ["microscope", "flask-conical"],
  space: ["rocket", "telescope", "satellite"],
  astronomy: ["telescope", "rocket"],
  physics: ["atom"],
  biology: ["dna", "leaf"],
  climate: ["globe", "leaf", "cloud"],
  environment: ["leaf", "tree-pine"],
  nature: ["leaf", "tree-pine", "mountain"],
  weather: ["cloud", "sun", "snowflake"],
  health: ["heart-pulse", "stethoscope", "pill"],
  medicine: ["stethoscope", "pill", "syringe"],
  fitness: ["dumbbell", "activity"],
  sport: ["trophy", "dumbbell", "goal"],
  sports: ["trophy", "dumbbell", "goal"],
  linux: ["terminal", "monitor"],
  windows: ["monitor", "laptop"],
  macos: ["laptop", "monitor"],
  apple: ["laptop", "smartphone"],
  android: ["smartphone"],
  ios: ["smartphone"],
  opensource: ["git-branch", "code"],
  github: ["git-branch", "code"],
  cybersecurity: ["shield", "lock"],
  hacking: ["terminal", "bug"],
  football: ["goal"],
  gaming: ["gamepad-2", "joystick"],
  games: ["gamepad-2", "dice-5"],
  esports: ["gamepad-2", "trophy"],
  news: ["newspaper", "megaphone"],
  politics: ["landmark", "vote"],
  election: ["vote"],
  law: ["gavel", "scale"],
  legal: ["gavel", "scale"],
  money: ["banknote", "chart-line", "wallet"],
  finance: ["chart-line", "banknote", "piggy-bank"],
  markets: ["chart-line"],
  stocks: ["chart-line"],
  business: ["briefcase", "building"],
  economy: ["chart-line", "landmark"],
  food: ["salad", "chef-hat", "pizza"],
  cooking: ["chef-hat", "salad"],
  recipes: ["chef-hat", "salad"],
  drink: ["coffee", "beer", "wine"],
  travel: ["plane", "map", "compass"],
  geography: ["globe", "map"],
  history: ["history", "landmark"],
  war: ["sword", "shield"],
  military: ["shield", "sword"],
  security: ["shield", "lock"],
  privacy: ["shield", "lock"],
  cars: ["car"],
  automotive: ["car"],
  bikes: ["bike"],
  home: ["house", "sofa"],
  diy: ["hammer", "shapes"],
  gardening: ["sprout", "flower"],
  pets: ["paw-print", "dog", "cat"],
  animals: ["paw-print", "bird", "fish"],
  fashion: ["shirt", "glasses"],
  style: ["shirt", "glasses"],
  school: ["graduation-cap", "backpack"],
  education: ["graduation-cap", "book"],
  kids: ["baby", "blocks"],
  family: ["users", "house"],
  people: ["users", "user"],
  religion: ["church", "book"],
  spirituality: ["sparkles", "church"],
  psychology: ["brain"],
  philosophy: ["brain", "book"],
};

/**
 * The words people name a whole category with, worth a little extra.
 *
 * They are not synonyms (the glyph is already tagged with them); they are the
 * ones where the plain keyword match is often beaten by a same-scoring glyph and
 * the reader's expectation is specific — "Tech News" wants a chip, not a laptop.
 */
const BONUS: Record<string, string[]> = {
  news: ["newspaper"],
  tech: ["cpu"],
  art: ["palette"],
  music: ["music"],
  film: ["film"],
  books: ["book-open"],
  gaming: ["gamepad-2"],
  sport: ["trophy"],
  food: ["chef-hat"],
  travel: ["plane"],
  science: ["flask-conical"],
  money: ["banknote"],
  design: ["palette"],
  photography: ["camera"],
  comics: ["book-open"],
  ai: ["bot"],
  // Both `satellite` and `rocket` are tagged "space"; the one a reader means by
  // "Space" is the one going up, so it is said here rather than left to the
  // curated order.
  space: ["rocket"],
  linux: ["terminal"],
  security: ["shield"],
  privacy: ["lock"],
  pets: ["paw-print"],
  animals: ["paw-print"],
};

/** Words that make a two-word label a publication rather than a person. */
const NOT_A_PERSON = new Set([
  "the",
  "news",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "times",
  "post",
  "journal",
  "review",
  "magazine",
  "blog",
  "press",
  "club",
  "comics",
  "tech",
  "media",
  "network",
  "report",
  "gazette",
  "herald",
  "tribune",
  "digest",
  "today",
  "morning",
  "evening",
  "global",
  "world",
  "international",
  "central",
  "national",
]);

/** Lowercase words, no punctuation or emoji. */
function tokens(label: string): string[] {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length >= 2);
}

/**
 * Whether a word is close enough to a tag to count.
 *
 * A prefix counts for less than equality and a substring for least: `photo` is
 * `photography` nearly spelled out, while `arts` merely contains `art`. Below
 * four characters only equality is allowed, so `tv` cannot match `television`
 * by accident and `art` cannot claim every word with the letters in it.
 */
function closeness(word: string, keyword: string): number {
  if (word === keyword) return 3;
  if (word.length < 4 || keyword.length < 4) return 0;
  if (keyword.startsWith(word) || word.startsWith(keyword)) return 2;
  return keyword.includes(word) ? 1 : 0;
}

/** The best glyph for a label, or `null` when nothing is close enough. */
export function guessIcon(label: string): string | null {
  const words = tokens(label);
  if (words.length === 0) return null;

  const scores = new Map<string, number>();
  const add = (name: string, points: number) => {
    if (points <= 0) return;
    scores.set(name, (scores.get(name) ?? 0) + points);
  };

  // Per word, an icon scores its *best* reason, not the sum of them. Adding them
  // up let a word double-count itself — `news` matched `newspaper`'s tag, the
  // synonym table and the bonus, and beat `tech` on a label that names both.
  // The weights are ordered so the specific beats the generic: a bonus word (4)
  // beats a synonym (3), which beats a tag match (≤3).
  for (const word of words) {
    const synonyms = new Set(SYNONYMS[word] ?? []);
    const bonuses = new Set(BONUS[word] ?? []);
    for (const name of ICON_NAMES) {
      const keywords = ICON_KEYWORDS[name] ?? [];
      let tag = 0;
      for (const keyword of keywords) tag = Math.max(tag, closeness(word, keyword));
      const points = Math.max(tag, synonyms.has(name) ? 3 : 0, bonuses.has(name) ? 4 : 0);
      add(name, points);
    }
  }

  let winner: string | null = null;
  let highest = 0;
  // Curated order, so a tie goes to the earlier glyph every time.
  for (const name of ICON_NAMES) {
    const score = scores.get(name) ?? 0;
    if (score > highest) {
      highest = score;
      winner = name;
    }
  }
  if (winner !== null) return winner;

  return looksLikePerson(label) ? "user" : null;
}

/**
 * Two or three capitalised words with nothing else to recommend them: a person.
 *
 * Deliberately structural. `Alex Ross` and `Ars Technica` are the same shape, and
 * no rule without a dictionary of names can separate them, so the guess is
 * allowed to be wrong and the picker is the correction. What the rule *can* do is
 * refuse the obvious non-people: `BBC NEWS` (all caps), `Reuters` (one word),
 * `The Verge` (a publication stopword), and anything with a number in it.
 */
export function looksLikePerson(label: string): boolean {
  const words = label
    .trim()
    .replace(/\./g, "")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length < 2 || words.length > 3) return false;

  // A capitalised word, and a hyphenated pair of them (`Jean-Luc`), which is why
  // the lowercase run may be followed by another capital word.
  const cap = /^[A-Z][a-z'\u2019-]+(?:[A-Z][a-z'\u2019-]+)*$/;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const middle = index === 1 && words.length === 3;
    // A middle initial is the one place a single letter is allowed: `Sarah J. Maas`.
    if (middle && /^[A-Z]$/.test(word)) continue;
    if (!cap.test(word)) return false;
    if (NOT_A_PERSON.has(word.toLowerCase())) return false;
    if (word.length > 15) return false;
    if (/\d/.test(word)) return false;
  }
  // The first or last word being a stopword is the publication case; the middle
  // initial is exempt from the check above but never carries meaning on its own.
  return !NOT_A_PERSON.has(words[0].toLowerCase());
}
