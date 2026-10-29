/**
 * The demo build: a library that is already there.
 *
 * GitHub Pages serves files and nothing else, and a browser tab cannot fetch an arbitrary
 * publisher's RSS — the CORS headers are simply not sent. So a demo of *this* app cannot be
 * "the real thing pointed at real feeds"; it has to arrive with a library.
 *
 * This file is that library. Three sample feeds, a dozen posts, a few comic pages drawn as
 * inline SVG so Cards and the article pane have something real to fit — all generated here, no
 * network, no third-party content, nothing to license.
 *
 * Two rules:
 *
 * - **Seeded once, idempotently.** The store carries a `demo.seeded` marker, so a reload does not
 *   duplicate feeds and a visitor who marked something read keeps it for the session.
 * - **Only when the flag is on.** `VITE_DEMO=1` at build time, never at runtime, so a normal build
 *   can never grow sample feeds by accident.
 *
 * The addresses are `https://…example.invalid/…`: the store refuses anything that is not http(s),
 * and `.invalid` is reserved by RFC 2606, so nothing can ever answer and a demo build that somehow
 * did try to refresh would fail honestly instead of reaching a real host.
 */
import type { LocalStore } from "../api/local/store";

/** True only in a build made with `VITE_DEMO=1`. */
export const DEMO: boolean = (() => {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    return env?.VITE_DEMO === "1";
  } catch {
    // No bundler env at all (a unit suite): a normal build.
    return false;
  }
})();

/** The one line every demo surface says, so they cannot drift. */
export const DEMO_NOTE = "Demo — real feeds, fetched when this page was built. Nothing you do is saved. Hidden categories unlock with 0000.";

/**
 * A sample page, drawn at the size the post claims.
 *
 * The width and height are the point: the Cards view draws a picture at its own aspect ratio, so a
 * demo where every page is 900x1400 shows one shape four times and hides the feature. These are the
 * shapes a real reading list carries — a portrait page, a double-page spread, a square cover, a
 * tall webtoon strip, a small panel sheet — and each one is drawn from its own numbers rather than
 * cropped to fit.
 */
const SVG = (label: string, hue: number, width: number, height: number): string => {
  const w = width;
  const h = height;
  const pad = Math.round(Math.min(w, h) * 0.06);
  const inner = w - pad * 2;
  // Four frames, arranged for the page's own proportions: two across when there is width, stacked
  // when there is height.
  const wide = w / h > 1.15;
  const band = Math.round((h - pad * 2) * (wide ? 0.62 : 0.4));
  const gap = Math.round(pad * 0.8);
  const half = Math.round((inner - gap) / 2);
  const frames = wide
    ? `<rect x="${pad}" y="${pad}" width="${inner}" height="${band}" rx="10"/>
       <rect x="${pad}" y="${pad + band + gap}" width="${half}" height="${h - pad * 2 - band - gap}" rx="10"/>
       <rect x="${pad + half + gap}" y="${pad + band + gap}" width="${half}" height="${h - pad * 2 - band - gap}" rx="10"/>`
    : `<rect x="${pad}" y="${pad}" width="${inner}" height="${band}" rx="10"/>
       <rect x="${pad}" y="${pad + band + gap}" width="${inner}" height="${Math.round((h - pad * 2 - band - gap - gap) / 2)}" rx="10"/>
       <rect x="${pad}" y="${pad + band + gap + Math.round((h - pad * 2 - band - gap - gap) / 2) + gap}" width="${inner}" height="${Math.round((h - pad * 2 - band - gap - gap) / 2)}" rx="10"/>`;
  const type = Math.round(Math.min(w, h) * 0.05);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 62% 58%)"/><stop offset="1" stop-color="hsl(${hue + 40} 55% 22%)"/>
  </linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <g fill="none" stroke="rgba(8,10,14,.82)" stroke-width="${Math.max(4, Math.round(type * 0.16))}">${frames}</g>
  <g fill="rgba(255,255,255,.92)" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${type}">
    <text x="${pad * 2}" y="${pad * 2 + type}">${label}</text>
    <text x="${pad * 2}" y="${pad * 2 + type + Math.round(type * 0.62)}" font-size="${Math.round(type * 0.62)}" fill="rgba(255,255,255,.7)">${w} x ${h}</text>
  </g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

interface DemoPost {
  title: string;
  author: string;
  hoursAgo: number;
  /** The publisher's own address, when a real feed supplied one. */
  link?: string | null;
  /** Paragraphs of filler, plus an optional page picture. */
  body: string[];
  page?: string;
}

interface DemoFeed {
  url: string;
  title: string;
  folder: string | null;
  posts: DemoPost[];
}

/** A portrait comic page: the shape a page is when it is a page. */
const PAGE_ONE = SVG("Chapter one", 214, 900, 1400);
/** A webtoon strip: very tall, which is the shape the Cards view must not crop to a thumbnail. */
const PAGE_TWO = SVG("Chapter two", 24, 900, 2200);
/** A square cover. */
const PAGE_THREE = SVG("A drawn cover", 292, 1000, 1000);
/** A double-page spread: wider than it is tall. */
const PAGE_FOUR = SVG("Panel study", 148, 1800, 1000);
/** A small panel sheet, for the low end of the range. */
const PAGE_FIVE = SVG("Six panels", 340, 640, 900);

