import { strict as assert } from "node:assert";
import {
  FLOOD_MS,
  MAX_FLOODS,
  fallbackOrigin,
  floodStrength,
  floodTone,
  pushFlood,
  retireFlood,
} from "../../src/lib/floods.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

const VIEW = { width: 1200, height: 800 };

check("a flood lives about half a second", () => {
  assert.ok(FLOOD_MS >= 400 && FLOOD_MS <= 700, String(FLOOD_MS));
});

check("each kind has its own tone, all valid CSS", () => {
  const kinds = ["hidden", "revealed", "pin", "unpin", "sync"];
  const tones = kinds.map((kind) => floodTone(kind));
  for (const tone of tones) assert.ok(tone.startsWith("var(--"), tone);
  assert.equal(new Set(tones).size, kinds.length - 1, "pin and revealed may share the accent");
  assert.ok(floodTone("hidden").includes("tone-hidden"));
  assert.ok(floodTone("sync").includes("tone-sync"));
});

check("locking has no glow at all", () => {
  // The kind is gone from the union, so nothing can ask for one: the band's own
  // pulse is the feedback, and light escaping a lock says the opposite.
  assert.equal(floodStrength("lock"), undefined, "no tone, no strength, nothing to draw");
  assert.equal(floodTone("lock"), undefined);
});

check("a kind with no strength draws nothing, even when pushed by hand", () => {
  assert.equal(pushFlood([], "lock", { x: 5, y: 5 }, 1, VIEW).length, 0);
});

check("unlocking draws nothing: the band answers in place", () => {
  assert.equal(floodStrength("unlock"), undefined, "the band pulses, the window does not");
  for (const kind of ["hidden", "revealed", "pin", "unpin", "sync"]) {
    assert.equal(floodStrength(kind), 1, `${kind} keeps the full glow`);
  }
  assert.equal(pushFlood([], "unlock", { x: 10, y: 10 }, 9, VIEW).length, 0, "no flood to measure");
  const hide = pushFlood([], "hidden", { x: 10, y: 10 }, 10, VIEW)[0];
  assert.equal(hide.strength, 1);
});

check("a strength outside 0-1 is clamped", () => {
  assert.equal(pushFlood([], "hidden", { x: 1, y: 1 }, 1, VIEW, 4)[0].strength, 1);
  assert.equal(pushFlood([], "hidden", { x: 1, y: 1 }, 2, VIEW, -3)[0].strength, 0);
});

check("a click starts the flood where it happened", () => {
  const list = pushFlood([], "hidden", { x: 120, y: 340 }, 1, VIEW);
  assert.deepEqual(list, [{ id: 1, kind: "hidden", x: 120, y: 340, strength: 1 }]);
});

check("an origin off the edge is pulled back inside the viewport", () => {
  const low = pushFlood([], "hidden", { x: 40, y: 900 }, 2, VIEW)[0];
  assert.equal(low.y, 800);
  const left = pushFlood([], "pin", { x: -30, y: 10 }, 3, VIEW)[0];
  assert.equal(left.x, 0);
});

check("without a click, a sync arrives top right", () => {
  const origin = fallbackOrigin("sync", VIEW);
  assert.equal(origin.x, VIEW.width - 46);
  assert.equal(origin.y, 30);
  assert.equal(pushFlood([], "sync", null, 4, VIEW)[0].y, origin.y);
});

check("anything else without a click lands centre screen", () => {
  assert.deepEqual(fallbackOrigin("pin", VIEW), { x: 600, y: 400 });
});

check("the queue is bounded, oldest dropped first", () => {
  let list = [];
  for (let id = 1; id <= 6; id += 1) {
    list = pushFlood(list, "pin", { x: id * 10, y: id * 10 }, id, VIEW);
  }
  assert.equal(list.length, MAX_FLOODS);
  assert.deepEqual(
    list.map((flood) => flood.id),
    [4, 5, 6],
  );
});

check("retiring removes exactly one, by id", () => {
  const list = pushFlood(pushFlood([], "pin", { x: 1, y: 1 }, 1, VIEW), "pin", { x: 2, y: 2 }, 2, VIEW);
  assert.deepEqual(
    retireFlood(list, 1).map((flood) => flood.id),
    [2],
  );
  assert.equal(retireFlood(list, 99).length, 2, "an unknown id changes nothing");
});

check("pushing does not mutate the list it was given", () => {
  const original = pushFlood([], "pin", { x: 5, y: 5 }, 1, VIEW);
  const copy = [...original];
  pushFlood(original, "hidden", { x: 9, y: 9 }, 2, VIEW);
  assert.deepEqual(original, copy);
});

check("a zero-size viewport (no window yet) does not produce NaN", () => {
  const flood = pushFlood([], "sync", { x: 10, y: 10 }, 1, { width: 0, height: 0 })[0];
  assert.equal(flood.x, 0);
  assert.equal(flood.y, 0);
  assert.ok(Number.isFinite(flood.x) && Number.isFinite(flood.y));
});

console.log(`\n${passed}/${passed} checks passed`);
