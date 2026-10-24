/**
 * Checks for the change watch.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/watch-changes.mjs
 *
 * The clock and the reader are both injected, so the whole schedule can be
 * played out instantly. The end-to-end case — a token that moves and the state
 * that gets re-read because of it — is covered in a browser harness, and the PHP
 * side has its own tests for `/v1/revision`.
 *
 * `advance()` fires whatever poll is scheduled and lets it finish, which is how
 * time passes in these tests. The first `advance()` is the baseline read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CHANGE_POLL_MAX_MS,
  CHANGE_POLL_MS,
  startChangeWatch,
} from "../../src/lib/watch-changes.ts";

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

const flush = () => new Promise((resolve) => setImmediate(resolve));

function clock() {
  const timers = [];
  let next = 0;
  return {
    setTimer: (fn, ms) => {
      const timer = { id: (next += 1), fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const at = timers.indexOf(timer);
      if (at !== -1) timers.splice(at, 1);
    },
    get pending() {
      return timers.length;
    },
    get last() {
      return timers[timers.length - 1] ?? null;
    },
    take() {
      return timers.shift() ?? null;
    },
  };
}

function bench({ tokens = [], rejects = [] } = {}) {
  const timer = clock();
  const state = { reads: 0, changes: [], busy: false, visible: true };
  const watch = startChangeWatch({
    read: async () => {
      const index = state.reads;
      state.reads += 1;
      if (rejects[index]) throw new Error("offline");
      return tokens[Math.min(index, tokens.length - 1)] ?? "a";
    },
    onChange: (token) => state.changes.push(token),
    busy: () => state.busy,
    visible: () => state.visible,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  const advance = async () => {
    const fired = timer.take();
    fired?.fn();
    await flush();
    await flush();
    return fired;
  };
  return { watch, state, timer, advance };
}

// ------------------------------------------------------------------ baseline
{
  const { watch, state, timer, advance } = bench({ tokens: ["a"] });
  check("watching starts by scheduling a read", timer.pending === 1);
  check("...at the normal interval", timer.last?.ms === CHANGE_POLL_MS, String(timer.last?.ms));
  check("...and does not read before it is due", state.reads === 0);

  await advance();
  check("the first answer is the baseline", state.reads === 1 && state.changes.length === 0);
  check("and it is remembered", watch.known() === "a");
  check("the next read is scheduled", timer.pending === 1);
  watch.stop();
}

// -------------------------------------------------------------- no churn
{
  const { watch, state, advance } = bench({ tokens: ["a"] });
  await advance();
  await advance();
  await advance();
  check("an unchanged token never calls back", state.changes.length === 0, String(state.changes));
  check("but it keeps being read", state.reads === 3, String(state.reads));
  watch.stop();
}

// ------------------------------------------------------------ a real change
{
  const { watch, state, advance } = bench({ tokens: ["a", "a", "b", "b", "c"] });
  await advance(); // baseline a
  await advance(); // still a
  check("nothing happened while the token held", state.changes.length === 0);
  await advance(); // b
  check("the move is reported once", state.changes.join(",") === "b", state.changes.join(","));
  await advance(); // still b
  check("and it is not reported again next time", state.changes.join(",") === "b");
  await advance(); // c
  check("the following move is reported too", state.changes.join(",") === "b,c");
  watch.stop();
}

// ---------------------------------------------------------- do not disturb
{
  const { watch, state, advance, timer } = bench({ tokens: ["a", "b"] });
  await advance();
  state.busy = true;
  await advance();
  check("nothing is asked while a sync is running", state.reads === 1, String(state.reads));
  check("and the token is not treated as changed", state.changes.length === 0);
  check("the interval is untouched by a skip", timer.last?.ms === CHANGE_POLL_MS);

  state.busy = false;
  state.visible = false;
  await advance();
  check("nothing is asked while the window is hidden", state.reads === 1, String(state.reads));
  check("still at the normal interval", timer.last?.ms === CHANGE_POLL_MS);

  state.visible = true;
  await advance();
  check("a hidden window catches up as soon as it is shown", state.changes.join(",") === "b");
  watch.stop();
}

// ------------------------------------------------------------------ backoff
{
  const { watch, state, advance, timer } = bench({ tokens: ["a"], rejects: Array(30).fill(true) });
  await advance();
  check("a failed read schedules again", timer.pending === 1);
  check("...having doubled the wait", timer.last?.ms === CHANGE_POLL_MS * 2, String(timer.last?.ms));
  await advance();
  check("a second failure doubles again", timer.last?.ms === CHANGE_POLL_MS * 4, String(timer.last?.ms));
  await advance();
  check("and again", timer.last?.ms === CHANGE_POLL_MS * 8, String(timer.last?.ms));
  for (let i = 0; i < 5; i += 1) await advance();
  check("the wait is capped", timer.last?.ms === CHANGE_POLL_MAX_MS, String(timer.last?.ms));
  check("a failing server is not hammered", state.changes.length === 0);
  watch.stop();
}

{
  const { watch, advance, timer } = bench({ tokens: ["a", "a"], rejects: [true, false] });
  await advance();
  check("a failure backs off", timer.last?.ms === CHANGE_POLL_MS * 2, String(timer.last?.ms));
  await advance();
  check("the first success returns to normal", timer.last?.ms === CHANGE_POLL_MS, String(timer.last?.ms));
  watch.stop();
}

// ------------------------------------------------------------------- waking
{
  const { watch, state, timer, advance } = bench({ tokens: ["a", "b"] });
  await advance();
  const before = state.reads;
  watch.kick();
  await flush();
  await flush();
  check("waking reads at once", state.reads === before + 1, String(state.reads));
  check("and does not leave two timers behind", timer.pending === 1, String(timer.pending));
  check("the new token is reported", state.changes.join(",") === "b");
  watch.stop();
}

// ------------------------------------------------------------------ stopping
{
  const { watch, state, timer, advance } = bench({ tokens: ["a", "b", "c"] });
  await advance();
  watch.stop();
  check("stopping clears the pending read", timer.pending === 0);
  check("and reports itself stopped", watch.running() === false);
  watch.kick();
  await flush();
  await flush();
  check("a stopped watch cannot be woken", state.reads === 1, String(state.reads));
  check("and never schedules again", timer.pending === 0);
}

// ------------------------------------------------------------------- wiring
{
  const main = readFileSync(new URL("../../src/views/Main.svelte", import.meta.url), "utf8");
  const api = readFileSync(new URL("../../src/api/hardlyread.ts", import.meta.url), "utf8");
  const php = readFileSync(
    fileURLToPath(new URL("../../extensions/xExtension-HardlyRead/lib/HardlyReadApi.php", import.meta.url)),
    "utf8",
  );

  check("the app watches while it is open", /startChangeWatch\(\{/.test(main));
  check("it reads the token, not the state", /read: \(\) => getRevision\(transport, session\)/.test(main));
  check("a change re-reads the extension state", /onChange: \(\) => \{[\s\S]{0,120}reader\.loadApiState\(\)/.test(main));
  // The feed list and counts come from FreshRSS's crawler, not from a view
  // change, so the reaction is one request and nothing else.
  check(
    "and nothing else is refetched",
    !/onChange: \(\) => \{[\s\S]{0,400}?reader\.loadSidebar\(\)/.test(main),
  );
  check("nothing is asked while a sync runs", /busy: \(\) => reader\.sync\.active/.test(main));
  check("a hidden window does not poll", /visible: \(\) => document\.visibilityState === "visible"/.test(main));
  check("coming back to the window checks at once", /visibilitychange/.test(main) && /watch\.kick\(\)/.test(main));
  check("the watch is torn down with the view", /watch\.stop\(\)/.test(main));

  check("the client asks for the token", /"\/revision"/.test(api));
  check("the server answers it", /\$segments\[0\] === 'revision'/.test(php));
  check("the token is built from the same state the app reads", /private function revisionToken/.test(php) && /sha1\(/.test(php));
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
