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

// Collapsing is not a crop: one column starts at its first pane, the feeds.
// Shrinking the window while an article was open used to leave that article
// alone on screen — the second pane's content on the surface whose first pane
// is the feeds.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(join(root, "src/views/Main.svelte"), "utf8");
const layout = readFileSync(join(root, "src/state/layout.svelte.ts"), "utf8");

check(
  "landing on one pane closes the article",
  /if \(now === 1\) reader\.closeReader\(\)/.test(main),
);
check(
  "and it is the transition that decides, not the width at render",
  /let drawn = layout\.mode;[\s\S]{0,200}\$effect/.test(main),
);
check("the drawn mode is state, so it can remember what it was", /mode = \$state<PaneMode>\(1\)/.test(layout));
check("a threshold change is banded", /setThreshold[\s\S]{0,1600}this\.settle\(\);/.test(layout));
// The panes are the source of truth: every path that moves one re-derives the
// thresholds, so the settings panel cannot disagree with the layout.
check("a drag re-derives the thresholds", /dragTo\([\s\S]{0,900}this\.syncThresholds\(\);/.test(layout));
check("commit trims the requirement to the window", /commit\(\)[\s\S]{0,300}settleRequirement/.test(layout));
check("the drawn widths come from the panes", /get shown\(\)[\s\S]{0,200}layoutWidths\(this\.panes, this\.mode\)/.test(layout));
check("two and three keep separate posts widths", /this\.mode === 3 \? "list3" : "list2"/.test(layout));
check("only the one-pane width is saved as a threshold", /thresholds: \{ one: this\.thresholds\.one \}/.test(layout));
check("a resize is banded", /setAvailable[\s\S]{0,1200}this\.settle\(\);/.test(layout));
// Except the one resize the user asked for by pressing a mode: that must answer
// at once, or "3" would grow the window and still show two panes.
check(
  "but a resize answering a mode press is not banded",
  /if \(Date\.now\(\) < this\.pressUntil\)[\s\S]{0,300}this\.settle\(false\)/.test(layout),
);
// Armed before the resize travels: the observer can report the new width while
// the call is still in flight, and a banded answer would undo the press.
check(
  "a press arms the answer before the resize is asked for",
  /this\.pressUntil = Date\.now\(\) \+ PRESS_GRACE_MS;[\s\S]{0,700}fitWindowTo\(target\)/.test(layout),
);
// Two presses in flight are answered in order, so the window cannot keep the
// width of a press that was superseded.
check(
  "a press waits for the resize before it",
  /const ask = this\.resizing\.then\(\(\) => fitWindowTo\(target\)\)/.test(layout),
);
// Pane one is one number: the slider writes the sidebar, and the threshold is
// read back from it, so a dragged divider and the settings panel agree.
check(
  "the one-pane threshold comes from the sidebar",
  /thresholdsFor\(this\.panes, this\.device, this\.panes\.sidebar\)/.test(layout),
);
check("a choice is not", /setMode[\s\S]{0,300}this\.settle\(false\);/.test(layout));

// Arrow keys are shaped like the panes: Right goes in a column, Left comes back
// out one, and Up/Down belong to whichever pane is in hand.
check(
  "Left closes the article before it gives up a pane",
  /case "back":[\s\S]{0,700}if \(reader\.back\(\)\) return;/.test(main),
);
check(
  "Left with nothing open drops a column",
  /if \(reader\.back\(\)\) return;[\s\S]{0,700}layout\.collapseOne\(\);/.test(main),
);
check(
  "a column collapse never resizes the window",
  /collapseOne\(\): boolean \{[\s\S]{0,400}this\.setMode/.test(layout) &&
    !/collapseOne\(\): boolean \{[\s\S]{0,400}fitWindowTo/.test(layout),
);
check("Left stops at one pane", /collapseOne\(\): boolean \{[\s\S]{0,200}return false;/.test(layout));
check(
  "Down in the posts pane steps the post, not the feed",
  /case "stream":[\s\S]{0,700}reader\.selectedId !== null[\s\S]{0,200}reader\.stepItem\(intent\.delta\)/.test(main),
);
check("with no post open they still step the feed", /case "stream":[\s\S]{0,1000}reader\.stepStream\(intent\.delta\)/.test(main));

// Pressing 3 from two panes extends the columns on screen; it does not divide
// the window they were already sharing.
check(
  "pressing 3 from two panes extends instead of re-dividing",
  /chooseMode\(mode: PaneMode\)[\s\S]{0,1400}extendToThree\(this\.panes, this\.available/.test(layout),
);
// Only when it has to: a window already wide enough for its three columns keeps
// them, so 2 ↔ 3 does not grow the window a little on every press.
check(
  "and only when the window is too narrow for them",
  /mode === 3 && this\.mode === 2 && this\.available < this\.thresholds\.three/.test(layout),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
