/**
 * Unit checks for the Buzz engine.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/buzz.mjs
 *
 * What is load-bearing here:
 *
 *   - the window. Buzz is about what is happening now; a post from last week
 *     with the same words is a different story, and a post with no origin has
 *     no feed to count as a source.
 *   - the count. A story is only Buzz when two *distinct* feeds carry it. One
 *     feed posting twice is one source, however many posts it writes.
 *   - the ranking. Coverage first, then recency, then id — and no score field,
 *     because a number the reader cannot see is a ranking they cannot trust.
 *   - determinism. Same items, same `now`, same order, every time.
 */
import {
  BUZZ_MAX_ITEMS,
  BUZZ_MIN_SOURCES,
  BUZZ_MOMENTUM_MS,
  BUZZ_WINDOW_MS,
  buildBuzz,
  cosine,
  feedCounts,
  fingerprint,
  idfOf,
  normalise,
  vectorOf,
} from "../../src/lib/buzz.ts";

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = 1_790_000_000_000;
const hour = 60 * 60 * 1000;

/** A post: title, feed, how long ago. */
function post(id, feed, title, hoursAgo, extra = {}) {
  return {
    id,
    title,
    published: NOW - hoursAgo * hour,
    origin: { streamId: feed, title: feed },
    summary: { content: "" },
    ...extra,
  };
}

// ---------------------------------------------------------------- normalise

{
  const words = normalise("<p>Apple unveils the <b>M6</b> chip today</p>");
  check("markup is dropped and words lowercased", words.includes("apple") && words.includes("m6"), words.join(","));
  check("boilerplate is dropped", !words.includes("today") && !words.includes("the"), words.join(","));
  check("an alphanumeric model name survives", words.includes("m6"), words.join(","));
  check("one-character tokens are dropped", normalise("a b c m6").join(",") === "m6", normalise("a b c m6").join(","));
  check("empty text is no words", normalise("").length === 0);
  check("announce is meaning, not boilerplate", normalise("Studio announces a delay").includes("announces"));
}

// ------------------------------------------------------------- fingerprints

{
  const title = post("a", "f1", "Apple unveils the M6 chip", 1);
  const print = fingerprint(title);
  check("title terms weigh three", print.terms.get("apple") === 3, String(print.terms.get("apple")));
  check("the fingerprint knows its feed", print.feedId === "f1");
  check("the fingerprint knows when", print.published === NOW - hour);

  const withSummary = post("b", "f1", "Apple unveils the M6 chip", 1, {
    summary: { content: "<p>Apple showed the chip on stage in October</p>" },
  });
  const both = fingerprint(withSummary);
  check("summary terms weigh one", both.terms.get("october") === 1, String(both.terms.get("october")));
  check("and add to a title term rather than replacing it", both.terms.get("apple") === 4, String(both.terms.get("apple")));

  const again = fingerprint(withSummary);
  check("a second pass reuses the cached fingerprint", again === both);
}

// --------------------------------------------------------------- similarity

{
  const a = fingerprint(post("a", "f1", "Apple unveils the M6 chip at its October event", 2));
  const b = fingerprint(post("b", "f2", "Apple's M6 chip unveiled at the October event", 1));
  const c = fingerprint(post("c", "f3", "Jughead loses his hat in Archie comics", 1));
  const idf = idfOf([a, b, c]);
  const va = vectorOf(a, idf);
  const vb = vectorOf(b, idf);
  const vc = vectorOf(c, idf);
  check("the same story scores high", cosine(va, vb) > 0.6, cosine(va, vb).toFixed(3));
  check("a different story scores near nothing", cosine(va, vc) < 0.2, cosine(va, vc).toFixed(3));
  check("a vector is normalised", Math.abs(Math.sqrt([...va.values()].reduce((s, w) => s + w * w, 0)) - 1) < 1e-9);
  check("an empty vector is not a divide-by-zero", vectorOf({ id: "x", feedId: "f", published: 0, terms: new Map() }, idf).size === 0);
}

// -------------------------------------------------------------- feed counts

{
  const items = [
    post("1", "verge", "One", 1),
    post("2", "verge", "Two", 2),
    post("3", "ars", "Three", 3),
    post("4", "wired", "Four", 4),
    post("5", "wired", "Five", 5),
    { id: "6", title: "No origin", published: NOW },
  ];
  const counts = feedCounts(items);
  check(
    "feeds are counted and sorted by count then id",
    counts.map((row) => `${row.id}:${row.items}`).join(",") === "verge:2,wired:2,ars:1",
    counts.map((row) => `${row.id}:${row.items}`).join(","),
  );
  check("a post with no origin is not a feed", counts.every((row) => row.id !== ""));
  check("no items is no counts", feedCounts([]).length === 0);
}

// -------------------------------------------------------------------- buzz

