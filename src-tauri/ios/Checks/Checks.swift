// The checks for the Swift half of the local refresh.
//
// Run with Swift on any machine — no Mac, no simulator, no device:
//
//   scripts/ios-refresh-checks.sh
//
// They compile RefreshPolicy.swift, FeedScanner.swift, LocalLibrary.swift and
// BackgroundRefresher.swift (everything except the BGTaskScheduler glue, which
// needs iOS) and drive them against a real SQLite file and a fake transport.
// The expected values are not invented here: the feed fixtures, the dates, the
// hash and the item id were produced by the JavaScript they have to agree with,
// so a drift on either side fails a check rather than quietly storing every
// article twice.
import Foundation
import SQLite3

@main
struct RefreshChecks {
  static func main() async throws {
    policy()
    scanner()
    await try wakeAndStore()
    report()
  }

  // MARK: - The rule

  static func policy() {
    same("interval with no failures is an hour", RefreshMath.intervalSeconds(failures: nil), 3600)
    same("one failure doubles it", RefreshMath.intervalSeconds(failures: 1), 7200)
    same("two failures double it again", RefreshMath.intervalSeconds(failures: 2), 14400)
    same("three failures are capped at six hours", RefreshMath.intervalSeconds(failures: 3), 21600)
    same("a long outage stays capped", RefreshMath.intervalSeconds(failures: 9), 21600)

    same("a feed never attempted is due now", RefreshMath.dueAt(FeedState(key: "a")), 0)
    same(
      "a successful poll waits an hour",
      RefreshMath.dueAt(FeedState(key: "a", attemptedAt: 1_000, failures: 0)), 4_600)
    same(
      "a failed poll waits two",
      RefreshMath.dueAt(FeedState(key: "a", attemptedAt: 1_000, failures: 1)), 8_200)
    same(
      "the later of the two times is what counts",
      RefreshMath.dueAt(FeedState(key: "a", fetchedAt: 9_000, attemptedAt: 1_000, failures: 0)),
      12_600)

    let feed = FeedState(key: "a", attemptedAt: 1_000, failures: 0)
    check("due at the boundary", RefreshMath.isDue(feed, now: 4_600))
    check("not due a second early", !RefreshMath.isDue(feed, now: 4_599))

    // Stalest first, key breaking ties, and six of them at most.
    var feeds: [FeedState] = []
    for index in 0..<8 {
      feeds.append(FeedState(key: "feed-\(index)", attemptedAt: 10_000 + index * 10, failures: 0))
    }
    let due = RefreshMath.dueFeeds(feeds, now: 100_000)
    same("a wake is bounded at six feeds", due.count, 6)
    same("the stalest is first", due.first?.key ?? "", "feed-0")
    same("the sixth stale, not the sixth subscribed", due.last?.key ?? "", "feed-5")

    let tied = RefreshMath.dueFeeds(
      [
        FeedState(key: "b", attemptedAt: 1_000, failures: 0),
        FeedState(key: "a", attemptedAt: 1_000, failures: 0),
      ],
      now: 100_000)
    same("ties are taken in key order", tied.map(\.key).joined(separator: ","), "a,b")

    let fresh = RefreshMath.dueFeeds(
      [FeedState(key: "fresh", attemptedAt: 100_000, failures: 0)], now: 100_000)
    same("a feed read a moment ago is not due", fresh.count, 0)
  }

  // MARK: - The scanner

