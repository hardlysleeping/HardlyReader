// The picture cache's policy, argued with in the open.
//
// Everything the picture cache decides — how big a copy is worth keeping, what
// goes when the device is full, what may never go, which of two pictures stamped
// with the same second is older — is in `src/lib/images.ts` with no database in
// it, so it is provable here without a browser, a canvas or a network. The
// adapter that uses these answers is `picture-cache.mjs`; the table underneath is
// `picture-store.mjs`.
import {
  PICTURE_BUDGET_CHOICES_MB,
  PICTURE_BUDGET_DEFAULT,
  PICTURE_KEEP_DEFAULT,
  PICTURE_KEEP_LABELS,
  PICTURE_KEEP_MODES,
  PICTURE_KEEP_TITLES,
  PICTURE_MAX_ONE,
  FULL_TARGET_DEFAULT,
  FULL_TARGET_MAX,
  FULL_TARGET_MIN,
  THUMB_TARGET,
  describePictures,
  isPictureBudget,
  isPictureKeepMode,
  keepsVariant,
  pictureKey,
  picturesOverLimit,
  planPictureEviction,
  targetWidth,
} from "../../src/lib/images.ts";
import { formatBytes } from "../../src/lib/bodies.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const MIB = 1024 * 1024;
const record = (key, bytes, usedAt, storedAt = usedAt) => ({ key, bytes, usedAt, storedAt });
const keys = (plan) => plan.drop.join(",");

// ---------------------------------------------------------------------------
// The three answers: off, the list's own pictures, or every picture.
// ---------------------------------------------------------------------------
check("three answers, in order", PICTURE_KEEP_MODES.join(",") === "off,thumbs,all");
check("the list's pictures are what a fresh device keeps", PICTURE_KEEP_DEFAULT === "thumbs");
check(
  "each answer has a word and a sentence",
  PICTURE_KEEP_MODES.every(
    (mode) => PICTURE_KEEP_LABELS[mode] !== "" && PICTURE_KEEP_TITLES[mode].length > 20,
  ),
);
check("off is a real answer and not a missing one", isPictureKeepMode("off"));
check("a word that is not one of the three is refused", !isPictureKeepMode("on"));
check("...and so is a body's word", !isPictureKeepMode("ahead"));

check("off keeps nothing at all", !keepsVariant("off", "thumb") && !keepsVariant("off", "full"));
check(
  "thumbnails keeps the list's pictures and only those",
  keepsVariant("thumbs", "thumb") && !keepsVariant("thumbs", "full"),
);
check(
  "every picture keeps both copies",
  keepsVariant("all", "thumb") && keepsVariant("all", "full"),
);

// ---------------------------------------------------------------------------
// The sizes a copy is stored at.
// ---------------------------------------------------------------------------
check("a thumbnail is stored at 192px, one number for every row", THUMB_TARGET === 192);
check(
  "the article's picture is stored at the width of the column",
  targetWidth("full", 700, 2) === 1400,
  String(targetWidth("full", 700, 2)),
);
check(
  "at most twice the CSS width, whatever the screen says",
  targetWidth("full", 700, 3) === 1400,
  String(targetWidth("full", 700, 3)),
);
check("a pane that has not measured itself yet asks for a sane width", targetWidth("full") === FULL_TARGET_DEFAULT);
check("no pane is wider than this", targetWidth("full", 2000, 2) === FULL_TARGET_MAX);
check("and no copy is stored smaller than this", targetWidth("full", 100, 1) === FULL_TARGET_MIN);
check("a fractional density below one is not a reason to shrink", targetWidth("full", 500, 0.5) === 500);
check("a thumbnail ignores the frame entirely", targetWidth("thumb", 1400, 2) === THUMB_TARGET);

// ---------------------------------------------------------------------------
// The key: one row per picture per variant.
// ---------------------------------------------------------------------------
const url = "https://comics.test/pages/2026-10-21-strip.png";
check("the key names the variant and the address", pictureKey("thumb", url) === `thumb\n${url}`);
check(
  "the two copies of one picture are two rows",
  pictureKey("thumb", url) !== pictureKey("full", url),
);
check(
  "and two addresses are two rows",
  pictureKey("thumb", url) !== pictureKey("thumb", "https://comics.test/other.png"),
);

