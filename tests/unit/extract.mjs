import {
  canExtract,
  chooseBody,
  EXTRACT_DEFAULT,
  textLength,
} from "../../src/lib/extract.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- off unless asked -------------------------------------------------------
check("reader view starts off", EXTRACT_DEFAULT === false);

// --- only a web page is a candidate ----------------------------------------
check("https is a page", canExtract("https://example.com/a"));
check("http is a page", canExtract("http://example.com/a"));
check("a mailto is not", !canExtract("mailto:someone@example.com"));
check("script is not a page", !canExtract("javascript:alert(1)"));
check("an empty link is not", !canExtract(""));
check("whitespace is not", !canExtract("   "));
check("a relative path is not fetchable", !canExtract("/posts/1"));
check("nonsense is not", !canExtract("not a url"));

// --- how much text is in a fragment ---------------------------------------
check("tags are not text", textLength("<p></p>") === 0);
check("text is counted", textLength("<p>hello</p>") === 5);
// Tags become a space, not nothing: without it "a</p><p>b" would read as "ab"
// and the length would be wrong by a letter per tag boundary.
check("tags leave a space so words do not fuse", textLength("<p>a</p><p>b</p>") === 3);
check("and runs of them collapse to one", textLength("<p>a</p>\n\n  <p>b</p>") === 3);
check("entities are placeholders, not text", textLength("<p>&amp;&#32;</p>") === 0);
// A <script> is not part of the article, and counting it would let a cookie
// banner look like a successful extraction.
check(
  "script contents do not count",
  textLength("<p>real</p><script>var huge = '" + "x".repeat(500) + "';</script>") === 4,
);
check(
  "style contents do not count",
  textLength("<style>.a{color:red}</style><p>real</p>") === 4,
);

const long = (n) => `<p>${"word ".repeat(Math.ceil(n / 5)).slice(0, n)}</p>`;

// --- which text wins, and where it came from -------------------------------
const feedFull = long(2000);
const feedShort = "<p>Two sentences and a read more link.</p>";

const good = { html: "<p>extracted</p>", title: "t", byline: "", textLength: 1200 };
const thin = { html: "<p>cookie notice</p>", title: "t", byline: "", textLength: 120 };

check("no extraction keeps the feed", chooseBody(null, feedShort).source === "feed");
check("no extraction returns the feed html exactly", chooseBody(null, feedShort).html === feedShort);

// A paywall or cookie wall parses to a few hundred characters. Showing that
// instead of the feed's summary loses content the reader already had.
check("a thin extraction is refused", chooseBody(thin, feedShort).source === "feed");
check("a thin extraction keeps the feed html", chooseBody(thin, feedShort).html === feedShort);

// The case extraction exists for: the feed sent a summary, the page has the piece.
check("a real extraction replaces a summary", chooseBody(good, feedShort).source === "article");
check("and it is the extracted html", chooseBody(good, feedShort).html === "<p>extracted</p>");

// Many feeds ship the whole article. Stripping it to a paragraph would be a
// regression, so an extraction that found much less than the feed loses.
const smaller = { html: "<p>short</p>", title: "t", byline: "", textLength: 400 };
check("an extraction smaller than a full feed loses", chooseBody(smaller, feedFull).source === "feed");

// But comparable size on a full feed is the good case: same piece, no furniture.
const comparable = { html: "<p>clean</p>", title: "t", byline: "", textLength: 1500 };
check("a comparable extraction wins", chooseBody(comparable, feedFull).source === "article");

// Exactly at the line: 0.6 * 2000 = 1200, so 1200 is not "less than".
const edge = { html: "<p>edge</p>", title: "t", byline: "", textLength: 1200 };
check("the ratio boundary is inclusive", chooseBody(edge, feedFull).source === "article");
const justUnder = { html: "<p>under</p>", title: "t", byline: "", textLength: 1199 };
check("a hair under the ratio loses", chooseBody(justUnder, feedFull).source === "feed");

// An empty feed body must still accept a real extraction: nothing to lose.
check("an empty feed body accepts an extraction", chooseBody(good, "").source === "article");

if (failures === 0) {
  console.log(`ok ${checks} checks — reader view extraction rules`);
} else {
  console.log(`${failures} failed of ${checks} checks`);
  process.exit(1);
}
