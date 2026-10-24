/**
 * Pictures in an article, which is half of what fetching one is for.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/article-images.mjs
 *
 * Measured before this rule existed, against the stub publisher below and the
 * real extraction path in a browser DOM: a page with four pictures rendered
 * three — one was a 1×1 blank whose real file (`data-original`) was never
 * requested, and one was a 403 refusal left as a 232×23 broken frame with alt
 * text. Readability's own lazy pass skips any image whose `src` is non-empty,
 * which is exactly the spacer case.
 *
 * What this suite can prove in Node, and what it cannot:
 *
 * - **Proved here**: the promotion rules against stub markup, and the same rules
 *   over a page fetched by `fetchArticle()` from a real HTTP server — which
 *   URL ends up in `src`, in what order, what is dropped, and that promotion
 *   itself asks the server for nothing.
 * - **Only the DOM can run**: `sanitizeArticle()` and `prepareImages()`, and the
 *   pane's own width rules. There is no DOM in this project's unit runs (no
 *   jsdom by design), so their wiring is pinned by reading the source, and the
 *   refusal path was measured in a browser: four images in, three out, the 403
 *   removed, each survivor `lazy/async/no-referrer` at 700px in a 700px column.
 * - **Only the Tauri window can prove**: that WebKitGTK sends the same
 *   `no-referrer` and that a publisher which refuses the WebView's user agent
 *   still refuses it. Chromium was measured; the app's window was not.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchArticle, imageSources, promoteImages, sameImage } from "../../src/lib/extract.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const BASE = "https://pub.example/2026/10/slow-boats";

/* --- the stub publisher ---------------------------------------------------- */

/** A real 8×6 PNG and a real 1×1 GIF: the bytes are valid, nothing here decodes them. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGOIqjiBFTEMpAQAcuBM4eSCd/oAAAAASUVORK5CYII=",
  "base64",
);
const SPACER = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/** `data-src`, a WordPress-style `data-srcset`, a 1×1 in `src`, placeholder size. */
const LAZY_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Slow boats through the limestone</title></head><body>
<nav><a href="/">Home</a><a href="/archive">Archive</a></nav>
<article>
<h1>Slow boats through the limestone</h1>
<p>The canal is not a river and it does not behave like one. It was dug, in
sections, across four decades, and every lock along it was built by a different
contractor with a different idea of how wide a gate should be.</p>
<p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
  data-src="img/lock.jpg" data-srcset="img/lock-640x427.jpg 640w, img/lock-1280x853.jpg 1280w"
  width="1" height="1" alt="A lock gate at dusk"></p>
