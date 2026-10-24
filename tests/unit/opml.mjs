import { strict as assert } from "node:assert";
import { buildOpml, escapeXml, opmlFileName, parseOpml } from "../../src/lib/opml.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

// A file from another reader: folders, a feed outside any folder, entities, a
// self-closing tag and one duplicate.
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="Technology">
      <outline type="rss" text="Ars Technica" xmlUrl="https://example.com/ars.xml" />
      <outline type="rss" text="Lobsters" xmlUrl="https://example.com/lobsters.xml"></outline>
    </outline>
    <outline text="Design &amp; Art">
      <outline type="rss" text="It&#39;s Nice That" xmlUrl="https://example.com/itsnicethat.xml" htmlUrl="https://example.com/" />
    </outline>
    <outline type="rss" text="Loose feed" xmlUrl="https://example.com/loose.xml" />
    <outline type="rss" text="Ars again" xmlUrl="https://example.com/ars.xml" />
  </body>
</opml>`;

{
  const feeds = parseOpml(SAMPLE);
  check("every feed is read", () => assert.equal(feeds.length, 4, String(feeds.length)));
  check(
    "a feed keeps the folder it was filed under",
    () => assert.equal(feeds[0].category, "Technology"),
  );
  check("entities in a folder name are decoded", () => assert.equal(feeds[2].category, "Design & Art"));
  check("a feed outside a folder has no folder", () => assert.equal(feeds[3].category, undefined));
  check("a title is carried", () => assert.equal(feeds[3].title, "Loose feed"));
  check("the URL is carried verbatim", () => assert.equal(feeds[0].url, "https://example.com/ars.xml"));
  check(
    "the same feed twice is one feed, first one winning",
    () => assert.equal(feeds.filter((feed) => feed.url.endsWith("ars.xml")).length, 1),
  );
  check(
    "...and the first one is the one with the folder",
    () => assert.equal(feeds.find((feed) => feed.url.endsWith("ars.xml")).category, "Technology"),
  );
  check(
    "a folder with no name does not swallow its feeds",
    () => {
      const xml = `<opml><body><outline><outline xmlUrl="https://example.com/x.xml" title="X" /></outline></body></opml>`;
      assert.equal(parseOpml(xml)[0].category, undefined);
    },
  );
  check(
    "the flat `category` attribute works when there is no nesting",
    () => {
      const xml = `<opml><body><outline type="rss" text="Y" category="News/Sport" xmlUrl="https://example.com/y.xml" /></body></opml>`;
      assert.equal(parseOpml(xml)[0].category, "News");
    },
  );
  check("a lower-case xmlurl attribute is accepted", () => {
    const xml = `<opml><body><outline xmlurl="https://example.com/z.xml" /></body></opml>`;
    assert.equal(parseOpml(xml)[0].url, "https://example.com/z.xml");
  });
  check("a file with no feeds is refused, in words", () => {
    assert.throws(
      () => parseOpml("<?xml version=\"1.0\"?><opml><body></body></opml>"),
      /no feeds in it/,
    );
  });
  check("nonsense is refused rather than silently empty", () => {
    assert.throws(() => parseOpml("not xml at all"), /no feeds/);
  });
}

{
  const folders = [
    { label: "Technology", feeds: [{ title: "Ars & Co", url: "https://example.com/ars.xml" }] },
    { label: "Odd <names>", feeds: [{ title: "Quotes \"here\"", url: "https://example.com/q.xml?a=1&b=2" }] },
  ];
  const xml = buildOpml(folders, { created: new Date("2026-10-23T04:05:06Z") });
  check("the document declares itself OPML 2.0", () => assert.match(xml, /<opml version="2\.0">/));
  check("the date is ISO-8601", () => assert.match(xml, /<dateCreated>2026-10-23T04:05:06\.000Z<\/dateCreated>/));
  check("folders are outlines with their feeds inside", () => {
    assert.match(xml, /<outline text="Technology"/);
    assert.match(xml, /xmlUrl="https:\/\/example\.com\/ars\.xml"/);
  });
  check("a title with markup is escaped, not broken", () => {
    assert.match(xml, /text="Odd &lt;names&gt;"/);
    assert.match(xml, /title="Quotes &quot;here&quot;"/);
  });
  check("an ampersand in a URL is escaped", () => assert.match(xml, /a=1&amp;b=2/));

  const back = parseOpml(xml);
  check("a written file reads back as what went in", () => {
    assert.deepEqual(
      back.map((feed) => [feed.url, feed.title, feed.category]),
      [
        ["https://example.com/ars.xml", "Ars & Co", "Technology"],
        ["https://example.com/q.xml?a=1&b=2", 'Quotes "here"', "Odd <names>"],
      ],
    );
  });
  check("escaping is reversible", () => {
    const odd = `A & B < C > "D" 'E'`;
    assert.equal(parseOpml(`<opml><body><outline xmlUrl="https://x.test/f" text="${escapeXml(odd)}"/></body></opml>`)[0].title, odd);
  });
}

check("the file name is dated and has no spaces", () => {
  assert.equal(opmlFileName(new Date(2026, 9, 23)), "hardlyreader-2026-10-23.opml");
  assert.equal(opmlFileName(new Date(2026, 0, 5)), "hardlyreader-2026-01-05.opml");
});

console.log(`\n${passed}/${passed} checks passed`);
