import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { cropVariant, firstImageIn, fullSize, imagesOf, panelsOf, resolveUrl, thumbnailOf } from "../../src/lib/thumb.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

const LINK = [{ href: "https://example.com/posts/hello" }];

check("an image enclosure wins over anything in the body", () => {
  const thumb = thumbnailOf({
    alternate: LINK,
    enclosure: [{ href: "https://cdn.example.com/cover.jpg", type: "image/jpeg" }],
    content: { content: '<p><img src="https://example.com/body.jpg"></p>' },
  });
  assert.equal(thumb.kind, "enclosure");
  assert.equal(thumb.url, "https://cdn.example.com/cover.jpg");
});

check("an audio enclosure is not a thumbnail", () => {
  const thumb = thumbnailOf({
    alternate: LINK,
    enclosure: [{ href: "https://cdn.example.com/ep.mp3", type: "audio/mpeg" }],
  });
  assert.equal(thumb.url, null);
  assert.equal(thumb.kind, "none");
});

check("media:thumbnail is used when there is no enclosure", () => {
  const thumb = thumbnailOf({
    alternate: LINK,
    media: { thumbnail: [{ url: "https://cdn.example.com/mrss.jpg" }] },
  });
  assert.equal(thumb.kind, "media");
  assert.equal(thumb.url, "https://cdn.example.com/mrss.jpg");
});

check("media:content only counts when it is an image", () => {
  assert.equal(
    thumbnailOf({ media: { content: [{ url: "https://cdn.example.com/v.mp4", type: "video/mp4" }] } }).url,
    null,
  );
  assert.equal(
    thumbnailOf({ media: { content: [{ url: "https://cdn.example.com/photo.png", type: "image/png" }] } }).url,
    "https://cdn.example.com/photo.png",
  );
});

check("the first body image is the fallback", () => {
  const thumb = thumbnailOf({
    alternate: LINK,
    content: { content: '<p>Text</p><img src="https://example.com/a.jpg"><img src="https://example.com/b.jpg">' },
  });
  assert.equal(thumb.kind, "inline");
  assert.equal(thumb.url, "https://example.com/a.jpg");
});

check("content is read before summary", () => {
  const thumb = thumbnailOf({
    content: { content: '<img src="https://example.com/full.jpg">' },
    summary: { content: '<img src="https://example.com/short.jpg">' },
  });
  assert.equal(thumb.url, "https://example.com/full.jpg");
});

check("a tracker pixel is skipped for the next real image", () => {
  const thumb = thumbnailOf({
    alternate: LINK,
    content: {
      content: '<img src="https://feeds.example.com/pixel.gif"><img src="/images/real.jpg">',
    },
  });
  assert.equal(thumb.url, "https://example.com/images/real.jpg");
});

check("a 1x1 tracked by size in the filename is skipped", () => {
  assert.equal(firstImageIn('<img src="https://a.example.com/1x1.png">'), null);
});

check("a relative src resolves against the post link", () => {
  assert.equal(resolveUrl("/i/pic.jpg", "https://example.com/posts/hello"), "https://example.com/i/pic.jpg");
  assert.equal(resolveUrl("pic.jpg", "https://example.com/posts/hello"), "https://example.com/posts/pic.jpg");
});

check("a protocol-relative src becomes https", () => {
  assert.equal(thumbnailOf({ alternate: LINK, content: { content: '<img src="//cdn.x/y.jpg">' } }).url, "https://cdn.x/y.jpg");
});

check("single quotes, no quotes and extra attributes all parse", () => {
  assert.equal(firstImageIn("<img alt='x' src='https://a/b.jpg' />"), "https://a/b.jpg");
  assert.equal(firstImageIn("<img width=300 src=https://a/c.jpg>"), "https://a/c.jpg");
  assert.equal(firstImageIn('<IMG\n  SRC="https://a/d.jpg">'), "https://a/d.jpg");
});

