/**
 * Reading a feed without a server: the two formats, the dates they disagree
 * about, and the ids that have to survive the next fetch.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/rss.mjs
 *
 * The documents below are shaped like real ones: RSS with and without guids,
 * CDATA bodies, `content:encoded`, enclosures; Atom with attribute links, a
 * subtitle and an `updated` instead of a `published`.
 */
import { looksLikeFeed, parseDate, parseFeed } from "../../src/lib/rss.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}
const eq = (actual, expected, what) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
  }
};

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Adventures &amp; Comics</title>
    <link>https://comics.example/</link>
    <description>A comic a day</description>
    <item>
      <title><![CDATA[Page <em>one</em>]]></title>
      <link>https://comics.example/one</link>
      <guid isPermaLink="false">comic-1</guid>
      <pubDate>Tue, 20 Oct 2026 08:30:00 GMT</pubDate>
      <description>&lt;p&gt;A short note&lt;/p&gt;</description>
      <content:encoded><![CDATA[<p>Full page</p><img src="https://comics.example/1.png">]]></content:encoded>
      <category>Comics</category>
      <category>Daily</category>
      <enclosure url="https://comics.example/1.png" type="image/png" length="1234" />
    </item>
    <item>
      <title>No guid here</title>
      <link>https://comics.example/two</link>
      <pubDate>Wed, 21 Oct 2026 09:00:00 +0000</pubDate>
      <description>Body two</description>
    </item>
    <item>
      <title>No guid, no link</title>
      <pubDate>Thu, 22 Oct 2026 09:00:00 GMT</pubDate>
      <description>Body three</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Design Notes</title>
  <subtitle>Occasional writing</subtitle>
  <link href="https://design.example/" rel="alternate" />
  <link href="https://design.example/feed.xml" rel="self" />
  <entry>
    <title>On grids</title>
    <id>tag:design.example,2026:grids</id>
    <published>2026-10-19T11:00:00Z</published>
    <updated>2026-10-20T12:00:00Z</updated>
    <link rel="alternate" href="https://design.example/grids" />
    <link rel="enclosure" type="image/jpeg" href="https://design.example/grids.jpg" />
    <summary>Short summary</summary>
    <content type="html">&lt;p&gt;The whole piece&lt;/p&gt;</content>
    <author><name>Someone</name></author>
  </entry>
  <entry>
    <title>On margins</title>
    <id>tag:design.example,2026:margins</id>
    <updated>2026-10-21T12:00:00Z</updated>
    <link href="https://design.example/margins" />
    <content type="html">Margin notes</content>
  </entry>
