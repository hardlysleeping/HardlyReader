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
  admitPicture,
  fetchSize,
  mayKeepPicture,
  thumbnailFirst,
  PRELOAD_AHEAD_DEFAULT,
  SHRINK_FLOOR,
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

// ---------------------------------------------------------------------------
// Whether an address may be kept at all: the scheme, and only the scheme.
// ---------------------------------------------------------------------------
check("a publisher's https picture may be kept", mayKeepPicture(url).keep && mayKeepPicture(url).why === null);
check("so may a plain http one", mayKeepPicture("http://old.test/strip.png").keep);
check("and a protocol-relative one, which is http(s) by the page's answer", mayKeepPicture("//cdn.test/a.png").keep);
check(
  "...including a picture served from the app's own origin, because a self-hosted reader's publisher shares it",
  mayKeepPicture("https://rss.test/f.php?h=abc").keep,
);
{
  const inline = mayKeepPicture("data:image/png;base64,AAAA");
  check("an inline picture is already in the document, so it is not kept", !inline.keep && inline.why === "inline", String(inline.why));
  const local = mayKeepPicture("blob:https://app.test/6f1c");
  check("nor is this device's own memory", !local.keep && local.why === "local", String(local.why));
  const nothing = mayKeepPicture("");
  check("nothing is nothing", !nothing.keep && nothing.why === "empty", String(nothing.why));
  check("...and whitespace is nothing too", mayKeepPicture("   ").why === "empty");
  check("the scheme is read whatever case it was written in", mayKeepPicture("DATA:image/png;base64,AA").why === "inline");
  for (const address of ["file:///home/reader/a.png", "chrome-extension://abc/a.png", "javascript:alert(1)", "asset://localhost/a.png"]) {
    const verdict = mayKeepPicture(address);
    check(`${address.split(":")[0]}: is not a publisher's picture`, !verdict.keep && verdict.why === "scheme", String(verdict.why));
  }
}

// ---------------------------------------------------------------------------
// What to do with a picture that has just been fetched: write it, make room
// first, or do not write it at all.
// ---------------------------------------------------------------------------
{
  const empty = admitPicture(0, { count: 0, bytes: 0 }, 1000);
  check("nothing to write is not written", !empty.store && empty.why === "empty");
  check("...and a size that is not a number is nothing", admitPicture(Number.NaN, { count: 0, bytes: 0 }, 1000).why === "empty");
  const one = admitPicture(PICTURE_MAX_ONE + 1, { count: 0, bytes: 0 }, 2048 * MIB);
  check("a picture past one post's allowance is not kept", !one.store && one.why === "one", String(one.why));
  const ceiling = admitPicture(64, { count: 0, bytes: 0 }, 32);
  check("a picture bigger than the whole budget is not written at all", !ceiling.store && ceiling.why === "ceiling", String(ceiling.why));
  check("a ceiling of zero holds nothing", !admitPicture(1, { count: 0, bytes: 0 }, 0).store);
  check("...and a nonsense ceiling is treated as zero", admitPicture(1, { count: 0, bytes: 0 }, Number.NaN).why === "ceiling");
}
{
  const fits = admitPicture(100, { count: 2, bytes: 800 }, 1000);
  check("a picture that fits is written as it is", fits.store && fits.reserve === 0, JSON.stringify(fits));
  const exact = admitPicture(100, { count: 2, bytes: 900 }, 1000);
  check("one that lands exactly on the ceiling needs no room", exact.store && exact.reserve === 0, JSON.stringify(exact));
  const over = admitPicture(200, { count: 5, bytes: 900 }, 1000);
  check("one that does not fit is still written", over.store, JSON.stringify(over));
  check("...but only after the library is brought down to the ceiling minus its own size", over.reserve === 800, String(over.reserve));
  check(
    "...which leaves exactly the room it needs and not a byte more",
    over.reserve + 200 === 1000,
    `${over.reserve} + 200`,
  );
  const nonsense = admitPicture(100, { count: 1, bytes: Number.NaN }, 1000);
  check("a measurement that is not a number is treated as an empty library", nonsense.store && nonsense.reserve === 0, JSON.stringify(nonsense));
}

