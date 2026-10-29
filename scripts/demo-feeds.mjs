#!/usr/bin/env node
/**
 * Fetches the demo's feeds at build time and writes them into the bundle.
 *
 * The demo is a static page, and a browser cannot fetch a publisher's RSS from another origin — no
 * CORS headers, and none of these publishers are going to add them for us. So the fetching happens
 * here, once, when the demo is built: the same reason a print edition is typeset rather than read
 * live.
 *
 * Output, all under `public/demo/`:
 *   feeds.json          — the library: feeds, folders, posts, summaries, image paths
 *   img/<hash>.<ext>    — the pictures, downloaded so they are same-origin (the app's picture cache
 *                         fetches, and a cross-origin fetch is what a static page cannot do)
 *   ATTRIBUTION.md      — who wrote each feed, so the demo can say where the sample came from
 *
 * Nothing here is a dependency of the app: a failed fetch drops that feed and the demo still builds.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("../public/demo/", import.meta.url).pathname;
const IMG = join(OUT, "img");
const UA = "HardlyReader-demo/1.0 (+https://hardlysleeping.github.io/HardlyReader/)";
/** Per-feed cap: a demo list should be a list, not an archive. */
const PER_FEED = 6;
/** A picture bigger than this is not worth a demo's first paint. */
const MAX_IMAGE = 3_000_000;

/**
 * The sample library's sources.
 *
 * Chosen for two things: they are free to read and to quote, and between them they carry the shapes
 * a reader has to handle — a tall comic page, a wide newspaper strip, a landscape panel, a square
 * cover — plus the kind of text a real feed has.
 */
const FEEDS = [
  { url: "https://librearts.org/index.xml", title: "Libre Arts", folder: "Art", site: "librearts.org" },
  { url: "https://www.smbc-comics.com/comic/rss", title: "Saturday Morning Breakfast Cereal", folder: "Comics", site: "smbc-comics.com" },
  { url: "https://poorlydrawnlines.com/feed/", title: "Poorly Drawn Lines", folder: "Comics", site: "poorlydrawnlines.com" },
  { url: "https://www.davidrevoy.com/feed/rss", title: "David Revoy", folder: "Art", site: "davidrevoy.com" },
  { url: "https://lwn.net/headlines/rss", title: "LWN", folder: "Linux", site: "lwn.net" },
  { url: "https://www.phoronix.com/rss.php", title: "Phoronix", folder: "Linux", site: "phoronix.com" },
  { url: "https://blog.gtk.org/feed/", title: "GTK Development Blog", folder: "Linux", site: "blog.gtk.org" },
  { url: "https://itsfoss.com/feed/", title: "It's FOSS", folder: "Linux", site: "itsfoss.com" },
  { url: "https://krita.org/en/feed/", title: "Krita", folder: "Art", site: "krita.org" },
];

const hash = (value) => createHash("sha1").update(value).digest("hex").slice(0, 12);

/** Decodes the entities RSS actually uses, and leaves the tags alone. */
function unescapeHtml(html) {
  return String(html ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    // Last, so an escaped entity in the source (`&amp;lt;`) survives as text rather than markup.
    .replace(/&amp;/g, "&");
}

/** Strips tags, decodes the handful of entities RSS actually uses, collapses whitespace. */
function text(html) {
  return String(html ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first usable image in a block of HTML or an enclosure.
 *
 * The block is unescaped first: a publisher that puts HTML in `<description>` escapes it
 * (`&lt;img src=&quot;…`), and matching `src="` against that finds nothing at all.
 */
function firstImage(block) {
  const html = unescapeHtml(block);
  const enclosure = /<enclosure[^>]+url="([^"]+)"[^>]*type="image\//i.exec(html);
  if (enclosure) return enclosure[1];
  const media = /<media:content[^>]+url="([^"]+)"[^>]*medium="image"/i.exec(html) ?? /<media:thumbnail[^>]+url="([^"]+)"/i.exec(html);
  if (media) return media[1];
  const img = /<img[^>]+src="([^"]+)"/i.exec(html);
  return img ? img[1] : null;
}

/** Reads RSS 2.0 or Atom into the handful of fields a list row draws. */
function parseFeed(xml) {
  const items = [];
  const rss = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const atom = [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  for (const raw of rss.length > 0 ? rss : atom) {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(raw);
      return m ? text(m[1]) : "";
    };
    const link =
      /<link[^>]*>([^<]+)<\/link>/i.exec(raw)?.[1]?.trim() ??
      /<link[^>]+href="([^"]+)"/i.exec(raw)?.[1] ??
      "";
    const title = pick("title");
    if (title === "") continue;
    items.push({
      title,
      link: link === "" ? null : link,
      author: pick("dc:creator") || pick("author") || "",
      published: Date.parse(pick("pubDate") || pick("updated") || pick("published") || "") || null,
      summary: pick("description") || pick("summary") || pick("content:encoded"),
      image: firstImage(raw),
    });
  }
  return items;
}

