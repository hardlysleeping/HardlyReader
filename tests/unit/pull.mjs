// Pull-down: the arithmetic, and the three places that listen for it.
//
// The gesture is only ever allowed to mean one thing at a time, so the checks
// that matter are the boundaries: too short does nothing, sideways is somebody
// else's, and pulled from the middle of a page is a scroll.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ARM_PX, MAX_PULL, resist, isArmed } from "../../src/lib/pull.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- the pull itself
check("nothing pulled, nothing happens", resist(0) === 0 && resist(-40) === 0);
check("the pull is resisted, not 1:1", resist(100) < 100, String(resist(100)));
check("resistance grows with the drag", resist(90) > resist(60) && resist(60) > resist(30));
check("the pull stops growing", resist(500) === MAX_PULL && resist(1000) === MAX_PULL);
check("a nudge is not a pull", isArmed(resist(80)) === false, String(resist(80)));
check("a deliberate drag arms it", ARM_PX > MAX_PULL * 0.5 && isArmed(ARM_PX) === true);
check("the arm point is reachable within the cap", ARM_PX <= MAX_PULL, `${ARM_PX} vs ${MAX_PULL}`);
check("nonsense in, zero out", resist(NaN) === 0 && resist(Infinity) === MAX_PULL);

// --- the reader: out, not up
const readerPane = read("src/components/ReaderPane.svelte");
check("the article listens for a pull", /use:pullDown=\{\{/.test(readerPane));
check("the article pull leaves when there is nothing higher",
  /reading\.advanceOnScroll \? void reader\.advanceArticle\(-1\) : onClose\?\.\(\)/.test(readerPane));
check("the article pull says which of the two it will do",
  /Pull down to go back/.test(readerPane) && /Pull down for the previous post/.test(readerPane));
check("advance-on-scroll decides, not the wheel alone",
  /reading\.advanceOnScroll \? "Pull down for the previous post"/.test(readerPane));

// --- the posts: ask the feed for news, keep the list
const articleList = read("src/components/ArticleList.svelte");
check("the posts column listens for a pull", /use:pullDown=\{\{/.test(articleList));
check("the posts pull reloads the stream", /onPull:\s*\(\)\s*=>\s*void reader\.reloadStream\(\{\s*force:\s*true\s*\}\)/.test(articleList));
check("the posts pull does not stack up", /enabled:\s*\(\)\s*=>\s*!reader\.loadingList/.test(articleList));

// --- one column: the feed list is the feed view
const sidebar = read("src/components/Sidebar.svelte");
check("the feed list listens for a pull", /use:pullDown=\{\{/.test(sidebar));
check("the feed list pull refreshes the open feed", /reader\.activeStream !== ""\)\s*void reader\.reloadStream/.test(sidebar));
check("...and the whole account when none is open", /else void reader\.refresh\(\)/.test(sidebar));

// --- the feed stays unfolded, because the reader took the panel away
const readerStore = read("src/state/reader.svelte.ts");
check("the open feed survives the reader", /expandedFeedId = \$state<string \| null>/.test(readerStore));
check("the sidebar reads it instead of owning it", /const expandedFeed = \$derived\(reader\.expandedFeedId\)/.test(sidebar));

// --- the gesture library keeps its promises
const pull = read("src/lib/pull.ts");
check("it only starts at the top", /node\.scrollTop > 0[\s\S]{0,80}return;/.test(pull));
check("it leaves sideways drags alone", /Math\.abs\(dx\) > Math\.abs\(dy\)/.test(pull));
check("it stops the browser's own overscroll", /event\.preventDefault\(\)/.test(pull));
check("it takes its listeners away", /removeEventListener\("touchmove", onMove\)/.test(pull));
check("it puts itself back", /node\.style\.transform = ""/.test(pull));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
