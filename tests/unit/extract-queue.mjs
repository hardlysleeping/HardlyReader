/**
 * The posts ahead are prepared in reading order, a couple at a time.
 *
 * The queue's own promises are the test: a page that lands is remembered, a page
 * that refuses is not, and nothing waits on either.
 */
import {
  AHEAD,
  ExtractionQueue,
  candidateFor,
  planQueue,
  wantsPage,
} from "../../src/lib/extract-queue.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const posts = (count, from = 1) =>
  Array.from({ length: count }, (_, index) => ({
    id: `e${from + index}`,
    url: `https://example.com/${from + index}`,
  }));

const ids = (plan) => plan.map((candidate) => candidate.id).join(",");

const wish = (overrides = {}) => ({
  items: posts(6),
  start: 0,
  wanted: () => true,
  ready: () => false,
  parked: () => false,
  ...overrides,
});

// --- what the pane would fetch ---------------------------------------------
check("the switch means every post", wantsPage(null, true));
check("a per-post ask fetches with the switch off", wantsPage("article", false));
check("no ask and the switch off fetches nothing", !wantsPage(null, false));
check("a per-post refusal outranks the switch", !wantsPage("feed", true));
check("and outranks its own absence", !wantsPage("feed", false));

// --- only a page is a candidate --------------------------------------------
check("https is a page", candidateFor("e1", "https://example.com/a").url !== "");
check("http is a page", candidateFor("e1", "http://example.com/a").url !== "");
check("a mailto is not", candidateFor("e1", "mailto:someone@example.com").url === "");
check("an empty link is not", candidateFor("e1", "").url === "");
check("a relative link is not", candidateFor("e1", "/posts/1").url === "");

// --- in reading order, from where the caller says ---------------------------
check("nothing open starts at the top of the list", ids(planQueue(wish())) === "e1,e2,e3");
check("a step starts just past the post in hand", ids(planQueue(wish({ start: 3 }))) === "e4,e5,e6");
check("a position off the list starts at the top", ids(planQueue(wish({ start: -1 }))) === "e1,e2,e3");
check("the end of the list has nothing ahead", planQueue(wish({ start: 6 })).length === 0);
check("a short tail prepares what is there", ids(planQueue(wish({ start: 5 }))) === "e6");
check("the default is three", planQueue(wish()).length === AHEAD);
check("the width is the caller's", ids(planQueue(wish({ start: 1, ahead: 5 }))) === "e2,e3,e4,e5,e6");
check("nothing asked for is nothing fetched", planQueue(wish({ ahead: 0 })).length === 0);

// --- what is skipped does not take a slot ----------------------------------
check("a post with no page is passed over", ids(planQueue(wish({
  start: 0,
  items: [{ id: "e1", url: "" }, { id: "e2", url: "https://example.com/2" }, { id: "e3", url: "" }, { id: "e4", url: "https://example.com/4" }],
}))) === "e2,e4");
check("a post kept on the feed is passed over", ids(planQueue(wish({
  start: 0,
  wanted: (candidate) => candidate.id !== "e3",
}))) === "e1,e2,e4");
check("a page already on hand is passed over", ids(planQueue(wish({
  start: 0,
  ready: (candidate) => candidate.id === "e2",
}))) === "e1,e3,e4");
check("a parked page is passed over", ids(planQueue(wish({
  start: 0,
  parked: (candidate) => candidate.id === "e3",
}))) === "e1,e2,e4");
check("nothing wanted is an empty plan", planQueue(wish({ wanted: () => false })).length === 0);

// --- the queue works through the plan two at a time -------------------------
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

