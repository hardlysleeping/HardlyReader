/**
 * The inbox: the two calls, and the state a screen draws.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/inbox.mjs
 *
 * What is load-bearing here:
 *
 *   - **A message is one app's.** Every call names the app, and the reader only
 *     ever names its own.
 *   - **"Nothing to read" and "could not ask" are different answers.** A failed
 *     fetch with no cached copy is `failed` with a reason, never an empty
 *     `ready`; a cached copy is drawn with the sentence that says it is the last
 *     one this device saw.
 *   - **Read is local first.** Opening the list clears the count under the
 *     finger, and the server records the same ids afterwards; a refused record
 *     does not un-read words the reader has already seen.
 *   - **One account's list never draws for another.** The cache is keyed by user
 *     id, in the key and in the value.
 *
 * The server here is a recorded `fetch`: no project, no token, no network.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compileModule } from "svelte/compiler";
import ts from "typescript";

import { GEN_DIR, ROOT, absolute } from "./build-reader.mjs";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* --------------------------------------------------------------------------
 * The state module, compiled the way the other runes suites compile theirs
 * ----------------------------------------------------------------------- */

function buildInboxModule() {
  const file = join(ROOT, "src/state/inbox.svelte.ts");
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "inbox.svelte.ts",
  });
  const compiled = compileModule(outputText, { generate: "client", filename: "inbox.svelte.ts" });
  // The generated file lives in `tests/unit/.gen-<pid>`, so its relative imports
  // would resolve beside it rather than beside `src/state/`. Point them at home.
  const code = compiled.js.code
    .replaceAll('"../api/identity"', JSON.stringify(absolute("src/api/identity.ts")))
    .replaceAll('"../api/messages"', JSON.stringify(absolute("src/api/messages.ts")));
  mkdirSync(GEN_DIR, { recursive: true });
  const out = join(GEN_DIR, "inbox.mjs");
  writeFileSync(out, code);
  return pathToFileURL(out).href;
}

const { Inbox, INBOX_CACHE_PREFIX } = await import(buildInboxModule());
const { INBOX_APP, listMessages, markRead } = await import(pathToFileURL(join(ROOT, "src/api/messages.ts")).href);

const PROJECT = { url: "https://project.test/", anonKey: "anon-key" };
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

/** A row as PostgREST sends it. */
function row(id, title, publishedAt, readAt = null) {
  return {
    id,
    app: INBOX_APP,
    title,
    body: `Body of ${title}.`,
    published_at: new Date(publishedAt).toISOString(),
    read_at: readAt === null ? null : new Date(readAt).toISOString(),
  };
}

/** A recorded server: one answer, and the calls that asked for it. */
function server(answer, { ok = true, status = 200 } = {}) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
    if (answer === "throw") throw new TypeError("network down");
    const body = typeof answer === "function" ? answer(calls.length) : answer;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, request };
}

