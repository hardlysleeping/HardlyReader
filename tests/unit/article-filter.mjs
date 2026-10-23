import {
  ARTICLE_FILTERS,
  filterItems,
  isArticleFilter,
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

check("the control offers three filters", ARTICLE_FILTERS.join(",") === "unread,all,starred", ARTICLE_FILTERS.join(","));
check("only those three are filters", isArticleFilter("unread") && !isArticleFilter("read") && !isArticleFilter(null));

check("unread keeps the unread posts", filterItems(items, "unread").map((i) => i.id).join(",") === "a,c", filterItems(items, "unread").map((i) => i.id).join(","));
check("...including starred-but-unread ones", filterItems(items, "unread").some((i) => i.id === "c"));
check("...and drops the read ones", !filterItems(items, "unread").some((i) => i.id === "b" || i.id === "d"));

check("all keeps everything in order", filterItems(items, "all").map((i) => i.id).join(",") === "a,b,c,d");
check("all returns a copy, not the same array", filterItems(items, "all") !== items);

check("starred keeps only starred", filterItems(items, "starred").map((i) => i.id).join(",") === "c,d", filterItems(items, "starred").map((i) => i.id).join(","));
check("an empty stream stays empty", ["unread", "all", "starred"].every((f) => filterItems([], f).length === 0));

// The filter must not mutate what the cache holds: switching back has to show
// the same posts, in the same order.
const before = items.map((i) => i.id).join(",");
filterItems(items, "unread");
filterItems(items, "starred");
check("filtering leaves the source list untouched", items.map((i) => i.id).join(",") === before);

// Reading a post while "unread" is on removes it from the list on the next
// render, which is exactly what the reader wants — as long as the rule is the
// read state and not a snapshot.
const nowRead = [{ ...unread, categories: [...unread.categories, READ] }];
check("the rule is the state, not a snapshot: a post read in place drops out", filterItems(nowRead, "unread").length === 0);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
