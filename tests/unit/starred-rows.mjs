/**
 * A starred post is marked in the star's colour — read or not.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/starred-rows.mjs
 *
 * The report this answers: "in starred some feeds don't have the gold color, i think it's because
 * they were starred off the app". The cause was not where the star was made. The accent edge on a
 * row was drawn only for an unread post (`:not(.read)`), and a read post is dimmed to 0.48, so a
 * post read this morning and starred this afternoon had **no gold at all** — the star button was
 * the only mark, at 48%, which reads as a dull mustard rather than as the colour that says starred.
 *
 * Two promises now:
 *
 *   - the edge belongs to `:where(:not(.read), .starred)`, so a starred row keeps it once read;
 *   - the WASH stays unread-only, so "new" and "starred" are still told apart at a glance; and
 *   - a starred read row dims to 0.62 rather than 0.48, because at 0.48 the gold goes to mustard.
 *
 * These are stylesheet contracts, checked the way this repo checks CSS (the source the browser
 * reads), because the reader's own markup only carries `class:starred={isStarred(item)}`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`PASS  ${name}${detail === undefined ? "" : `  (${detail})`}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${detail})`}`);
}

const listSource = read("src/components/ArticleList.svelte");
const freshrssSource = read("src/api/freshrss.ts");

/** The body of the first rule whose selector contains `needle`. */
function ruleBody(needle) {
  const at = listSource.indexOf(needle);
  if (at < 0) return "";
  const open = listSource.indexOf("{", at);
  const close = listSource.indexOf("\n  }", open);
  return close < 0 ? "" : listSource.slice(open + 1, close);
}

/* ---------------------------------------------------------------------------
 * The star is a fact about the post, not about whether it is new
 * ------------------------------------------------------------------------ */

check(
  "a starred row keeps the star's edge after it has been read",
  (listSource.match(/\.row:where\(:not\(\.read\), \.starred\)::after/g) ?? []).length >= 5,
  "every shape: the pill, its mirror, both ends, the foot, and the foot hung from the top",
);

check(
  "and the edge is the star's colour on it, not the app's accent",
  /\.row\.starred \{\s*--accent: var\(--star\);/.test(listSource),
);

check(
  "the wash stays the unread language, so a read starred row is still told apart",
  /\.items:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.row\.read\.starred::after \{\s*background: none;/.test(
    listSource,
  ),
  "the wash and its dark band come off, the border stays",
);

check(
  "a read starred row dims to 0.62, where the gold is still gold",
  /\.row\.read\.starred \{\s*opacity: 0\.62;/.test(listSource),
);

check(
  "a plain read row still steps back to 0.48",
  /\.row\.read \{\s*opacity: 0\.48;/.test(listSource),
);

check(
  "and a pointer still brightens any read row it is over",
  listSource.indexOf(".row.read.starred") < listSource.indexOf(".row.read:hover"),
  "the starred dim is declared above the hover rule, so equal specificity lets the hover win",
);

/* ---------------------------------------------------------------------------
 * The mark itself, which was never the broken half
 * ------------------------------------------------------------------------ */

check(
  "a starred post fills its star instead of recolouring it",
  /\.act\.star\.on svg \{\s*fill: currentColor;/.test(listSource),
);

check(
  "the star's ink is the star's colour, not the accent",
  /\.act\.star \{\s*color: var\(--act-star\);/.test(listSource),
);

check(
  "a starred row always shows its actions, so the filled star is never hover-only",
  /\.act\.on,/.test(listSource) && /\.row:hover \.act,/.test(listSource),
);

/* ---------------------------------------------------------------------------
 * The reading that decides it, and where it comes from
 * ------------------------------------------------------------------------ */

check(
  "starred is read off the item's own state, so a star made anywhere counts",
  /const STARRED_STATE_SUFFIX = "\/state\/com\.google\/starred";/.test(freshrssSource) &&
    /export function isStarred\(item: StreamItem\): boolean \{\s*return hasState\(item, STARRED_STATE_SUFFIX\);/.test(
      freshrssSource,
    ),
  "the suffix test, which matches FreshRSS's user/- and Miniflux's user/1 spelling alike",
);

check(
  "and the row takes it from that function, never from a local star list",
  /class:starred=\{isStarred\(item\)\}/.test(listSource),
);

console.log(
  failures === 0
    ? `\n${checks} checks, 0 failure(s)`
    : `\n${checks} checks, ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
