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
check("the star switch walks off, starred, unstarred", STAR_FILTERS.join(",") === "off,starred,unstarred", STAR_FILTERS.join(","));
check(
  "only those states are states",
  isReadFilter("unread") && isReadFilter("off") && !isReadFilter("all") && !isReadFilter(null) &&
    isStarFilter("starred") && isStarFilter("unstarred") && !isStarFilter("all") && !isStarFilter(1),
);


check("a fresh install opens on unread only", READ_FILTER_DEFAULT === "unread" && STAR_FILTER_DEFAULT === "off");

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

// The control is two pairs of buttons drawn from the same tables as the model:
// icon-only, so there is no word to keep in step with the state. Within a pair
// only one can be on, and pressing the one already on turns the pair off — the
// model's "off" is reached that way, because there is no All button for it.
const list = readFileSync(new URL("../../src/components/ArticleList.svelte", import.meta.url), "utf8");
const pairs = list.match(/class="filterpair"/g) ?? [];
check("the switches are drawn in two pairs", pairs.length === 2, String(pairs.length));
check(
  "the read pair is unread and read, one at a time",
  /reading\.setReadFilter\(reading\.readFilter === "unread" \? "off" : "unread"\)/.test(list) &&
    /reading\.setReadFilter\(reading\.readFilter === "read" \? "off" : "read"\)/.test(list),
);
check(
  "the star pair is starred and not starred, one at a time",
  /reading\.setStarFilter\(reading\.starFilter === "starred" \? "off" : "starred"\)/.test(list) &&
    /reading\.setStarFilter\(reading\.starFilter === "unstarred" \? "off" : "unstarred"\)/.test(list),
);
check(
  "each button is pressed only in its own state",
  /class:on=\{reading\.readFilter === "unread"\}/.test(list) &&
    /class:on=\{reading\.readFilter === "read"\}/.test(list) &&
    /class:on=\{reading\.starFilter === "starred"\}/.test(list) &&
    /class:on=\{reading\.starFilter === "unstarred"\}/.test(list),
);
// The read pair reuses the row's own mark icons — a circle, and a circle with a
// tick — so the filter and the row it filters say the same thing.
check(
  "the read pair is the row's circle and circle-with-tick",
  /<circle cx="8" cy="8" r="5\.4" \/><path d="M5\.2 8\.2l2 2 3\.6-3\.9" \/>/.test(list) &&
    /<circle cx="8" cy="8" r="5\.4" \/><\/svg>/.test(list),
);
check("the star pair is one filled glyph and one hollow", /class="filled"/.test(list));
// The hollow star sits on the left and the filled one on the right: "not
// starred" reads as the absence of the mark, so it comes first.
{
  const starPair = list.slice(list.indexOf('aria-label="Favourites or not favourited"'));
  const pair = starPair.slice(0, starPair.indexOf("</div>"));
  const hollow = pair.indexOf('<path d="M8 1.9l1.9 3.9');
  const filled = pair.indexOf('class="filled"');
  check(
    "the hollow star is on the left and the filled star on the right",
    hollow > -1 && filled > -1 && hollow < filled,
    `hollow@${hollow} filled@${filled}`,
  );
}
// The row's own mark uses the same circle, ticked only once the post is read.
check(
  "a row's mark is a hollow circle until the post is read",
  /\{#if isRead\(item\)\}<path\s+d="M5\.2 8\.2l2 2 3\.6-3\.9"/.test(list),
);
check("no All button is left beside them", !/All<\/button>/.test(list) && !/ARTICLE_FILTERS/.test(list));
// A pair that is off filters nothing, and it says so by going dimmer — never
// by a slash drawn across it (it read as a defect, not as a state).
check(
  "an off pair is dimmed and not struck through",
  /class:off=\{reading\.readFilter === "off"\}/.test(list) &&
    /class:off=\{reading\.starFilter === "off"\}/.test(list) &&
    /\.filterpair\.off \.filter \{[\s\S]{0,80}?opacity: 0\.32;/.test(list) &&
    !/\.filterpair\.off::after/.test(list) &&
    !/linear-gradient\(\s*\n\s*to top right/.test(list),
);
check(
  "an inert switch is dimmed",
  /\.filter \{[\s\S]{0,600}?opacity: 0\.5;/.test(list) && /\.filter\.on \{[\s\S]{0,200}?opacity: 1;/.test(list),
);
// Two switches, one row, 390px: thumb-sized on a phone, the same box as the
// view icons beside them.
check(
  "the switches are thumb targets on a phone",
  /@media \(pointer: coarse\)[\s\S]*?\n    \.filter \{[\s\S]{0,320}?width: 30px;/.test(list),
);
// "or just read": an empty unread list offers the half that has the posts, in
// one press, without asking the server.
check(
  "an empty unread list offers what you have read",
  /reading\.readFilter === "unread"[\s\S]{0,700}?Nothing unread here\.[\s\S]{0,300}?setReadFilter\("read"\)/.test(list),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
