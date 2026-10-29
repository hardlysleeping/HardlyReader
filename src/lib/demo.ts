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
export const DEMO_NOTE = "Demo library — sample feeds, nothing you do is saved.";

const SVG = (label: string, hue: number): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1400" viewBox="0 0 900 1400">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 62% 58%)"/><stop offset="1" stop-color="hsl(${hue + 40} 55% 22%)"/>
  </linearGradient></defs>
  <rect width="900" height="1400" fill="url(#g)"/>
  <g fill="none" stroke="rgba(8,10,14,.82)" stroke-width="7">
    <rect x="56" y="56" width="788" height="560" rx="10"/>
    <rect x="56" y="648" width="380" height="330" rx="10"/>
    <rect x="464" y="648" width="380" height="330" rx="10"/>
    <rect x="56" y="1010" width="788" height="330" rx="10"/>
  </g>
  <g fill="rgba(255,255,255,.92)" font-family="ui-sans-serif,system-ui,sans-serif" font-size="42">
    <text x="88" y="126">${label}</text>
    <text x="88" y="180" font-size="26" fill="rgba(255,255,255,.7)">A sample page, drawn in the demo build.</text>
  </g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

interface DemoPost {
  title: string;
  author: string;
  hoursAgo: number;
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

const PAGE_ONE = SVG("Chapter one", 214);
const PAGE_TWO = SVG("Chapter two", 24);
const PAGE_THREE = SVG("A drawn cover", 292);
const PAGE_FOUR = SVG("Panel study", 148);

/**
 * The sample library.
 *
 * Deliberately generic magazine and comic shapes: the point is to show four list views, the
 * picture fit and the reading pane, not to imitate anyone's actual publication.
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

/**
 * Fills an empty library with the sample feeds.
 *
 * Returns the number of posts written, 0 when the marker says it is already seeded or when the
 * library is not empty — a visitor's own feeds are never joined by samples.
 */
export async function seedDemoLibrary(store: LocalStore, now: number = Math.floor(Date.now() / 1000)): Promise<number> {
  if ((await store.meta("demo.seeded")) !== null) return 0;
  if ((await store.feeds()).length > 0) return 0;

  let written = 0;
  for (const feed of DEMO_FEEDS) {
    if (feed.folder !== null) await store.ensureFolder(feed.folder);
    await store.subscribe(feed.url, { title: feed.title, folder: feed.folder });
    const entries = feed.posts.map((post, index) => ({
      feedUrl: feed.url,
      guid: `${feed.url}#${index}`,
      title: post.title,
      link: null,
      author: post.author,
      published: now - Math.round(post.hoursAgo * 3600),
      summary: post.body[0] ?? "",
      content:
        post.body.map((paragraph) => `<p>${paragraph}</p>`).join("") +
        (post.page === undefined ? "" : `<p><img src="${post.page}" alt="A sample comic page"></p>`),
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