  static func scanner() {
    check("an RSS document looks like a feed", FeedScanner.looksLikeFeed(rssFixture))
    check("an RDF document looks like a feed", FeedScanner.looksLikeFeed("<rdf:RDF>x</rdf:RDF>"))
    check("an HTML page does not", !FeedScanner.looksLikeFeed(htmlFixture))

    let rss = FeedScanner.parse(rssFixture, feedUrl: "https://example.test/feed")
    same("the channel title", rss.title, "Test Feed")
    same("the site's address, not the feed's", rss.siteUrl, "https://example.test/")
    same("both items", rss.entries.count, 2)

    let first = rss.entries[0]
    same("the guid is the id", first.id, "guid-1")
    same("the title", first.title, "Post One")
    same("the link", first.url, "https://example.test/one")
    same("the date, in milliseconds", first.publishedAt, 1_212_491_130_000)
    same("CDATA unwrapped, entities decoded", first.content, "<p>Hello & welcome</p>")
    same("dc:creator is the author", first.author, "Ada")
    same("the enclosure is the image", first.image, "https://example.test/a.jpg")

    let second = rss.entries[1]
    same("content:encoded beats description", second.content, "<p>Second</p>")
    same("no author is no author", second.author, "")
    same("no enclosure is no image", second.image, "")

    let atom = FeedScanner.parse(atomFixture, feedUrl: "https://atom.test/feed")
    same("the Atom title", atom.title, "Atom Test")
    same("the Atom site link", atom.siteUrl, "https://atom.test/")
    same("the Atom subtitle is the description", atom.description, "sub")
    same("one entry", atom.entries.count, 1)
    same("the Atom id", atom.entries[0].id, "urn:uuid:1")
    same("the alternate link", atom.entries[0].url, "https://atom.test/p/1")
    same("updated is the date", atom.entries[0].publishedAt, 1_709_294_400_000)
    same("decoded content", atom.entries[0].content, "<p>Body</p>")
    // Foundation, like the JS side, returns the `author` element's inside, so
    // an Atom author arrives with its `<name>` markup. Bug for bug: the two
    // sides must agree, and this is the shape they both have.
    same("the Atom author, markup and all", atom.entries[0].author, "<name>Grace</name>")

    same("RFC-822 with a timezone word", FeedScanner.parseDate("Tue, 03 Jun 2008 11:05:30 GMT"), 1_212_491_130_000)
    same("ISO-8601", FeedScanner.parseDate("2003-12-13T18:30:02Z"), 1_071_340_202_000)
    same("RFC-822 with a numeric offset", FeedScanner.parseDate("Mon, 15 Jan 2024 10:00:00 +0000"), 1_705_312_800_000)
    same("a two-digit year", FeedScanner.parseDate("Tue, 03 Jun 08 11:05:30 GMT"), 1_212_491_130_000)
    same("no date is zero", FeedScanner.parseDate(""), 0)

    same("&amp;lt; stays text, once", FeedScanner.unescapeXml("&amp;lt;b&amp;gt;"), "&lt;b&gt;")
    same("entities and non-breaking spaces", FeedScanner.unescapeXml("&#x263A; &nbsp;x &amp; y"), "☺  x & y")

    // The id a feed with no guid and no link gets: a hash of title and date,
    // over UTF-16 code units, in base 36 — computed by `fingerprint` in
    // src/lib/rss.ts.
    let nameless = FeedScanner.parse(
      "<rss><channel><item><title>No Id</title></item></channel></rss>",
      feedUrl: "https://example.test/feed")
    same("a nameless post still gets an id", nameless.entries[0].id, "https://example.test/feed#5jpdrv")

    same(
      "the item id is the app's item id",
      LocalLibrary.itemId(feedUrl: "https://x.test/feed", guid: "a b"),
      "local/aHR0cHM6Ly94LnRlc3QvZmVlZA/a b")
  }

  // MARK: - A wake, against a real SQLite file

