import { readFileSync } from "node:fs";

import {
  ARTICLE_FILTERS,
  ARTICLE_FILTER_LABELS,
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

check("the control offers four filters", ARTICLE_FILTERS.join(",") === "unread,all,read,starred", ARTICLE_FILTERS.join(","));
check("only those four are filters", isArticleFilter("unread") && isArticleFilter("read") && !isArticleFilter("everything") && !isArticleFilter(null));

check("unread keeps the unread posts", filterItems(items, "unread").map((i) => i.id).join(",") === "a,c", filterItems(items, "unread").map((i) => i.id).join(","));
check("...including starred-but-unread ones", filterItems(items, "unread").some((i) => i.id === "c"));
check("...and drops the read ones", !filterItems(items, "unread").some((i) => i.id === "b" || i.id === "d"));

check("all keeps everything in order", filterItems(items, "all").map((i) => i.id).join(",") === "a,b,c,d");
check("all returns a copy, not the same array", filterItems(items, "all") !== items);

check("starred keeps only starred", filterItems(items, "starred").map((i) => i.id).join(",") === "c,d", filterItems(items, "starred").map((i) => i.id).join(","));

// "or just read": a feed with nothing new is not an empty feed once you can ask
// for what you have already read. Read is the exact other half of unread, so the
// two never lose a post between them.
const readIds = filterItems(items, "read").map((i) => i.id).join(",");
check("read keeps the read posts", readIds === "b,d", readIds);
check("...and nothing unread", !filterItems(items, "read").some((i) => i.id === "a" || i.id === "c"));
check("read and unread together are everything", filterItems(items, "read").length + filterItems(items, "unread").length === items.length);
check("...in the same order the server sent", filterItems(items, "read")[0].id === "b" && filterItems(items, "read")[1].id === "d");
check("a starred post that was also read is in both", filterItems(items, "read").some((i) => i.id === "d") && filterItems(items, "starred").some((i) => i.id === "d"));
check("a feed with nothing new still has its read posts", filterItems([{ ...unread, categories: [...unread.categories, READ] }], "read").length === 1);

check("an empty stream stays empty", ["unread", "all", "read", "starred"].every((f) => filterItems([], f).length === 0));

// The filter must not mutate what the cache holds: switching back has to show
// the same posts, in the same order.
const before = items.map((i) => i.id).join(",");
filterItems(items, "unread");
filterItems(items, "read");
filterItems(items, "starred");
check("filtering leaves the source list untouched", items.map((i) => i.id).join(",") === before);

// Reading a post while "unread" is on removes it from the list on the next
// render, which is exactly what the reader wants — as long as the rule is the
// read state and not a snapshot.
const nowRead = [{ ...unread, categories: [...unread.categories, READ] }];
check("the rule is the state, not a snapshot: a post read in place drops out", filterItems(nowRead, "unread").length === 0);

// The pill and the way out of an empty unread list are drawn from the same
// table, so a filter cannot exist in the model and be missing from the control.
check("every filter has a word of its own", ARTICLE_FILTERS.every((f) => (ARTICLE_FILTER_LABELS[f] ?? "").length > 0));
const list = readFileSync(new URL("../../src/components/ArticleList.svelte", import.meta.url), "utf8");
check("the control is drawn from the table, not a second list", /\{#each ARTICLE_FILTERS as filter/.test(list));
check("...and Read's label comes from it too", /\{ARTICLE_FILTER_LABELS\[filter\]\}/.test(list));
// "or just read": an empty unread list offers the half that has the posts, in
// one press, without asking the server.
check(
  "an empty unread list offers what you have read",
  /reading\.articleFilter === "unread"[\s\S]{0,400}?Nothing unread here\.[\s\S]{0,200}?setFilter\("read"\)/.test(list),
);
// Four pills, one row, 390px: the thumb-sized pill in the coarse block is
// narrower than it was and the gaps come in with it, because measured at the
// old size the fourth ran 20px off the header's edge.
check(
  "the pills tighten so four fit one row on a phone",
  /@media \(pointer: coarse\)[\s\S]*?\n    \.filter \{[\s\S]{0,320}?padding: 6px 7px;/.test(list) &&
    /\n    \.filters \{\s*\n      gap: 3px;/.test(list),
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