{
  // One story, three feeds, plus an unrelated post and a second single-feed one.
  const items = [
    post("a1", "verge", "Apple unveils the M6 chip at its October hardware event", 1),
    post("a2", "ars", "Apple's M6 chip unveiled at the October hardware event", 2),
    post("a3", "wired", "M6 chip: Apple's October hardware event, unveiled", 3),
    post("b1", "comics", "Jughead loses his hat in Archie comics", 1),
    post("b2", "comics", "Archie comics roundup: Jughead's hat", 2),
  ];
  const stories = buildBuzz(items, NOW);
  check("one story, because the other posts share no feed", stories.length === 1, String(stories.length));
  const story = stories[0];
  check("it counts its three feeds", story.sourceCount === 3, String(story.sourceCount));
  check("its feed ids are distinct", new Set(story.feedIds).size === story.feedIds.length);
  check("it holds the three posts", story.articles.length === 3, String(story.articles.length));
  check("articles are newest first", story.articles[0].published > story.articles[1].published);
  check("the headline is one the feeds wrote", items.some((item) => item.title === story.title));
  check("the id is the representative post", ["a1", "a2", "a3"].includes(story.id), story.id);
  check("the story knows when it happened", story.newest === NOW - hour);
  check("recent sources counts the momentum window", story.recentSources === 3, String(story.recentSources));

  const again = buildBuzz(items, NOW);
  check("the same items rank the same way", again.map((s) => s.id).join(",") === stories.map((s) => s.id).join(","));
}

{
  // Two feeds, same event, three days apart: outside the window, so no story.
  const stale = post("old", "verge", "Apple unveils the M6 chip at its October event", 72);
  const fresh = post("new", "ars", "Apple's M6 chip unveiled at the October event", 1);
  check("a post older than the window is not in Buzz", buildBuzz([stale, fresh], NOW).length === 0);
  check("and it is not counted even with a twin", buildBuzz([stale, stale], NOW).length === 0);
}

{
  // One feed writing twice is one source.
  const items = [
    post("x1", "verge", "Apple unveils the M6 chip at its October event", 1),
    post("x2", "verge", "Apple M6 chip: the October event in full", 2),
  ];
  check(`one feed twice is under BUZZ_MIN_SOURCES (${BUZZ_MIN_SOURCES})`, buildBuzz(items, NOW).length === 0);
}

{
  // No origin: no source, and not guessed.
  const items = [
    { id: "p1", title: "Apple unveils the M6 chip at its October event", published: NOW - hour },
    { id: "p2", title: "Apple's M6 chip unveiled at the October event", published: NOW - hour },
  ];
  check("posts with no origin are never a story", buildBuzz(items, NOW).length === 0);
  const untitled = [post("t1", "verge", "", 1), post("t2", "ars", "", 1)];
  check("posts with no title are never a story", buildBuzz(untitled, NOW).length === 0);
}

{
  // Coverage beats recency: two feeds on an older story outrank one feed... which
  // cannot exist, so: three feeds three hours ago beat two feeds one hour ago.
  const items = [
    post("c1", "a", "Senate passes the water bill after a long night session", 3),
    post("c2", "b", "Senate passes water bill after long night session", 3),
    post("c3", "c", "Water bill passes the Senate after a long night session", 3),
    post("d1", "d", "Local bakery wins a national award", 1),
    post("d2", "e", "Bakery wins a national award for its sourdough", 1),
  ];
  const stories = buildBuzz(items, NOW);
  check("both stories are Buzz", stories.length === 2, String(stories.length));
  check("the three-feed story ranks first", stories[0].sourceCount === 3, stories.map((s) => s.sourceCount).join(","));
  check("...even though it is older", stories[0].newest < stories[1].newest);
}

{
  // The momentum count is about the last six hours, not the whole window.
  //
  // The background posts are the point: idf over three documents gives every
  // unique word more weight than the words a story shares, so a three-post
  // window is the one case where this engine is artificially strict. A real
  // window is hundreds of posts, which is what this fixture is.
  const background = [];
  for (let index = 0; index < 40; index += 1) {
    const filling = ["thyme", "plum", "fig", "lime"][index % 4];
    background.push(post(`bg${index}`, `bg${index}`, `Slow-cooked ${filling} supper for two, part ${index}`, 1 + (index % 20)));
  }
  const items = [
    ...background,
    post("m1", "a", "Ferry strike halts the harbour crossing", 30),
    post("m2", "b", "Ferry strike halts the harbour crossing for a second day", 26),
    post("m3", "c", "Ferry strike halts the harbour crossing again", 1),
  ];
  const story = buildBuzz(items, NOW).find((one) => one.feedIds.includes("a"));
  check("the story counts its three feeds", story !== undefined && story.sourceCount === 3, String(story?.sourceCount));
  check("but only one arrived recently", story !== undefined && story.recentSources === 1, String(story?.recentSources));
  check(
    "the momentum window is what it says",
    BUZZ_MOMENTUM_MS === 6 * hour && BUZZ_WINDOW_MS === 48 * hour && BUZZ_MAX_ITEMS === 500,
  );
}

{
  // A cap that is a cap: the newest items are the ones kept.
  const many = [];
  for (let index = 0; index < BUZZ_MAX_ITEMS + 20; index += 1) {
    many.push(post(`cap${index}`, `f${index % 7}`, `Item number ${index} about nothing in particular`, index + 1));
  }
  const stories = buildBuzz(many, NOW);
  const kept = stories.flatMap((story) => story.articles.map((item) => item.id));
  check("nothing from outside the cap is in a story", kept.every((id) => Number(id.slice(3)) < BUZZ_MAX_ITEMS), String(kept.length));
  check("the cap does not stop stories being found", stories.length > 0, String(stories.length));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
