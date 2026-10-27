import Foundation
import SQLite3

/// The local library, opened the way the app opens it.
///
/// `src/api/local/sqlite-db.ts` reaches the same file through
/// `@tauri-apps/plugin-sql`, which resolves `sqlite:hardlyreader.db` under the
/// app's config directory. A background wake has no plugin and no webview, so
/// it opens the file itself — same file, same tables, same column meanings, and
/// the same rules about what a fetch may change. What it must never do is
/// *create* a library: if the file is not there, the reader has not used local
/// mode on this device yet and the wake has nothing to do.
public final class LocalLibrary {
  public static let databaseFile = "hardlyreader.db"

  public enum LibraryError: Error, CustomStringConvertible {
    case notFound([String])
    case unreadable(String, String)

    public var description: String {
      switch self {
      case .notFound(let roots):
        return "no \(LocalLibrary.databaseFile) under \(roots.joined(separator: ", "))"
      case .unreadable(let path, let why):
        return "cannot read \(path): \(why)"
      }
    }
  }

  private var handle: OpaquePointer?

  /// Opens an existing library. Never creates one.
  public init(path: String) throws {
    var opened: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(path, &opened, flags, nil) == SQLITE_OK, let db = opened else {
      let why = opened.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open_v2 failed"
      if let handle = opened { sqlite3_close(handle) }
      throw LibraryError.unreadable(path, why)
    }
    sqlite3_busy_timeout(db, 5_000)
    self.handle = db
  }

  deinit {
    if let handle { sqlite3_close(handle) }
  }

  /// The library file, looked for where the app's own paths put it.
  ///
  /// The plugin resolves its directory from Tauri, which on iOS means the app's
  /// Application Support directory, sometimes with the bundle identifier as a
  /// subdirectory. Rather than hard-code one answer this looks in both places
  /// and then one level deeper, and reports the roots it tried when it finds
  /// nothing — a wake that silently does nothing is worse than one that says
  /// why.
  public static func find(in roots: [URL]) -> URL? {
    let fileManager = FileManager.default
    for root in roots {
      let direct = root.appendingPathComponent(databaseFile)
      if fileManager.fileExists(atPath: direct.path) { return direct }
      let children =
        (try? fileManager.contentsOfDirectory(
          at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
        )) ?? []
      for child in children {
        let nested = child.appendingPathComponent(databaseFile)
        if fileManager.fileExists(atPath: nested.path) { return nested }
      }
    }
    return nil
  }

  // MARK: - Reading

  /// Every subscription, with the columns the poll decides on.
  public func feeds() throws -> [FeedState] {
    let sql = """
      SELECT "key", "fetched_at", "attempted_at", "failures", "etag", "last_modified", "title_source"
      FROM "feeds"
      """
    var feeds: [FeedState] = []
    try query(sql) { row in
      feeds.append(
        FeedState(
          key: row.text(0) ?? "",
          fetchedAt: row.int(1),
          attemptedAt: row.int(2),
          failures: row.int(3),
          etag: row.text(4),
          lastModified: row.text(5),
          titleSource: row.text(6)
        )
      )
    }
    return feeds.filter { !$0.key.isEmpty }
  }

  // MARK: - Writing

  /// Records a poll that got an answer: the validators, both times, and a
  /// failure count reset to zero.
  ///
  /// A feed that the reader has not renamed may learn its own name from the
  /// document, and the site's address replaces the placeholder when one arrives
  /// — the same two liberties `recordFetch` takes, and no others.
  public func recordFetch(
    feedUrl: String,
    at: Int,
    etag: String?,
    lastModified: String?,
    title: String?,
    siteUrl: String?
  ) throws {
    let named = (title ?? "").trimmed()
    let site = (siteUrl ?? "").trimmed()
    let sql = """
      UPDATE "feeds" SET
        "fetched_at" = ?, "attempted_at" = ?, "etag" = ?, "last_modified" = ?,
        "failures" = 0, "last_error" = NULL,
        "title" = CASE WHEN ? <> '' AND "title_source" = 'url' THEN ? ELSE "title" END,
        "title_source" = CASE WHEN ? <> '' AND "title_source" = 'url' THEN 'feed' ELSE "title_source" END,
        "html_url" = CASE WHEN ? <> '' THEN ? ELSE "html_url" END
      WHERE "key" = ?
      """
    try run(
      sql,
      [
        .int(at), .int(at), .text(etag), .text(lastModified),
        .text(named), .text(named), .text(named),
        .text(site), .text(site),
        .text(feedUrl),
      ]
    )
  }

  /// Records a poll that did not get an answer.
  ///
  /// `fetched_at` is left alone on purpose — it is when the feed was last read
  /// successfully, and moving it because a site is down would hide how stale
  /// this library is. `attempted_at` moves, because it is what the widening
  /// wait is measured from.
  public func recordFailure(feedUrl: String, at: Int, error: String) throws {
    let sql = """
      UPDATE "feeds" SET
        "attempted_at" = ?, "failures" = COALESCE("failures", 0) + 1, "last_error" = ?
      WHERE "key" = ?
      """
    try run(sql, [.int(at), .text(error), .text(feedUrl)])
  }