async function downloadImage(url) {
  try {
    const response = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!/^image\//.test(type)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE) return null;
    const ext = type.includes("png") ? "png" : type.includes("gif") ? "gif" : type.includes("webp") ? "webp" : type.includes("svg") ? "svg" : "jpg";
    const name = `${hash(url)}.${ext}`;
    writeFileSync(join(IMG, name), bytes);
    return `demo/img/${name}`;
  } catch {
    return null;
  }
}

mkdirSync(IMG, { recursive: true });

/**
 * xkcd, from its JSON API rather than its feed.
 *
 * `xkcd.com/rss.xml` carries titles and no images, and the image is the whole comic. The JSON gives
 * the picture, its real dimensions and the alt text, and the pictures are the wide newspaper-strip
 * shape nothing else in this list has.
 */
async function xkcdPosts(count) {
  const latest = await fetch("https://xkcd.com/info.0.json", { headers: { "user-agent": UA } });
  if (!latest.ok) return [];
  const newest = await latest.json();
  const posts = [];
  for (let offset = 0; offset < count; offset += 1) {
    const num = newest.num - offset;
    try {
      const response = await fetch(`https://xkcd.com/${num}/info.0.json`, { headers: { "user-agent": UA } });
      if (!response.ok) continue;
      const comic = await response.json();
      const image = await downloadImage(comic.img);
      posts.push({
        title: comic.title,
        link: `https://xkcd.com/${num}/`,
        author: "Randall Munroe",
        published: Date.UTC(Number(comic.year), Number(comic.month) - 1, Number(comic.day)),
        summary: comic.alt ?? "",
        image,
      });
    } catch {
      // one comic missing is not a reason to lose the feed
    }
  }
  return posts;
}

const library = [];
const attribution = [];
for (const feed of FEEDS) {
  try {
    const response = await fetch(feed.url, { headers: { "user-agent": UA }, redirect: "follow" });
    if (!response.ok) {
      console.warn(`skip ${feed.title}: ${response.status}`);
      continue;
    }
    const items = parseFeed(await response.text()).slice(0, PER_FEED);
    if (items.length === 0) {
      console.warn(`skip ${feed.title}: no items`);
      continue;
    }
    const posts = [];
    for (const item of items) {
      const image = item.image === null ? null : await downloadImage(item.image);
      posts.push({
        title: item.title,
        link: item.link,
        author: item.author === "" ? feed.title : item.author,
        published: item.published,
        summary: item.summary.slice(0, 400),
        image,
      });
    }
    library.push({ url: feed.url, title: feed.title, folder: feed.folder, site: feed.site, posts });
    attribution.push(`- **${feed.title}** — <${feed.site}> (feed: <${feed.url}>)`);
    console.log(`${feed.title}: ${posts.length} posts, ${posts.filter((p) => p.image !== null).length} with a picture`);
  } catch (error) {
    console.warn(`skip ${feed.title}: ${String(error)}`);
  }
}

try {
  const posts = await xkcdPosts(4);
  if (posts.length > 0) {
    library.push({ url: "https://xkcd.com/", title: "xkcd", folder: "Comics", site: "xkcd.com", posts });
    attribution.push("- **xkcd** — <xkcd.com> by Randall Munroe, CC BY-NC 2.5 (via its JSON API)");
    console.log(`xkcd: ${posts.length} posts, ${posts.filter((p) => p.image !== null).length} with a picture`);
  }
} catch (error) {
  console.warn(`skip xkcd: ${String(error)}`);
}

if (library.length === 0) {
  console.error("no feeds could be fetched; the demo would ship empty");
  process.exit(1);
}

writeFileSync(join(OUT, "feeds.json"), JSON.stringify({ generated: new Date().toISOString(), feeds: library }, null, 1));
writeFileSync(
  join(OUT, "ATTRIBUTION.md"),
  `# Where the demo's reading list comes from\n\nFetched at build time from the publishers' own feeds. Every headline, summary and picture is\ntheirs; the demo only lays it out.\n\n${attribution.join("\n")}\n`,
);
const total = library.reduce((sum, feed) => sum + feed.posts.length, 0);
console.log(`\nwrote ${total} posts from ${library.length} feeds to public/demo/`);
if (!existsSync(join(OUT, "feeds.json"))) process.exit(1);
