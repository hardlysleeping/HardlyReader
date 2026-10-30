// The picture cache the panes talk to: what it keeps, what it fetches, and what
// it does when the device is full.
//
// `picture-budget` proves the policy and the `images` table is ordinary store
// code; this is the adapter between them, over a real `LocalStore` on the memory
// engine and a seam that stands in for the webview. So the things only this suite
// can prove are the ones the card is about: **the second draw of a picture makes
// no request**, two panes on one picture cost one download, a picture on screen
// survives the pass, and a library with no cache attached behaves exactly as the
// app did before any of this existed.
//
// The seam is a stub on purpose: no canvas, no network, no CORS. What it cannot
// prove is that a publisher's file decodes and downscales — that is the running
// app's job.
import { LocalStore } from "../../src/api/local/store.ts";
import { MemoryDatabase } from "../../src/api/local/memory-db.ts";
import { createPictureCache, fromBase64, toBase64 } from "../../src/lib/image-cache.ts";
import { PICTURE_MAX_ONE, THUMB_TARGET, pictureKey } from "../../src/lib/images.ts";

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
const THUMB = "https://comics.test/pages/strip.png";
const PHOTO = "https://photos.test/one.jpg";
const PANEL = "https://comics.test/pages/panel-2.png";
const GHOST = "https://gone.test/missing.jpg";

/**
 * What each address is made of, as far as this suite is concerned: the bytes the
 * network answers with, and the bytes the "downscale" asks to keep.
 */
const pages = new Map([
  [THUMB, { source: new Uint8Array([1, 2, 3, 4, 5, 6, 7]), copy: new Uint8Array([9, 9, 9]) }],
  [PHOTO, { source: new Uint8Array([8, 8, 8, 8, 8]), copy: new Uint8Array([7, 7, 7, 7]) }],
  [PANEL, { source: new Uint8Array([2, 2, 2]), copy: new Uint8Array([3, 3, 3, 3, 3, 3]) }],
]);

const downloads = [];
const targets = [];
const revoked = [];
let minted = 0;

/** The webview, as this suite pretends it answers. */
const seam = {
  async download(url) {
    downloads.push(url);
    const page = pages.get(url);
    // A picture every origin refuses: the pane must fall back to the address it
    // was given rather than draw nothing.
    if (page === undefined) return null;
    return new Blob([page.source], { type: "image/png" });
  },
  async downscale(blob, width) {
    // The bytes are answered by address: a Blob carries no name of its own, and
    // the last download is the one being scaled.
    const page = pages.get(downloads[downloads.length - 1]);
    targets.push(width);
    if (page === undefined || blob.size === 0) return null;
    const copy = new Blob([page.copy], { type: "image/webp" });
    return { blob: copy, mime: "image/webp", width, height: width };
  },
  objectUrl() {
    minted += 1;
    return `blob:test/${minted}`;
  },
  revoke(address) {
    revoked.push(address);
  },
};

const store = new LocalStore(new MemoryDatabase());

let mode = "thumbs";
let limit = 200 * MIB;
let reported = null;
let cleared = null;

const cache = createPictureCache({
  library: () => store,
  keeping: () => mode,
  limit: () => limit,
  measured: (usage) => {
    reported = usage;
  },
  cleared: (pruned) => {
    cleared = pruned;
  },
  seam,
  density: () => 2,
});

// ---------------------------------------------------------------------------
// 1. The first draw fetches once, downscales to the row's box, keeps it, and
//    draws the device's own copy.
// ---------------------------------------------------------------------------
const first = cache.draw(THUMB, "thumb");
check("a picture the device has never drawn has nothing to show yet", first.src === null);
const address = await first.settled;

check("and then it draws the device's own copy", typeof address === "string" && address.startsWith("blob:test/"), String(address));
check("one request, once", downloads.filter((url) => url === THUMB).length === 1, String(downloads.length));
check("downscaled to the box the row draws", targets[0] === THUMB_TARGET, String(targets[0]));

