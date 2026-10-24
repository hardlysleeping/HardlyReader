import {
  extractText,
  fuzzyScore,
  groupHits,
  normalise,
  rankByFuzzy,
  searchFeeds,
  snippetAround,
} from "../../src/lib/search.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- normalising ------------------------------------------------------------
check("case is ignored", normalise("Ars Technica") === "ars technica");
check("accents fold", normalise("Café") === "cafe");

// --- scoring ---------------------------------------------------------------
check("an empty query matches everything weakly", fuzzyScore("", "Ars Technica") === 0);
check("an empty name never matches", fuzzyScore("ars", "") === null);
check("a plain prefix matches", fuzzyScore("ars", "Ars Technica") !== null);
check("a word start beats the middle of a word", (fuzzyScore("tec", "Ars Technica") ?? 0) > (fuzzyScore("tec", "Protect") ?? 0));
check("a contiguous hit beats a scattered one", (fuzzyScore("art", "Art & Design") ?? 0) > (fuzzyScore("art", "A R T digest") ?? 0));
check("an exact name scores highest", (fuzzyScore("art", "Art") ?? 0) > (fuzzyScore("art", "Art & Design") ?? 0));
check("an earlier hit beats a later one", (fuzzyScore("de", "Design Week") ?? 0) > (fuzzyScore("de", "Weekly Design") ?? 0));
check("scattered letters still match", fuzzyScore("atc", "Ars Technica") !== null);
check("letters in the wrong order do not", fuzzyScore("cat", "Ars Technica") === null);
check("no match returns null", fuzzyScore("zzz", "Ars Technica") === null);
check("fuzzy survives a typo-ish run", fuzzyScore("technca", "Ars Technica") !== null);

// --- ranking ---------------------------------------------------------------
const feeds = [{ title: "Ars Technica" }, { title: "Art & Design" }, { title: "The Verge" }];
const ranked = rankByFuzzy("art", feeds, (feed) => feed.title);
check("ranking drops non-matches", ranked.length === 2, String(ranked.length));
check("the better match leads", ranked[0].item.title === "Art & Design", ranked[0]?.item.title);
check("scores descend", ranked.every((entry, index) => index === 0 || ranked[index - 1].score >= entry.score));

// --- post text -------------------------------------------------------------
check("markup becomes text", extractText("<p>Hello <b>world</b></p>") === "Hello world");
check("entities are decoded", extractText("a &amp; b &lt;c&gt;") === "a & b <c>");
check("scripts are dropped", extractText("<script>bad()</script>ok") === "ok");
check("styles are dropped", extractText("<style>.a{}</style>ok") === "ok");
check("whitespace collapses", extractText("a\n\n   b") === "a b");
check("missing content is empty", extractText(undefined) === "");
check("long text is capped", extractText("x".repeat(5000), 100).length === 100);
check("a snippet shows the match", snippetAround("the quick brown fox", "brown", 5)?.includes("brown"));
check("a snippet marks truncation", snippetAround("x".repeat(200) + " target " + "y".repeat(200), "target", 10)?.startsWith("…"));
check("no match means no snippet", snippetAround("nothing here", "zebra") === null);
check("an empty query means no snippet", snippetAround("text", "  ") === null);

// --- searching groups ------------------------------------------------------
const groups = [
  { label: "Art", feeds: [{ id: "f1", title: "MoMA" }, { id: "f2", title: "Artforum" }] },
  { label: "Technology", feeds: [{ id: "f3", title: "Ars Technica" }] },
  { label: "News", feeds: [{ id: "f4", title: "The Verge" }] },
];

const empty = searchFeeds("", groups);
check("an empty query shows nothing", empty.length === 0);

const byName = searchFeeds("ars", groups);
check("a feed name matches", byName.map((hit) => hit.feed.id).join(",") === "f3", byName.map((hit) => hit.feed.id).join(","));
check("the reason is recorded", byName[0].via === "title");