/**
 * The fallback library, for a build with no `public/demo/feeds.json`.
 *
 * The demo proper reads real publishers' feeds (scripts/demo-feeds.mjs fetches them at build time
 * and bakes the posts and their pictures into the bundle). This stays for the suites and for a
 * build where the fetch failed: a demo with four invented posts is still a demo, an empty one is a
 * broken page.
 */
export const DEMO_FEEDS: readonly DemoFeed[] = [
  {
    url: "https://comics.example.invalid/slow-orbit",
    title: "Slow Orbit",
    folder: "Comics",
    posts: [
      {
        title: "Slow Orbit — chapter one",
        author: "Sample Studio",
        hoursAgo: 3,
        body: [
          "A page that is taller than it is wide, which is what the Cards view is for: it fills the pane at its own aspect ratio, one push moves one page, and nothing is cropped.",
        ],
        page: PAGE_ONE,
      },
      {
        title: "Slow Orbit — chapter two",
        author: "Sample Studio",
        hoursAgo: 26,
        body: ["The second page, same treatment. Press the fit button and the window sizes itself to the whole page, buttons and all."],
        page: PAGE_TWO,
      },
      {
        title: "A drawn cover",
        author: "Sample Studio",
        hoursAgo: 49,
        body: ["A cover, so the article pane has a picture to fit by width, height and the file's own pixels."],
        page: PAGE_THREE,
      },
    ],
  },
  {
    url: "https://design.example.invalid/panel-study",
    title: "Panel Study",
    folder: "Comics",
    posts: [
      {
        title: "Panel study — four frames",
        author: "Sample Studio",
        hoursAgo: 5,
        body: ["Four frames, drawn at page size rather than as a thumbnail, so zooming in the article pane shows the difference."],
        page: PAGE_FOUR,
      },
      {
        title: "On gutters",
        author: "Sample Studio",
        hoursAgo: 30,
        body: [
          "Gutters are the invisible part of a page. This post is text only, which is why it is here: a feed where every item is a picture is not a feed anyone actually reads.",
          "Long enough to fill the pane and to exercise the reading measure, the leading and the type scale in Settings → Reading.",
        ],
      },
    ],
  },
  {
    url: "https://design.example.invalid/type-and-space",
    title: "Type and Space",
    folder: null,
    posts: [
      {
        title: "A note on measure",
        author: "Sample Editor",
        hoursAgo: 8,
        body: [
          "Text columns are a measurement, not a percentage: the app keeps a measure and lets the window be as wide as it likes.",
          "Try the three panes: drag a divider, fold the feeds pane, press 1 and 2 and 3, and the arrangement you leave is the one it remembers.",
        ],
      },
      {
        title: "Hidden and pinned categories",
        author: "Sample Editor",
        hoursAgo: 33,
        body: [
          "Right-click a category in the sidebar: pin it, hide it, or lock the hidden ones behind a passcode. None of it needs a server, which is the point of a local library.",
        ],
      },
      {
        title: "Keyboard first",
        author: "Sample Editor",
        hoursAgo: 57,
        body: ["Press ? for the list of keys: next and previous post and feed, mark read, star, open in the browser, back."],
      },
      {
        title: "Four ways to list posts",
        author: "Sample Editor",
        hoursAgo: 80,
        body: ["Regular, List, Cards, Grid — one row structure behind all four, so every action works in every shape."],
      },
    ],
  },
  {
    url: "https://reading.example.invalid/long-form",
    title: "Long Form",
    folder: "Reading",
    posts: [
      {
        title: "What this demo cannot do",
        author: "Sample Editor",
        hoursAgo: 12,
        body: [
          "Pages serve files and nothing else, and a browser cannot fetch a publisher's RSS across origins, so this build ships its own sample feeds instead of fetching yours.",
          "Everything you can try is the real app: the panes, the four list views, the picture fit, the keyboard, the themes, hidden and pinned categories, the reading settings. Adding a feed, refreshing, device sync, accounts and billing need the installed app, and each says so rather than failing silently.",
        ],
      },
    ],
  },
];

/** One post, as `scripts/demo-feeds.mjs` writes it. */
interface BakedPost {
  title?: unknown;
  link?: unknown;
  author?: unknown;
  published?: unknown;
  summary?: unknown;
  image?: unknown;
}

interface BakedFeed {
  url?: unknown;
  title?: unknown;
  folder?: unknown;
  posts?: unknown;
}

/**
 * The real library, fetched from the bundle.
 *
 * Same origin, so this is the one fetch a static page is allowed to make. Every field is checked
 * rather than trusted: the file is written by a build step that talks to other people's servers, and
 * a feed that answered with something odd must not be able to break the seed.
 */
