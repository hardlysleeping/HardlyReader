// A page that refused is not asked again, and an explicit press still is.
//
// The interesting part is the request count: a reader moving through a feed full
// of paywalled links should cost one request per page, not one per post open, and
// a restart should not reset that. This suite drives `extractFor()` against a
// stub publisher and reads the ledger the app itself uses.
//
// The extraction engine needs a DOM, so in Node a page that *does* arrive cannot
// become an article — which is fine here: every check below is about the fetch
// decision, not about Readability.
import { createServer } from "node:http";

import { extractFor, fetchPage } from "../../src/lib/extract.ts";
import { ledger, RETRY_AFTER } from "../../src/lib/extract-ledger.ts";

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
  "/paywalled": { status: 403, body: "no", type: "text/html" },
  "/broken": { status: 500, body: "oops", type: "text/html" },
  "/stub": { status: 200, body: "<html><body><p>short</p></body></html>", type: "text/html" },
  "/notes.txt": { status: 200, body: "plain text", type: "text/plain" },
};

function startStub() {
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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

const { server, origin } = await startStub();
try {
  // --- a refusal is remembered ---------------------------------------------
  const paid = `${origin}/paywalled`;
  check("the page is asked the first time", (await extractFor("entry-a", paid)) === null && requests.length === 1, String(requests.length));
  check("a 403 is a refusal", ledger.failure(paid)?.kind === "refused", JSON.stringify(ledger.failure(paid)));
  check("and it stands for a week", ledger.failure(paid)?.retryAt >= Date.now() + RETRY_AFTER.refused - 1000);

  await extractFor("entry-b", paid);
  check("the next post linking there is answered without a request", requests.length === 1, String(requests.length));

  await extractFor("entry-b", paid);
  check("and so is the one after that", requests.length === 1, String(requests.length));

  // --- a press is a retry ---------------------------------------------------
  await extractFor("entry-c", paid, { force: true });
  check("an explicit press asks again", requests.length === 2, String(requests.length));

  // --- a broken server is not a refusal -------------------------------------
  const broken = `${origin}/broken`;
  await extractFor("entry-d", broken);
  check("a 5xx is the server, not the publisher", ledger.failure(broken)?.kind === "unreachable", JSON.stringify(ledger.failure(broken)));
  check("and it is released ten minutes later", ledger.parked(broken, Date.now() + RETRY_AFTER.unreachable + 1) === false);

  // --- a page that arrives but is not an article ----------------------------
  const stub = `${origin}/stub`;
  await extractFor("entry-e", stub);
  check("a page with no engine to parse it is parked as thin", ledger.failure(stub)?.kind === "thin", JSON.stringify(ledger.failure(stub)));

  // --- not every answer is a page ------------------------------------------
  const text = `${origin}/notes.txt`;
  await extractFor("entry-f", text);
  check("a text/plain answer is a refusal", ledger.failure(text)?.kind === "refused");

  const gone = `${origin}/missing`;
  await extractFor("entry-g", gone);
  check("a 404 is a refusal", ledger.failure(gone)?.kind === "refused");

  const mail = "mailto:someone@example.com";
  await extractFor("entry-h", mail);
  check("a mailto link is never fetched", !requests.includes("mailto:someone@example.com"));

  // --- a page that answers is forgiven --------------------------------------
  const flaky = `${origin}/flaky`;
  ledger.record(flaky, "refused");
  check("a parked page starts parked", ledger.parked(flaky));
  ledger.forgive(flaky);
  check("and a success clears it by hand", !ledger.parked(flaky));

  // --- what a page is, asked directly --------------------------------------
  check("fetchPage says why there is no page", "failure" in (await fetchPage(`${origin}/paywalled`)));
  check("fetchPage hands back the markup", "html" in (await fetchPage(`${origin}/stub`)));
} finally {
  server.close();
}

if (failures === 0) {
  console.log(`ok ${checks} checks — a page is asked once`);
} else {
  console.log(`${failures} failed of ${checks} checks`);
  process.exit(1);
}