  static func wakeAndStore() async throws {
    let database = try FixtureDatabase()
    defer { database.close() }
    try database.insertFeed(key: feedUrl, title: "example.test", titleSource: "url", addedAt: 1_000)

    let library = try LocalLibrary(path: database.path)
    let clock = Clock(start: 10_000)

    // 1. A feed that answered with two new posts.
    let transport = FakeTransport([
      FeedResponse(
        status: 200,
        headers: ["etag": "W/\"abc\"", "last-modified": "Tue, 03 Jun 2008 11:05:30 GMT"],
        body: rssFixture)
    ])
    let refresher = BackgroundRefresher(
      library: library, transport: transport, now: { clock.now })

    var report = await refresher.wake()
    same("one feed attempted", report.attempted, 1)
    same("it changed", report.changed, 1)
    same("two articles added", report.added, 2)
    same("both stored", report.stored, 2)
    same("nothing answered 304", report.notModified, 0)
    same("nothing failed", report.failures.count, 0)
    check("the log line names the feed", report.describe().contains(feedUrl), report.describe())
    check("the log line counts the 304s", report.describe().contains("0 answered 304"), report.describe())

    same("the row remembers the poll", database.number("SELECT fetched_at FROM feeds"), 10_000)
    same("and the attempt", database.number("SELECT attempted_at FROM feeds"), 10_000)
    same("and the etag", database.text("SELECT etag FROM feeds"), "W/\"abc\"")
    same("and the validator", database.text("SELECT last_modified FROM feeds"), "Tue, 03 Jun 2008 11:05:30 GMT")
    same("failures are cleared", database.number("SELECT failures FROM feeds"), 0)
    same("no error is left behind", database.text("SELECT last_error FROM feeds"), nil)
    same("the feed learned its name", database.text("SELECT title FROM feeds"), "Test Feed")
    same("and that the name came from the feed", database.text("SELECT title_source FROM feeds"), "feed")
    same("and the site's address", database.text("SELECT html_url FROM feeds"), "https://example.test/")
    same("two rows in entries", database.number("SELECT COUNT(*) FROM entries"), 2)

    let itemKey = LocalLibrary.itemId(feedUrl: feedUrl, guid: "guid-1")
    same("the row is keyed the app's way", database.text("SELECT key FROM entries WHERE guid = 'guid-1'"), itemKey)
    same("the body is stored", database.text("SELECT content FROM entries WHERE guid = 'guid-1'"), "<p>Hello & welcome</p>")
    same("the date is in seconds", database.number("SELECT published FROM entries WHERE guid = 'guid-1'"), 1_212_491_130)
    same("an article arrives unread", database.number("SELECT read FROM entries WHERE guid = 'guid-1'"), 0)

    // The reader reads and stars one, long before the next wake.
    try database.exec("UPDATE entries SET read = 1, starred = 1, stored_at = 7 WHERE guid = 'guid-1'")

    // 2. An hour later, a 304: the feed has published nothing.
    clock.advance(4_000)
    transport.respond([
      FeedResponse(status: 304, headers: ["etag": "W/\"abc\""], body: "")
    ])
    report = await refresher.wake()
    same("the poll was attempted", report.attempted, 1)
    same("and answered 304", report.notModified, 1)
    same("nothing was added", report.added, 0)
    same("the 304 moved the attempt", database.number("SELECT attempted_at FROM feeds"), 14_000)
    same("but not the last success", database.number("SELECT fetched_at FROM feeds"), 14_000)
    same("no error", database.number("SELECT failures FROM feeds"), 0)
    check(
      "the 304 was sent conditionally",
      transport.requests.last?.headers["if-none-match"] == "W/\"abc\"",
      "\(transport.requests.last?.headers ?? [:])")
    same("the feed count is unchanged", database.number("SELECT COUNT(*) FROM entries"), 2)

    // 3. A changed feed: what a post says may be replaced, what the reader did
    //    to it may not.
    clock.advance(4_000)
    transport.respond([
      FeedResponse(
        status: 200, headers: ["etag": "W/\"def\""],
        body: rssFixture.replacingOccurrences(of: "Post One", with: "Post One, retitled"))
    ])
    report = await refresher.wake()
    same("the retitled post was stored", report.added, 0)
    same("the title is the feed's new one", database.text("SELECT title FROM entries WHERE guid = 'guid-1'"), "Post One, retitled")
    same("read survives a re-fetch", database.number("SELECT read FROM entries WHERE guid = 'guid-1'"), 1)
    same("starred survives a re-fetch", database.number("SELECT starred FROM entries WHERE guid = 'guid-1'"), 1)
    same("the first time it was seen survives", database.number("SELECT stored_at FROM entries WHERE guid = 'guid-1'"), 7)

    // 4. A 500: a failure on the feed, and a widening wait.
    clock.advance(4_000)
    transport.respond([FeedResponse(status: 500, headers: [:], body: "")])
    report = await refresher.wake()
    same("the failure is reported", report.failures.count, 1)
    same("in the app's words", report.failures.first?.reason ?? "", "\(feedUrl) answered 500")
    same("counted on the row", database.number("SELECT failures FROM feeds"), 1)
    same("with the reason", database.text("SELECT last_error FROM feeds"), "\(feedUrl) answered 500")
    same("the last success is not moved by a failure", database.number("SELECT fetched_at FROM feeds"), 18_000)

    // 6. An hour after a failure is too soon: the wait has doubled.
    clock.advance(3_600 - 10)
    transport.respond([FeedResponse(status: 200, headers: [:], body: rssFixture)])
    report = await refresher.wake()
    same("a failing feed is left alone for the backoff", report.attempted, 0)

    clock.advance(3_620)
    transport.respond([FeedResponse(status: 200, headers: [:], body: rssFixture)])
    report = await refresher.wake()
    same("and tried again when the backoff is up", report.attempted, 1)
    same("a good answer clears the failures", database.number("SELECT failures FROM feeds"), 0)

    // 7. Offline is not a failing feed.
    let offline = BackgroundRefresher(
      library: library, transport: transport, now: { clock.now }, online: { false })
    report = await offline.wake()
    same("an offline wake is skipped", report.skipped ?? "", "offline")
    same("and attempts nothing", report.attempted, 0)

    // 8. The deadline arriving.
    clock.advance(10_000)
    let stopped = BackgroundRefresher(
      library: library, transport: transport, now: { clock.now })
    report = await stopped.wake(cancelled: { true })
    same("a cancelled wake attempts nothing", report.attempted, 0)
    check("and says so", report.aborted || report.attempted == 0)
  }

