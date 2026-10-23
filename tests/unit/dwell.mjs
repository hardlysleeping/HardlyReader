import { AUTO_MARK_MS, shouldArmDwell, successorId } from "../../src/lib/dwell.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Three seconds, and the reason is the accident case: the timer is long enough
// that a post flipped past never qualifies.
check("the dwell is three seconds", AUTO_MARK_MS === 3000, String(AUTO_MARK_MS));
check("long enough to notice", AUTO_MARK_MS >= 3000);

// Arming.
check("off by default means never armed", shouldArmDwell({ enabled: false, alreadyRead: false, isOpen: true }) === false);
check("enabled and open arms", shouldArmDwell({ enabled: true, alreadyRead: false, isOpen: true }) === true);
check("an already-read post needs no timer", shouldArmDwell({ enabled: true, alreadyRead: true, isOpen: true }) === false);
check("a post that is not the open one is not armed", shouldArmDwell({ enabled: true, alreadyRead: false, isOpen: false }) === false);

// Landing after the open post leaves the list.
const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
check("the next post is preferred", successorId(items, "a") === "b");
check("in the middle, forward again", successorId(items, "b") === "c");
check("at the end, back to where you came from", successorId(items, "c") === "b");
check("a single-post list has nowhere to land", successorId([{ id: "only" }], "only") === null);
check("an absent post has nowhere to land", successorId(items, "zzz") === null);
check("an empty list has nowhere to land", successorId([], "a") === null);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