<p>In the nineteen-thirties the traffic was coal, and the boats were narrow
enough that two could pass in the wide pounds but not in the cuttings.</p>
<p><img src="img/blank.gif" data-original="/img/pound.jpg" alt="A wide pound"></p>
<p><img src="img/refused.jpg" alt="A picture the publisher refuses"></p>
<p>Nothing here fetches pictures unless the page is read in a reader, which is
the point: the text was never the hard part, and the water board has never
agreed about the spring.</p>
</article>
<footer>© the publisher</footer>
</body></html>`;

const ROUTES = {
  "/post": { type: "text/html; charset=utf-8", body: Buffer.from(LAZY_PAGE) },
  "/img/lock.jpg": { type: "image/png", body: PNG },
  "/img/lock-640x427.jpg": { type: "image/png", body: PNG },
  "/img/lock-1280x853.jpg": { type: "image/png", body: PNG },
  "/img/pound.jpg": { type: "image/png", body: PNG },
  "/img/blank.gif": { type: "image/gif", body: SPACER },
  "/img/spacer.gif": { type: "image/gif", body: SPACER },
  "/img/pixel.png": { type: "image/png", body: SPACER },
  // The second suspect, made real: an origin that refuses the picture.
  "/img/refused.jpg": { type: "text/plain", body: Buffer.from("hotlinking not permitted"), status: 403 },
  "/notes.txt": { type: "text/plain", body: Buffer.from("not html") },
};

const requests = [];

function startStub() {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({ path, referer: req.headers.referer ?? null });
    const route = ROUTES[path];
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(route.status ?? 200, {
      "Content-Type": route.type,
      "Content-Length": route.body.length,
      "Cache-Control": "no-store",
    });
    res.end(route.body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* --- promotion rules, on stub markup --------------------------------------- */

const promoted = (tag) => promoteImages(tag, BASE);
const srcOf = (html) => {
  const found = imageSources(html);
  return found.length === 1 ? found[0] : found;
};

// The acceptance case: a 1×1 spacer in src, the real file in data-src.
const spacer = promoted(
  '<p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="img/lock.jpg" alt="lock"></p>',
);
check("a data-src behind a 1×1 spacer becomes the picture", srcOf(spacer) === `${BASE.replace(/slow-boats$/, "")}img/lock.jpg`, spacer);
check("and the lazy attribute is gone from the markup", !spacer.includes("data-src"), spacer);
check("the paragraph around it is untouched", spacer.startsWith("<p><img") && spacer.endsWith('alt="lock"></p>'), spacer);

// PowerShell (and plenty of hand-written CMS templates) use data-original, and
// a named spacer rather than a data URI — Readability skips this one entirely.
const original = promoted('<img src="img/blank.gif" data-original="/img/pound.jpg" alt="pound">');
check("data-original wins over a named spacer", srcOf(original) === "https://pub.example/img/pound.jpg", original);
check("the spacer is not left as an alternative", !original.includes("blank.gif"), original);

// srcset: the largest candidate, whether the set is written ascending or not.
const ascending = promoted('<img src="img/a.jpg" srcset="img/a-320x240.jpg 320w, img/a-1280x960.jpg 1280w">');
check("the largest srcset candidate wins", srcOf(ascending) === "https://pub.example/2026/10/img/a-1280x960.jpg", ascending);
const descending = promoted('<img src="img/a.jpg" srcset="img/a-1280x960.jpg 1280w, img/a-320x240.jpg 320w">');
check("and not merely the last one written", srcOf(descending) === "https://pub.example/2026/10/img/a-1280x960.jpg", descending);
const density = promoted('<img data-srcset="img/a.jpg 1x, img/a@2x.jpg 2x">');
check("density descriptors are compared too", srcOf(density) === "https://pub.example/2026/10/img/a@2x.jpg", density);
const undecorated = promoted('<img srcset="img/a.jpg, img/b.jpg">');
check("a set with no descriptors behaves like a browser's 1x", srcOf(undecorated) === "https://pub.example/2026/10/img/b.jpg", undecorated);

// Relative, protocol-relative and absolute sources all leave as absolute, or
// nothing could be fetched from inside the app.
check("a rooted path resolves against the article", srcOf(promoted('<img src="/img/a.jpg">')) === "https://pub.example/img/a.jpg");
check("a protocol-relative source keeps its host", srcOf(promoted('<img data-src="//cdn.example/a.jpg">')) === "https://cdn.example/a.jpg");
check("an absolute source is left alone", srcOf(promoted('<img src="https://cdn.example/a.jpg">')) === "https://cdn.example/a.jpg");
check(
  "a query and fragment survive resolution",
  srcOf(promoted('<img data-src="img/a.jpg?w=640&amp;h=427#top">')) === "https://pub.example/2026/10/img/a.jpg?w=640&h=427#top",
  srcOf(promoted('<img data-src="img/a.jpg?w=640&amp;h=427#top">')),
);
check(
  "and are written back escaped exactly once",
  promoted('<img data-src="img/a.jpg?w=640&amp;h=427">').includes("src=\"https://pub.example/2026/10/img/a.jpg?w=640&amp;h=427\""),
  promoted('<img data-src="img/a.jpg?w=640&amp;h=427">'),
);
check("a data:image source is carried through untouched", srcOf(promoted('<img src="data:image/png;base64,iVBORw0KGgo=">')) === "data:image/png;base64,iVBORw0KGgo=");

// Spacers, beacons and scripts are not pictures. The names come from thumb.ts's
// own filter, so a row and the article agree about what a picture is.
check("a bare spacer is dropped", promoted('<p>text</p><img src="img/pixel.png">') === "<p>text</p>");
check("a beacon is dropped", promoted('<img src="/analytics/beacon.gif">') === "");
check("a script source is dropped", promoted('<img src="javascript:alert(1)">') === "");
check("an image with no source at all is dropped", promoted("<img alt=\"nothing\">") === "");
check("an empty source with no fallback is dropped", promoted('<img src="">') === "");
check("a dropped picture takes its paragraph's image, not the paragraph", promoted('<p><img src="img/spacer.gif"></p>') === "");
check("a paragraph left empty by a dropped picture goes with it", promoted('<p>before</p><p><img src="img/spacer.gif"></p><p>after</p>') === "<p>before</p><p>after</p>");
check("and so does an empty figure", promoted('<figure><img src="img/spacer.gif"></figure>') === "");

// Placeholder dimensions describe the spacer, so they go with it; a picture
// whose src was already real keeps its aspect-ratio hint.
const placeholder = promoted('<img src="img/spacer.gif" data-src="img/real.jpg" width="1" height="1">');
check("a placeholder's width and height are dropped", !/\bwidth=|\bheight=/.test(placeholder), placeholder);
const real = promoted('<img src="img/real.jpg" width="1280" height="853" alt="x">');
check("a real picture keeps them", real.includes('width="1280"') && real.includes('height="853"'), real);
const fromSet = promoted('<img src="img/real.jpg" srcset="img/real-1280x853.jpg 1280w" width="1" height="1">');
check("a srcset winner drops the src's dimensions too", !/\bwidth=|\bheight=/.test(fromSet), fromSet);

// A <picture> hands the choice to its <source>, so a relative or lazy source
// would override the promoted <img> and the pane would show nothing.
const picture = promoted('<picture><source data-srcset="img/a-800x600.jpg 800w"><img src="img/spacer.gif" data-src="img/a.jpg"></picture>');
check(
  "a picture source is made absolute instead of overriding with a relative path",
  picture.includes('srcset="https://pub.example/2026/10/img/a-800x600.jpg"') && picture.includes('src="https://pub.example/2026/10/img/a.jpg"'),
  picture,
);
check("a source that is only a beacon is removed", promoted('<picture><source srcset="/analytics/beacon.png"><img src="img/a.jpg"></picture>').includes("<source") === false);

// Reading order: promotion edits tags in place and touches nothing else.
const ordered = promoted('<p>one</p><img data-src="img/1.jpg"><p>two</p><img src="img/2.jpg"><p>three</p>');
check(
  "pictures stay where they were in the text",
  /one<\/p><img[^>]*1\.jpg[^>]*><p>two<\/p><img[^>]*2\.jpg[^>]*><p>three<\/p>/.test(ordered),
  ordered,
);
check("alt text survives", ordered.includes("alt") === false && promoted('<img data-src="img/1.jpg" alt="first">').includes('alt="first"'));
check("no markup means no change", promoteImages("<p>just text</p>", BASE) === "<p>just text</p>");
check("an empty fragment is returned as it came", promoteImages("", BASE) === "");
check("a null base still resolves an absolute source", promoteImages('<img src="https://cdn.example/a.jpg">', null).includes("https://cdn.example/a.jpg"));

/* --- the same rules through a real fetch ---------------------------------- */

const { server, origin } = await startStub();
try {
  const page = await fetchArticle(`${origin}/post`);
  check("the page is fetched", typeof page === "string" && page.includes("Slow boats"), String(page).slice(0, 80));
  check("a non-html response is not a page", (await fetchArticle(`${origin}/notes.txt`)) === null);
  check("a missing page is not a page", (await fetchArticle(`${origin}/gone`)) === null);

  const before = requests.length;
  const body = promoteImages(page, `${origin}/post`);
  check("promotion asks the server for nothing", requests.length === before, `${requests.length - before} requests`);
  check("the fetched page keeps all three picture slots", imageSources(body).length === 3, JSON.stringify(imageSources(body)));

  const [lock, pound, refused] = imageSources(body);
  check("the lazy picture arrives at its largest file", lock === `${origin}/img/lock-1280x853.jpg`, lock);
  check("the data-original picture arrives at all", pound === `${origin}/img/pound.jpg`, pound);
  check("the refused picture is still in the markup", refused === `${origin}/img/refused.jpg`, refused);
  check("and the spacer is gone", !body.includes("blank.gif"), body.slice(0, 200));
  check(
    "nothing in the body is relative any more",
    !/<img[^>]+src="(?!https?:|data:)/.test(body),
    body.match(/<img[^>]+>/)?.[0] ?? "",
  );

  // The origin really does refuse it, which is what the pane's drop rule meets.
  const refusal = await fetch(`${origin}/img/refused.jpg`);
  check("the stub publisher refuses that picture", refusal.status === 403, String(refusal.status));
  const served = await fetch(`${origin}/img/pound.jpg`);
  check("and serves the promoted ones", served.status === 200 && served.headers.get("content-type") === "image/png");

  // No fabricated referrer: the page fetch sends none, and the pane's pictures
  // are marked no-referrer rather than handed an invented one.
  const pageRequest = requests.find((entry) => entry.path === "/post");
  check("fetching the page sends no referrer", pageRequest.referer === null, String(pageRequest.referer));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

/* --- the lead picture is not drawn twice ---------------------------------- */

check("the same URL is the same picture", sameImage("https://pub.example/a/lock.jpg", "https://pub.example/a/lock.jpg"));
check("a query string is not a different picture", sameImage("https://pub.example/a/lock.jpg?w=640", "https://pub.example/a/lock.jpg"));
check("a scheme change is not a different picture", sameImage("http://pub.example/a/lock.jpg", "https://pub.example/a/lock.jpg"));
check("a resized copy beside the original is the same picture", sameImage("https://pub.example/a/lock-1280x853.jpg", "https://pub.example/a/lock.jpg"));
check("so is a density variant", sameImage("https://pub.example/a/lock@2x.jpg", "https://pub.example/a/lock.jpg"));
check("and a .jpeg is a .jpg", sameImage("https://pub.example/a/lock.jpeg", "https://pub.example/a/lock.jpg"));
check("an escaped ampersand does not hide a duplicate", sameImage("https://pub.example/a/l.jpg?w=1&amp;h=2", "https://pub.example/a/l.jpg?w=9"));
check("another host is another picture", !sameImage("https://cdn.example/a/lock.jpg", "https://pub.example/a/lock.jpg"));
check("another folder is another picture", !sameImage("https://pub.example/b/lock.jpg", "https://pub.example/a/lock.jpg"));
check("another name is another picture", !sameImage("https://pub.example/a/gate.jpg", "https://pub.example/a/lock.jpg"));
check("a year in the name is not a size", !sameImage("https://pub.example/a/cover-2024.jpg", "https://pub.example/a/cover.jpg"));
check("an empty URL is nobody's picture", !sameImage("", ""));

check("imageSources lists every picture, in order", imageSources('<img src="a"><p><img src="b"></p>').join() === "a,b");
check("imageSources reads a quoted or bare attribute", imageSources("<img src=a><img src='b'>").join() === "a,b");
check("imageSources ignores anything that is not an img", imageSources('<source src="a"><video poster="b">').length === 0);
check("imageSources survives null", imageSources(null).length === 0);

/* --- wiring only the DOM can execute -------------------------------------- */

const read = (path) => readFileSync(join(new URL("../../", import.meta.url).pathname, path), "utf8");
const sanitize = read("src/lib/sanitize.ts");
const pane = read("src/components/ReaderPane.svelte");
const extract = read("src/lib/extract.ts");

check("extraction promotes before returning", /html:\s*promoteImages\(article\.content, url\)/.test(extract));
check("the sanitiser does not forbid img", !/FORBID_TAGS:[^\]]*"img"/.test(sanitize));
check("nor the attributes the picture needs", !/FORBID_ATTR:[^\]]*(?:referrerpolicy|loading|decoding)/.test(sanitize));
check("prepareImages sets a no-referrer policy on the element", /referrerpolicy", "no-referrer"/.test(sanitize));
check("and lazy loading with async decoding", /loading", "lazy"/.test(sanitize) && /decoding", "async"/.test(sanitize));
check("a picture that fails is removed", /addEventListener\("error", \(\) => img\.remove\(\)/.test(sanitize));
check("including one that failed before the listener existed", /complete && img\.naturalWidth === 0/.test(sanitize));
check("the pane prepares images on the first attach", /innerHTML = html;[\s\S]{0,120}prepareImages\(node\)/.test(pane));
check("and on every update", /innerHTML = next;[\s\S]{0,120}prepareImages\(node\)/.test(pane));
check("the lead is suppressed by comparing sources, not substrings", /imageSources\(body\)\.some\(\(src\) => sameImage\(src, url\)\)/.test(pane));
// A picture is the page's width, not the reading column's: the column holds
// text at 780px, and a picture sitting inside it left a band of empty space
// either side. The picture keeps its own height, so nothing is cropped.
check(
  "the article's pictures run the page's full width",
  /\.content :global\(img\) \{[^}]*width: var\(--page-width, 100%\)[^}]*height: auto/.test(pane) &&
    /\.content :global\(img\) \{[^}]*margin-inline: calc\(\(100% - var\(--page-width, 100%\)\) \/ 2\)/.test(pane),
);
check(
  "the reading column is what stays narrow",
  /article > h1,\s*article > \.byline,\s*\.content \{[^}]*max-width: 780px/.test(pane),
);
check(
  "the page width is measured off the article, not a container query",
  /style:--page-width=\{pageWidth > 0/.test(pane) && /new ResizeObserver/.test(pane),
);

if (failures === 0) {
  console.log(`ok ${checks} checks — article pictures: lazy sources promoted, refused ones dropped`);
} else {
  console.log(`${failures} failed of ${checks} checks`);
  process.exit(1);
}