/** The device's storage, in memory. */
function keys(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* --------------------------------------------------------------------------
 * 1. The calls
 * ----------------------------------------------------------------------- */

{
  const seen = server([row("a", "Hello", NOW), row("b", "Again", NOW - DAY, NOW - 1000)]);
  const answer = await listMessages({
    url: PROJECT.url,
    anonKey: PROJECT.anonKey,
    token: "token-1",
    request: seen.request,
  });
  check("the list is one RPC call", seen.calls.length === 1);
  check(
    "and it asks for this app, by name",
    seen.calls[0]?.url === "https://project.test/rest/v1/rpc/my_app_messages" &&
      seen.calls[0]?.body?.p_app === INBOX_APP,
    seen.calls[0]?.url,
  );
  check(
    "with the account's own token, never the anon key alone",
    seen.calls[0]?.init.headers.Authorization === "Bearer token-1" &&
      seen.calls[0]?.init.headers.apikey === "anon-key",
  );
  check("a message arrives with its time in milliseconds", answer.ok === true && answer.messages[0]?.publishedAt === NOW);
  check("and read state as null-or-a-date", answer.ok === true && answer.messages[0]?.readAt === null && answer.messages[1]?.readAt === NOW - 1000);
}

{
  const seen = server([{ id: "a", title: "  ", body: "x", published_at: null }]);
  const answer = await listMessages({ ...PROJECT, token: "t", request: seen.request });
  check("a row with nothing to draw is dropped, not drawn empty", answer.ok === true && answer.messages.length === 0);
}

{
  const seen = server({ message: "boom" }, { ok: false, status: 500 });
  const answer = await listMessages({ ...PROJECT, token: "t", request: seen.request });
  check("a 500 is a sentence, not an empty inbox", answer.ok === false && answer.reason.includes("500"), answer.reason);
}

{
  const seen = server({}, { ok: false, status: 401 });
  const answer = await listMessages({ ...PROJECT, token: "t", request: seen.request });
  check("an expired token says so", answer.ok === false && answer.reason.includes("sign-in has expired"), answer.reason);
}

{
  const seen = server("throw");
  const answer = await listMessages({ ...PROJECT, token: "t", request: seen.request });
  check("no network is its own sentence", answer.ok === false && answer.reason.includes("did not answer"), answer.reason);
}

{
  const seen = server([]);
  check("marking nothing read asks the server nothing", (await markRead({ ...PROJECT, token: "t", request: seen.request }, [])) === true && seen.calls.length === 0);
  const answered = await markRead({ ...PROJECT, token: "t", request: seen.request }, ["a", "b"]);
  check(
    "marking read posts the ids under this app",
    answered === true && seen.calls[0]?.body?.p_app === INBOX_APP && seen.calls[0]?.body?.p_messages.join(",") === "a,b",
  );
}

/* --------------------------------------------------------------------------
 * 2. The state a screen draws
 * ----------------------------------------------------------------------- */

{
  const seen = server([]);
  const inbox = new Inbox({
    identity: { userId: null, token: null },
    server: () => PROJECT,
    request: seen.request,
    storage: keys(),
    now: () => NOW,
  });
  await inbox.load();
  check("a signed-out device has no inbox", inbox.messages.length === 0 && inbox.status === "ready");
  check("and asks the server nothing", seen.calls.length === 0);
  check("so nothing is offered as unread", inbox.unread === 0);
}

{
  const seen = server([row("a", "Outage", NOW), row("b", "Upgrade", NOW - DAY)]);
  const storage = keys();
  const inbox = new Inbox({
    identity: { userId: USER, token: "t" },
    server: () => PROJECT,
    request: seen.request,
    storage,
    now: () => NOW,
  });
  await inbox.load();
  check("a signed-in device gets its list", inbox.messages.length === 2 && inbox.status === "ready");
  check("newest first", inbox.messages[0]?.title === "Outage");
  check("and both count as unread", inbox.unread === 2);
  check("the list is kept for this account", storage.getItem(`${INBOX_CACHE_PREFIX}.${USER}`) !== null);

  const offline = new Inbox({
    identity: { userId: USER, token: "t" },
    server: () => PROJECT,
    request: server("throw").request,
    storage,
    now: () => NOW,
  });
  await offline.load();
  check("offline still draws the last copy", offline.messages.length === 2 && offline.status === "ready");
  check("and says it is the last copy", offline.reason !== null && offline.reason.includes("last"), offline.reason);
}

{
  const empty = new Inbox({
    identity: { userId: OTHER, token: "t" },
    server: () => PROJECT,
    request: server("throw").request,
    storage: keys({ [`${INBOX_CACHE_PREFIX}.${USER}`]: JSON.stringify({ userId: USER, messages: [row("a", "Theirs", NOW)] }) }),
    now: () => NOW,
  });
  await empty.load();
  check("another account's cache is never drawn", empty.messages.length === 0);
  check("and a failure with nothing cached is a failure, not an empty inbox", empty.status === "failed" && empty.reason !== null, empty.reason);
}

{
  const seen = server([row("a", "Outage", NOW), row("b", "Upgrade", NOW - DAY)]);
  const inbox = new Inbox({
    identity: { userId: USER, token: "t" },
    server: () => PROJECT,
    request: seen.request,
    storage: keys(),
    now: () => NOW,
  });
  await inbox.load();
  const before = seen.calls.length;
  await inbox.readAll();
  check("reading marks everything locally", inbox.unread === 0);
  check(
    "and records the same ids on the server",
    seen.calls.length === before + 1 &&
      seen.calls.at(-1)?.url.endsWith("/rpc/mark_app_messages_read") &&
      seen.calls.at(-1)?.body?.p_messages.join(",") === "a,b",
  );
  check("the first read is the time it says", inbox.messages[0]?.readAt === NOW);
}

{
  const seen = server((call) => (call === 1 ? [row("a", "Outage", NOW)] : null), { ok: true });
  // The second call is the read marker, which the server refuses.
  const request = async (url, init) => {
    if (String(url).includes("mark_app_messages_read")) {
      seen.calls.push({ url, init, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 500 });
    }
    return seen.request(url, init);
  };
  const inbox = new Inbox({
    identity: { userId: USER, token: "t" },
    server: () => PROJECT,
    request,
    storage: keys(),
    now: () => NOW,
  });
  await inbox.load();
  await inbox.readAll();
  check("a refused record still leaves the words read here", inbox.unread === 0);
  await settle();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
