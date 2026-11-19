/**
 * Picking a feed leaves Buzz.
 *
 * Buzz owns pane 2 while it is open, so a feed tap that did not close it left the
 * stories on screen and the chosen feed nowhere — reported on a phone in 2-pane
 * mode, where pane 2 sat on Buzz through every feed tap. Leaving Buzz is one
 * boolean (`buzz.close()`), which is why this is a line in the sidebar's `open`
 * and not a restore path.
 *
 * The behaviour lives in markup, so this suite reads it out of the components.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sidebar = readFileSync(join(root, "src/components/Sidebar.svelte"), "utf8");
const stack = readFileSync(join(root, "src/components/MobilePaneStack.svelte"), "utf8");
const main = readFileSync(join(root, "src/views/Main.svelte"), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const open = sidebar.slice(sidebar.indexOf("async function open(streamId"), sidebar.indexOf("async function open(streamId") + 700);
check("the sidebar's feed tap exists", open.startsWith("async function open("), open.slice(0, 40));
check("a feed tap closes Buzz", /if \(buzz\.active\) buzz\.close\(\);/.test(open));
check("and only then opens the stream", open.indexOf("buzz.close()") < open.indexOf("focused.openStream"));

// It has to be before the await, or the stories stay up through the round trip
// the tap just started.
check("before the stream is opened", open.indexOf("buzz.close()") < open.indexOf("await focused.openStream"));

// Buzz still owns pane 2 while it is open — this fixes the tap, not the mode.
check("pane 2 still draws Buzz while it is open", /\{#if buzz\.active\}\s*<BuzzList \/>/.test(stack));
check("and the posts otherwise", /<ArticleList \/>/.test(stack));
check("the desktop pane does the same", /\{#if buzz\.active\}\s*<BuzzList/.test(main));
// The one-pane walk unfolds the feed where it sits (`toggleFeed`) instead of
// opening the posts pane, and it took the same wrong turn: Buzz stayed up.
const toggle = sidebar.slice(sidebar.indexOf("async function toggleFeed"), sidebar.indexOf("async function toggleFeed") + 700);
check("the unfolding path closes Buzz too", /if \(buzz\.active\) buzz\.close\(\);/.test(toggle));
check("before it opens the stream", toggle.indexOf("buzz.close()") < toggle.indexOf("reader.openStream"));

check("the ⚡ still closes it", /if \(buzz\.active\) \{\s*buzz\.close\(\);\s*return;/.test(sidebar));

if (failures > 0) {
  console.log(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`buzz-leaves: ${checks} checks passed`);
