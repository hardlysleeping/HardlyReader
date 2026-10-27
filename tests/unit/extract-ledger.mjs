// The extractor's memory: parked pages, and what the reader chose per article.
//
// These checks are about the two things a click cannot show — that a page which
// refused is not requested again until its retry time, and that a per-article
// choice survives a relaunch without leaking into another account.
import {
  EXTRACT_LEDGER_KEY,
  RETRY_AFTER,
  createExtractLedger,
} from "../../src/lib/extract-ledger.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A `localStorage` stand-in: one Map, plus the ability to survive a "relaunch". */
function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// --- the retry times themselves --------------------------------------------

check("a timeout is retried soon", RETRY_AFTER.unreachable === 10 * MINUTE);
check("a refusal stands for a week", RETRY_AFTER.refused === 7 * DAY);
check("a thin extraction stands for a day", RETRY_AFTER.thin === 24 * HOUR);
check(
  "a refusal outlasts a timeout, and a thin page sits between them",
  RETRY_AFTER.refused > RETRY_AFTER.thin && RETRY_AFTER.thin > RETRY_AFTER.unreachable,
);

// --- parking a page --------------------------------------------------------

const store = fakeStorage();
const ledger = createExtractLedger({ storage: store, account: null });
const url = "https://pub.example/post";
const t0 = 1_800_000_000_000;

check("nothing is parked to begin with", !ledger.parked(url, t0));
check("and no failure is remembered", ledger.failure(url, t0) === null);

ledger.record(url, "refused", t0);
check("a refusal parks the page", ledger.parked(url, t0));
check("the reason is kept", ledger.failure(url, t0)?.kind === "refused");
check("the retry time is the refusal's", ledger.failure(url, t0)?.retryAt === t0 + 7 * DAY);

check("still parked a second later", ledger.parked(url, t0 + 1_000));
check("still parked an hour later", ledger.parked(url, t0 + HOUR));
check("still parked six days later", ledger.parked(url, t0 + 6 * DAY));
check("free again after the week", !ledger.parked(url, t0 + 7 * DAY));
check("and the failure is gone, not merely ignored", ledger.failure(url, t0 + 7 * DAY) === null);

// A page that fails differently replaces the record rather than stacking one.
ledger.record(url, "unreachable", t0 + 8 * DAY);
check("the newest reason wins", ledger.failure(url, t0 + 8 * DAY)?.kind === "unreachable");
check("a timeout is released after ten minutes", !ledger.parked(url, t0 + 8 * DAY + 10 * MINUTE));

// A page that answers again is forgotten entirely.
ledger.record(url, "refused", t0);
ledger.forgive(url);
check("forgiving a page unparks it at once", !ledger.parked(url, t0 + 1));

// Only parked URLs are parked: the neighbouring post is untouched.
ledger.record("https://pub.example/one", "refused", t0);
check("another post is still worth asking", !ledger.parked("https://pub.example/two", t0));

// --- what survives a relaunch ----------------------------------------------

ledger.record(url, "thin", t0);
const relaunched = createExtractLedger({ storage: store, account: null });
check("a parked page is still parked after a relaunch", relaunched.parked(url, t0 + HOUR));
check("and its reason came back", relaunched.failure(url, t0 + HOUR)?.kind === "thin");

// --- the per-article choice ------------------------------------------------

check("a post starts with no choice", ledger.choice("entry-1") === null);
ledger.remember("entry-1", "article", t0);
ledger.remember("entry-2", "feed", t0);
check("the article choice is remembered", ledger.choice("entry-1") === "article");
check("the feed choice is remembered too", ledger.choice("entry-2") === "feed");
check("a choice is per entry, not per feed", ledger.choice("entry-3") === null);

const afterRestart = createExtractLedger({ storage: store, account: null });
check("a choice survives a relaunch", afterRestart.choice("entry-2") === "feed");

ledger.forget("entry-1");
check("forgetting a choice is how 'automatic' comes back", ledger.choice("entry-1") === null);
check("and the other post keeps its own", ledger.choice("entry-2") === "feed");

// --- two accounts on one device -------------------------------------------