export async function loadDemoFeeds(
  base: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<DemoFeed[] | null> {
  try {
    const response = await fetch(`${base}demo/feeds.json`, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body = (await response.json()) as { feeds?: unknown };
    if (!Array.isArray(body.feeds)) return null;
    const feeds: DemoFeed[] = [];
    for (const raw of body.feeds as BakedFeed[]) {
      const url = typeof raw.url === "string" ? raw.url : "";
      const title = typeof raw.title === "string" ? raw.title : "";
      if (url === "" || title === "") continue;
      const posts: DemoPost[] = [];
      for (const item of (Array.isArray(raw.posts) ? raw.posts : []) as BakedPost[]) {
        const postTitle = typeof item.title === "string" ? item.title.trim() : "";
        if (postTitle === "") continue;
        const published =
          typeof item.published === "number" && Number.isFinite(item.published) && item.published > 0
            ? Math.round(item.published / 1000)
            : now - posts.length * 3600;
        const summary = typeof item.summary === "string" ? item.summary.slice(0, 400) : "";
        const image = typeof item.image === "string" ? `${base}${item.image}` : undefined;
        posts.push({
          title: postTitle,
          author: typeof item.author === "string" && item.author !== "" ? item.author : title,
          hoursAgo: Math.max(0, Math.round((now - published) / 3600)),
          body: summary === "" ? [] : [summary],
          page: image,
        });
      }
      if (posts.length === 0) continue;
      feeds.push({ url, title, folder: typeof raw.folder === "string" ? raw.folder : null, posts });
    }
    return feeds.length === 0 ? null : feeds;
  } catch {
    // No bundle, no network, a malformed file: the built-in samples answer for all three.
    return null;
  }
}

/**
 * The sidebar a visitor lands on: two things pinned, one thing hidden behind a code.
 *
 * A demo that opens on a plain list shows none of this: the pins are a menu away and the hidden
 * set is empty until someone makes one. So the demo starts with the state a reader who has been
 * using it would have, and `0000` is printed in the banner — a lock nobody can open is not a
 * demonstration of a lock.
 *
 * Written through the reader's own methods, not into storage: the same calls the sidebar's menus
 * make, so what the demo shows is what the feature does.
 */
export const DEMO_PASSCODE = "0000";

/** The MIME type of a bundled picture, from its extension. */
function imageTypeOf(path: string): string {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

export interface DemoSidebar {
  setCategoryPinned(label: string, pinned: boolean): Promise<void>;
  setCategoryHidden(label: string, hidden: boolean): Promise<unknown>;
  setHiddenPasscode(passcode: string): Promise<boolean>;
}

export async function applyDemoDefaults(reader: DemoSidebar): Promise<void> {
  await reader.setCategoryPinned("Comics", true);
  await reader.setCategoryPinned("Linux", true);
  await reader.setCategoryHidden("Art", true);
  await reader.setHiddenPasscode(DEMO_PASSCODE);
}

/**
 * Fills an empty library with the sample feeds.
 *
 * Returns the number of posts written, 0 when the marker says it is already seeded or when the
 * library is not empty — a visitor's own feeds are never joined by samples.
 */
export async function seedDemoLibrary(
  store: LocalStore,
  now: number = Math.floor(Date.now() / 1000),
  base = "/",
): Promise<number> {
  if ((await store.meta("demo.seeded")) !== null) return 0;
  if ((await store.feeds()).length > 0) return 0;

  const library = (await loadDemoFeeds(base, now)) ?? DEMO_FEEDS;
  // The picture cache and the thumbnail picker both want a URL with an origin: a bare
  // "/repo/demo/img/x.png" has no base to resolve against (`resolveUrl` returns null for it) and
  // the row would draw no picture at all. The page's own address supplies the origin, so the same
  // build works on a laptop, on a Pages subpath, and under any hostname.
  const absolute = (path: string): string =>
    typeof location === "undefined" ? path : new URL(path, location.href).href;
  let written = 0;
  for (const feed of library) {
    if (feed.folder !== null) await store.ensureFolder(feed.folder);
    await store.subscribe(feed.url, { title: feed.title, folder: feed.folder });
    const entries = feed.posts.map((post, index) => ({
      feedUrl: feed.url,
      guid: `${feed.url}#${index}`,
      title: post.title,
      link: post.link ?? null,
      author: post.author,
      published: now - Math.round(post.hoursAgo * 3600),
      summary: post.body[0] ?? "",
      // The enclosure is what the list's thumbnail picker reads (`lib/thumb.ts`); the copy in the
      // content is what the article pane draws. A pictured post carries both.
      enclosure:
        post.page === undefined
          ? null
          : { href: absolute(post.page), type: imageTypeOf(post.page) },
      content:
        post.body.map((paragraph) => `<p>${paragraph}</p>`).join("") +
        (post.page === undefined ? "" : `<p><img src="${absolute(post.page)}" alt=""></p>`),
    }));
    const stored = await store.putEntries(entries);
    written += stored.added;
  }

  // A library where nothing has been read looks dead; two read marks and a star show the states
  // the list is built around.
  const page = await store.queryEntries({ count: 3 });
  const ids = page.entries.map((entry) => entry.key);
  if (ids.length >= 2) await store.setRead(ids.slice(0, 2), true);
  if (ids.length >= 3) await store.setStarred([ids[2]!], true);

  await store.setMeta("demo.seeded", String(now));
  return written;
}
