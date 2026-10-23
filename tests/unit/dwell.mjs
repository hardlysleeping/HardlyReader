import {
  AUTO_MARK_MS,
  DWELL_SECONDS_DEFAULT,
  DWELL_SECONDS_MAX,
  DWELL_SECONDS_HARD_MAX,
  DWELL_SECONDS_HARD_MIN,
  DWELL_SECONDS_MIN,
  clampDwellSeconds,
  dwellMs,
  shouldArmDwell,
  successorId,
} from "../../src/lib/dwell.ts";

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
check("the default setting matches the constant", DWELL_SECONDS_DEFAULT === AUTO_MARK_MS / 1000);
check("the setting is in seconds", dwellMs(DWELL_SECONDS_DEFAULT) === AUTO_MARK_MS);

// The setting is the owner's, within bounds that stay usable.
check("a chosen delay converts", dwellMs(7) === 7000);
check("below the floor clamps up", clampDwellSeconds(0) === DWELL_SECONDS_MIN && clampDwellSeconds(-4) === DWELL_SECONDS_MIN);
check("above the slider is still allowed", clampDwellSeconds(45) === 45, String(clampDwellSeconds(45)));
check("above the hard ceiling clamps down", clampDwellSeconds(9999) === DWELL_SECONDS_HARD_MAX, String(clampDwellSeconds(9999)));
check("the hard ceiling is ten minutes", DWELL_SECONDS_HARD_MAX === 600);
check("the hard floor is a second", DWELL_SECONDS_HARD_MIN === 1);
check("the floor is a second", DWELL_SECONDS_MIN === 1);
check("the ceiling is half a minute", DWELL_SECONDS_MAX === 30);
check("fractions round to whole seconds", clampDwellSeconds(4.4) === 4 && clampDwellSeconds(4.6) === 5);
check("rubbish falls back to the default", clampDwellSeconds("nope") === DWELL_SECONDS_DEFAULT && clampDwellSeconds(null) === DWELL_SECONDS_DEFAULT);
check("a numeric string is accepted", clampDwellSeconds("12") === 12);
check("the slider ceiling is untouched", DWELL_SECONDS_MAX === 30);
check("the clamped value drives the timer", dwellMs(9999) === DWELL_SECONDS_HARD_MAX * 1000);
check("a typed value beyond the slider drives it too", dwellMs(45) === 45_000);

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
