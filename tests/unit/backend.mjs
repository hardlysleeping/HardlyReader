/**
 * The seam that makes a second source of articles possible.
 *
 * `GReaderBackend` must be transparent: every method has to produce the request
 * the app produced before it existed — same URL, same method, same body — or the
 * "this changes nothing" claim is false. So this suite is a wire test: a stub
 * transport records what was asked, and each method is checked against the
 * literal request the old call site sent.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/backend.mjs
 */
import { GReaderBackend } from "../../src/api/greader-backend.ts";
import { itemsOf } from "../../src/api/backend.ts";
import { AuthError, STATE_READ, STATE_STARRED } from "../../src/api/freshrss.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

const SESSION = {
  serverUrl: "https://reader.example",
  apiPath: "/api/greader.php",
  email: "someone@example.com",
  token: "SECRET-TOKEN",
};

/** Records every request and answers the few endpoints these methods touch. */
function stubServer() {
  const seen = [];
  const transport = async (url, init = {}) => {
    const method = init.method ?? "GET";
    seen.push({ url, method, body: init.body ?? null, headers: init.headers ?? {} });

    if (url.includes("/reader/api/0/token")) {
      return new Response("write-token", { status: 200 });
    }
    if (url.includes("/subscription/list")) {
      return Response.json({ subscriptions: [{ id: "feed/1", title: "A feed", url: "https://a.test/rss" }] });
    }
    if (url.includes("/tag/list")) {
      return Response.json({ tags: [{ id: "user/-/label/Comics" }] });
    }
    if (url.includes("/unread-count")) {
      return Response.json({ unreadcounts: [{ id: "feed/1", count: 3 }] });
    }
    if (url.includes("/stream/contents/")) {
      return Response.json({ id: "x", items: [{ id: "item-1", title: "One" }] });
    }
    if (url.includes("/user-info")) {
      return Response.json({ userId: "u", userName: "n", userProfileId: "p", userEmail: "e" });
    }
    return new Response("ok", { status: 200 });
  };
  return { transport, seen };
}

const { transport, seen } = stubServer();
const backend = new GReaderBackend(transport, SESSION);
const last = () => seen[seen.length - 1];
const form = (entry) => new URLSearchParams(String(entry.body));

/* ---------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------- */

await (async () => {
  await backend.subscriptions();
  check("subscriptions asks the list endpoint with output=json", () => {
    const url = new URL(last().url);
    if (url.pathname !== "/api/greader.php/reader/api/0/subscription/list") throw new Error(url.pathname);
    if (url.searchParams.get("output") !== "json") throw new Error(url.search);
    if (last().method !== "GET") throw new Error(last().method);
  });

  check("subscriptions sends the stored token as GoogleLogin", () => {
    if (last().headers.Authorization !== "GoogleLogin auth=SECRET-TOKEN") throw new Error(last().headers.Authorization);
  });

  await backend.tags();
  check("tags asks the tag list", () => {
    if (!last().url.endsWith("/reader/api/0/tag/list?output=json")) throw new Error(last().url);
  });

  await backend.unreadCounts();
  check("unread counts asks unread-count", () => {
    if (!last().url.endsWith("/reader/api/0/unread-count?output=json")) throw new Error(last().url);
  });

  await backend.profile();
  check("profile asks user-info", () => {
    if (!last().url.includes("/reader/api/0/user-info")) throw new Error(last().url);
  });

  const page = await backend.stream("user/-/state/com.google/reading-list", { count: 20 });
  check("stream passes the count and keeps the stream id literal", () => {
    const url = new URL(last().url);
    if (!url.pathname.endsWith("/stream/contents/user/-/state/com.google/reading-list")) throw new Error(url.pathname);
    if (url.searchParams.get("n") !== "20") throw new Error(url.search);
  });

  check("stream items come back unchanged", () => {
    if (itemsOf(page).length !== 1 || itemsOf(page)[0].id !== "item-1") throw new Error(JSON.stringify(page));
  });

  await backend.stream("feed/https://a.test/rss", { excludeRead: true });
  check("excludeRead becomes the read-state exclusion", () => {
    const url = new URL(last().url);
    if (url.searchParams.get("xt") !== STATE_READ) throw new Error(url.search);
  });
})();

/* ---------------------------------------------------------------------------
 * Writes: each one is a write-token fetch, then the edit
 * ------------------------------------------------------------------------- */