check("srcset prefers the largest candidate", () => {
  assert.equal(
    firstImageIn('<img srcset="https://a/s.jpg 320w, https://a/l.jpg 1280w" src="https://a/s.jpg">'),
    "https://a/l.jpg",
  );
});

check("an inline data image is allowed, other data URLs are not", () => {
  assert.equal(
    thumbnailOf({ content: { content: '<img src="data:image/png;base64,iVBORw0KGgo=">' } }).url,
    "data:image/png;base64,iVBORw0KGgo=",
  );
  assert.equal(thumbnailOf({ content: { content: '<img src="data:text/html,<b>x</b>">' } }).url, null);
});

check("script and file URLs are refused", () => {
  assert.equal(thumbnailOf({ alternate: LINK, content: { content: '<img src="javascript:alert(1)">' } }).url, null);
  assert.equal(thumbnailOf({ alternate: LINK, content: { content: '<img src="file:///etc/passwd">' } }).url, null);
});

check("a post with no picture anywhere has no thumbnail", () => {
  const thumb = thumbnailOf({ alternate: LINK, summary: { content: "<p>Just words.</p>" } });
  assert.deepEqual(thumb, { url: null, kind: "none" });
  assert.deepEqual(thumbnailOf({}), { url: null, kind: "none" });
});

check("null and empty fields do not throw", () => {
  assert.equal(thumbnailOf({ summary: null, content: null, alternate: null, enclosure: null, media: null }).url, null);
  assert.equal(thumbnailOf({ enclosure: [] }).url, null);
  assert.equal(firstImageIn(null), null);
  assert.equal(firstImageIn(""), null);
});

check("every picture in a post comes back in order for flipping", () => {
  assert.deepEqual(
    imagesOf({
      alternate: LINK,
      content: {
        content:
          '<img src="/p/1.jpg" alt="page one">' +
          '<img src="/p/2.jpg" alt="page two">' +
          '<img src="/p/3.jpg" alt="page three">',
      },
    }),
    ["https://example.com/p/1.jpg", "https://example.com/p/2.jpg", "https://example.com/p/3.jpg"],
  );
});

check("a page's pictures are capped so a gallery cannot make a hundred pips", () => {
  const many = Array.from({ length: 40 }, (_, i) => `<img src="/p/${i}.jpg" alt="">`).join("");
  assert.equal(imagesOf({ alternate: LINK, content: { content: many } }).length, 12);
  assert.equal(imagesOf({ alternate: LINK, content: { content: many } }, 4).length, 4);
});

check("trackers and duplicates are not pages to flip through", () => {
  assert.deepEqual(
    imagesOf({
      content: {
        content: '<img src="https://x.test/pixel.gif" alt="">' +
          '<img src="/p/1.jpg" alt=""><img src="/p/1.jpg" alt="one again">',
      },
      alternate: LINK,
    }),
    ["https://example.com/p/1.jpg"],
  );
});

check("a strip published as separate panels comes back in reading order", () => {
  const panels = panelsOf({
    alternate: LINK,
    content: {
      content:
        '<div class="comic-panel"><img src="https://cdn.example.com/a/1.jpg" alt="Beetle Bailey - Panel 1"></div>' +
        '<div class="comic-panel"><img src="https://cdn.example.com/a/2.jpg" alt="Beetle Bailey - Panel 2"></div>',
    },
  });
  assert.deepEqual(panels, ["https://cdn.example.com/a/1.jpg", "https://cdn.example.com/a/2.jpg"]);
});

check("one panel is just a thumbnail, not a strip", () => {
  assert.deepEqual(
    panelsOf({ content: { content: '<img src="https://cdn.example.com/one.jpg" alt="Zits - Panel 1">' } }),
    [],
  );
});

check("pictures that do not call themselves panels are left to the thumbnail", () => {
  assert.deepEqual(
    panelsOf({
      content: {
        content: '<img src="https://cdn.example.com/a.jpg" alt="Sunday strip">' +
          '<img src="https://cdn.example.com/b.jpg" alt="Illustration">',
      },
    }),
    [],
  );
});