{
  const key = pictureKey("thumb", THUMB);
  const kept = await store.keptImage(key);
  check("the copy is in the library", kept !== null);
  check("at the stored size, not the file's", kept.width === THUMB_TARGET, `w=${kept?.width}`);
  check("with a name for its format", kept.mime === "image/webp", kept?.mime);
  check(
    "and it costs what the stored text costs",
    kept.bytes === toBase64(pages.get(THUMB).copy).length,
    `${kept.bytes} vs ${toBase64(pages.get(THUMB).copy).length}`,
  );
  check("the cache reports one picture", reported.count === 1, JSON.stringify(reported));
  check("of the bytes it wrote", reported.bytes === kept.bytes, JSON.stringify(reported));
}

// ---------------------------------------------------------------------------
// 2. A second pane on the same picture draws it in hand — no request, no read.
// ---------------------------------------------------------------------------
const second = cache.draw(THUMB, "thumb");
check("a picture already in hand is drawn at once", second.src !== null, String(second.src));
check("it is the same address", second.src === address, `${second.src} / ${address}`);
check("with no second request", downloads.filter((url) => url === THUMB).length === 1, String(downloads.length));
await second.settled;
second.release();
first.release();

// ---------------------------------------------------------------------------
// 3. Drawn again after its address was given back: the copy comes off the disk,
//    and that is the difference between a cache and a memo.
// ---------------------------------------------------------------------------
{
  const before = downloads.filter((url) => url === THUMB).length;
  const again = cache.draw(THUMB, "thumb");
  check("an address given back is not a picture kept in memory", again.src === null);
  const found = await again.settled;
  again.release();
  check("the copy comes back off the device", found !== null && found.startsWith("blob:test/"), String(found));
  check(
    "with no request to the publisher",
    downloads.filter((url) => url === THUMB).length === before,
    String(downloads.length),
  );
}

// ---------------------------------------------------------------------------
// 4. Two panes on one picture cost one download.
// ---------------------------------------------------------------------------
{
  const one = cache.draw(PANEL, "thumb");
  const two = cache.draw(PANEL, "thumb");
  const [left, right] = await Promise.all([one.settled, two.settled]);
  one.release();
  two.release();
  check("both panes draw the same picture", left !== null && left === right, `${left} / ${right}`);
  check("and they cost one request between them", downloads.filter((url) => url === PANEL).length === 1);
}

// ---------------------------------------------------------------------------
// 5. A picture that cannot be fetched falls back to the publisher's own address —
//    a hole is never an option, and a failure is not kept as a picture.
// ---------------------------------------------------------------------------
{
  const shot = cache.draw(GHOST, "thumb");
  const fallback = await shot.settled;
  shot.release();
  check("a refused picture draws its address anyway", fallback === GHOST, String(fallback));
  check("and is not kept", (await store.keptImage(pictureKey("thumb", GHOST))) === null);
}

// ---------------------------------------------------------------------------
// 6. A server's library, and a device asked to keep nothing: the app exactly as
//    it was. No cache attached, no new request.
// ---------------------------------------------------------------------------
{
  mode = "off";
  const before = downloads.length;
  const off = cache.draw(PHOTO, "thumb");
  check("with keeping off the address is drawn straight away", off.src === PHOTO, String(off.src));
  check("and that is what it settles on", (await off.settled) === PHOTO);
  check("with no request of its own", downloads.length === before);
  off.release();
  mode = "thumbs";
}
{
  const detached = createPictureCache({
    library: () => null,
    keeping: () => "all",
    limit: () => limit,
    measured: () => {},
    seam,
    density: () => 2,
  });
  const before = downloads.length;
  const shot = detached.draw(PHOTO, "thumb");
  check("a server's library draws the publisher's address", shot.src === PHOTO);
  check("and settles on it", (await shot.settled) === PHOTO);
  check("with no request the app was not already making", downloads.length === before);
  check("and keeps nothing", (await store.keptImage(pictureKey("thumb", PHOTO))) === null);
}