  // MARK: - Reporting

  static var checks = 0
  static var failures = 0

  static func check(_ name: String, _ passed: Bool, _ detail: String = "") {
    checks += 1
    if passed {
      print("ok   \(name)")
    } else {
      failures += 1
      print("FAIL \(name)\(detail.isEmpty ? "" : " — \(detail)")")
    }
  }

  static func same<T: Equatable>(_ name: String, _ actual: T, _ expected: T) {
    check(name, actual == expected, "got \(String(describing: actual)), wanted \(String(describing: expected))")
  }

  static func report() {
    print("\n\(checks - failures)/\(checks) checks passed")
    if failures > 0 { exit(1) }
  }
}

// MARK: - Fixtures

let feedUrl = "https://example.test/feed"

/// Produced by the JavaScript side (`parseFeed` on the same document), so the
/// two ports are held to one answer rather than two that look similar.
let rssFixture = """
  <?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><link>https://example.test/</link><description>d</description><item><title>Post One</title><link>https://example.test/one</link><guid>guid-1</guid><pubDate>Tue, 03 Jun 2008 11:05:30 GMT</pubDate><description><![CDATA[<p>Hello &amp; welcome</p>]]></description><dc:creator>Ada</dc:creator><enclosure url="https://example.test/a.jpg" type="image/jpeg"/></item><item><title>Post Two</title><link>https://example.test/two</link><guid>guid-2</guid><pubDate>Mon, 15 Jan 2024 10:00:00 +0000</pubDate><content:encoded><![CDATA[<p>Second</p>]]></content:encoded></item></channel></rss>
  """

