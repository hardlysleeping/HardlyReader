import { strict as assert } from "node:assert";
import { SYNC_IDLE, SYNC_TOTAL, percentOf, syncDescription, syncReadout } from "../../src/lib/sync-progress.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

check("idle is not active and has no step", () => {
  assert.equal(SYNC_IDLE.active, false);
  assert.equal(SYNC_IDLE.step, "");
});

check("a sync is five fetches", () => assert.equal(SYNC_TOTAL, 5));

check("percent is the rounded fraction", () => {
  assert.equal(percentOf(2, 5), 40);
  assert.equal(percentOf(1, 3), 33);
});

check("percent clamps beyond the ends", () => {
  assert.equal(percentOf(7, 5), 100);
  assert.equal(percentOf(-1, 5), 0);
});

check("percent of an unknown total is zero, not NaN", () => {
  assert.equal(percentOf(0, 0), 0);
  assert.equal(percentOf(3, 0), 0);
});

check("readout is the count and the percentage", () => {
  assert.equal(syncReadout({ active: true, done: 2, total: 5, step: "Tags" }), "2/5 steps");
});

check("readout never claims more done than the total", () => {
  assert.equal(syncReadout({ active: true, done: 9, total: 5, step: "Tags" }), "5/5 steps");
});

check("an unknown total names the step instead of 0/0", () => {
  assert.equal(syncReadout({ active: true, done: 0, total: 0, step: "Feeds" }), "Feeds…");
});

check("an unknown total with no step still says something true", () => {
  assert.equal(syncReadout({ active: true, done: 0, total: 0, step: "" }), "Syncing…");
});

check("description is the button label when idle", () => {
  assert.equal(syncDescription(SYNC_IDLE), "Sync now");
});

check("description names the step and the count", () => {
  assert.equal(
    syncDescription({ active: true, done: 2, total: 5, step: "Tags" }),
    "Syncing tags: 2 of 5 steps, 40 percent",
  );
});

check("description before the count is known says starting", () => {
  assert.equal(syncDescription({ active: true, done: 0, total: 0, step: "" }), "Syncing, starting");
});

console.log(`${passed} checks passed`);
