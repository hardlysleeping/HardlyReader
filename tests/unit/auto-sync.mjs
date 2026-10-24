/**
 * Checks for automatic sync.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/auto-sync.mjs
 *
 * The clock is injected, so "every 4 hours" is a number to assert instead of
 * four hours to wait. The settings rows and the wiring in `Main.svelte` are
 * covered by source checks at the end plus a browser pass over the real panel.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AUTO_SYNC_DEFAULT_HOURS,
  AUTO_SYNC_HOURS,
  autoSyncLabel,
  autoSyncMs,
  isAutoSyncHours,
  parseAutoSyncHours,
  startAutoSync,
} from "../../src/lib/auto-sync.ts";

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail === undefined ? "" : `(${detail})`}`);
  }
}

// ---------------------------------------------------------------- the options
check("the intervals are the ones offered", AUTO_SYNC_HOURS.join(",") === "1,2,4,6,12,24");
check("hourly is the default", AUTO_SYNC_DEFAULT_HOURS === 1);
check("only listed intervals pass", AUTO_SYNC_HOURS.every((hours) => isAutoSyncHours(hours)));
check("an unlisted interval does not", !isAutoSyncHours(3) && !isAutoSyncHours(0) && !isAutoSyncHours("4"));
check("stored text is read back as a number", parseAutoSyncHours("12") === 12);
check("anything unknown falls back to the default", parseAutoSyncHours(7) === 1 && parseAutoSyncHours(null) === 1 && parseAutoSyncHours(true) === 1);
check("milliseconds are hours", autoSyncMs(4) === 14_400_000 && autoSyncMs(24) === 86_400_000);
check("one hour reads as an hour", autoSyncLabel(1) === "Every hour");
check("a day says so", autoSyncLabel(24) === "Every 24 hours (daily)");
check("the rest are counted", autoSyncLabel(6) === "Every 6 hours");

// ---------------------------------------------------------------- the timer
function harness(options = {}) {
  const state = { enabled: true, hours: 4, busy: false, syncs: 0, timer: null, ms: null, cleared: 0 };
  const run = startAutoSync({
    enabled: () => state.enabled,
    hours: () => state.hours,
    sync: () => {
      state.syncs += 1;
      return options.rejects ? Promise.reject(new Error("offline")) : undefined;
    },
    busy: () => state.busy,
    launch: options.launch,
    setTimer: (fn, ms) => {
      state.timer = fn;
      state.ms = ms;
      return "handle";
    },
    clearTimer: () => {
      state.cleared += 1;
      state.timer = null;
    },
  });
  return { state, run };
}

{
  const { state, run } = harness();
  check("a launch sync runs at once", state.syncs === 1);
  check("the timer is set to the chosen interval", state.ms === 14_400_000, String(state.ms));
  state.timer();
  check("a tick syncs", state.syncs === 2);
  state.busy = true;
  state.timer();
  check("but not while a sync is already running", state.syncs === 2);
  state.busy = false;
  state.enabled = false;
  state.timer();
  check("and not once it is switched off", state.syncs === 2);
  run.stop();
  check("stopping clears the timer", state.cleared === 1 && run.running() === false);
  run.stop();
  check("stopping twice is harmless", state.cleared === 1);
}

{
  const { state, run } = harness({ launch: false });
  check("the launch sync can be skipped", state.syncs === 0 && state.ms === 14_400_000);
  run.stop();
}

{
  const { state, run } = harness();
  state.enabled = false;
  run.stop();
  const off = harness();
  off.state.enabled = false;
  const idle = startAutoSync({
    enabled: () => false,
    hours: () => 4,
    sync: () => {
      off.state.syncs += 1;
    },
    busy: () => false,
  });
  check("off starts no timer at all", idle.running() === false);
  idle.stop();
}

{
  const { state, run } = harness({ rejects: true });
  check("a rejected sync is not thrown at the timer", state.syncs === 1);
  state.timer();
  check("and the next tick still happens", state.syncs === 2);
  run.stop();
}

// ---------------------------------------------------------------- the wiring
{
  const prefs = readFileSync(new URL("../../src/lib/chrome-prefs.ts", import.meta.url), "utf8");
  const chrome = readFileSync(new URL("../../src/state/chrome.svelte.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../../src/views/Main.svelte", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../src/components/ThemePanel.svelte", import.meta.url), "utf8");

  check("auto sync is off in the stored defaults", /autoSync: false/.test(prefs));
  check("and the interval is stored beside it", /autoSyncHours: AUTO_SYNC_DEFAULT_HOURS/.test(prefs));
  check("the chrome state owns both", /autoSync = \$state\(false\)/.test(chrome) && /autoSyncHours = \$state<AutoSyncHours>/.test(chrome));
  check("the launch path starts the timer", /startAutoSync\(\{/.test(main) && /return \(\) => run\.stop\(\)/.test(main));
  check("it waits for the launch load", /const started = launched;/.test(main) && /if \(!enabled \|\| !started\) return;/.test(main));
  check("a sync does not restart the timer", /untrack\(\(\) =>\s*startAutoSync/.test(main));
  check("a launch load counts as the launch sync", /AUTO_SYNC_LAUNCH_GRACE_MS/.test(main));
  check("both settings are in the panel", /Auto sync/.test(panel) && /Every/.test(panel));
  check("every interval is offered", /\{#each AUTO_SYNC_HOURS as hours/.test(panel));
  check("the interval is unusable while off", /disabled=\{!chrome\.autoSync\}/.test(panel));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