{
  const calls = [];
  const gates = [];
  const queue = new ExtractionQueue(
    {
      extract: (id) => {
        calls.push(id);
        const one = gate();
        gates.push(one);
        return one.promise;
      },
      ready: () => false,
      parked: () => false,
    },
    2,
  );

  queue.setPlan(posts(4));
  check("two go out at once, in order", calls.join(",") === "e1,e2", calls.join(","));
  check("and the rest wait their turn", queue.waiting === 2, `${queue.waiting}`);
  check("nothing is busy before a page lands", queue.busy === 2, `${queue.busy}`);

  gates[0].open({ html: "a" });
  await settled();
  check("a page landing starts the next one", calls.join(",") === "e1,e2,e3", calls.join(","));
  check("and never more than the cap", queue.busy === 2, `${queue.busy}`);

  gates[1].open({ html: "b" });
  gates[2].open({ html: "c" });
  await settled();
  check("the plan is worked through", calls.join(",") === "e1,e2,e3,e4", calls.join(","));

  gates[3].open({ html: "d" });
  await settled();
  check("and then the queue is empty", queue.busy === 0 && queue.waiting === 0);

  // A post already prepared is not fetched a second time: the memo holds four
  // extractions and a cursor that moves back and forth would walk past them.
  calls.length = 0;
  queue.setPlan(posts(4));
  check("a prepared post is not prepared again", calls.length === 0, calls.join(","));
}

// --- a page that fails is asked for again, a page that lands is not ---------
{
  const calls = [];
  const queue = new ExtractionQueue({
    extract: async (id) => {
      calls.push(id);
      return id === "e2" ? null : { html: id };
    },
    ready: () => false,
    parked: () => false,
  });

  queue.setPlan([{ id: "e2", url: "https://example.com/2" }]);
  await settled();
  check("a refusal is not a page", queue.busy === 0);

  queue.setPlan([{ id: "e2", url: "https://example.com/2" }]);
  await settled();
  check("so it is planned again later", calls.join(",") === "e2,e2", calls.join(","));
}

// --- a new plan replaces the old one ---------------------------------------
{
  const calls = [];
  const gates = [];
  const queue = new ExtractionQueue(
    {
      extract: (id) => {
        calls.push(id);
        const one = gate();
        gates.push(one);
        return one.promise;
      },
      ready: () => false,
      parked: () => false,
    },
    1,
  );

  queue.setPlan(posts(3));
  check("the first post of the plan goes out", calls.join(",") === "e1", calls.join(","));
  check("with the rest behind it", queue.waiting === 2, `${queue.waiting}`);
  // The reader stepped somewhere else: the posts behind are no longer wanted,
  // but the one already on its way is not recalled.
  queue.setPlan(posts(3, 7));
  check("the plan is the new place's", queue.waiting === 3, `${queue.waiting}`);
  check("and the one in hand is left alone", calls.join(",") === "e1", calls.join(","));
  check("which the pane can still wait on", queue.pending("e1") !== null);
  check("nothing is pending for a post that is not out", queue.pending("e7") === null);

  gates[0].open({ html: "a" });
  await settled();
  check(
    "a post the reader walked away from is never fetched",
    calls.join(",") === "e1,e7",
    calls.join(","),
  );
}

// --- a runner that throws is a page that did not arrive --------------------
{
  const calls = [];
  const queue = new ExtractionQueue({
    extract: async (id) => {
      calls.push(id);
      if (id === "e1") throw new Error("no");
      return { html: id };
    },
    ready: () => false,
    parked: () => false,
  });

  queue.setPlan(posts(2));
  await settled();
  await settled();
  check("a thrown fetch does not stop the queue", calls.join(",") === "e1,e2", calls.join(","));
  check("and the queue drains", queue.busy === 0 && queue.waiting === 0);
}

// --- the one call the app makes -------------------------------------------
{
  const calls = [];
  const queue = new ExtractionQueue({
    extract: async (id) => {
      calls.push(id);
      return { html: id };
    },
    ready: (id) => id === "e2",
    parked: (url) => url.endsWith("/3"),
  });

  queue.prepare(posts(6), 0, (candidate) => candidate.id !== "e4");
  await settled();
  check("a page on hand is not prepared", !calls.includes("e2"), calls.join(","));
  check("a parked page is not asked for again", !calls.includes("e3"), calls.join(","));
  check("a post the pane would not fetch is skipped", !calls.includes("e4"), calls.join(","));
  check("and the rest go, in reading order", calls.join(",") === "e1,e5,e6", calls.join(","));
}

if (failures === 0) {
  console.log(`ok ${checks} checks — the posts ahead`);
} else {
  console.log(`${failures} failed of ${checks} checks`);
  process.exit(1);
}