  /// Stores the entries of one feed, keyed so a re-fetch is the same row.
  ///
  /// Read and starred are the reader's, not the feed's: a re-fetch may replace
  /// what a post says but never whether it has been read, and `stored_at` keeps
  /// the first time this device saw it.
  @discardableResult
  public func putEntries(_ entries: [ScannedEntry], feedUrl: String, at: Int) throws -> (
    stored: Int, added: Int
  ) {
    if entries.isEmpty { return (0, 0) }

    try run("BEGIN IMMEDIATE", [])
    do {
      var stored = 0
      var added = 0
      var seen = Set<String>()

      for entry in entries {
        let key = LocalLibrary.itemId(feedUrl: feedUrl, guid: entry.id)
        if !seen.insert(key).inserted { continue }

        let published = entry.publishedAt > 0 ? entry.publishedAt / 1000 : at
        let insert = """
          INSERT OR IGNORE INTO "entries"
            ("key", "feed", "guid", "title", "link", "author", "published", "summary",
             "content", "enclosure_href", "enclosure_type", "read", "starred", "stored_at")
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, 0, ?)
          """
        try run(
          insert,
          [
            .text(key), .text(feedUrl), .text(entry.id),
            .text(FeedScanner.empty(entry.title)),
            .text(FeedScanner.empty(entry.url)),
            .text(FeedScanner.empty(entry.author)),
            .int(published),
            .text(FeedScanner.empty(entry.content)),
            .text(FeedScanner.empty(entry.image)),
            .int(at),
          ]
        )
        if sqlite3_changes(handle) > 0 { added += 1 }

        let update = """
          UPDATE "entries" SET
            "title" = ?, "link" = ?, "author" = ?, "published" = ?,
            "content" = ?, "enclosure_href" = ?
          WHERE "key" = ?
          """
        try run(
          update,
          [
            .text(FeedScanner.empty(entry.title)),
            .text(FeedScanner.empty(entry.url)),
            .text(FeedScanner.empty(entry.author)),
            .int(published),
            .text(FeedScanner.empty(entry.content)),
            .text(FeedScanner.empty(entry.image)),
            .text(key),
          ]
        )
        stored += 1
      }

      try run("COMMIT", [])
      return (stored, added)
    } catch {
      try? run("ROLLBACK", [])
      throw error
    }
  }

  // MARK: - Ids

  /// The item id, spelled exactly as `localItemId` spells it — the row the
  /// background wake writes has to be the row the app reads.
  public static func itemId(feedUrl: String, guid: String) -> String {
    "local/\(base64Url(feedUrl))/\(guid)"
  }

  static func base64Url(_ value: String) -> String {
    Data(value.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  // MARK: - SQLite

  enum Value {
    case int(Int)
    case text(String?)

    var bounds: (text: String?, int: Int32?) {
      switch self {
      case .int(let value): return (nil, Int32(value))
      case .text(let value): return (value, nil)
      }
    }
  }

  struct Row {
    let statement: OpaquePointer?

    func text(_ index: Int32) -> String? {
      guard let pointer = sqlite3_column_text(statement, index) else { return nil }
      return String(cString: pointer)
    }

    func int(_ index: Int32) -> Int? {
      guard sqlite3_column_type(statement, index) != SQLITE_NULL else { return nil }
      return Int(sqlite3_column_int64(statement, index))
    }
  }

  private func run(_ sql: String, _ values: [Value]) throws {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
      throw LibraryError.unreadable("statement", lastMessage())
    }
    defer { sqlite3_finalize(statement) }

    for (offset, value) in values.enumerated() {
      let index = Int32(offset + 1)
      let bounds = value.bounds
      if let number = bounds.int {
        sqlite3_bind_int64(statement, index, Int64(number))
      } else if let string = bounds.text {
        // SQLITE_TRANSIENT: SQLite copies the bytes, so the Swift string may go.
        sqlite3_bind_text(statement, index, string, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
      } else {
        sqlite3_bind_null(statement, index)
      }
    }

    guard sqlite3_step(statement) == SQLITE_DONE else {
      throw LibraryError.unreadable("statement", lastMessage())
    }
  }

  private func query(_ sql: String, _ each: (Row) -> Void) throws {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
      throw LibraryError.unreadable("query", lastMessage())
    }
    defer { sqlite3_finalize(statement) }

    while true {
      let step = sqlite3_step(statement)
      if step == SQLITE_ROW {
        each(Row(statement: statement))
      } else if step == SQLITE_DONE {
        return
      } else {
        throw LibraryError.unreadable("query", lastMessage())
      }
    }
  }

  private func lastMessage() -> String {
    guard let handle, let message = sqlite3_errmsg(handle) else { return "unknown error" }
    return String(cString: message)
  }
}

extension FeedScanner {
  /// A column value for text that may be missing: the schema's null, not "".
  static func empty(_ value: String) -> String? {
    value.isEmpty ? nil : value
  }
}
