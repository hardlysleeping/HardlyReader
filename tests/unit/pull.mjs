// Pull-down: the arithmetic, and the three places that listen for it.
//
// The gesture is only ever allowed to mean one thing at a time, so the checks
// that matter are the boundaries: too short does nothing, sideways is somebody
// else's, and pulled from the middle of a page is a scroll.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ARM_PX, MAX_PULL, resist, isArmed, sliderMetrics } from "../../src/lib/pull.ts";

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
  /reading\.advanceOnScroll \? void store\.advanceArticle\(-1\) : onClose\?\.\(\)/.test(readerPane));
check("the article pull says which of the two it will do",
  /Pull down to go back/.test(readerPane) && /Pull down for the previous post/.test(readerPane));
check("advance-on-scroll decides, not the wheel alone",
  /reading\.advanceOnScroll \? "Pull down for the previous post"/.test(readerPane));

// --- the posts: ask the feed for news, keep the list
const articleList = read("src/components/ArticleList.svelte");
check("the posts column listens for a pull", /use:pullDown=\{\{/.test(articleList));
check("the posts pull reloads the stream", /onPull:\s*\(\)\s*=>\s*void store\.reloadStream\(\{\s*force:\s*true\s*\}\)/.test(articleList));
check("the posts pull does not stack up", /enabled:\s*\(\)\s*=>\s*!store\.loadingList/.test(articleList));

// --- one column: the feed list is the feed view
const sidebar = read("src/components/Sidebar.svelte");
check("the feed list listens for a pull", /use:pullDown=\{\{/.test(sidebar));
check("the feed list pull refreshes the open feed", /openStreamId !== ""\)\s*void focused\.reloadStream/.test(sidebar));
check("...and the whole account when none is open", /else void reader\.refresh\(\)/.test(sidebar));

// --- the feed stays unfolded, because the reader took the panel away
const readerStore = read("src/state/reader.svelte.ts");
check("the open feed survives the reader", /expandedFeedId = \$state<string \| null>/.test(readerStore));
check("the sidebar reads it instead of owning it", /const expandedFeed = \$derived\(reader\.expandedFeedId\)/.test(sidebar));

// --- the feedback: a slider that rises from the bottom edge
check("nothing pulled, nothing risen", sliderMetrics(0).rise === 0 && sliderMetrics(0).fill === 0);
check("the first pixel of the drag moves it", sliderMetrics(2).rise > 0 && sliderMetrics(2).rise < 0.1);
check("a full pull is a full capsule", sliderMetrics(MAX_PULL).rise === 1);
check("the capsule finishes filling exactly at the arm point",
  sliderMetrics(ARM_PX).fill === 1 && sliderMetrics(ARM_PX - 1).fill < 1);
check("it cannot overfill beyond that", sliderMetrics(MAX_PULL).fill === 1);
check("the fill and the arm agree, which is what the words say",
  [1, 20, 40, 63, 64, 80, 88].every((px) => sliderMetrics(px).armed === isArmed(px)));
check("nonsense rises nothing", sliderMetrics(NaN).rise === 0 && sliderMetrics(-20).rise === 0);
check("it never exceeds the cap", sliderMetrics(1000).rise === 1 && sliderMetrics(Infinity).rise === 1);

const appCss = read("src/app.css");
check("the feedback is anchored to the bottom edge",
  /\.pull-slider \{[\s\S]{0,400}?bottom: max\(0px, env\(safe-area-inset-bottom\)\);/.test(appCss));
check("and no longer anchored to the top of the window", !/\.pull-slider \{[^}]*\btop:/.test(appCss));
check("it rises out of that edge rather than fading in",
  /transform: translate\(-50%, calc\(\(1 - var\(--rise, 0\)\) \* \(100% \+ 10px\) - 10px\)\);/.test(appCss),
  "the capsule rests clear of the edge instead of being clipped by it");
check("the accent fills it as the pull arms",
  /\.pull-slider \.fill \{[\s\S]{0,160}?transform: scaleX\(var\(--fill, 0\)\);/.test(appCss));
check("it only transitions on the way back, so it tracks the finger",
  /\.pull-slider\.leaving \{[\s\S]{0,80}?transition: transform 200ms ease-out;/.test(appCss) &&
    !/^\.pull-slider \{[^}]*transition:/m.test(appCss));
check("reduced motion has no retraction to animate, and it still leaves",
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,120}?\.pull-slider\.leaving \{[\s\S]{0,40}?transition: none;/.test(appCss) &&
    /retreat = setTimeout\([\s\S]{0,60}?slider\.remove\(\);/.test(read("src/lib/pull.ts")));

// --- the gesture library keeps its promises
const pull = read("src/lib/pull.ts");
check("it only starts at the top", /node\.scrollTop > 0[\s\S]{0,80}return;/.test(pull));
check("it leaves sideways drags alone", /Math\.abs\(dx\) > Math\.abs\(dy\)/.test(pull));
check("it stops the browser's own overscroll", /event\.preventDefault\(\)/.test(pull));
check("it takes its listeners away", /removeEventListener\("touchmove", onMove\)/.test(pull));
check("it puts itself back", /node\.style\.transform = ""/.test(pull));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
