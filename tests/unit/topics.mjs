/**
 * Unit checks for topics: the matcher and the input parser.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/topics.mjs
 *
 * The whole-word rule is the one that matters. A substring match turns "AI"
 * into "said", "trail" and "certain", and a topic that matches everything looks
 * exactly like a topic that works — until you read it.
 */
import {
  DEFAULT_TOPICS,
  matchesTopic,
  slugOf,
  topicFromInput,
} from "../../src/lib/topics.ts";

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const topic = (name, keywords) => ({ id: slugOf(name), name, keywords });
const ai = topic("AI", ["ai", "openai"]);
const comics = topic("Comics", ["comic", "manga"]);

function item(title, summary = "", extra = {}) {
  return { id: title, title, summary: { content: summary }, ...extra };
}

// ------------------------------------------------------------------- matching

{
  check("a keyword in the headline matches", matchesTopic(item("OpenAI ships a new model"), ai));
  check("a keyword in the summary matches", matchesTopic(item("A quiet week", "<p>OpenAI shipped something</p>"), ai));
  check("a keyword in the feed's name matches", matchesTopic(item("Weekly roundup"), ai, "OpenAI Blog"));
  check("a keyword in a category label matches", matchesTopic(item("Weekly roundup", "", { categories: ["AI"] }), ai));
  check("case does not matter", matchesTopic(item("OPENAI ships"), ai));
  check("markup does not hide a keyword", matchesTopic(item("x", "<b>OpenAI</b>"), ai));

  check("a substring is not a word", !matchesTopic(item("He said it was certain"), ai), "ai inside said/certain");
  check("...nor inside a longer word", !matchesTopic(item("Start the trail"), topic("Art", ["art"])), "art inside start");
  check("a topic with no keywords matches everything", matchesTopic(item("Anything at all"), DEFAULT_TOPICS[0]));
  check("an empty keyword is not a match-everything keyword", !matchesTopic(item("Anything"), topic("Blank", [""])));

  check("a two-word keyword is matched as two words", matchesTopic(item("An artificial intelligence lab"), topic("AI", ["artificial intelligence"])));
  check("...and not when the words are apart", !matchesTopic(item("Artificial light is intelligent"), topic("AI", ["artificial intelligence"])));
  check("a hyphen is a boundary", matchesTopic(item("An open-source release"), topic("Open", ["open"])));
  check("a slash is a boundary", matchesTopic(item("AI/ML tooling"), ai));
  check("punctuation at the edge of a title still matches", matchesTopic(item("OpenAI."), ai));
  check("the feed's own title is used when none is passed", matchesTopic({ ...item("Weekly roundup"), origin: { streamId: "f", title: "OpenAI Blog" } }, ai));
  check("categories are searched as words, not a joined string", matchesTopic(item("x", "", { categories: ["AImark"] }), ai) === false);
}

// --------------------------------------------------------------------- input

{
  check("a name becomes a slug id", slugOf("Breaking News") === "breaking-news", slugOf("Breaking News"));
  check("accents and punctuation are slugged", slugOf("Café & Bar!") === "cafe-bar", slugOf("Café & Bar!"));

  const made = topicFromInput("Local  Politics", " council , mayor ,, COUNCIL ");
  check("keywords are trimmed, lowercased and de-duplicated", made !== null && made.keywords.join(",") === "council,mayor", JSON.stringify(made?.keywords));
  check("the name is trimmed and its spaces collapsed", made !== null && made.name === "Local Politics", made?.name);
  check("the id comes from the name", made !== null && made.id === "local-politics", made?.id);

  check("a nameless topic is refused", topicFromInput("   ", "x") === null);
  check("a name that slugs to nothing is refused", topicFromInput("!!!", "x") === null);

  const taken = [topic("Tech", ["tech"])];
  check("a duplicate name is refused", topicFromInput("tech", "x", taken) === null);
  check("...case-insensitively", topicFromInput("TECH", "x", taken) === null);

  const bare = topicFromInput("Breaking", "");
  check("no keywords is a valid topic", bare !== null && bare.keywords.length === 0);
  check("a topic with no keywords matches everything", bare !== null && matchesTopic(item("Anything"), bare));
}

// -------------------------------------------------------------------- default

{
  const ids = DEFAULT_TOPICS.map((one) => one.id);
  check("the seeded topics have unique ids", new Set(ids).size === ids.length, ids.join(","));
  check("every seeded id matches its name", DEFAULT_TOPICS.every((one) => slugOf(one.name) === one.id));
  check("Breaking News carries no keywords", DEFAULT_TOPICS[0].keywords.length === 0);
  check("the seeded list is a working list", DEFAULT_TOPICS.every((one) => one.name.trim() !== ""));
  check(
    "the seeded topics are the ten the plan names",
    DEFAULT_TOPICS.map((one) => one.name).join(",") ===
      "Breaking News,Tech,AI,Science,Comics,Film,Music,Games,Money,Design",
    DEFAULT_TOPICS.map((one) => one.name).join(","),
  );
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