check("panel urls resolve against the post and are not repeated", () => {
  const panels = panelsOf({
    alternate: LINK,
    content: {
      content:
        '<img src="/img/1.jpg" alt="Comic - PANEL 1">' +
        '<img src="/img/1.jpg" alt="Comic - Panel 1">' +
        '<img src="/img/2.jpg" alt="Comic - panel 2">',
    },
  });
  assert.deepEqual(panels, ["https://example.com/img/1.jpg", "https://example.com/img/2.jpg"]);
});

check("panel extraction tolerates missing fields", () => {
  assert.deepEqual(panelsOf({}), []);
  assert.deepEqual(panelsOf({ content: null, summary: null }), []);
});

/* ---------------------------------------------------------------- WordPress
   A feed that publishes only the 150px crop beside the real comic put a soft
   square at the head of every card. These checks pin the sharpening: the URL
   the card asks for, the crop it falls back to when the big file is gone, and
   the shapes that must not be touched. */

const STRIP_CROP = "https://example.test/wp-content/uploads/2026/10/2026-10-21-strip-150x150.jpg";
const STRIP_FULL = "https://example.test/wp-content/uploads/2026/10/2026-10-21-strip.jpg";

/* The entry body exactly as FreshRSS stores it (read from the live DB). */
const STRIP_BODY =
  '<p><a href="https://example.test/comic/strip-2018/" title="strip">' +
  '<img width="150" height="150" src="' + STRIP_CROP + '" alt="" ' +
  'data-sanitized-class="attachment-thumbnail size-thumbnail wp-post-image"></a>\r\n</p>';

const STRIP_ITEM = {
  id: "1792647410983255",
  alternate: [{ href: "https://example.test/comic/strip-2018/" }],
  content: { content: STRIP_BODY },
  summary: { content: STRIP_BODY },
};

check("the 150x150 crop becomes the 780x1054 page, with the crop kept as fallback", () => {
  const thumb = thumbnailOf(STRIP_ITEM);
  assert.equal(thumb.url, STRIP_FULL);
  assert.equal(thumb.kind, "inline");
  assert.equal(thumb.fallback, STRIP_CROP);
  // The card's onerror path asks for this: the file the feed actually named.
  assert.equal(cropVariant(STRIP_FULL), STRIP_CROP);
});

check("the client's own URL — wrapped by the image cache — still sharpens inside the wrapper", () => {
  // FreshRSS's ImageCache extension rewrites every src to the piccache proxy,
  // rawurlencode leaves `-` and `.` alone, so the crop name is still the tail.
  const wrapped = "https://cache.example.test:8449/piccache.php?url=" + encodeURIComponent(STRIP_CROP);
  const wrappedFull = "https://cache.example.test:8449/piccache.php?url=" + encodeURIComponent(STRIP_FULL);
  const thumb = thumbnailOf({ alternate: [{ href: "https://example.test/comic/strip-2018/" }], content: { content: '<img src="' + wrapped + '">' } });
  assert.equal(thumb.url, wrappedFull);
  assert.equal(thumb.fallback, wrapped);
  assert.equal(cropVariant(wrappedFull), wrapped);
  // A plain file behind the proxy is not "sharpened" into a 404.
  assert.equal(fullSize("https://cache.example.test:8449/piccache.php?url=" + encodeURIComponent(STRIP_FULL)), null);
});