// ---------------------------------------------------------------------------
// The ceiling.
// ---------------------------------------------------------------------------
check("200 MB is what a device holds", PICTURE_BUDGET_DEFAULT === 200 * MIB);
check("offered as three sizes, middle one the default", PICTURE_BUDGET_CHOICES_MB.join(",") === "100,200,500");
check(
  "and none of them repeats a size the text cache offers",
  PICTURE_BUDGET_CHOICES_MB.every((mb) => ![8, 24, 64].includes(mb)),
  PICTURE_BUDGET_CHOICES_MB.join(","),
);
check(
  "...and the default is one of them",
  PICTURE_BUDGET_CHOICES_MB.some((mb) => mb * MIB === PICTURE_BUDGET_DEFAULT),
);
check("a ceiling under a megabyte is not a ceiling", !isPictureBudget(1024));
check("a sane one is accepted", isPictureBudget(100 * MIB));
check("and a nonsense one is refused", !isPictureBudget(Number.NaN) && !isPictureBudget(-1));
check("one picture is never worth more than this", PICTURE_MAX_ONE === 2 * MIB);

// ---------------------------------------------------------------------------
// Eviction: least recently drawn, then least recently fetched, then by key.
// ---------------------------------------------------------------------------
{
  const plan = planPictureEviction(
    [record("a", 10, 100), record("b", 10, 200), record("c", 10, 300)],
    { limitBytes: 25 },
  );
  check("the least recently drawn picture goes first", keys(plan) === "a", keys(plan));
  check("and only as many as the ceiling needs", plan.drop.length === 1, String(plan.drop.length));
  check("what it freed is counted", plan.freed === 10 && plan.remaining === 20);
  check("nothing is over the limit after one drop", plan.overLimit === false);
}
{
  const plan = planPictureEviction(
    [record("a", 10, 500, 100), record("b", 10, 500, 200), record("c", 10, 500, 300)],
    { limitBytes: 10 },
  );
  check("drawn in the same second, the one fetched first goes first", keys(plan) === "a,b", keys(plan));
}
{
  const plan = planPictureEviction(
    [record("c", 10, 500, 100), record("a", 10, 500, 100), record("b", 10, 500, 100)],
    { limitBytes: 20 },
  );
  check("stamped identically, the key decides — not the engine's order", keys(plan) === "a", keys(plan));
  const reversed = planPictureEviction(
    [record("b", 10, 500, 100), record("c", 10, 500, 100), record("a", 10, 500, 100)],
    { limitBytes: 20 },
  );
  check("...and the same library in another order evicts the same picture", keys(reversed) === keys(plan));
}
{
  const plan = planPictureEviction(
    [record("a", 100, 100), record("b", 100, 200), record("c", 100, 300)],
    { limitBytes: 250, keep: ["a"] },
  );
  check("a picture on screen is never evicted", !plan.drop.includes("a"), keys(plan));
  check("the next oldest goes instead", keys(plan) === "b", keys(plan));
}
{
  const plan = planPictureEviction([record("a", 100, 100), record("b", 100, 200)], {
    limitBytes: 0,
    keep: ["a", "b"],
  });
  check("a ceiling that cannot be met without a hole says so", plan.overLimit === true);
  check("and takes nothing", plan.drop.length === 0 && plan.remaining === 200);
}
{
  const plan = planPictureEviction([record("a", 0, 100), record("b", 0, 200)], { limitBytes: 0 });
  check("an empty row costs nothing and frees nothing", plan.drop.length === 0 && plan.overLimit === false);
}
{
  const plan = planPictureEviction([], { limitBytes: 10 });
  check("an empty library has nothing to evict", plan.drop.length === 0 && plan.freed === 0);
}

// ---------------------------------------------------------------------------
// The sentence the Settings row draws.
// ---------------------------------------------------------------------------
check(
  "nothing kept says so, and what it may hold",
  describePictures({ count: 0, bytes: 0 }, 200 * MIB) === "No saved pictures — up to 200 MB can be kept",
  describePictures({ count: 0, bytes: 0 }, 200 * MIB),
);
check(
  "one picture is singular",
  describePictures({ count: 1, bytes: 1234 }, 100 * MIB) === "1 picture, 1.2 KB of 100 MB",
  describePictures({ count: 1, bytes: 1234 }, 100 * MIB),
);
check(
  "many are counted, measured and capped",
  describePictures({ count: 204, bytes: Math.round(2.4 * MIB) }, 200 * MIB) === "204 pictures, 2.4 MB of 200 MB",
  describePictures({ count: 204, bytes: Math.round(2.4 * MIB) }, 200 * MIB),
);
check(
  "a whole number of megabytes does not grow a decimal",
  describePictures({ count: 12, bytes: 12 * MIB }, 200 * MIB) === "12 pictures, 12 MB of 200 MB",
  describePictures({ count: 12, bytes: 12 * MIB }, 200 * MIB),
);
check("the ceiling reads as the reader chose it", formatBytes(200 * MIB) === "200 MB");
check("over the ceiling is a measurement, not a guess", picturesOverLimit({ count: 1, bytes: 101 * MIB }, 100 * MIB));
check("and at the ceiling is not over it", !picturesOverLimit({ count: 1, bytes: 100 * MIB }, 100 * MIB));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
