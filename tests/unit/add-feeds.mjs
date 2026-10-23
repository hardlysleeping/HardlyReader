import assert from "node:assert/strict";
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

console.log(`\n${checks}/${checks} checks passed`);