check("a size suffix followed by a query string is stripped and the query kept", () => {
  assert.equal(fullSize("https://cdn.example.com/p/photo-150x150.jpg?resize=150%2C150"), "https://cdn.example.com/p/photo.jpg?resize=150%2C150");
  assert.equal(fullSize("https://cdn.example.com/p/photo-1024x768.png#top"), "https://cdn.example.com/p/photo.png#top");
  assert.equal(fullSize("https://cdn.example.com/p/photo.jpg?w=150&h=150"), null);
  // Only the innermost suffix goes, the same way the old anchored match did.
  assert.equal(fullSize("https://cdn.example.com/a-150x150-300x300.jpg"), "https://cdn.example.com/a-150x150.jpg");
  // Extensions the browser can draw, and nothing else.
  assert.equal(fullSize("https://cdn.example.com/p/scan-800x600.webp"), "https://cdn.example.com/p/scan.webp");
  assert.equal(fullSize("https://cdn.example.com/p/scan-800x600.svg"), null);
  assert.equal(fullSize("https://cdn.example.com/p/scan-800x600"), null);
});

check("a picture that is not a WordPress crop is left exactly as it was", () => {
  const plain = "https://cdn.example.com/comics/strip-2026-10-21.jpg";
  const thumb = thumbnailOf({ alternate: LINK, enclosure: [{ href: plain, type: "image/jpeg" }] });
  assert.equal(thumb.url, plain);
  assert.equal(thumb.fallback, undefined);
  assert.equal(cropVariant(plain), null);
  assert.equal(fullSize(plain), null);
  assert.equal(fullSize("https://example.com/index.php?p=1"), null);
  assert.equal(fullSize(""), null);
});

check("a crop in srcset is sharpened, and a crop on an enclosure too", () => {
  const thumb = thumbnailOf({
    alternate: LINK,
    enclosure: [{ href: "https://cdn.example.com/cover-300x200.jpg", type: "image/jpeg" }],
  });
  assert.equal(thumb.url, "https://cdn.example.com/cover.jpg");
  assert.equal(thumb.fallback, "https://cdn.example.com/cover-300x200.jpg");

  const fromset = thumbnailOf({
    alternate: LINK,
    content: { content: '<img srcset="https://e.test/s-150x150.jpg 150w, https://e.test/l-768x512.jpg 768w">' },
  });
  assert.equal(fromset.url, "https://e.test/l.jpg");
  assert.equal(cropVariant("https://e.test/l.jpg"), "https://e.test/l-768x512.jpg");
});

check("every picture of a multi-picture strip-shaped post is sharpened too", () => {
  const list = imagesOf({
    alternate: LINK,
    content: {
      content:
        '<img src="https://e.test/p/1-150x150.jpg"><img src="https://e.test/p/2-300x200.jpg">' +
        '<img src="https://e.test/p/plain.jpg">',
    },
  });
  assert.deepEqual(list, ["https://e.test/p/1.jpg", "https://e.test/p/2.jpg", "https://e.test/p/plain.jpg"]);
  assert.equal(cropVariant("https://e.test/p/2.jpg"), "https://e.test/p/2-300x200.jpg");
});

/* ------------------------------------------------------------------- Buni
   The report this work came from, in its own URLs. Feed 215
   (https://www.bunicomic.com/feed/) publishes one picture per post, a 150x150
   WordPress crop (150x150, ~7KB); the page itself is at the same path without
   the size suffix, 780x1054. Nothing below needs the network: it is the URL
   rewriting the card depends on, checked against the real strings and against
   the body WordPress actually publishes. */

const BUNI_DIR = "https://www.bunicomic.com/wp-content/uploads/2026/10/";
const BUNI_CROP = `${BUNI_DIR}2026-10-21-Buni-150x150.jpg`;
const BUNI_PAGE = `${BUNI_DIR}2026-10-21-Buni.jpg`;

check("the real Buni crop is asked for as the 780x1054 page", () => {
  assert.equal(fullSize(BUNI_CROP), BUNI_PAGE);
  // …and the page itself is not rewritten into a 404.
  assert.equal(fullSize(BUNI_PAGE), null);
});

