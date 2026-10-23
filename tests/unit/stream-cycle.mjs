import { attemptOrder, cycleIndex } from "../../src/lib/stream-cycle.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Wrapping is the reason continuous reading has no dead end.
check("forward from the middle is the neighbour", cycleIndex(4, 1, 1) === 2);
check("forward from the last wraps to the first", cycleIndex(4, 3, 1) === 0);
check("back from the first wraps to the last", cycleIndex(4, 0, -1) === 3);
check("back from the middle is the neighbour", cycleIndex(4, 2, -1) === 1);
check("a single-stream list wraps onto itself", cycleIndex(1, 0, 1) === 0);
check("an empty list has nowhere to go", cycleIndex(0, 0, 1) === null);
check("a stream that is not in the list starts from the top going forward", cycleIndex(3, -1, 1) === 0);
check("and from the bottom going back", cycleIndex(3, -1, -1) === 2);
check("two hops skip one", cycleIndex(4, 0, 1, 2) === 2);

// attemptOrder is the bounded walk: every other stream once, nearest first,
// never the current one.
const order = attemptOrder(4, 1, 1);
check("the walk covers every other stream", order.length === 3, JSON.stringify(order));
check("nearest first", order[0] === 2 && order[1] === 3, JSON.stringify(order));
check("it wraps, and the loneliest candidate is last", order[2] === 0, JSON.stringify(order));
check("the current stream is never a candidate", !order.includes(1));

const backwards = attemptOrder(4, 1, -1);
check("backwards starts at the previous stream", backwards[0] === 0);
check("backwards wraps to the end", backwards[1] === 3 && backwards[2] === 2, JSON.stringify(backwards));

check("the walk is bounded by the list, not unbounded", attemptOrder(9, 4, 1).length === 8);
check("an empty list yields no candidates", attemptOrder(0, 0, 1).length === 0);
check("a one-stream list has no other candidate", attemptOrder(1, 0, 1).length === 0);

// Simulating the search: skip empty feeds; in the unread view the whole account
// can drain, and that must terminate rather than loop.
function findNext(hasItems, current, direction) {
  for (const at of attemptOrder(hasItems.length, current, direction)) {
    if (hasItems[at]) return at;
  }
  return null;
}
check("an empty neighbour is skipped for a full one", findNext([true, true, false, true], 1, 1) === 3);
check("a run of empty feeds is skipped", findNext([true, false, false, false], 0, 1) === null);
check("nothing unread anywhere ends the walk", findNext([true, false, false], 0, 1) === null);
check("but the current stream is not reconsidered", findNext([true, false, false], 1, 1) === 0);
check("reading backwards finds the earlier feed", findNext([true, false, true], 2, -1) === 0);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
