/**
 * Syncing several accounts, where one being down is not the others' problem.
 *
 * A sync button shared by four accounts has one honest summary — "three fetched,
 * this one did not, here is what it said" — and that is what `refreshAll` has to
 * produce. These checks pin the four rules that make it true: every account is
 * asked in Pane 1's order, one at a time; a failure is filed against its account and
 * the rest still run; `flush` is forced because the reason for waiting has changed;
 * and the account the reader is refreshing itself is skipped, so it is not fetched
 * twice and its progress bar keeps one owner.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/refresh-all.mjs
 */
import { AccountAggregate } from "../../src/api/aggregate.ts";
import { AccountRegistry } from "../../src/api/registry.ts";
import { syncProfile } from "../../src/api/profile.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

/** A backend with a crawl, a queue, or neither, recording which was asked and when. */
function backend(log, name, shape = {}) {
  const entry = { name };
  log.push(entry);
  const base = {
    kind: "greader",
    async profile() {
      return { userId: "0", userName: name };
    },
    async subscriptions() {
      return [];
    },
    async tags() {
      return [];
    },
    async unreadCounts() {
      return [];
    },
    async stream(id) {
      return { id, items: [] };
    },
    async setRead() {},
    async setStarred() {},
    async subscribe() {},
    async unsubscribe() {},
    async moveFeed() {},
  };
  if (shape.fetches !== false) {
    base.fetchNew = async (options) => {
      entry.asked = true;
      entry.wake = options?.wake;
      entry.startedAt = Date.now();
      if (shape.fetchFails) throw new Error(shape.fetchFails);
      await new Promise((resolve) => setTimeout(resolve, 5));
      entry.finishedAt = Date.now();
    };
  }
  if (shape.flushes !== false) {
    base.flush = async (force) => {
      entry.asked = true;
      entry.flush = force;
      if (shape.flushFails) throw new Error(shape.flushFails);
      return 0;
    };
  }
  return base;
}

/** Which accounts were actually called — construction alone is not a call. */
function asked(w) {
  return w.log.filter((entry) => entry.asked === true).map((entry) => entry.name);
}

function session(email) {
  return { serverUrl: "https://reader.example", apiPath: "/api/greader.php", email, token: `t-${email}` };
}

/** Three accounts, in the order Pane 1 would draw them. */
function window(shapeFor = {}) {
  const log = [];
  const registry = new AccountRegistry();
  const profiles = ["one@example.com", "two@example.com", "three@example.com"].map((email, index) => {
    const profile = syncProfile(session(email), backend(log, `account-${index + 1}`, shapeFor[email] ?? {}));
    registry.add(profile);
    return profile;
  });
  return { registry, profiles, log, aggregate: new AccountAggregate(registry) };
}

// ——— the ordinary pass ———

{
  const w = window();
  const outcome = await w.aggregate.refreshAll("manual");
  equal("every account is refreshed", outcome.refreshed, w.profiles.map((profile) => profile.slug));
  equal("and every account was actually called", asked(w), ["account-1", "account-2", "account-3"]);
  equal("nothing failed", outcome.failed, []);
  equal("each account was asked to crawl for the same reason", w.log.map((entry) => entry.wake), ["manual", "manual", "manual"]);
  equal("and to send its queue, forcibly", w.log.map((entry) => entry.flush), [true, true, true]);
  check(
    "one account at a time, in the order Pane 1 draws them",
    w.log.every((entry, index) => index === 0 || entry.startedAt >= w.log[index - 1].finishedAt),
    JSON.stringify(w.log.map((entry) => [entry.name, entry.startedAt, entry.finishedAt])),
  );
}

// ——— one account down ———

{
  const w = window({ "two@example.com": { fetchFails: "503 from the server" } });
  const outcome = await w.aggregate.refreshAll("background");
  equal("the accounts that answered are named", outcome.refreshed, [w.profiles[0].slug, w.profiles[2].slug]);
  equal("the one that did not is named with its reason", outcome.failed.map((f) => [f.slug, f.message]), [[w.profiles[1].slug, "503 from the server"]]);
  equal("and the account after it still ran", asked(w), ["account-1", "account-2", "account-3"]);
  check("the failure carried a label to draw", outcome.failed[0].label.length > 0, outcome.failed[0].label);
}

{
  const w = window({ "one@example.com": { flushFails: "401 from the server" } });
  const outcome = await w.aggregate.refreshAll();
  equal("a queue that could not be sent fails that account even though it crawled", outcome.failed.map((f) => f.slug), [w.profiles[0].slug]);
  equal("and the others are unaffected", outcome.refreshed.length, 2);
}

// ——— the account the reader is already refreshing ———

{
  const w = window();
  const outcome = await w.aggregate.refreshAll("manual", { except: w.profiles[1].slug });
  equal("the focused account is left to the reader's own pass", asked(w), ["account-1", "account-3"]);
  equal("and is not reported as refreshed by the fan-out", outcome.refreshed, [w.profiles[0].slug, w.profiles[2].slug]);
  equal("nor as a failure", outcome.failed, []);
}

// ——— accounts with nothing to do ———

{
  // A FreshRSS account: the server crawls, and nothing is queued. Asking it to
  // fetch would be a request that cannot do anything, and counting it as refreshed
  // would claim work that never happened.
  const w = window({ "one@example.com": { fetches: false, flushes: false } });
  const outcome = await w.aggregate.refreshAll();
  equal("an account with neither a crawl nor a queue is not refreshed", outcome.refreshed, [w.profiles[1].slug, w.profiles[2].slug]);
  check("and its backend was not asked anything", asked(w).length === 2, asked(w).join(","));
}

{
  const w = window({ "one@example.com": { fetches: false } });
  const outcome = await w.aggregate.refreshAll();
  equal("an account with only a queue is still refreshed", outcome.refreshed.includes(w.profiles[0].slug), true);
  check("by flushing, not by fetching", w.log[0].asked === true && w.log[0].wake === undefined && w.log[0].flush === true);
}

// ——— turned off is not signed out ———

{
  const w = window();
  w.registry.add({ ...w.profiles[1], enabled: false });
  const outcome = await w.aggregate.refreshAll();
  equal("an account turned off for merged views is not crawled", asked(w), ["account-1", "account-3"]);
  equal("and is not reported at all", [outcome.refreshed.length, outcome.failed.length], [2, 0]);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