// ---------------------------------------------------------------------------
// Downscale at fetch: never upscale, and never bother for a rounding error.
// ---------------------------------------------------------------------------
check("a file within fifteen per cent of the box is already the right file", SHRINK_FLOOR === 1.15);
{
  const unknown = fetchSize(null, THUMB_TARGET);
  check("a file that has not decoded yet is attempted at the box", unknown.downscale && unknown.width === THUMB_TARGET && unknown.why === "unknown", JSON.stringify(unknown));
  check("...and so is one with no size of its own", fetchSize({ width: 0, height: 0 }, THUMB_TARGET).downscale);
  const huge = fetchSize({ width: 4000, height: 3000 }, THUMB_TARGET);
  check("a 4000px photograph is stored at the row's 192", huge.downscale && huge.width === THUMB_TARGET, JSON.stringify(huge));
  const same = fetchSize({ width: 192, height: 192 }, THUMB_TARGET);
  check("a file already at the box is kept as it arrived", !same.downscale && same.why === "small" && same.width === 192, JSON.stringify(same));
  const smaller = fetchSize({ width: 150, height: 150 }, THUMB_TARGET);
  check("a smaller file is never drawn up", !smaller.downscale && smaller.width === 150, JSON.stringify(smaller));
  const close = fetchSize({ width: 200, height: 200 }, THUMB_TARGET);
  check("a file a tenth over the box is not re-encoded", !close.downscale && close.why === "close" && close.width === 200, JSON.stringify(close));
  const just = fetchSize({ width: Math.floor(THUMB_TARGET * SHRINK_FLOOR), height: 200 }, THUMB_TARGET);
  check("at the edge of that band it still is not", !just.downscale, JSON.stringify(just));
  const past = fetchSize({ width: Math.floor(THUMB_TARGET * SHRINK_FLOOR) + 1, height: 200 }, THUMB_TARGET);
  check("one pixel past it, it is", past.downscale && past.width === THUMB_TARGET, JSON.stringify(past));
  const lead = fetchSize({ width: 900, height: 600 }, FULL_TARGET_MAX);
  check("a 900px lead in a 1600px pane is not stretched or re-encoded", !lead.downscale && lead.width === 900, JSON.stringify(lead));
  check("a target that is not a number still names a real width", fetchSize({ width: 4000, height: 10 }, Number.NaN).width === 1);
  check("a fractional file width is rounded, not truncated into a blur", fetchSize({ width: 191.6, height: 10 }, 192).width === 192);
}

// ---------------------------------------------------------------------------
// Thumbnails first: what the list warms, in what order, and how much of it.
// ---------------------------------------------------------------------------
const wish = (address, variant = "thumb") => ({ url: address, variant });
check("two pictures of the card ahead is the default", PRELOAD_AHEAD_DEFAULT === 2);
{
  const strip = ["https://comics.test/p1.png", "https://comics.test/p2.png", "https://comics.test/p3.png"];
  const ordered = thumbnailFirst(strip.map((address) => wish(address)), 2);
  check("a strip warms its first pictures in reading order", ordered.map((one) => one.url).join(",") === `${strip[0]},${strip[1]}`, ordered.map((one) => one.url).join(","));
  check("...and no more than the cap", ordered.length === 2);
  check("a cap of one is a cap of one", thumbnailFirst(strip.map((address) => wish(address)), 1).length === 1);
  check("a cap of none warms nothing", thumbnailFirst(strip.map((address) => wish(address)), 0).length === 0);
  check("...and a cap that is not a number warms nothing either", thumbnailFirst(strip.map((address) => wish(address)), Number.NaN).length === 0);
  check("a fractional cap is floored", thumbnailFirst(strip.map((address) => wish(address)), 2.9).length === 2);
  check("a shorter list than the cap is the whole list", thumbnailFirst(strip.map((address) => wish(address)), 5).length === 3);
}
{
  const page = "https://comics.test/lead.png";
  const both = thumbnailFirst([wish(page, "full"), wish(page, "thumb")], 4);
  check("both copies of one picture: the thumb goes first", both[0].variant === "thumb" && both[1].variant === "full", JSON.stringify(both));
  check("...and it is one wish per copy, not one per address", both.length === 2);
  const twice = thumbnailFirst([wish(page, "thumb"), wish(page, "thumb"), wish(page, "thumb")], 4);
  check("the same wish twice is one fetch", twice.length === 1, JSON.stringify(twice));
  const mixed = thumbnailFirst([wish("https://a.test/1.png", "full"), wish("https://a.test/2.png", "thumb"), wish("https://a.test/3.png", "full")], 4);
  check("every thumbnail is ahead of every lead picture", mixed[0].variant === "thumb", JSON.stringify(mixed));
  const onlyFull = thumbnailFirst([wish("https://a.test/1.png", "full"), wish("https://a.test/2.png", "full")], 4);
  check("a list of lead pictures alone is still warmed in order", onlyFull.map((one) => one.url).join(",") === "https://a.test/1.png,https://a.test/2.png");
}
{
  const refused = thumbnailFirst([wish("data:image/png;base64,AA"), wish(""), wish("file:///a.png"), wish("https://a.test/real.png")], 4);
  check("an address that may not be kept is not warmed", refused.length === 1 && refused[0].url === "https://a.test/real.png", JSON.stringify(refused));
  check("an empty list warms nothing", thumbnailFirst([], 4).length === 0);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