const byCategory = searchFeeds("techno", groups);
check("a category name matches its feeds", byCategory.length === 1 && byCategory[0].feed.id === "f3");
check("and says why", byCategory[0].via === "category");
check("a category hit ranks below a name hit", (searchFeeds("art", groups)[0].score ?? 0) >= (byCategory[0].score ?? 0));

const textIndex = {
  f4: { posts: [{ id: "p1", title: "Phones reviewed", text: "we tested the new folding screen" }] },
};
const namesOnly = searchFeeds("folding", groups);
check("post text is not searched when no index is given", namesOnly.length === 0);
const withText = searchFeeds("folding", groups, textIndex);
check("post text matches its feed", withText.length === 1 && withText[0].feed.id === "f4", JSON.stringify(withText.map((h) => h.feed.id)));
check("the matching post is named", withText[0].postTitle === "Phones reviewed");
check("a snippet comes along", (withText[0].snippet ?? "").includes("folding"));
check("text hits rank below name hits", withText[0].score < (searchFeeds("verge", groups)[0].score ?? 0));

const both = searchFeeds("verge", groups, { f4: { posts: [{ id: "p", title: "x", text: "verge" }] } });
check("a feed matching both ways appears once", both.filter((hit) => hit.feed.id === "f4").length === 1);
check("and is credited to its name", both[0].via === "title");

const typo = searchFeeds("technca", groups);
check("a fuzzy typo still finds the feed", typo.length === 1 && typo[0].feed.id === "f3", JSON.stringify(typo.map((h) => h.feed.id)));

// --- results keep their category ---------------------------------------------
// The sidebar draws every feed inside a category, so the results do too: a
// heading is drawn whenever anything under it matched, even if the heading's
// own name did not. `Cross` is deliberately in two categories: a feed is listed
// once, in the first category the tree draws it in, and the two agree.

const tree = [
  {
    id: "c-art",
    label: "Art",
    feeds: [
      { id: "f1", title: "MoMA" },
      { id: "f2", title: "Artforum" },
      { id: "f9", title: "Shared Feed" },
    ],
  },
  { id: "c-tech", label: "Technology", feeds: [{ id: "f3", title: "Ars Technica" }, { id: "f9", title: "Shared Feed" }] },
  { id: "c-news", label: "News", feeds: [{ id: "f4", title: "The Verge" }] },
];

const named = groupHits("ars", searchFeeds("ars", tree), tree);
check("a feed found by name still gets its category", named.length === 1 && named[0].label === "Technology", JSON.stringify(named.map((g) => g.label)));
check("the category is drawn holding only what matched", named[0].hits.length === 1 && named[0].total === 2);
check("and it is not treated as a name match", named[0].categoryScore === null);
check("the heading carries the category id", named[0].id === "c-tech");

const namedCategory = groupHits("art", searchFeeds("art", tree), tree);
check("a category found by name comes first", namedCategory[0].label === "Art", JSON.stringify(namedCategory.map((g) => g.label)));
check("and brings all of its feeds", namedCategory[0].hits.length === 3 && namedCategory[0].total === 3);
check("its score says the name matched", namedCategory[0].categoryScore !== null);
check(
  "feeds found by their own name keep their own category",
  namedCategory[1].label === "Technology" && namedCategory[1].hits.length === 1,
);

const shared = groupHits("cross", searchFeeds("cross", tree), tree);
check("a feed in two categories is listed once, in the first", shared.length === 1 && shared[0].id === "c-art" && shared[0].hits.length === 1);

check("a category with nothing under it is not drawn", groupHits("verge", searchFeeds("verge", tree), tree).length === 1);
check("no query, no groups", groupHits("", [], tree).length === 0);
check(
  "every hit lands in exactly one group",
  namedCategory.reduce((sum, group) => sum + group.hits.length, 0) === searchFeeds("art", tree).length,
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