check("Buni's entry, as WordPress publishes it, draws the page rather than the crop", () => {
  // The labelled crop beside the src, which is what WordPress writes for a
  // thumbnail: `src` is the 150px square, `srcset` carries the 768-wide one.
  const body =
    '<p><a href="https://www.bunicomic.com/comic/buni-2018/" rel="noopener">' +
    `<img loading="lazy" width="150" height="150" src="${BUNI_CROP}" ` +
    `srcset="${BUNI_CROP} 150w, ${BUNI_DIR}2026-10-21-Buni-768x1024.jpg 768w" ` +
    'sizes="(max-width: 150px) 100vw, 150px" class="attachment-thumbnail size-thumbnail wp-post-image" alt="">' +
    "</a></p>\n";
  const item = {
    alternate: [{ href: "https://www.bunicomic.com/comic/buni-2018/" }],
    content: { content: body },
    summary: { content: body },
  };
  const thumb = thumbnailOf(item);
  assert.equal(thumb.url, BUNI_PAGE);
  assert.equal(thumb.kind, "inline");
  // The widest srcset candidate is the crop to fall back to, not the 150px one:
  // if the page is gone, the biggest file the feed named is the one to draw.
  assert.equal(thumb.fallback, `${BUNI_DIR}2026-10-21-Buni-768x1024.jpg`);
  assert.equal(cropVariant(BUNI_PAGE), `${BUNI_DIR}2026-10-21-Buni-768x1024.jpg`);
});

check("one picture is not a strip: Buni keeps the plain card Archie's post gets", () => {
  // `pictures()` in ArticleList asks imagesOf for a list and draws a pager only
  // when it comes back with more than one, so a single sharpened picture has to
  // be a list of exactly one here — the markup and CSS stay as they were.
  const list = imagesOf({
    alternate: [{ href: "https://www.bunicomic.com/comic/buni-2018/" }],
    content: { content: `<p><img src="${BUNI_CROP}" alt=""></p>` },
  });
  assert.deepEqual(list, [BUNI_PAGE]);
  assert.deepEqual(panelsOf({ content: { content: `<img src="${BUNI_CROP}" alt="">` } }), []);
});

/* ------------------------------------------------------------------ the card
   The other half of the joke: the card has to *ask* for the sharpened URL, and
   when the full-size file is not there after all it has to go back to the crop
   the feed named rather than leave a hole. Both are in ArticleList.svelte, so
   they are read there — no DOM needed for "the markup binds the fallback". */

const LIST_SRC = readFileSync(
  new URL("../../src/components/ArticleList.svelte", import.meta.url),
  "utf8",
);

check("the card draws the sharpened url, not the crop it read", () => {
  // `shown()` is the one funnel every card picture goes through, and `refuse()`
  // is what the `<img>` calls when it fails: it swaps in the crop and returns,
  // so the broken file is not counted as a post with no picture.
  assert.match(LIST_SRC, /function shown\(url: string\): string \{\s*return downgraded\[url\] \?\? url;/);
  assert.match(LIST_SRC, /function refuse\(item: StreamItem, event: Event, url: string\): void \{/);
  assert.match(LIST_SRC, /const crop = cropVariant\(url\);/);
  assert.match(LIST_SRC, /downgraded = \{ \.\.\.downgraded, \[url\]: crop \};/);
  // A card's single picture and the strip's pages both bind it.
  assert.match(LIST_SRC, /src=\{shown\(picture \?\? ""\)\}/);
  assert.match(LIST_SRC, /onerror=\{\(event\) => refuse\(item, event, picture \?\? ""\)\}/);
  assert.match(LIST_SRC, /src=\{shown\(strip\[page\]\)\}/);
  assert.match(LIST_SRC, /onerror=\{\(event\) => refuse\(item, event, strip\[page\]\)\}/);
});

check("a picture that fails twice is dropped, not left as a broken box", () => {
  assert.match(
    LIST_SRC,
    /if \(event\.currentTarget instanceof HTMLImageElement\) event\.currentTarget\.src = "";\s*fail\(item\.id\);/,
  );
});

console.log(`\n${passed}/${passed} checks passed`);
