/**
 * The keys step the cards the same way the wheel does.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/cards-keyboard.mjs
 *
 * In Cards, the post in hand is a card. The key map's Up/Down walk the posts
 * (`lib/keys.ts` -> `reader.stepItem`), and the wheel steps the column
 * (`ArticleList.stepCard`). Those are two different roads to "the next card",
 * and for a long time only one of them moved the column: a key that selected the
 * next post left the column where it was, so the card it had just chosen was
 * wherever the scroll happened to be.
 *
 * What is pinned here is that both roads end in the same placement:
 *
 * 1. There is one placement function, `landOn`/`centreCard`, and both the wheel's
 *    step and the selection effect call it — no second arithmetic for the keys.
 * 2. The selection effect only fires for Cards, only once per selection, and not
 *    while a launch restore is still applying its own offset.
 *
 * No browser and no server: the component is read as source, the way the other
 * Cards suites read it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const articleList = read("src/components/ArticleList.svelte");
const keys = read("src/lib/keys.ts");

/** The body of a top-level `function name(...)` in the component, by brace count. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    else if (source[at] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, at + 1);
    }
  }
  return source.slice(open);
}

/** The step effect: the `$effect` that reads `store.stepSeq`. */
function selectionEffect(source) {
  const marker = "const seq = store.stepSeq;";
  const at = source.indexOf(marker);
  if (at === -1) return "";
  const open = source.lastIndexOf("$effect(() => {", at);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

const effectSource = selectionEffect(articleList);
const stepBody = functionBody(articleList, "stepCard");
const centreBody = functionBody(articleList, "centreCard");
const landBody = functionBody(articleList, "landOn");

// 1. One placement, and it is the wheel's.
check(
  "the wheel's step places its card with landOn",
  /landOn\(target\)/.test(stepBody),
);
check(
  "landOn is centreCard, not a second arithmetic",
  /centreCard\(card\)/.test(landBody) && landBody.split("centreCard").length - 1 === 1,
);
check(
  "centreCard centres against the port's own middle",
  /el\.clientHeight - box\.height\) \/ 2/.test(centreBody),
);
check(
  "a card taller than the pane aligns to its top instead",
  /box\.height > el\.clientHeight \? place/.test(centreBody),
);

// 2. The selection effect exists, and ends in the same placement.
check("there is a step effect", effectSource.length > 0);
check(
  "the step effect places with landOn",
  /landOn\(card\)/.test(effectSource),
);
check(
  "the step effect never restates the centring arithmetic",
  !/clientHeight\s*-\s*box\.height/.test(effectSource) && !/scrollTop\s*=/.test(effectSource),
);
check(
  "the step effect asks the snap state again, like a step",
  /syncSnap\(\)/.test(effectSource),
);
check(
  "a click is not a step: the effect keys on stepSeq, not on selectedId alone",
  /const seq = store\.stepSeq/.test(effectSource) && /seq === lastStep/.test(effectSource),
);

// 3. Its guards: Cards only, once per selection, never during a launch restore.
check("Cards view only", /view !== "cards"/.test(effectSource));
check("once per step", /seq === lastStep/.test(effectSource) && /lastStep = seq/.test(effectSource));
check("a launch restore keeps its own offset", /resumeAt !== null/.test(effectSource));
check(
  "a card already in the middle is not moved under a click",
  /card === currentCard\(\)/.test(effectSource),
);
check(
  "the rows landing re-runs it",
  /void store\.items\.length/.test(effectSource),
);

// 4. The key map itself is unchanged: Up/Down still mean "the post in hand".
check(
  "ArrowDown is a stream step",
  /case "ArrowDown":\s*return \{ type: "stream", delta: 1 \};/.test(keys),
);
check(
  "ArrowUp is a stream step",
  /case "ArrowUp":\s*return \{ type: "stream", delta: -1 \};/.test(keys),
);
check(
  "inside the article pane the arrows scroll the page instead",
  /if \(ctx\.inArticle\) \{[\s\S]*?ArrowDown"\) return \{ type: "scroll"/.test(keys),
);

console.log(`${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
