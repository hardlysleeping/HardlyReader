/**
 * One implementation of "add these feeds".
 *
 * The sidebar's form, an OPML import and the phone's share sheet all subscribe
 * through `lib/subscribe-feeds`; these checks pin the rules that make a burst
 * safe on FreshRSS and honest in the UI.
 */
import assert from "node:assert/strict";
import { subscribeFeeds } from "../../src/lib/subscribe-feeds.ts";

let checks = 0;
function check(name, fn) {
  return Promise.resolve(fn()).then(() => {
    checks += 1;
    console.log(`  ok   ${name}`);
  });
}

/** A backend that records what it was asked, and fails the URLs it was told to. */
function fakeBackend({ fail = [], fetchNew = true } = {}) {
  const calls = { subscribe: [], fetchNew: 0 };
  const backend = {
    async subscribe(request) {
      calls.subscribe.push(request);
      if (fail.includes(request.feedUrl)) throw new Error("The server said no.");
    },
  };
  if (fetchNew) {
    backend.fetchNew = async (options) => {
      calls.fetchNew += 1;
      calls.wake = options?.wake;
    };
  }
  return { backend, calls };
}

await check("every feed is subscribed, in the order it was given", async () => {
  const { backend, calls } = fakeBackend();
  const result = await subscribeFeeds(backend, [
    { url: "https://a.example/1" },
    { url: "https://b.example/2" },
    { url: "https://c.example/3" },
  ]);
  assert.deepEqual(result.added, ["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(
    calls.subscribe.map((call) => call.feedUrl),
    ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
  );
});

await check("one at a time, never a burst", async () => {
  const seen = [];
  let inFlight = 0;
  let overlap = false;
  const backend = {
    async subscribe(request) {
      inFlight += 1;
      if (inFlight > 1) overlap = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      seen.push(request.feedUrl);
    },
  };
  await subscribeFeeds(backend, [{ url: "a" }, { url: "b" }, { url: "c" }]);
  assert.equal(overlap, false, "subscribes overlapped");
  assert.deepEqual(seen, ["a", "b", "c"]);
});

await check("a failure does not stop the rest", async () => {
  const { backend } = fakeBackend({ fail: ["https://b.example/2"] });
  const result = await subscribeFeeds(backend, [
    { url: "https://a.example/1" },
    { url: "https://b.example/2" },
    { url: "https://c.example/3" },
  ]);
  assert.deepEqual(result.added, ["https://a.example/1", "https://c.example/3"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].url, "https://b.example/2");
  assert.equal(result.failed[0].error, "The server said no.");
});

await check("a non-Error rejection still says something legible", async () => {
  const backend = {
    async subscribe() {
      throw "plain string";
    },
  };
  const result = await subscribeFeeds(backend, [{ url: "https://a.example/1" }]);
  assert.deepEqual(result.failed, [{ url: "https://a.example/1", error: "plain string" }]);
});

await check("title and category travel with the subscribe", async () => {
  const { backend, calls } = fakeBackend();
  await subscribeFeeds(backend, [{ url: "https://a.example/1", title: "News", category: "Tech" }]);
  assert.deepEqual(calls.subscribe[0], { feedUrl: "https://a.example/1", title: "News", category: "Tech" });
});

await check("a local library is fetched once, after the subscribes", async () => {
  const { backend, calls } = fakeBackend();
  await subscribeFeeds(backend, [{ url: "https://a.example/1" }, { url: "https://b.example/2" }]);
  assert.equal(calls.fetchNew, 1);
  assert.equal(calls.wake, "manual");
});

await check("a backend with no crawler is not asked to crawl", async () => {
  const { backend, calls } = fakeBackend({ fetchNew: false });
  const result = await subscribeFeeds(backend, [{ url: "https://a.example/1" }]);
  assert.deepEqual(result.added, ["https://a.example/1"]);
  assert.equal(calls.fetchNew, 0);
});

await check("nothing added means nothing fetched", async () => {
  const { backend, calls } = fakeBackend({ fail: ["https://a.example/1"] });
  await subscribeFeeds(backend, [{ url: "https://a.example/1" }]);
  assert.equal(calls.fetchNew, 0);
});

await check("a failed first fetch is not a failed subscribe", async () => {
  const backend = {
    async subscribe() {},
    async fetchNew() {
      throw new Error("down");
    },
  };
  const result = await subscribeFeeds(backend, [{ url: "https://a.example/1" }]);
  assert.deepEqual(result.added, ["https://a.example/1"]);
  assert.deepEqual(result.failed, []);
});

await check("progress is reported once per attempt", async () => {
  const { backend } = fakeBackend({ fail: ["https://b.example/2"] });
  const seen = [];
  await subscribeFeeds(backend, [{ url: "a" }, { url: "b" }, { url: "c" }], (done, total) => seen.push([done, total]));
  assert.deepEqual(seen, [
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

console.log(`\n${checks} subscribe-feeds checks passed`);
