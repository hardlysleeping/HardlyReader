// The device's copy comes before the publisher, and an explicit press comes
// before both.
//
// The order inside `extractFor()` is the whole contract: memo → what the device
// kept → the ledger → the network. This suite proves it by counting requests to
// a stub publisher, because a cache that reads but does not stop the fetch saves
// nobody anything, and a cache that stops a fetch the reader asked for turns the
// ¶ button into a lie.
//
// What it cannot prove in Node: the *write* half. A page cannot become an article
// without a DOM, so the body that would be kept is `local-bodies` and
// `body-cache`'s business — here the fake cache's `write` is only checked for
// being offered the body it should be.
import { createServer } from "node:http";

import { extractFor, rememberedExtraction, setExtractionCache } from "../../src/lib/extract.ts";
import { ledger } from "../../src/lib/extract-ledger.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const requests = [];
const ROUTES = {
  "/kept": { status: 200, body: "<html><body><p>short</p></body></html>", type: "text/html" },
  "/refused": { status: 403, body: "no", type: "text/html" },
  "/pressed": { status: 200, body: "<html><body><p>short</p></body></html>", type: "text/html" },
};

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  requests.push(path);
  const route = ROUTES[path];
  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(route.status, {
    "Content-Type": route.type,
    "Content-Length": route.body.length,
    "Cache-Control": "no-store",
  });
  res.end(route.body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** The device's copy, as the pipeline sees it. */
function fakeCache(stored) {
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    cache: {
      read: async (itemId) => {
        reads.push(itemId);
        return stored[itemId] ?? null;
      },
      write: async (itemId, extracted) => {
        writes.push({ itemId, extracted });
      },
    },
  };
}

const keptBody = { html: "<p>The whole article, kept last week.</p>", title: "Kept", byline: "", textLength: 580 };

try {
  // 1. A body the device has is answered without a request at all.
  requests.length = 0;
  const first = fakeCache({ "entry-kept": keptBody });
  setExtractionCache(first.cache);
  const kept = await extractFor("entry-kept", `${origin}/kept`);
  check("a kept body is what comes back", kept && kept.html === keptBody.html, JSON.stringify(kept));
  check("and the publisher was not asked", requests.length === 0, requests.join(","));
  check("a kept body lands in the session memo too", rememberedExtraction("entry-kept")?.html === keptBody.html);

  // 2. The memo comes before the store: a second ask does not even read a row.
  const readsBefore = first.reads.length;
  await extractFor("entry-kept", `${origin}/kept`);
  check("the memo answers before the store is read again", first.reads.length === readsBefore, `${first.reads.length}`);

  // 3. Nothing kept and nothing parked: the page is asked for, once.
  requests.length = 0;
  const second = fakeCache({});
  setExtractionCache(second.cache);
  const refused = await extractFor("entry-refused", `${origin}/refused`);
  check("a page with nothing kept is fetched", requests.join(",") === "/refused", requests.join(","));
  check("a refused page still reads as the feed's text", refused === null);
  check("and the store was asked first", second.reads.join(",") === "entry-refused");

  // 4. An explicit press is "as it is now": the store is skipped and the page is
  //    asked for even though the ledger has just parked it.
  requests.length = 0;
  const third = fakeCache({ "entry-refused": keptBody });
  setExtractionCache(third.cache);
  check("the page is parked after a refusal", ledger.parked(`${origin}/refused`) === true);
  const pressed = await extractFor("entry-refused", `${origin}/refused`, { force: true });
  check("a press does not read the device's copy", third.reads.length === 0, third.reads.join(","));
  check("a press asks the parked page again", requests.join(",") === "/refused", requests.join(","));
  check("and a page that will not parse still ends as the feed's text", pressed === null);

  // 5. A cache that throws on read is a miss, not a broken reader.
  requests.length = 0;
  setExtractionCache({
    read: async () => {
      throw new Error("the store is closed");
    },
    write: async () => {},
  });
  const survived = await extractFor("entry-pressed", `${origin}/pressed`);
  check("a store that throws does not stop the fetch", requests.join(",") === "/pressed", requests.join(","));
  check("and the reader still gets an answer", survived === null);

  // 6. No cache attached — a library on a server — behaves exactly as before.
  requests.length = 0;
  setExtractionCache(null);
  await extractFor("entry-no-cache", `${origin}/kept`);
  check("with no cache attached the page is fetched as it always was", requests.join(",") === "/kept", requests.join(","));
} finally {
  setExtractionCache(null);
  await new Promise((resolve) => server.close(resolve));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
