/**
 * Unit checks for topics as they cross the sync wire, and for the store's rules.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/topics-store.mjs
 *
 * The state module itself cannot be imported here — `$state` is a Svelte
 * compile-time thing and throws in plain Node — so the rules that must hold are
 * in `lib/topics.ts` and are tested for real, while the store's *wiring* is
 * checked against its source, which is how every other state suite in this tree
 * does it.
 *
 * The wire bound is the reason this file exists: depth is 3, and
 * `{topics: [{id, name, keywords: [...]}]}` is 4. That is refused per entry, so
 * an array of keywords would have synced every topic's name and silently
 * dropped every topic's words. The snapshot is pushed through the real parser
 * below to prove it comes back whole.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TOPICS,
  seededTopics,
  topicOf,
  topicsFromValue,
  topicsToValue,
} from "../../src/lib/topics.ts";
import { emptyPrefs, parsePreferences, preferencesBody, withEntry } from "../../src/lib/prefs-sync.ts";

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const store = readFileSync(join(here, "../../src/state/topics.svelte.ts"), "utf8");
const prefs = readFileSync(join(here, "../../src/state/prefs.svelte.ts"), "utf8");
const wire = readFileSync(join(here, "../../src/lib/prefs-sync.ts"), "utf8");

// -------------------------------------------------------------------- shapes

{
  const value = topicsToValue([
    { id: "tech", name: "Tech", keywords: ["tech", "apple"] },
    { id: "breaking-news", name: "Breaking News", keywords: [] },
  ]);
  check("one object, one array", Array.isArray(value.topics) && value.topics.length === 2);
  check("keywords are a string on the wire", typeof value.topics[0].keywords === "string", typeof value.topics[0].keywords);
  check("...comma-separated", value.topics[0].keywords === "tech, apple", value.topics[0].keywords);

  const back = topicsFromValue(value);
  check("the value reads back as a list", back !== null && back.length === 2, JSON.stringify(back));
  check("...with keywords split again", back !== null && back[0].keywords.join(",") === "tech,apple", JSON.stringify(back?.[0]?.keywords));
  check("...and an empty list stays empty", back !== null && back[1].keywords.length === 0);

  check("no topics key is not a list", topicsFromValue({}) === null);
  check("a malformed topics value is not a list", topicsFromValue({ topics: "tech" }) === null);
  check("a non-object is not a list", topicsFromValue(null) === null);
  check("an empty array IS a list", JSON.stringify(topicsFromValue({ topics: [] })) === "[]");

  const mixed = topicsFromValue({ topics: [{ id: "x", name: "X" }, null, { id: "", name: "Y" }, { id: "z" }] });
  check("records that are not topics are dropped", mixed !== null && mixed.length === 1, JSON.stringify(mixed));
  check("a topic with no keywords field is valid", mixed !== null && mixed[0].keywords.length === 0);
  check("arrays are accepted where an older client sent one", topicOf({ id: "a", name: "A", keywords: [" one ", "one", "two"] })?.keywords.join(",") === "one,two");
}

// ------------------------------------------------------------- seeded topics

{
  const seeded = seededTopics();
  check("seeding copies the list", seeded.length === DEFAULT_TOPICS.length);
  check("...so editing one does not edit the constant", seeded[1] !== DEFAULT_TOPICS[1]);
  seeded[1].keywords.push("nothing");
  check("...and the keywords are copies too", !DEFAULT_TOPICS[1].keywords.includes("nothing"));
}

// --------------------------------------------------------------- the bounds

{
  const list = [
    { id: "breaking-news", name: "Breaking News", keywords: [] },
    { id: "local-politics", name: "Local Politics", keywords: ["council", "mayor"] },
  ];
  const doc = withEntry(emptyPrefs(), "topics", { updatedAt: 1_790_000_000_000, value: topicsToValue(list) });
  const parsed = parsePreferences(preferencesBody(doc));
  const kept = parsed.entries.topics?.value;

  check("the namespace survives the wire's parser", kept !== undefined, JSON.stringify(preferencesBody(doc)).slice(0, 120));
  const keptList = topicsFromValue(kept);
  check("every topic survives it", keptList !== null && keptList.length === 2, JSON.stringify(kept?.topics));
  check(
    "...with its keywords",
    keptList !== null && keptList[1].keywords.join(",") === "council,mayor",
    JSON.stringify(keptList?.[1]?.keywords),
  );

  // The shape this file is named for: an array of keywords would be depth 4.
  const nested = withEntry(emptyPrefs(), "topics", {
    updatedAt: 1_790_000_000_000,
    value: { topics: [{ id: "a", name: "A", keywords: ["one", "two"] }] },
  });
  const nestedKept = parsePreferences(preferencesBody(nested)).entries.topics?.value;
  check(
    "a nested keywords array really does lose its words",
    Array.isArray(nestedKept?.topics) && nestedKept.topics[0].keywords === undefined,
    JSON.stringify(nestedKept?.topics),
  );
}

// ------------------------------------------------------------ the store's wiring

{
  check("the store keeps its own copy on the device", /localStorage\?\.setItem\(STORAGE_KEY/.test(store));
  check("seeding is guarded by a flag, not by an empty list", /#settled/.test(store) && /if \(this\.#settled\) return;/.test(store));
  check("loading seeds through the copied list", /this\.list = seededTopics\(\);/.test(store));
  check("the snapshot is the shared shape", /return topicsToValue\(this\.list\);/.test(store));
  check("adopt refuses a value that says nothing", /const list = topicsFromValue\(value\);\s*\n\s*if \(list === null\) return;/.test(store));
  check("removing one topic keeps the rest", /const next = this\.list\.filter\(\(topic\) => topic\.id !== id\);/.test(store));
  check("adding goes through the one parser", /topicFromInput\(name, keywords, this\.list\)/.test(store));

  check("topics are a synced namespace", /PREFS_NAMESPACES = \[[^\]]*"topics"/.test(wire));
  check("...and the prefs store knows how to write and take them", /topics: \{ snapshot: \(\) => topics\.snapshot\(\), adopt: \(value\) => topics\.adopt\(value\) \}/.test(prefs));
  check("the prefs module imports the store", /import \{ topics \} from "\.\/topics\.svelte"/.test(prefs));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
