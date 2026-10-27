/**
 * iOS background refresh: the Swift half must not become a second policy.
 *
 * The app's poller is `src/api/local/refresh.ts`, and the background task is a
 * port of it in Swift because iOS wakes the process, not the webview. A port
 * can drift, and drift here is expensive: a different interval means feeds
 * fetched twice or not at all, a different id spelling means every article
 * stored twice, and a different task identifier means a launch handler that is
 * never called, with no error anywhere.
 *
 * So this suite holds the two sides together without a Mac:
 *
 * - the policy numbers, the accept header and the conditional-request headers
 *   are compared against `refresh.ts` itself (imported, not copied);
 * - the task identifier is compared across the four places it is spelled:
 *   `tauri.conf.json`, the Swift, the Objective-C `+load`, and the Info.plist
 *   fragment Tauri merges into the generated project;
 * - the Swift SQL names every column `schema.ts` declares, so a column added on
 *   one side cannot be silently missing on the other;
 * - the things a wake must do — complete exactly once, reschedule, never keep
 *   a timer — are looked for in the source, because they cannot be run here.
 *
 * The behavioural checks are in `src-tauri/ios/Checks/Checks.swift`, which runs
 * the ported code against a real SQLite file on any machine with Swift
 * (`scripts/ios-refresh-checks.sh`).
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/ios-background-refresh.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REFRESH_POLICY } from "../../src/api/local/refresh.ts";
import { TABLES } from "../../src/api/local/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

function fail(message) {
  throw new Error(message);
}

function equal(actual, expected, what) {
  if (actual !== expected) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function read(path) {
  const full = join(root, path);
  if (!existsSync(full)) fail(`${path} is missing`);
  return readFileSync(full, "utf8");
}

function number(source, pattern, what) {
  const match = pattern.exec(source);
  if (match === null) fail(`could not find ${what}`);
  return Number(match[1].replace(/_/g, ""));
}

function text(source, pattern, what) {
  const match = pattern.exec(source);
  if (match === null) fail(`could not find ${what}`);
  return match[1];
}

const refresh = read("src/api/local/refresh.ts");
const policy = read("src-tauri/ios/RefreshPolicy.swift");
const refresher = read("src-tauri/ios/BackgroundRefresher.swift");
const library = read("src-tauri/ios/LocalLibrary.swift");
const task = read("src-tauri/ios/AppRefreshTask.swift");
const hook = read("src-tauri/ios/AppRefreshTaskHook.m");
const plist = read("src-tauri/Info.ios.plist");
const wiring = read("scripts/ios-background-refresh.sh");
const ci = read("codemagic.yaml");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));

// --- The numbers, from the JS side, which is the one that already shipped ---

check("the interval is the same hour", () => {
  equal(
    number(policy, /intervalMinutes = ([\d_]+)/, "the Swift interval"),
    REFRESH_POLICY.intervalMinutes,
    "the interval",
  );
});

check("a wake is bounded at the same six feeds", () => {
  equal(
    number(policy, /maxFeedsPerWake = ([\d_]+)/, "the Swift cap"),
    REFRESH_POLICY.maxFeedsPerWake,
    "the per-wake cap",
  );
});

check("the backoff is capped at the same six hours", () => {
  equal(
    number(policy, /maxBackoffMinutes = ([\d_]+)/, "the Swift cap"),
    REFRESH_POLICY.maxBackoffMinutes,
    "the backoff cap",
  );
});

check("an attempt has the same fifteen seconds", () => {
  equal(
    number(policy, /timeoutMs = ([\d_]+)/, "the Swift timeout"),
    REFRESH_POLICY.timeoutMs,
    "the timeout",
  );
});

check("the same number of doublings before the cap", () => {
  equal(
    number(policy, /maxDoublings = ([\d_]+)/, "the Swift doublings"),
    number(refresh, /const MAX_DOUBLINGS = (\d+)/, "MAX_DOUBLINGS"),
    "the doublings",
  );
});

check("both sides bound the wake the same way", () => {
  const js = /slice\(0, Math\.max\(0, policy\.maxFeedsPerWake\)\)/.test(refresh);
  const swift = /prefix\(max\(0, RefreshPolicy\.maxFeedsPerWake\)\)/.test(policy);
  if (!js || !swift) fail(`the cap is applied in js=${js} swift=${swift}`);
});

check("both sides measure the due time from the later of the two", () => {
  const js = /Math\.max\(feed\.fetched_at \?\? 0, feed\.attempted_at \?\? 0\)/.test(refresh);
  const swift = /max\(feed\.fetchedAt \?\? 0, feed\.attemptedAt \?\? 0\)/.test(policy);
  if (!js || !swift) fail(`the due time is measured in js=${js} swift=${swift}`);
});

// --- One set of request headers ---

check("the same accept header", () => {
  const js = text(refresh, /accept: "([^"]+)"/, "the JS accept header");
  const swift = text(refresher, /"accept": "([^"]+)"/, "the Swift accept header");
  equal(swift, js, "the accept header");
});

check("the same conditional headers", () => {
  for (const name of ["if-none-match", "if-modified-since"]) {
    if (!refresh.includes(name)) fail(`refresh.ts no longer sends ${name}`);
    if (!refresher.includes(name)) fail(`BackgroundRefresher.swift does not send ${name}`);
  }
});

// --- The identifier, in all four places it is spelled ---

const expected = `${config.identifier}.refresh`;

check("the task identifier is the bundle's", () => {
  equal(expected, "ing.hardlysleep.hardlyreader.refresh", "the bundle identifier");
});

check("the Swift and the plist agree on the identifier", () => {
  equal(text(task, /identifier = "([^"]+)"/, "the Swift identifier"), expected, "the Swift identifier");
});

check("the +load hook registers the same identifier", () => {
  equal(
    text(hook, /HRRefreshTaskIdentifier = @"([^"]+)"/, "the Objective-C identifier"),
    expected,
    "the Objective-C identifier",
  );
});

check("Info.plist permits the same identifier", () => {
  const permitted = /<key>BGTaskSchedulerPermittedIdentifiers<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(
    plist,
  );
  if (permitted === null) fail("BGTaskSchedulerPermittedIdentifiers is not in Info.ios.plist");
  equal(permitted[1], expected, "the permitted identifier");
});

check("Info.plist declares the fetch background mode", () => {
  const modes = /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (modes === null) fail("UIBackgroundModes is not in Info.ios.plist");
  if (!modes[1].includes("<string>fetch</string>")) fail("UIBackgroundModes does not include fetch");
});

// --- Completing, rescheduling, and not being a schedule ---

check("the task is registered before launch, in Objective-C", () => {
  if (!/\+ \(void\)load/.test(hook)) fail("the hook has no +load");
  if (!hook.includes("registerForTaskWithIdentifier")) fail("the hook does not register the task");
  if (!hook.includes("hardlyreader_app_refresh_handle")) fail("the launch handler does not reach Swift");
  if (task.includes("registerForTaskWithIdentifier")) fail("registration moved into Swift, where +load cannot reach it");
});

check("setTaskCompleted is called on the success path and the failure path", () => {
  if (!task.includes("setTaskCompleted(success: success)")) fail("the work does not complete the task");
  if (!task.includes("setTaskCompleted(success: false)")) fail("the early return does not complete the task");
});

check("the deadline completes the task too", () => {
  if (!task.includes("expirationHandler")) fail("no expiration handler");
  const handler = /expirationHandler = \{[\s\S]{0,600}?\n      \}/.exec(task);
  if (handler === null) fail("could not read the expiration handler");
  if (!handler[0].includes("completion.finish(success: false)")) {
    fail("the expiration handler does not complete the task");
  }
});

check("completion happens once, behind a lock", () => {
  if (!/var finished = false/.test(task)) fail("no once-guard");
  if (!/lock\.lock\(\)[\s\S]{0,200}guard !already else \{ return \}/.test(task)) {
    fail("the once-guard does not gate setTaskCompleted");
  }
});

check("the next wake is requested at the start and at the end of every run", () => {
  const start = /submit\(\)\n\n      let completion/.test(task);
  const end = /defer \{ submit\(\) \}/.test(task);
  if (!start || !end) fail(`rescheduled at start=${start} at end=${end}`);
});

check("nothing assumes an hour of the day", () => {
  if (/bySettingHour|dateComponents\(\[\.hour|Calendar\.current/.test(task)) {
    fail("the task looks at the clock's hour");
  }
  if (!task.includes("earliestBeginDate")) fail("no earliestBeginDate: nothing would be scheduled");
});

check("the wake keeps no timer", () => {
  if (/Timer\.|DispatchSourceTimer|asyncAfter/.test(refresher)) fail("the wake has a timer in it");
  if (/Timer\.|DispatchSourceTimer|asyncAfter/.test(policy)) fail("the policy has a timer in it");
});

check("the wake can be stopped at the deadline", () => {
  if (!/cancelled: \(\) -> Bool/.test(refresher)) fail("the wake takes no cancellation");
  if (!refresher.includes("report.aborted = true")) fail("being stopped is not reported");
});

// --- The store it writes to, column for column ---

check("every entries column the schema declares is written", () => {
  for (const column of TABLES.entries.columns) {
    if (!library.includes(`"${column.name}"`)) fail(`LocalLibrary.swift never mentions entries.${column.name}`);
  }
});

check("the poll's memory, column for column", () => {
  for (const column of ["fetched_at", "attempted_at", "etag", "last_modified", "failures", "last_error"]) {
    if (!library.includes(`"${column}"`)) fail(`LocalLibrary.swift never mentions feeds.${column}`);
  }
});

check("a failed poll counts on the feed and leaves the last success alone", () => {
  const failure = /UPDATE "feeds" SET\s+"attempted_at" = \?, "failures" = COALESCE\("failures", 0\) \+ 1/.exec(
    library,
  );
  if (failure === null) fail("recordFailure does not count on the row");
  const statement = library.slice(failure.index, library.indexOf("WHERE", failure.index));
  if (statement.includes('"fetched_at"')) {
    fail("a failure moves fetched_at, which is when the feed was last read");
  }
});

check("a re-fetch keeps what the reader did", () => {
  const insert = /INSERT OR IGNORE INTO "entries"([\s\S]*?)VALUES \(([^)]*)\)/.exec(library);
  if (insert === null) fail("there is no insert into entries");
  if (!/"read", "starred", "stored_at"/.test(insert[1])) fail("read, starred and stored_at are not set on insert");
  const values = insert[2].split(",").map((value) => value.trim());
  const tail = values.slice(-4).join(",");
  if (tail !== "NULL,0,0,?") fail(`a new article is not stored unread and unstarred: ${tail}`);
  const update = /UPDATE "entries" SET([\s\S]{0,400}?)WHERE "key" = \?/.exec(library);
  if (update === null) fail("there is no update on re-fetch");
  if (/"read"/.test(update[1]) || /"starred"/.test(update[1]) || /"stored_at"/.test(update[1])) {
    fail("a re-fetch overwrites read, starred or stored_at");
  }
});

check("the item id is spelled the way the app spells it", () => {
  const store = read("src/api/local/store.ts");
  if (!store.includes("`local/${base64Url(feedUrl)}/${guid}`")) fail("localItemId changed shape");
  if (!library.includes('"local/\\(base64Url(feedUrl))/\\(guid)"')) {
    fail("LocalLibrary.swift spells the item id differently");
  }
});

check("the library is never created by a wake", () => {
  if (/SQLITE_OPEN_CREATE/.test(library)) fail("the wake can create a database");
  if (!/SQLITE_OPEN_READWRITE \| SQLITE_OPEN_FULLMUTEX/.test(library)) fail("the open flags changed");
});

// --- The build wiring, which is the only part that touches a Mac ---

check("the wiring script copies both halves into the generated project", () => {
  for (const needle of ["xcodegen generate", "'*.swift'", "'*.m'", "gen/apple", "project.pbxproj"]) {
    if (!wiring.includes(needle)) fail(`scripts/ios-background-refresh.sh no longer mentions ${needle}`);
  }
});

check("Codemagic wires the project before building it", () => {
  const step = /- name: .*background refresh[\s\S]{0,1200}?scripts\/ios-background-refresh\.sh/.exec(ci);
  if (step === null) fail("codemagic.yaml does not run scripts/ios-background-refresh.sh");
});

check("Codemagic checks the built app declares the task", () => {
  if (!ci.includes("BGTaskSchedulerPermittedIdentifiers")) fail("the build does not read the key back");
  if (!ci.includes("hardlyreader_app_refresh_handle")) fail("the build does not look for the entry point in the binary");
});

// --- And it says what it does ---

check("there is a document for it", () => {
  const doc = read("docs/ios-background-refresh.md");
  for (const needle of [expected, "BGAppRefreshTask", "setTaskCompleted", "checks"]) {
    if (!doc.includes(needle)) fail(`docs/ios-background-refresh.md does not mention ${needle}`);
  }
});

console.log(`\n${passed} checks passed`);
