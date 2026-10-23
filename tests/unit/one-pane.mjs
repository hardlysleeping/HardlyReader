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

// One column has two levels. A feed unfolds its posts where it sits, so there is
// no posts screen and nothing may pretend there is one.
check("the feed list is the feeds level", levelOf(null) === "feeds");
check("an open article is the article level", levelOf("item/42") === "article");

// Back is one step, never a jump.
check("back from an article closes it", stepBackTarget("article") === "close-article");
check("back from feeds has nowhere to go", stepBackTarget("feeds") === null);

// Walking in and back out, one level at a time.
let level = levelOf(null);
const walk = [level];
level = levelOf("item/7");
walk.push(level);
for (let press = 0; press < 1; press += 1) {
  level = stepBackTarget(level) === "close-article" ? "feeds" : "feeds";
  walk.push(level);
}
check("the walk is feeds then article then feeds", walk.join(">") === "feeds>article>feeds", walk.join(">"));

// What the bar says.
check("at feeds it says Feeds", whereLabel("feeds", "Ars", null) === "Feeds");
check("at an article it names feed and post", whereLabel("article", "Ars", "Big news") === "Ars › Big news");
check("a missing article title falls back to the feed", whereLabel("article", "Ars", null) === "Ars");
check("the back tooltip names the destination", backLabel("article", "Ars") === "Back to Ars");
check("back at the root is honest about it", backLabel("feeds", "Ars") === "Already at feeds");

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
