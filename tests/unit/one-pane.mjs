import { backLabel, levelOf, stepBackTarget, whereLabel } from "../../src/lib/one-pane.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The three levels are the three panes, in the order they sit on screen.
check("no article and the feed list showing is the feeds level", levelOf(null, false) === "feeds");
check("a feed open with no article is the posts level", levelOf(null, true) === "posts");
check("an open article is the article level", levelOf("item/42", true) === "article");
check("an article wins even if the posts flag was cleared", levelOf("item/42", false) === "article");

// Back is a single pane step, never a jump over one.
check("back from an article closes it", stepBackTarget("article") === "close-article");
check("back from posts returns to feeds", stepBackTarget("posts") === "show-feeds");
check("back from feeds has nowhere to go", stepBackTarget("feeds") === null);

// Walking in and back out visits every level, one at a time. This is the whole
// point of the module: no step may skip a screen.
let level = levelOf(null, false);
const walk = [level];
for (let press = 0; press < 2; press += 1) {
  level = level === "feeds" ? "posts" : "article";
  walk.push(level);
}
for (let press = 0; press < 2; press += 1) {
  const target = stepBackTarget(level);
  level = target === "close-article" ? "posts" : "feeds";
  walk.push(level);
}
check(
  "the walk passes through every level in both directions",
  walk.join(">") === "feeds>posts>article>posts>feeds",
  walk.join(">"),
);

// What the bar says.
check("at feeds it says Feeds", whereLabel("feeds", "Ars", null) === "Feeds");
check("at posts it names the feed", whereLabel("posts", "Ars", null) === "Ars");
check("at an article it names feed and post", whereLabel("article", "Ars", "Big news") === "Ars › Big news");
check("a missing article title falls back to the feed", whereLabel("article", "Ars", null) === "Ars");
check("the back tooltip names the destination", backLabel("article", "Ars") === "Back to Ars");
check("back from posts names the feed list", backLabel("posts", "Ars") === "Back to feeds");
check("back at the root is honest about it", backLabel("feeds", "Ars") === "Already at feeds");

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
