/**
 * Headless checks for the list view's date tabs.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/date-tabs.mjs
 *
 * The tabs are a fold, not a filter: every post in the list must still be under
 * some week, every week under a month, and closing a tab must take away exactly
 * what is inside it and nothing else. These are the things that would be wrong
 * quietly — a post dropped from the list, a month that shows a count its children
 * do not add up to, a closed week that still emits its posts, and the third fold
 * (a tab per day) creeping back in.
 */
import {
  tabbed,
  millisOf,
  weekKey,
  monthKey,
} from "../../src/lib/date-tabs.ts";

let checks = 0;
let failures = 0;

function check(name, pass, detail = "") {
  checks += 1;
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** A post at a local time, built the way the reader receives one: microseconds. */
function post(id, year, month, day, hour = 12) {
  const millis = new Date(year, month - 1, day, hour).getTime();
  return { id, timestampUsec: String(millis * 1000) };
}

// A hand-built October: two weeks in it, and one post a week back across the
// month line.
const items = [
  post("a", 2026, 10, 23),
  post("b", 2026, 10, 23),
  post("c", 2026, 10, 21),
  post("d", 2026, 10, 19),
  post("e", 2026, 10, 14),
  post("f", 2026, 9, 30),
];

const open = tabbed(items, new Set());
const tabs = open.filter((entry) => entry.kind === "tab").map((entry) => entry.tab);

check("no post is lost in the fold", open.filter((e) => e.kind === "post").length === items.length, String(open.filter((e) => e.kind === "post").length));
check(
  "the order is the list's, untouched",
  open.filter((e) => e.kind === "post").map((e) => e.item.id).join("") === "abcdef",
);
check(
  "a tab reads before what it holds",
  open[0].kind === "tab" && open[0].tab.level === 0,
);
check(
  "a month, then the weeks in it, and nothing between a week and its posts",
  tabs.map((t) => t.level).join("") === "01101",
  tabs.map((t) => t.level).join(""),
);
check("two months", tabs.filter((t) => t.level === 0).length === 2);
check("three weeks", tabs.filter((t) => t.level === 1).length === 3);
check("no day tab anywhere", tabs.every((t) => t.level === 0 || t.level === 1));
check(
  "the month's count is every post under it",
  tabs[0].count === 5,
  String(tabs[0].count),
);
check(
  "the last month's count is its own posts, not the list's",
  tabs.at(-3) === undefined || tabs.filter((t) => t.level === 0)[1].count === 1,
);
check("a week is labelled with its span", /–/.test(tabs[1].label), tabs[1].label);
check("a month is labelled with its name and year", /2026/.test(tabs[0].label), tabs[0].label);

// Closing.
const closedWeek = tabbed(items, new Set([weekKey(new Date(2026, 9, 19))]));
check(
  "closing a week takes its posts with it",
  closedWeek.filter((e) => e.kind === "post").map((e) => e.item.id).join("") === "ef",
  closedWeek.filter((e) => e.kind === "post").map((e) => e.item.id).join(""),
);
check(
  "and its tab stays, shut, with nothing under it",
  (() => {
    const at = closedWeek.findIndex((e) => e.kind === "tab" && e.tab.key === weekKey(new Date(2026, 9, 19)));
    const next = closedWeek[at + 1];
    return closedWeek[at].closed && (next === undefined || next.kind === "tab");
  })(),
);
check(
  "the counts stay counted when a tab is shut",
  closedWeek.find((e) => e.kind === "tab").tab.count === 5,
);

// A post of a shut week is gone; a post of a shut month is gone with its weeks.
const closedMonth = tabbed(items, new Set([monthKey(new Date(2026, 9, 23))]));
check(
  "closing a month leaves only the other month's post",
  closedMonth.filter((e) => e.kind === "post").map((e) => e.item.id).join("") === "f",
);
check(
  "and nothing from the shut month is drawn",
  closedMonth.filter((e) => e.kind === "tab" && e.tab.key.startsWith("w:2026-10")).length === 0,
);

// Shape details.
check("weeks start on Monday", weekKey(new Date(2026, 9, 23)).endsWith("10-19"), weekKey(new Date(2026, 9, 23)));
check("a Monday is its own week", weekKey(new Date(2026, 9, 19)).endsWith("10-19"));
check("a Sunday belongs to the week that began six days before", weekKey(new Date(2026, 9, 25)).endsWith("10-19"));
check("an empty list is an empty fold", tabbed([], new Set()).length === 0);
check("a post with no time still lands in a tab", tabbed([{ id: "x" }], new Set()).filter((e) => e.kind === "tab").length === 2);
check("millisOf prefers the microsecond stamp", millisOf({ timestampUsec: "1000000" }) === 1000);
check("and falls back to the published seconds", millisOf({ published: 2 }) === 2000);

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