// ---------------------------------------------------------------------------
// 7. Thumbnails keeps the list's pictures and not the article's; Everything keeps
//    both, the article's at the column's own width.
// ---------------------------------------------------------------------------
{
  const before = downloads.length;
  const lead = cache.draw(PHOTO, "full", 700);
  check("with thumbnails chosen, an article's picture is not kept", lead.src === PHOTO);
  check("...and not fetched for the cache", downloads.length === before);

  mode = "all";
  const shot = cache.draw(PHOTO, "full", 700);
  const keptAddress = await shot.settled;
  shot.release();
  check("with everything chosen, it is fetched and kept", keptAddress !== null && keptAddress.startsWith("blob:test/"));
  const kept = await store.keptImage(pictureKey("full", PHOTO));
  check(
    "at the width of the column, at this screen's density",
    kept !== null && kept.width === 1400,
    `${kept?.width}`,
  );
  const rows = await store.pictures();
  check(
    "the article's copy is a row of its own",
    rows.some((row) => row.key === pictureKey("full", PHOTO)) &&
      !rows.some((row) => row.key === pictureKey("thumb", PHOTO)),
    rows.map((row) => row.key.replace("\n", " ")).join(" | "),
  );
  mode = "thumbs";
}

// ---------------------------------------------------------------------------
// 8. One picture is never worth the whole budget.
// ---------------------------------------------------------------------------
{
  const huge = "https://comics.test/pages/enormous.png";
  pages.set(huge, { source: new Uint8Array([1]), copy: new Uint8Array(Math.round(PICTURE_MAX_ONE * 0.8)) });
  const shot = cache.draw(huge, "thumb");
  const fallback = await shot.settled;
  shot.release();
  check("a picture past the one-picture ceiling is not kept", (await store.keptImage(pictureKey("thumb", huge))) === null);
  check("...and is drawn from the publisher instead", fallback === huge, String(fallback));
}

// ---------------------------------------------------------------------------
// 9. Eviction: the least recently drawn picture goes, what is on screen stays,
//    and the bytes of a dropped picture go with its row.
// ---------------------------------------------------------------------------
{
  const shelf = new LocalStore(new MemoryDatabase());
  const press = createPictureCache({
    library: () => shelf,
    keeping: () => "thumbs",
    limit: () => limit,
    measured: (usage) => {
      reported = usage;
    },
    cleared: (pruned) => {
      cleared = pruned;
    },
    seam,
    density: () => 2,
  });
  const names = ["a", "b", "c"];
  const keys = names.map((name) => pictureKey("thumb", `https://comics.test/${name}.png`));
  for (const [index, key] of keys.entries()) {
    await shelf.saveImage({
      key,
      url: `https://comics.test/${names[index]}.png`,
      variant: "thumb",
      mime: "image/webp",
      width: 192,
      height: 192,
      data: "AAAA",
    });
  }

  // `a` is on screen and is the oldest thing held: the pass has to give way for
  // it, which is the one case where the ceiling is allowed to be broken.
  const onScreen = press.draw("https://comics.test/a.png", "thumb");
  await onScreen.settled;
  await shelf.touchImage(keys[0], 1000);
  await shelf.touchImage(keys[1], 2000);
  await shelf.touchImage(keys[2], 3000);

  limit = 8;
  cleared = null;
  const usage = await press.settle();
  check("the picture on screen stayed", (await shelf.keptImage(keys[0])) !== null);
  check("and so did the newest", (await shelf.keptImage(keys[2])) !== null);
  check("the least recently drawn one that was not on screen went", (await shelf.keptImage(keys[1])) === null);
  check("the pass reports what it cleared", cleared !== null && cleared.dropped === 1, JSON.stringify(cleared));
  check("including the keys, so the cache can let go of them", cleared.keys.length === 1 && cleared.keys[0] === keys[1], JSON.stringify(cleared?.keys));
  check("and the usage says what survived", usage.count === 2 && usage.bytes === 8, JSON.stringify(usage));
  onScreen.release();
}

