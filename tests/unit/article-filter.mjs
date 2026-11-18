import { readFileSync } from "node:fs";

import {
  FILTER_OFF,
  READ_FILTER_DEFAULT,
  READ_FILTERS,
  STAR_FILTER_DEFAULT,
  STAR_FILTERS,
  filterItems,
  filterWords,
  isFilterOff,
  isReadFilter,
  isStarFilter,
  nextReadFilter,
  nextStarFilter,
} from "../../src/lib/article-filter.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const READ = "user/-/state/com.google/read";
const STARRED = "user/-/state/com.google/starred";

const item = (id, states = []) => ({ id, categories: ["user/-/label/Technology", ...states] });

const unread = item("a");
const read = item("b", [READ]);
const starred = item("c", [STARRED]);
const readStarred = item("d", [READ, STARRED]);
const items = [unread, read, starred, readStarred];

const ids = (list) => list.map((i) => i.id).join(",");
const at = (readState, starState) => filterItems(items, { read: readState, star: starState });

// Two switches, three states each, and the third is off: the control has no
// "All" button because "off" is all, and no fourth pill to repeat it.
check("the read switch walks off, unread, read", READ_FILTERS.join(",") === "off,unread,read", READ_FILTERS.join(","));
check("the star switch walks off, unstarred, starred", STAR_FILTERS.join(",") === "off,unstarred,starred", STAR_FILTERS.join(","));
check(
  "only those states are states",
  isReadFilter("unread") && isReadFilter("off") && !isReadFilter("all") && !isReadFilter(null) &&
    isStarFilter("starred") && isStarFilter("unstarred") && !isStarFilter("all") && !isStarFilter(1),
);


check("a fresh install filters nothing", READ_FILTER_DEFAULT === "off" && STAR_FILTER_DEFAULT === "off");

check("both switches off is the whole list", ids(at("off", "off")) === "a,b,c,d", ids(at("off", "off")));
check("...and is what the app calls unfiltered", isFilterOff(FILTER_OFF) && !isFilterOff({ read: "off", star: "starred" }));

check("unread keeps the unread posts", ids(at("unread", "off")) === "a,c", ids(at("unread", "off")));
check("...and drops the read ones", !at("unread", "off").some((i) => i.id === "b" || i.id === "d"));

// The other half of the same switch: a feed with nothing new is not an empty
// feed once one press asks for what you have already read.
check("read keeps the read posts", ids(at("read", "off")) === "b,d", ids(at("read", "off")));
check("read and unread together are everything", at("read", "off").length + at("unread", "off").length === items.length);
check("...in the same order the server sent", at("read", "off")[0].id === "b" && at("read", "off")[1].id === "d");

check("starred keeps only starred", ids(at("off", "starred")) === "c,d", ids(at("off", "starred")));
check("unstarred keeps only unstarred", ids(at("off", "unstarred")) === "a,b", ids(at("off", "unstarred")));
check(
  "...and the two star halves together are everything",
  at("off", "starred").length + at("off", "unstarred").length === items.length,
);

// The point of two switches instead of four pills: they combine.
check("unread starred is both", ids(at("unread", "starred")) === "c", ids(at("unread", "starred")));
check("read unstarred is both", ids(at("read", "unstarred")) === "b", ids(at("read", "unstarred")));
check("the halves never contradict the other switch", at("unread", "unstarred").every((i) => i.id === "a"));

check(
  "an empty stream stays empty",
  READ_FILTERS.every((r) => STAR_FILTERS.every((s) => filterItems([], { read: r, star: s }).length === 0)),
);

// The filter must not mutate what the cache holds: switching back has to show
// the same posts, in the same order.
const before = ids(items);
at("unread", "off");
at("read", "starred");
at("off", "unstarred");
check("filtering leaves the source list untouched", ids(items) === before);
check("unfiltered returns a copy, not the same array", at("off", "off") !== items);

// Reading a post while "unread" is on removes it from the list on the next
// render, which is exactly what the reader wants — as long as the rule is the
// read state and not a snapshot.
const nowRead = [{ ...unread, categories: [...unread.categories, READ] }];
check(
  "the rule is the state, not a snapshot: a post read in place drops out",
  filterItems(nowRead, { read: "unread", star: "off" }).length === 0,
);

check(
  "the empty list names what it filtered by",
  filterWords({ read: "unread", star: "starred" }) === "Unread · Favourites",
  filterWords({ read: "unread", star: "starred" }),
);
check("...and says nothing was filtered when both are off", filterWords(FILTER_OFF) === "everything", filterWords(FILTER_OFF));

