/**
 * What the app says when a category move reaches the account.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/feed-move-notice.mjs
 *
 * The move itself is drawn before it is written, so the sidebar cannot tell the
 * reader whether FreshRSS took it — the confirmation line is the only place that
 * says so, and these are the three shapes it has to get right: into a category,
 * out of one (Uncategorized is the absence of a label), and a feed whose title
 * is missing or blank.
 */
import { moveNotice } from "../../src/lib/feed-move.ts";

const cases = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  cases.push({ name, ok, actual, expected });
}

check(
  "into a category",
  moveNotice("9to5linux", "FOSS"),
  "Moved 9to5linux to FOSS — synced",
);

check(
  "out of a category, to Uncategorized",
  moveNotice("9to5linux", null),
  "Moved 9to5linux to Uncategorized — synced",
);

check(
  "an empty label means Uncategorized, not an empty folder name",
  moveNotice("9to5linux", ""),
  "Moved 9to5linux to Uncategorized — synced",
);

check("a blank title still reads as a sentence", moveNotice("  ", "FOSS"), "Moved Feed to FOSS — synced");

check(
  "a long title is passed through untouched",
  moveNotice("9to5Linux Weekly Roundup", "FOSS"),
  "Moved 9to5Linux Weekly Roundup to FOSS — synced",
);

let failed = 0;
for (const c of cases) {
  if (c.ok) {
    console.log(`ok   ${c.name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${c.name}\n     expected: ${c.expected}\n     actual:   ${c.actual}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