// ---------------------------------------------------------------------------
// 10. A ceiling that cannot be met without taking what is on screen says so.
// ---------------------------------------------------------------------------
{
  const shelf = new LocalStore(new MemoryDatabase());
  const press = createPictureCache({
    library: () => shelf,
    keeping: () => "thumbs",
    limit: () => 4,
    measured: () => {},
    cleared: (pruned) => {
      cleared = pruned;
    },
    seam,
    density: () => 2,
  });
  const key = pictureKey("thumb", "https://comics.test/one.png");
  await shelf.saveImage({
    key,
    url: "https://comics.test/one.png",
    variant: "thumb",
    mime: "image/webp",
    width: 192,
    height: 192,
    data: "AAAAAAAA",
  });
  const shot = press.draw("https://comics.test/one.png", "thumb");
  await shot.settled;
  cleared = null;
  const usage = await press.settle();
  check("a ceiling that would take the picture on screen is not honoured", cleared?.overLimit === true, JSON.stringify(cleared));
  check("nothing was taken", cleared?.dropped === 0, JSON.stringify(cleared));
  check("the picture is still there, and still counted", (await shelf.keptImage(key)) !== null && usage.count === 1, JSON.stringify(usage));
  shot.release();
}

// ---------------------------------------------------------------------------
// 11. The tie-break, through the table: two pictures stamped identically are
//     ordered by their key, so the same library evicts the same picture twice.
// ---------------------------------------------------------------------------
{
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const shelf = new LocalStore(new MemoryDatabase());
    for (const name of ["zeta", "alpha"]) {
      await shelf.saveImage({
        key: pictureKey("thumb", `https://comics.test/${name}.png`),
        url: `https://comics.test/${name}.png`,
        variant: "thumb",
        mime: "image/webp",
        width: 192,
        height: 192,
        data: "AAAA",
      });
    }
    const stamped = await shelf.pictures();
    check(
      "both pictures carry the same used_at and stored_at",
      stamped.length === 2 &&
        stamped[0].usedAt === stamped[1].usedAt &&
        stamped[0].storedAt === stamped[1].storedAt,
      JSON.stringify(stamped),
    );
    const pass = await shelf.pruneImages(6, {});
    const byKey = [...stamped].sort((a, b) => (a.key < b.key ? -1 : 1));
    check("the key decides, and it is the one that sorts first", pass.keys[0] === byKey[0].key, pass.keys.join(","));
    check("one picture survived", (await shelf.pictures()).length === 1);
    check("with its bytes", (await shelf.keptImage(byKey[1].key)) !== null);
  } finally {
    Date.now = realNow;
  }
}

// ---------------------------------------------------------------------------
// 12. Giving the addresses back: nothing leaks when the library changes.
// ---------------------------------------------------------------------------
{
  const holding = cache.draw(THUMB, "thumb");
  await holding.settled;
  const before = revoked.length;
  cache.detach();
  check("an address in use is given back when the library goes", revoked.length > before, `${revoked.length - before}`);
  check("and the numbers start again", reported.count === 0 && reported.bytes === 0, JSON.stringify(reported));
}

// ---------------------------------------------------------------------------
// 13. The text column: base64 by hand, and back again, byte for byte.
// ---------------------------------------------------------------------------
{
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 42]);
  check("base64 is the usual alphabet", toBase64(new Uint8Array([77, 97, 110])) === "TWFu", toBase64(new Uint8Array([77, 97, 110])));
  check("padding is written", toBase64(new Uint8Array([77, 97])) === "TWE=", toBase64(new Uint8Array([77, 97])));
  check("a picture's bytes survive the trip", fromBase64(toBase64(bytes)).join(",") === bytes.join(","));
  check("an empty picture is an empty string", toBase64(new Uint8Array([])) === "");
  check("...and reads back empty", fromBase64("").length === 0);
  check("junk does not throw", fromBase64("= = =").length === 0);
}