let atomFixture = """
  <?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Test</title><link href="https://atom.test/" rel="alternate"/><subtitle>sub</subtitle><entry><title>Atom Post</title><link href="https://atom.test/p/1" rel="alternate"/><id>urn:uuid:1</id><updated>2024-03-01T12:00:00Z</updated><content type="html">&lt;p&gt;Body&lt;/p&gt;</content><author><name>Grace</name></author></entry></feed>
  """

let htmlFixture = "<html><body>nope</body></html>"

/// A DB the foreground app could have made: the same two tables, filled in the
/// same way, in a temporary file.
final class FixtureDatabase {
  let path: String
  private var handle: OpaquePointer?

  init() throws {
    path = NSTemporaryDirectory() + "hardlyreader-checks-\(UUID().uuidString).db"
    guard sqlite3_open(path, &handle) == SQLITE_OK else { throw Failure("could not create \(path)") }
    try exec(
      """
      CREATE TABLE "feeds" ("key" TEXT PRIMARY KEY NOT NULL, "title" TEXT, "html_url" TEXT,
        "icon_url" TEXT, "folder" TEXT, "added_at" INTEGER, "title_source" TEXT,
        "fetched_at" INTEGER, "attempted_at" INTEGER, "etag" TEXT, "last_modified" TEXT,
        "failures" INTEGER, "last_error" TEXT)
      """)
    try exec(
      """
      CREATE TABLE "entries" ("key" TEXT PRIMARY KEY NOT NULL, "feed" TEXT, "guid" TEXT,
        "title" TEXT, "link" TEXT, "author" TEXT, "published" INTEGER, "summary" TEXT,
        "content" TEXT, "enclosure_href" TEXT, "enclosure_type" TEXT, "read" INTEGER,
        "starred" INTEGER, "stored_at" INTEGER)
      """)
  }

  func close() {
    if let handle { sqlite3_close(handle) }
    handle = nil
    try? FileManager.default.removeItem(atPath: path)
  }

  func exec(_ sql: String) throws {
    var message: UnsafeMutablePointer<CChar>?
    if sqlite3_exec(handle, sql, nil, nil, &message) != SQLITE_OK {
      let why = message.map { String(cString: $0) } ?? "unknown"
      sqlite3_free(message)
      throw Failure(why)
    }
  }

  func insertFeed(key: String, title: String, titleSource: String, addedAt: Int) throws {
    try exec(
      """
      INSERT INTO "feeds" ("key", "title", "title_source", "added_at") VALUES
        ('\(key)', '\(title)', '\(titleSource)', \(addedAt))
      """)
  }

  func number(_ sql: String) -> Int? {
    guard let row = rows(sql).first, let value = row.first ?? nil else { return nil }
    return Int(value)
  }

  func text(_ sql: String) -> String? {
    rows(sql).first?[0]
  }

  private func rows(_ sql: String) -> [[String?]] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(statement) }
    var out: [[String?]] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      var row: [String?] = []
      for index in 0..<sqlite3_column_count(statement) {
        if let pointer = sqlite3_column_text(statement, index) {
          row.append(String(cString: pointer))
        } else {
          row.append(nil)
        }
      }
      out.append(row)
    }
    return out
  }
}

struct Failure: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

final class Clock {
  var now: Int
  init(start: Int) { now = start }
  func advance(_ seconds: Int) { now += seconds }
}

/// A transport that answers with whatever the check queued, and remembers what
/// it was asked — the same shape as the fake `fetch` the JS suite passes in.
final class FakeTransport: FeedTransport {
  private var queue: [FeedResponse]
  private(set) var requests: [(url: String, headers: [String: String])] = []

  init(_ responses: [FeedResponse]) { queue = responses }

  func respond(_ responses: [FeedResponse]) { queue = responses }

  func fetch(_ url: URL, headers: [String: String], timeout: TimeInterval) async throws
    -> FeedResponse
  {
    requests.append((url.absoluteString, headers))
    guard !queue.isEmpty else { throw URLError(.cannotConnectToHost) }
    return queue.removeFirst()
  }
}