const shared = fakeStorage();
const alice = createExtractLedger({
  storage: shared,
  account: { serverUrl: "https://rss.example", email: "alice@example.com" },
});
const bob = createExtractLedger({
  storage: shared,
  account: { serverUrl: "https://rss.example", email: "bob@example.com" },
});
alice.remember("1", "feed", t0);
check("one account's choice is its own", alice.choice("1") === "feed");
check("the other account does not inherit it", bob.choice("1") === null);
check(
  "and the address is not in a key",
  [...shared.data.keys()].every((key) => !key.includes("alice") && !key.includes("rss.example")),
  [...shared.data.keys()].join(", "),
);
check("the key is the documented one", [...shared.data.keys()].every((key) => key.startsWith(EXTRACT_LEDGER_KEY)));

// The account is resolved per call, so a ledger made before sign-in answers for
// the account signed in at the time of the call — not the one it was made for.
const who = { account: null };
const perCall = createExtractLedger({
  storage: shared,
  get account() {
    return who.account;
  },
});
who.account = { serverUrl: "https://rss.example", email: "carol@example.com" };
perCall.remember("9", "article", t0);
who.account = { serverUrl: "https://rss.example", email: "dave@example.com" };
check("a switched account starts clean", perCall.choice("9") === null);

// --- a store that is full, corrupt or absent ------------------------------

const broken = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};
const blocked = createExtractLedger({ storage: broken, account: null });
let threw = false;
try {
  blocked.record(url, "refused", t0);
} catch {
  threw = true;
}
check("a blocked store throws nothing", !threw);
check("a page it cannot store is not claimed to be parked", !blocked.parked(url, t0));
check("and no choice is invented", blocked.choice("entry-1") === null);

const corrupt = fakeStorage();
corrupt.setItem(EXTRACT_LEDGER_KEY, "{not json");
const recovered = createExtractLedger({ storage: corrupt, account: null });
check("corrupt JSON reads as an empty ledger", !recovered.parked(url, t0) && recovered.choice("x") === null);

const foreign = fakeStorage();
foreign.setItem(
  EXTRACT_LEDGER_KEY,
  JSON.stringify({
    failures: { [url]: { kind: "later", at: t0, retryAt: t0 + DAY }, ok: { kind: "refused" } },
    choices: { a: { choice: "maybe" }, b: { choice: "feed", at: t0 } },
  }),
);
const cleaned = createExtractLedger({ storage: foreign, account: null });
check("an unknown reason is not trusted", cleaned.failure(url, t0) === null);
check("a record without times is not trusted", cleaned.failure("ok", t0) === null);
check("an unknown choice is not trusted", cleaned.choice("a") === null);
check("a valid one beside it still is", cleaned.choice("b") === "feed");

// No storage at all is still a working ledger for this process, and remembers
// nothing beyond it.
const memoryOnly = createExtractLedger({ storage: null, account: null });
memoryOnly.record("https://pub.example/memory", "refused", t0);
check("no storage still parks for this session", memoryOnly.parked("https://pub.example/memory", t0));

// --- the caps -------------------------------------------------------------

const capped = fakeStorage();
const many = createExtractLedger({ storage: capped, account: null });
for (let index = 0; index < 260; index += 1) {
  many.record(`https://pub.example/${index}`, "refused", t0 + index);
}
const kept = JSON.parse(capped.getItem(EXTRACT_LEDGER_KEY)).failures;
check("the failure list is capped", Object.keys(kept).length === 200, String(Object.keys(kept).length));
check("the newest are the ones kept", kept["https://pub.example/259"] !== undefined);
check("the oldest are the ones dropped", kept["https://pub.example/0"] === undefined);

for (let index = 0; index < 520; index += 1) {
  many.remember(`entry-${index}`, "feed", t0 + index);
}
const choices = JSON.parse(capped.getItem(EXTRACT_LEDGER_KEY)).choices;
check("the choice list is capped", Object.keys(choices).length === 500, String(Object.keys(choices).length));
check("the newest choice is kept", choices["entry-519"] !== undefined);
check("the oldest choice is dropped", choices["entry-0"] === undefined);

// Expired failures are not written back for ever: the blob stays small.
for (let index = 0; index < 20; index += 1) {
  many.record(`https://old.example/${index}`, "unreachable", t0);
}
many.record("https://new.example/1", "refused", t0 + 2 * DAY);
const after = JSON.parse(capped.getItem(EXTRACT_LEDGER_KEY)).failures;
check(
  "expired failures are dropped on the next write",
  Object.keys(after).every((key) => !key.startsWith("https://old.example/")),
  Object.keys(after).slice(0, 4).join(", "),
);

if (failures === 0) {
  console.log(`ok ${checks} checks — the extractor's memory`);
} else {
  console.log(`${failures} failed of ${checks} checks`);
  process.exit(1);
}