// One switch per question, each a three-state cycle — off, the first half, the
// second half, back to off — so one press is one step and there is no "All"
// button beside it. The model's cycle is what the button calls.
check(
  "the read cycle is off, unread, read, off",
  nextReadFilter("off") === "unread" && nextReadFilter("unread") === "read" && nextReadFilter("read") === "off",
);
check(
  "the star cycle is off, unstarred, starred, off",
  nextStarFilter("off") === "unstarred" && nextStarFilter("unstarred") === "starred" && nextStarFilter("starred") === "off",
);
check("a value that is not a state restarts the cycle", nextReadFilter("all") === "off" && nextStarFilter(7) === "off");

const list = readFileSync(new URL("../../src/components/ArticleList.svelte", import.meta.url), "utf8");
const switches = list.match(/class="filter"/g) ?? [];
check("the two switches are two buttons, not four", switches.length === 2, String(switches.length));
check("no pair wrapper is left behind", !/class="filterpair"/.test(list));
check(
  "each button walks its own cycle",
  /onclick=\{\(\) => reading\.setReadFilter\(nextReadFilter\(reading\.readFilter\)\)\}/.test(list) &&
    /onclick=\{\(\) => reading\.setStarFilter\(nextStarFilter\(reading\.starFilter\)\)\}/.test(list),
);
check(
  "a switch is pressed only when it is filtering",
  /class:on=\{reading\.readFilter !== "off"\}/.test(list) && /class:on=\{reading\.starFilter !== "off"\}/.test(list),
);
// Every state has its own glyph, so the button says which half is showing
// rather than only whether something is on.
check(
  "the read switch draws off, unread and read",
  /\{#if reading\.readFilter === "read"\}/.test(list) &&
    /\{:else if reading\.readFilter === "unread"\}/.test(list) &&
    /\{:else\}/.test(list) &&
    /<circle cx="8" cy="8" r="5\.4" \/><path d="M5\.2 8\.2l2 2 3\.6-3\.9" \/>/.test(list),
);
check(
  "the star switch draws off, not favourited and favourited",
  /\{#if reading\.starFilter === "starred"\}/.test(list) &&
    /\{:else if reading\.starFilter === "unstarred"\}/.test(list) &&
    /class="filled"/.test(list) &&
    /d="M3\.4 13\.4L12\.6 2\.9"/.test(list),
);
// The row's own mark uses the same circle, ticked only once the post is read.
check(
  "a row's mark is a hollow circle until the post is read",
  /\{#if isRead\(item\)\}<path\s+d="M5\.2 8\.2l2 2 3\.6-3\.9"/.test(list),
);
check("no All button is left beside them", !/All<\/button>/.test(list) && !/ARTICLE_FILTERS/.test(list));
check(
  "an inert switch is dimmed",
  /\.filter \{[\s\S]{0,600}?opacity: 0\.5;/.test(list) && /\.filter\.on \{[\s\S]{0,200}?opacity: 1;/.test(list),
);
// Two switches, one row, 390px: thumb-sized on a phone, the same box as the
// view icons beside them -- both read the bar's --viewbox-*, so they cannot
// drift apart again.
check(
  "the switches are thumb targets on a phone",
  /@media \(pointer: coarse\)[\s\S]*?\n    \.filter \{[\s\S]{0,320}?width: var\(--viewbox-w\);/.test(list),
);
// A press is answered on the frame the pointer goes down, and the bar says so in
// one voice: the four shapes give the same acknowledgement the filters beside
// them already gave, at the same value (the band's .ctl is 0.97; this group is
// 0.95 on both sides of the gap).
check(
  "the shapes answer a press the way the filters do",
  /\.viewicon:active \{\s*transform: scale\(0\.95\);/.test(list) &&
    /\.filter:active \{\s*transform: scale\(0\.95\);/.test(list),
);
check(
  "...and that press is short, not a jump",
  /\.viewicon \{[\s\S]{0,700}?transform 0\.08s ease;/.test(list),
);
check(
  "...and focus reads like hover, not only as an outline ring",
  /\.viewicon:hover,\s*\n  \.viewicon:focus-visible \{/.test(list),
);
// "or just read": an empty unread list offers the half that has the posts, in
// one press, without asking the server.
check(
  "an empty unread list offers what you have read",
  /reading\.readFilter === "unread"[\s\S]{0,700}?Nothing unread here\.[\s\S]{0,300}?setReadFilter\("read"\)/.test(list),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
