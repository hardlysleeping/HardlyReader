// Where a post's text comes from, decided per feed.
//
// The rule is one function (`wantsFullText`) over four facts that arrive from
// four places: the reader's press on this entry, the feed's own answer, the
// account-wide switch, and what Auto has read in the feed's markup. These checks
// pin the order of those facts and the two ways a feed says "I cut this short" —
// a marker at the cut, and a body short enough that the marker means it.
//
// They are deliberately about the decision, not about the network: the fetch
// itself is `extract.ts`'s, and what it does with a thin page is already pinned
// by `extract.mjs`.
import {
  FULL_TEXT_DEFAULT,
  FULL_TEXT_LABELS,
  FULL_TEXT_MODES,
  TRUNCATED_TEXT,
  choiceFromMode,
  hasMoreMarker,
  isFullTextMode,
  looksTruncated,
  modeFromChoice,
  wantsFullText,
} from "../../src/lib/full-text.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const words = (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);
const long = (n) => `<p>${words(n)}</p>`;

// --- the three answers ------------------------------------------------------

check("a feed starts on Auto", FULL_TEXT_DEFAULT === "auto");
check("three answers, in the order they are offered", FULL_TEXT_MODES.join(",") === "auto,feed,article");
check("the third one is a webpage, not an article", FULL_TEXT_LABELS.article === "Full webpage");
check("and the first two are the feed's own words", FULL_TEXT_LABELS.auto === "Auto" && FULL_TEXT_LABELS.feed === "Feed");
check("only the three words are answers", isFullTextMode("auto") && isFullTextMode("feed") && isFullTextMode("article"));
check("nothing else is", !isFullTextMode("article+") && !isFullTextMode(null) && !isFullTextMode(""));

// Auto is the absence of a stored answer, so the ledger never learns a third
// value and an older build reads the same blob the same way.
check("the stored shape has two values", choiceFromMode("feed") === "feed" && choiceFromMode("article") === "article");
check("Auto stores nothing", choiceFromMode("auto") === null);
check("nothing stored reads back as Auto", modeFromChoice(null) === "auto" && modeFromChoice(undefined) === "auto");
check("and a stored answer reads back as itself", modeFromChoice("feed") === "feed" && modeFromChoice("article") === "article");

// --- what a cut-off post looks like ----------------------------------------

check("the length gate is under a thousand characters", TRUNCATED_TEXT >= 500 && TRUNCATED_TEXT < 1000);

check("an ellipsis at the end is the mark", looksTruncated(`<p>${words(400)}…</p>`));
check("three dots are the same mark", looksTruncated(`<p>${words(400)}...</p>`));
check("so is the entity", looksTruncated(`<p>${words(400)}&hellip;</p>`));
check("and a bracketed one", looksTruncated(`<p>${words(400)} [ … ] </p>`));
check("a trailing tag does not hide it", looksTruncated(`<p>${words(400)}…</p>\n</div>`));

check("a read-more link is the mark", looksTruncated(`<p>${words(400)}</p><p><a href="https://pub.example/a">Read more</a></p>`));
check("with an arrow inside the link", looksTruncated(`<p>${words(400)}</p><a href="https://pub.example/a">Continue reading<span>→</span></a>`));
check("and the words alone count when they are printed without a link", looksTruncated(`<p>${words(400)} Continue reading</p>`));

// The gate is what keeps the two marks honest: a piece that is 2000 characters
// long may well end in an ellipsis or mention reading more, and it is not cut.
check("a long post is never cut off, whatever it ends with", !looksTruncated(long(2000) + "…"));
check("nor is one that ends by mentioning reading more", !looksTruncated(long(2000) + " read more"));
check("a short whole post is not a teaser", !looksTruncated("<p>Filed under: notebooks. Two paragraphs, done.</p>"));
check("an empty body is not a teaser", !looksTruncated(""));
check("an unrelated link is not a read-more", !looksTruncated(`<p>${words(200)}</p><a href="https://pub.example/b">Related: another story</a>`));
check("nor is a link that merely begins with the words", !looksTruncated(`<p>${words(200)}</p><a href="https://pub.example/c">Read more about the author</a>`));

// The marker is asked of the body, not of one branch: a picture gallery is a
// whole post with no text at all, and is not a teaser.
check("a picture-only post is not a teaser", !looksTruncated(`<p><img src="https://pub.example/1.jpg"></p>`));
check("the marker finder is the one that answers", hasMoreMarker(`<a href="x">Read more</a>`) && !hasMoreMarker(`<a href="x">Another story</a>`));

// --- the order of the four facts -------------------------------------------

const teaser = `<p>${words(300)}…</p>`;
const whole = long(2000);

const ask = (over) => ({ post: null, feed: "auto", accountWide: false, remembered: false, html: whole, ...over });

// 1. One post outranks its feed in both directions.
check("a press on one post wins over the feed's Full webpage", wantsFullText(ask({ post: "feed", feed: "article" })) === false);
check("and over the account-wide switch", wantsFullText(ask({ post: "feed", accountWide: true })) === false);
check("a press for the article wins over a feed told to stay on the feed", wantsFullText(ask({ post: "article", feed: "feed" })) === true);

// 2. The feed's own answer is absolute.
check("Feed never fetches, even when the post is a teaser", wantsFullText(ask({ feed: "feed", html: teaser })) === false);
check("Feed never fetches for a feed Auto already knows truncates", wantsFullText(ask({ feed: "feed", remembered: true })) === false);
check("Full webpage fetches a whole post", wantsFullText(ask({ feed: "article" })) === true);

// 3. Auto: the account switch, then what Auto remembers, then this post.
check("Auto fetches when the account-wide switch is on", wantsFullText(ask({ accountWide: true })) === true);
check("Auto fetches for a feed it has caught truncating", wantsFullText(ask({ remembered: true })) === true);
check("Auto fetches a post whose own text stops short", wantsFullText(ask({ html: teaser })) === true);
check("and leaves a whole post alone", wantsFullText(ask()) === false);
check("a whole post is still left alone for a feed it has not seen", wantsFullText(ask({ remembered: false, html: whole })) === false);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