await (async () => {
  await backend.setRead(["a", "b"], true);
  const tokenCall = seen.find((s) => s.url.includes("/reader/api/0/token"));
  check("marking read fetches a write token first", () => {
    if (!tokenCall) throw new Error("no token request");
  });

  check("marking read posts one edit-tag with both ids and the read tag", () => {
    if (last().method !== "POST") throw new Error(last().method);
    const body = form(last());
    if (body.get("T") !== "write-token") throw new Error(String(body.get("T")));
    if (body.getAll("i").join(",") !== "a,b") throw new Error(body.getAll("i").join(","));
    if (body.getAll("a").join(",") !== STATE_READ) throw new Error("add missing");
    if (body.getAll("r").length !== 0) throw new Error("removed something while marking read");
  });

  await backend.setRead(["c"], false);
  check("marking unread removes the read tag instead of adding it", () => {
    const body = form(last());
    if (body.getAll("r").join(",") !== STATE_READ) throw new Error("remove missing");
    if (body.getAll("a").length !== 0) throw new Error("added something while marking unread");
  });

  await backend.setStarred(["d"], true);
  check("starring adds the starred tag, never the read one", () => {
    const body = form(last());
    if (body.getAll("a").join(",") !== STATE_STARRED) throw new Error(body.getAll("a").join(","));
  });

  await backend.setStarred(["d"], false);
  check("un-starring removes the starred tag", () => {
    if (form(last()).getAll("r").join(",") !== STATE_STARRED) throw new Error("remove missing");
  });

  const before = seen.length;
  await backend.setRead([], true);
  await backend.setStarred([], false);
  check("an empty batch costs no requests", () => {
    if (seen.length !== before) throw new Error(`made ${seen.length - before} requests`);
  });

  await backend.subscribe({ feedUrl: "https://a.test/rss", title: "A feed", category: "Comics" });
  check("subscribe sends ac=subscribe with the feed id, title and label", () => {
    const body = form(last());
    if (body.get("ac") !== "subscribe") throw new Error(String(body.get("ac")));
    if (body.get("s") !== "feed/https://a.test/rss") throw new Error(String(body.get("s")));
    if (body.get("t") !== "A feed") throw new Error(String(body.get("t")));
    if (body.get("a") !== "user/-/label/Comics") throw new Error(String(body.get("a")));
  });

  await backend.unsubscribe("feed/1");
  check("unsubscribe sends ac=unsubscribe with the stream id", () => {
    const body = form(last());
    if (body.get("ac") !== "unsubscribe" || body.get("s") !== "feed/1") throw new Error(body.toString());
  });

  await backend.moveFeed({ streamId: "feed/1", to: "Comics", from: "News" });
  check("a move adds the new label and removes the old one in one request", () => {
    const body = form(last());
    if (body.get("ac") !== "edit") throw new Error(String(body.get("ac")));
    if (body.get("a") !== "user/-/label/Comics") throw new Error(String(body.get("a")));
    if (body.get("r") !== "user/-/label/News") throw new Error(String(body.get("r")));
  });

  await backend.moveFeed({ streamId: "feed/1", to: null, from: "News" });
  check("a move to Uncategorized only removes the old label", () => {
    const body = form(last());
    if (body.has("a")) throw new Error("added a label while uncategorizing");
    if (body.get("r") !== "user/-/label/News") throw new Error(String(body.get("r")));
  });

  await backend.moveFeed({ streamId: "feed/1", to: "News", from: "News" });
  check("a move to the label it is already in does not try to remove it", () => {
    const body = form(last());
    if (body.get("a") !== "user/-/label/News") throw new Error(String(body.get("a")));
    if (body.has("r")) throw new Error(`removed ${body.get("r")}`);
  });
})();

/* ---------------------------------------------------------------------------
 * Errors travel through untouched
 * ------------------------------------------------------------------------- */

await (async () => {
  const rejecting = async (url) => {
    if (url.includes("/token")) return new Response("write-token", { status: 200 });
    return new Response("Unauthorized", { status: 401 });
  };
  const dead = new GReaderBackend(rejecting, SESSION);
  let caught = null;
  try {
    await dead.subscriptions();
  } catch (cause) {
    caught = cause;
  }
  check("a rejected token arrives as AuthError, not a generic failure", () => {
    if (!(caught instanceof AuthError)) throw new Error(String(caught));
  });
})();

console.log(`\n${passed} checks passed`);