// ---------------------------------------------------------------------------
// 14. What is never fetched, and what is never written.
// ---------------------------------------------------------------------------
{
  const shelf = new LocalStore(new MemoryDatabase());
  const press = createPictureCache({
    library: () => shelf,
    keeping: () => "thumbs",
    limit: () => 40,
    measured: () => {},
    seam,
    density: () => 2,
  });
  const before = downloads.length;
  const inline = "data:image/png;base64,iVBORw0KGgo=";
  const shot = press.draw(inline, "thumb");
  check("an inline picture is drawn exactly as the article wrote it", shot.src === inline, String(shot.src));
  check("and settles on itself", (await shot.settled) === inline);
  shot.release();
  press.preload(inline, "thumb");
  const elsewhere = "file:///home/reader/pictures/one.png";
  const local = press.draw(elsewhere, "thumb");
  check("a file on this machine is not a publisher's picture", local.src === elsewhere, String(local.src));
  check("neither of them costs a request", downloads.length === before, String(downloads.length - before));
  check("and neither is kept", (await shelf.pictures()).length === 0);

  // A picture larger than the whole ceiling would be written and then evicted by
  // the next pass: the write is not made at all, and the hotlink draws it.
  const big = "https://comics.test/pages/over-ceiling.png";
  pages.set(big, { source: new Uint8Array([5]), copy: new Uint8Array(40) });
  const over = press.draw(big, "thumb");
  const fallback = await over.settled;
  over.release();
  check("a picture bigger than the whole budget is not written", (await shelf.keptImage(pictureKey("thumb", big))) === null);
  check("and is drawn from the publisher instead", fallback === big, String(fallback));
}

// ---------------------------------------------------------------------------
// 15. Room is made before a picture is written, not after it.
// ---------------------------------------------------------------------------
{
  const shelf = new LocalStore(new MemoryDatabase());
  const passes = [];
  const press = createPictureCache({
    library: () => shelf,
    keeping: () => "thumbs",
    limit: () => 12,
    measured: () => {},
    cleared: (pruned) => passes.push(pruned),
    seam,
    density: () => 2,
  });
  const names = ["old", "mid", "new"];
  const addresses = names.map((name) => `https://comics.test/room/${name}.png`);
  for (const address of addresses) {
    pages.set(address, { source: new Uint8Array([1, 2, 3]), copy: new Uint8Array([4, 5, 6]) });
    const shot = press.draw(address, "thumb");
    await shot.settled;
    shot.release();
  }
  check("three pictures of four bytes each fill a twelve-byte ceiling", (await shelf.imageUsage()).bytes === 12, JSON.stringify(await shelf.imageUsage()));
  // The order of use, said out loud: the tie-break would otherwise be the key.
  for (const [index, address] of addresses.entries()) {
    await shelf.touchImage(pictureKey("thumb", address), 100 * (index + 1));
  }

  const fourth = "https://comics.test/room/fourth.png";
  pages.set(fourth, { source: new Uint8Array([7, 8, 9]), copy: new Uint8Array([7, 8, 9]) });
  const shot = press.draw(fourth, "thumb");
  const drawn = await shot.settled;
  shot.release();

  const kept = (await shelf.pictures()).map((row) => row.key);
  check("the picture that needed room is kept", kept.includes(pictureKey("thumb", fourth)), kept.join(" | "));
  check("and it is drawn from this device", drawn !== null && drawn.startsWith("blob:test/"), String(drawn));
  check("the least recently drawn one made the room", !kept.includes(pictureKey("thumb", addresses[0])), kept.join(" | "));
  check("nothing else was taken", kept.length === 3, kept.join(" | "));
  check("and the library is still inside the ceiling", (await shelf.imageUsage()).bytes === 12, JSON.stringify(await shelf.imageUsage()));
  check("the pass that made the room said so", passes.length === 1 && passes[0].dropped === 1, JSON.stringify(passes));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
