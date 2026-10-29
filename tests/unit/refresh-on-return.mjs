/**
 * Checks for returning to the window.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/refresh-on-return.mjs
 *
 * Two questions live here and they are deliberately not the same one: whether
 * opening the app should sync (never a preference — a stale app is a bug, not a
 * setting) and whether coming back to a window that has been in the background
 * should. The second one has a threshold, and `never` answers it alone; the
 * interesting cases are a clock, a corrupt blob, and an install from before the
 * setting existed.
 *
 * The last section reads the source of the wiring, the way the auto-sync suite
 * does, because the sentence "`never` does not silence the launch" is only true
 * if the effect that runs the launch check never looks at the preference.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { accountSlug, scopedKey } from "../../src/lib/account-key.ts";
import {
  autoSyncMs,
  AUTO_SYNC_DEFAULT_HOURS,
  parseAutoSyncHours,
  startAutoSync,
} from "../../src/lib/auto-sync.ts";
import {
  CHROME_KEY,
  readAutoSync,
  readAutoSyncHours,
  readRefreshOnReturn,
  writeAutoSync,
  writeRefreshOnReturn,
} from "../../src/lib/chrome-prefs.ts";
import {
  LAUNCH_GRACE_MS,
  REFRESH_ON_RETURN_DEFAULT,
  REFRESH_ON_RETURN_MINUTES,
  parseRefreshOnReturn,
  refreshDueOnLaunch,
  refreshDueOnReturn,
  refreshOnReturnChoices,
  refreshOnReturnLabel,
  refreshOnReturnShort,
  sameRefreshOnReturn,
} from "../../src/lib/refresh-on-return.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const ACCOUNT = { serverUrl: "https://reader.test", email: "u@reader.test" };
const MINUTE = 60_000;

function memoryStore() {
  const store = new Map();
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

// ---------------------------------------------------------------- the setting
check("the offered thresholds are 5, 10 and 30 minutes", REFRESH_ON_RETURN_MINUTES.join(",") === "5,10,30");
check(
  "five minutes is the default",
  REFRESH_ON_RETURN_DEFAULT.kind === "after" && REFRESH_ON_RETURN_DEFAULT.minutes === 5,
);

// ---------------------------------------------------------------- reading back
check("a stored threshold is read back", sameRefreshOnReturn(parseRefreshOnReturn({ kind: "after", minutes: 10 }), { kind: "after", minutes: 10 }));
check("a threshold saved as text is still a number", parseRefreshOnReturn({ kind: "after", minutes: "30" }).minutes === 30);
check("`always` survives", parseRefreshOnReturn({ kind: "always" }).kind === "always");
check("`never` survives", parseRefreshOnReturn({ kind: "never" }).kind === "never");

// Garbage lands on five minutes. The important half is what it must *not* land
// on: a corrupt blob must never read as `never`, which would look like the app
// had been told to stop fetching.
const garbage = [
  ["a missing field", undefined],
  ["null", null],
  ["a string where an object was", "never"],
  ["an unknown kind", { kind: "sometimes" }],
  ["an unoffered threshold", { kind: "after", minutes: 7 }],
  ["a threshold that is not a number", { kind: "after", minutes: "soon" }],
  ["a boolean", true],
  ["an array", []],
];
for (const [what, value] of garbage) {
  const parsed = parseRefreshOnReturn(value);
  check(`garbage falls back to five minutes: ${what}`, parsed.kind === "after" && parsed.minutes === 5, JSON.stringify(value));
}

// ---------------------------------------------------------------- stored, per account
{
  const storage = memoryStore();
  writeRefreshOnReturn(storage, { kind: "after", minutes: 30 }, ACCOUNT);
  check("a threshold survives a relaunch", readRefreshOnReturn(storage, ACCOUNT).minutes === 30);

  writeRefreshOnReturn(storage, { kind: "never" }, ACCOUNT);
  check("so does `never`", readRefreshOnReturn(storage, ACCOUNT).kind === "never");

  // One key holds every chrome preference, so a new one may not drop the others.
  writeAutoSync(storage, true, ACCOUNT);
  check("and writing it leaves the interval setting alone", readAutoSync(storage, ACCOUNT) === true && readAutoSyncHours(storage, ACCOUNT) === AUTO_SYNC_DEFAULT_HOURS);

  const keys = [...storage.store.keys()];
  check("the preference is stored under this account's key", keys.includes(scopedKey(CHROME_KEY, ACCOUNT)), keys.join(", "));
  check(
    "with no address in the key",
    keys.every((key) => !key.includes("@") && !key.includes("reader.test")),
    keys.join(", "),
  );
}

// An install from before the setting existed: the blob is there, the field is not.
{
  const storage = memoryStore();
  storage.setItem(scopedKey(CHROME_KEY, ACCOUNT), JSON.stringify({ bandCollapsed: true, autoSync: true }));
  const fallback = readRefreshOnReturn(storage, ACCOUNT);
  check("an old install gets five minutes, not never", fallback.kind === "after" && fallback.minutes === 5);
  check("and keeps its other preferences", readAutoSync(storage, ACCOUNT) === true);
}

// Corrupt JSON must not take the other preferences with it, and must not read as off.
{
  const storage = memoryStore();
  storage.setItem(scopedKey(CHROME_KEY, ACCOUNT), "{not json");
  check("a corrupt blob reads as five minutes", readRefreshOnReturn(storage, ACCOUNT).minutes === 5);
  check("...and everything else at its default", readAutoSync(storage, ACCOUNT) === false);

  const inner = memoryStore();
  inner.setItem(scopedKey(CHROME_KEY, ACCOUNT), JSON.stringify({ refreshOnReturn: { kind: "after", minutes: -5 } }));
  check("a negative threshold is not honoured", readRefreshOnReturn(inner, ACCOUNT).minutes === 5);
}

// ---------------------------------------------------------------- due or not
const at = (ms) => 1_000_000_000_000 + ms;

check("four minutes old is not worth a fetch at five", refreshDueOnReturn({ kind: "after", minutes: 5 }, at(0), at(4 * MINUTE)) === false);
check("five minutes old is", refreshDueOnReturn({ kind: "after", minutes: 5 }, at(0), at(5 * MINUTE)) === true);
check("ten minutes waits ten", refreshDueOnReturn({ kind: "after", minutes: 10 }, at(0), at(9 * MINUTE)) === false && refreshDueOnReturn({ kind: "after", minutes: 10 }, at(0), at(10 * MINUTE)) === true);
check("thirty waits thirty", refreshDueOnReturn({ kind: "after", minutes: 30 }, at(0), at(29 * MINUTE)) === false && refreshDueOnReturn({ kind: "after", minutes: 30 }, at(0), at(30 * MINUTE)) === true);

check("`always` fetches on every return", refreshDueOnReturn({ kind: "always" }, at(0), at(1)) === true);
check("`never` never fetches on return", refreshDueOnReturn({ kind: "never" }, 0, at(99 * 24 * 60 * MINUTE)) === false);
check("nothing ever synced is as stale as it gets", refreshDueOnReturn({ kind: "after", minutes: 5 }, 0, at(0)) === true);
check(
  "a clock that went backwards does not cause a fetch",
  refreshDueOnReturn({ kind: "after", minutes: 5 }, at(10 * MINUTE), at(0)) === false,
);
check("a corrupt preference is read on use, not trusted", refreshDueOnReturn({ kind: "after", minutes: 9999 }, at(0), at(6 * MINUTE)) === true);

// ---------------------------------------------------------------- launch is not this
check("thirty seconds is the launch grace", LAUNCH_GRACE_MS === 30_000);
check("a launch load a moment ago is the launch sync", refreshDueOnLaunch(at(0), at(10_000)) === false);
check("one older than the grace is not", refreshDueOnLaunch(at(0), at(31_000)) === true);
check("nothing on disk always needs one", refreshDueOnLaunch(0, at(0)) === true);
check("the grace is a parameter, so the number is not copied around", refreshDueOnLaunch(at(0), at(2_000), 1_000) === true);

// The whole point of the setting: it answers the return question and no part of
// the launch one. Two extremes of the preference, one launch answer.
check(
  "`never` does not silence the launch: an hour-old app still syncs on open",
  refreshDueOnReturn({ kind: "never" }, at(0), at(60 * MINUTE)) === false &&
    refreshDueOnLaunch(at(0), at(60 * MINUTE)) === true,
);
check(
  "and `always` changes the return answer without touching the launch one",
  refreshDueOnReturn({ kind: "always" }, at(0), at(10_000)) === true &&
  refreshDueOnLaunch(at(0), at(10_000)) === false,
);
check(
  "the launch check takes no preference at all",
  refreshDueOnLaunch.length >= 1 && !/preference|RefreshOnReturn/.test(refreshDueOnLaunch.toString()),
);

// ---------------------------------------------------------------- the row
check("five choices: three thresholds, always, never", refreshOnReturnChoices().length === 5);
check("they read as sentences", refreshOnReturnChoices().map(refreshOnReturnLabel).join(" / ") === "After 5 minutes / After 10 minutes / After 30 minutes / Always / Never");
check("and as buttons", refreshOnReturnChoices().map(refreshOnReturnShort).join(",") === "5m,10m,30m,Always,Never");
check(
  "each one is marked only when it is the one set",
  refreshOnReturnChoices().filter((choice) => sameRefreshOnReturn(choice, { kind: "after", minutes: 10 })).length === 1,
);

// ---------------------------------------------------------------- the wiring
{
  const main = readFileSync(new URL("../../src/views/Main.svelte", import.meta.url), "utf8");
  const chrome = readFileSync(new URL("../../src/state/chrome.svelte.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../src/components/ThemePanel.svelte", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../../src/components/SettingsPanel.svelte", import.meta.url), "utf8");

  check(
    "opening the app checks freshness by itself",
    // `!DEMO` first: a demo library has sample feeds and no network, so it must not refresh.
    /if \(!DEMO && !chrome\.autoSync && !reader\.sync\.active && refreshDueOnLaunch\(reader\.lastSyncAt\)\)/.test(main),
  );
  check(
    "and does not spend the same five requests twice",
    // Exactly one owner: when the interval timer is on, its own launch check
    // fires, and this path stands down.
    /!DEMO && !chrome\.autoSync && !reader\.sync\.active && refreshDueOnLaunch/.test(main),
  );
  check(
    "and the interval timer takes the same answer",
    /launch: refreshDueOnLaunch\(reader\.lastSyncAt\)/.test(main),
  );
  check(
    "the return check asks the preference",
    /refreshDueOnReturn\(chrome\.refreshOnReturn, reader\.lastSyncAt\)/.test(main),
  );
  check(
    "the preference is read at each return, not held as a listener dependency",
    /untrack\(\(\) => \{[\s\S]*?chrome\.refreshOnReturn[\s\S]*?addEventListener\("visibilitychange", onReturn\)/.test(main),
  );
  check("the return listener is removed with the effect", /removeEventListener\("visibilitychange", onReturn\)/.test(main));
  check("chrome owns the preference", /refreshOnReturn = \$state<RefreshOnReturn>/.test(chrome));
  check("and can be set", /setRefreshOnReturn\(value: RefreshOnReturn\)/.test(chrome));
  check("the Sync section is the one Settings shows", /part="sync"/.test(settings));
  check("the row is in the Sync section", /<span class="key">Refresh on return<\/span>/.test(panel));
  check("with every choice drawn from the list", /\{#each refreshOnReturnChoices\(\) as choice/.test(panel));
  check("and each press sets it", /chrome\.setRefreshOnReturn\(choice\)/.test(panel));
  check("its copy says never is not an off switch", /Never turns off only this check/.test(panel));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