</feed>`;

/* ------------------------------------------------------------------------- */

{
  const feed = parseFeed(RSS, "https://comics.example/rss");
  check("an RSS channel keeps its own title, site and description", () => {
    eq(feed.title, "Adventures & Comics", "title");
    eq(feed.siteUrl, "https://comics.example/", "site");
    eq(feed.description, "A comic a day", "description");
  });

  check("every item is an entry", () => eq(feed.entries.length, 3, "count"));

  check("a guid becomes the id, verbatim", () => eq(feed.entries[0].id, "comic-1", "id"));

  check("content:encoded wins over description", () => {
    if (!feed.entries[0].content.includes("Full page")) throw new Error(feed.entries[0].content);
    if (feed.entries[1].content !== "Body two") throw new Error(feed.entries[1].content);
  });

  check("a CDATA title is text, not markup, and entities are resolved", () => {
    eq(feed.entries[0].title, "Page <em>one</em>", "title");
    eq(feed.entries[1].title, "No guid here", "second title");
  });

  check("RFC-822 dates parse, GMT and numeric offsets alike", () => {
    eq(feed.entries[0].publishedAt, Date.parse("2026-10-20T08:30:00Z"), "first");
    eq(feed.entries[1].publishedAt, Date.parse("2026-10-21T09:00:00Z"), "second");
  });

  check("an item with no guid takes its link as the id", () => eq(feed.entries[1].id, "https://comics.example/two", "id"));

  check("an item with neither still gets a stable, non-empty id", () => {
    const id = feed.entries[2].id;
    if (id === "" || id === "undefined") throw new Error(`id is ${JSON.stringify(id)}`);
    const again = parseFeed(RSS, "https://comics.example/rss").entries[2].id;
    eq(again, id, "id across two fetches");
  });

  check("all three entries have distinct ids", () => {
    const ids = new Set(feed.entries.map((entry) => entry.id));
    eq(ids.size, 3, "distinct ids");
  });

  check("feed categories arrive as tags, without duplicates", () => eq(feed.entries[0].tags, ["Comics", "Daily"], "tags"));

  check("an image enclosure becomes the entry's image", () => {
    eq(feed.entries[0].image, "https://comics.example/1.png", "image");
  });

  check("an item without a picture has no image", () => eq(feed.entries[1].image, "", "image"));
}

/* ------------------------------------------------------------------------- */

{
  const feed = parseFeed(ATOM, "https://design.example/feed.xml");
  check("an Atom feed is recognised as Atom, not RSS", () => {
    eq(feed.title, "Design Notes", "title");
    eq(feed.description, "Occasional writing", "subtitle");
  });

  check("the alternate link is the site, not the feed itself", () => {
    eq(feed.siteUrl, "https://design.example/", "site");
  });

  check("the entry id is the Atom id, not the link", () => {
    eq(feed.entries[0].id, "tag:design.example,2026:grids", "id");
  });

  check("the alternate link is the entry's url", () => {
    eq(feed.entries[0].url, "https://design.example/grids", "url");
    eq(feed.entries[1].url, "https://design.example/margins", "url without rel");
  });

  check("an ISO date parses, and published is preferred over updated", () => {
    eq(feed.entries[0].publishedAt, Date.parse("2026-10-19T11:00:00Z"), "first");
    eq(feed.entries[1].publishedAt, Date.parse("2026-10-21T12:00:00Z"), "updated used when no published");
  });

  check("an escaped HTML body is resolved into markup", () => {
    eq(feed.entries[0].content, "<p>The whole piece</p>", "content");
  });

  check("an Atom enclosure is an image like RSS's", () => {
    eq(feed.entries[0].image, "https://design.example/grids.jpg", "image");
  });

  check("an Atom author element is not mistaken for the author's name alone", () => {
    if (!feed.entries[0].author.includes("Someone")) throw new Error(feed.entries[0].author);
  });
}

/* ------------------------------------------------------------------------- */

{
  check("a re-fetch produces the same entries in the same order", () => {
    const a = parseFeed(RSS, "https://comics.example/rss");
    const b = parseFeed(RSS, "https://comics.example/rss");
    eq(a.entries.map((entry) => entry.id), b.entries.map((entry) => entry.id), "ids");
  });

  check("a duplicate guid is dropped rather than shown twice", () => {
    const doubled = RSS.replace(
      "</channel>",
      `<item><title>Again</title><guid>comic-1</guid></item></channel>`,
    );
    eq(parseFeed(doubled, "").entries.length, 3, "count");
  });

  check("an HTML error page yields no entries and does not throw", () => {
    const feed = parseFeed("<html><body><h1>Not found</h1></body></html>", "https://x.test/feed");
    eq(feed.entries.length, 0, "entries");
  });

  check("an empty body yields no entries", () => eq(parseFeed("", "").entries.length, 0, "entries"));

  check("looksLikeFeed separates a feed from a web page", () => {
    eq(looksLikeFeed(RSS), true, "rss");
    eq(looksLikeFeed(ATOM), true, "atom");
    eq(looksLikeFeed("<html><body>nope</body></html>"), false, "html");
  });

  check("a date that is not a date is zero, not NaN", () => {
    eq(parseDate("sometime last week"), 0, "garbage");
    eq(parseDate(""), 0, "empty");
    eq(parseDate("Tue, 20 Oct 2026 08:30:00 PDT"), Date.parse("2026-10-20T15:30:00Z"), "named zone");
  });
}

console.log(`\n${passed} checks passed`);
