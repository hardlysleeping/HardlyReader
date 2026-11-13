/**
 * `hardlyreader://subscribe?…` — the link the phone's share sheet opens.
 *
 * A URL scheme can be opened by any app on the phone, so the parsing is the
 * boundary: only `http(s)` addresses may reach the Add Feed field, and anything
 * else opens a blank form instead of filling it with whatever was sent.
 */
import assert from "node:assert/strict";
import { parseDeepLink, DEEP_LINK_SCHEME } from "../../src/lib/deep-link.ts";

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok   ${name}`);
}

check("the scheme is the app's name", () => assert.equal(DEEP_LINK_SCHEME, "hardlyreader"));

check("a feed from the share sheet arrives with the form's value", () => {
  const link = parseDeepLink(
    "hardlyreader://subscribe?feed=https%3A%2F%2Fexample.com%2Ffeed.xml&page=https%3A%2F%2Fexample.com%2Fpost&title=Example",
  );
  assert.deepEqual(link, {
    feedUrl: "https://example.com/feed.xml",
    pageUrl: "https://example.com/post",
    title: "Example",
    seed: "https://example.com/feed.xml",
  });
});

check("with no chosen feed, the page is what the field gets", () => {
  const link = parseDeepLink("hardlyreader://subscribe?url=https%3A%2F%2Fexample.com%2F");
  assert.equal(link.seed, "https://example.com/");
  assert.equal(link.feedUrl, null);
});

check("optionally-empty means blank, not broken", () => {
  const link = parseDeepLink("hardlyreader://subscribe");
  assert.deepEqual(link, { feedUrl: null, pageUrl: null, title: null, seed: "" });
});

check("three slashes is the same route", () => {
  assert.equal(parseDeepLink("hardlyreader:///subscribe?feed=https://a.example/f")?.feedUrl, "https://a.example/f");
});

check("another scheme is not ours", () => {
  assert.equal(parseDeepLink("https://example.com/subscribe?feed=x"), null);
  assert.equal(parseDeepLink("hardlyreader://other?feed=https://a.example/f"), null);
});

check("garbage opens nothing at all", () => {
  assert.equal(parseDeepLink(""), null);
  assert.equal(parseDeepLink("   "), null);
  assert.equal(parseDeepLink("not a url"), null);
});

check("a javascript: feed never reaches the field", () => {
  const link = parseDeepLink("hardlyreader://subscribe?feed=javascript%3Aalert(1)");
  assert.equal(link.feedUrl, null);
  assert.equal(link.seed, "", "a refused value leaves a blank form, not a filled one");
});

check("a javascript: feed is dropped, not carried to the field", () => {
  const link = parseDeepLink("hardlyreader://subscribe?feed=javascript%3Aalert(1)&page=https%3A%2F%2Fa.example%2F");
  assert.equal(link.feedUrl, null);
  assert.equal(link.seed, "https://a.example/");
});

check("a file: URL is not a feed either", () => {
  assert.equal(parseDeepLink("hardlyreader://subscribe?feed=file%3A%2F%2F%2Fetc%2Fpasswd").feedUrl, null);
});

check("surrounding whitespace in a value is trimmed, not fatal", () => {
  const link = parseDeepLink("hardlyreader://subscribe?feed=%20https%3A%2F%2Fa.example%2Ff%20");
  assert.equal(link.feedUrl, "https://a.example/f");
});

check("an empty title is no title", () => {
  assert.equal(parseDeepLink("hardlyreader://subscribe?title=%20%20").title, null);
});

check("the feed wins over the page when both are sent", () => {
  const link = parseDeepLink("hardlyreader://subscribe?page=https%3A%2F%2Fb.example%2F&feed=https%3A%2F%2Fa.example%2Ff");
  assert.equal(link.seed, "https://a.example/f");
});

check("feedUrl is accepted as the older spelling", () => {
  assert.equal(parseDeepLink("hardlyreader://subscribe?feedUrl=https%3A%2F%2Fa.example%2Ff").feedUrl, "https://a.example/f");
});

console.log(`\n${checks} deep-link checks passed`);
