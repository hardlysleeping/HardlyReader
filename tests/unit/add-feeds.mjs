import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addFeedsMessage, isMultiLine, parseFeedUrls } from "../../src/lib/add-feeds.ts";

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok   ${name}`);
}

check("one URL is one URL", () => {
  assert.deepEqual(parseFeedUrls("https://example.com/feed.xml"), ["https://example.com/feed.xml"]);
});

check("a pasted list keeps its order", () => {
  assert.deepEqual(parseFeedUrls("https://a.example/1\nhttps://b.example/2\nhttps://c.example/3"), [
    "https://a.example/1",
    "https://b.example/2",
    "https://c.example/3",
  ]);
});

check("Windows line endings and padding are not URLs", () => {
  assert.deepEqual(parseFeedUrls("  https://a.example/1  \r\n\r\n\thttps://b.example/2\t\r\n"), [
    "https://a.example/1",
    "https://b.example/2",
  ]);
});

check("blank lines and trailing whitespace add nothing", () => {
  assert.deepEqual(parseFeedUrls("\n\n   \n"), []);
  assert.deepEqual(parseFeedUrls(""), []);
});

check("the same feed twice is one subscribe", () => {
  assert.deepEqual(parseFeedUrls("https://a.example/1\nhttps://A.example/1\nhttps://a.example/1"), [
    "https://a.example/1",
  ]);
});

check("the URL is passed through, not repaired", () => {
  // No scheme guessing: FreshRSS decides what it will accept, and a silently
  // rewritten URL is harder to debug than a server error about the original.
  assert.deepEqual(parseFeedUrls("example.com/feed\nfeed://x.example/rss"), [
    "example.com/feed",
    "feed://x.example/rss",
  ]);
});

check("a multi-line paste is what grows the field", () => {
  assert.equal(isMultiLine("https://a.example/1"), false);
  assert.equal(isMultiLine("https://a.example/1\n"), false, "a trailing newline is not a second row");
  assert.equal(isMultiLine("https://a.example/1\nhttps://b.example/2"), true);
});

check("one success says nothing, several say how many", () => {
  assert.equal(addFeedsMessage({ added: ["a"], failed: [] }), null);
  assert.equal(addFeedsMessage({ added: ["a", "b", "c"], failed: [] }), "Added 3 feeds.");
});

check("a lone failure keeps the server's own words", () => {
  assert.equal(
    addFeedsMessage({ added: [], failed: [{ url: "https://a.example/1", error: "This feed already exists." }] }),
    "This feed already exists.",
  );
});

check("a mixed run counts the good ones and names the first failure", () => {
  const message = addFeedsMessage({
    added: ["a", "b"],
    failed: [
      { url: "https://bad.example/1", error: "Could not reach the feed." },
      { url: "https://bad.example/2", error: "Not a feed." },
    ],
  });
  assert.equal(message, "Added 2, 2 feeds failed — https://bad.example/1: Could not reach the feed.");
});

check("nothing at all says nothing", () => {
  assert.equal(addFeedsMessage({ added: [], failed: [] }), null);
});

// The add field is a list, so Enter has to stay a newline: it used to add
// whenever the box held a single feed, which closed the box the moment the first
// URL of a list went in.
const sidebar = readFileSync(new URL("../../src/components/Sidebar.svelte", import.meta.url), "utf8");
check("Enter opens a line, Ctrl/Cmd+Enter is the add", () => {
  assert.match(sidebar, /if \(event\.ctrlKey \|\| event\.metaKey\) \{/);
  // The old rule: a box holding one feed submitted itself and closed.
  assert.doesNotMatch(sidebar, /feedUrl\.includes\("\\n"\)/);
});

check("the field says how it submits", () => {
  assert.match(sidebar, /placeholder="One feed per line — ⌘\/Ctrl\+Enter to add"/);
});

check("a pasted list grows the field", () => {
  assert.match(sidebar, /class:grow=\{feedLines > 1\}/);
  assert.match(sidebar, /const feedLines = \$derived\(parseFeedUrls\(feedUrl\)\.length\);/);
});

// The box grows upward over the feeds and stops at Starred: the height and the
// line limit come from the same arithmetic, because a textarea's scrollHeight
// carries a spare line and would answer "no room" to a single URL.
check("the box is one line tall for one feed, and grows by a line", () => {
  assert.match(sidebar, /const FEED_BOX_FLOOR = 30;/);
  assert.match(sidebar, /const FEED_LINE = 16;/);
  assert.match(sidebar, /return FEED_PAD \+ Math\.max\(1, lines\) \* FEED_LINE;/);
  assert.match(sidebar, /box\.style\.height = `\$\{Math\.min\(feedBoxHeight\(feedTextLines\), cap\)\}px`;/);
  assert.doesNotMatch(sidebar, /Math\.min\(feedBox\.scrollHeight, 128\)/);
});

check("the height stops at the Starred row", () => {
  assert.match(sidebar, /bind:this=\{starredRow\}/);
  assert.match(sidebar, /const star = starredRow\?\.getBoundingClientRect\(\) \?\? null;/);
  // The row is measured by how far down the tree it sits, because the tree
  // clips from the bottom: the last row to go is the one nearest the top.
  assert.match(sidebar, /const depth = star === null \? list\.height \* 0\.4 : star\.bottom - list\.top;/);
  assert.match(sidebar, /box\.style\.maxHeight = `\$\{cap\}px`;/);
});

check("Enter cannot add a line the box has no room to show", () => {
  assert.match(sidebar, /const room = Math\.max\(0, Math\.min\(list\.height - depth - 6, list\.height \* 0\.7\)\);/);
  assert.match(sidebar, /if \(feedTextLines >= feedLineLimit\(Math\.max\(FEED_BOX_FLOOR, feedCap\(\)\)\)\) event\.preventDefault\(\);/);
  assert.match(sidebar, /function feedLineLimit\(cap: number\): number \{/);
  assert.match(sidebar, /return Math\.max\(1, Math\.floor\(\(cap - FEED_PAD\) \/ FEED_LINE\)\);/);
});

check("a long paste stops at the cap and scrolls instead", () => {
  assert.match(sidebar, /overflow-y: auto;/);
  assert.match(sidebar, /Math\.round\(Math\.min\(FEED_BOX_FLOOR \+ room, 360\)\)/);
});

console.log(`\n${checks}/${checks} checks passed`);
