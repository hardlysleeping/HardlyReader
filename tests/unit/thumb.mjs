import { strict as assert } from "node:assert";
import { firstImageIn, resolveUrl, thumbnailOf } from "../../src/lib/thumb.ts";

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

console.log(`\n${passed}/${passed} checks passed`);
