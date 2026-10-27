import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// One feed's answer, as much of it as a poll uses.
public struct FeedResponse: Equatable {
  public var status: Int
  /// Header names are lowercased, because HTTP's are not case-sensitive.
  public var headers: [String: String]
  public var body: String

  public init(status: Int, headers: [String: String], body: String) {
    self.status = status
    self.headers = headers
    self.body = body
  }
}

/// How the poller reaches the network. A protocol so the wake can be driven by
/// a fake in the checks — the same reason `FeedFetcher` is a parameter in
/// `refresh.ts` rather than a call to `fetch` in the middle of the loop.
public protocol FeedTransport {
  func fetch(_ url: URL, headers: [String: String], timeout: TimeInterval) async throws
    -> FeedResponse
}

/// `URLSession`, which is what a background task is allowed to use.
public final class URLSessionTransport: FeedTransport {
  private let session: URLSession

  public init(session: URLSession = URLSession(configuration: .ephemeral)) {
    self.session = session
  }

  public func fetch(
    _ url: URL, headers: [String: String], timeout: TimeInterval
  ) async throws -> FeedResponse {
    var request = URLRequest(url: url)
    // The deadline covers the request *and* reading its body: a feed that sends
    // headers and then stalls is the same problem as one that never answers.
    request.timeoutInterval = timeout
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }

    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }

    var received: [String: String] = [:]
    for (name, value) in http.allHeaderFields {
      guard let name = name as? String else { continue }
      received[name.lowercased()] = String(describing: value)
    }
    return FeedResponse(
      status: http.statusCode,
      headers: received,
      body: String(decoding: data, as: UTF8.self)
    )
  }
}

/// One feed that could not be read, and why, in words a reader could be shown.
public struct RefreshFailure: Equatable {
  public var feedUrl: String
  public var reason: String
}

/// What one wake did. Counted, so the log line is a sentence and not a guess.
public struct WakeReport {
  public var wake: String
  public var at: Int
  public var due: Int = 0
  public var attempted: Int = 0
  public var attemptedFeeds: [String] = []
  public var changed: Int = 0
  public var notModified: Int = 0
  public var added: Int = 0
  public var stored: Int = 0
  public var failures: [RefreshFailure] = []
  /// True when the caller's deadline stopped the loop partway.
  public var aborted: Bool = false
  /// `offline` when nothing was attempted because there is no network.
  public var skipped: String?
  /// Set when the library itself could not be read or written.
  public var storeError: String?

  /// The one line a wake leaves behind: what it tried, and what came back.
  public func describe() -> String {
    if let storeError { return "bg-refresh: \(wake) wake failed: \(storeError)" }
    if skipped == "offline" { return "bg-refresh: \(wake) wake skipped, offline" }

    var parts = [
      "\(due) due", "\(attempted) attempted", "\(changed) changed", "\(notModified) answered 304",
      "\(added) added", "\(failures.count) failed",
    ]
    if aborted { parts.append("stopped at the deadline") }
    if let storeError { parts.append(storeError) }
    let tried = attemptedFeeds.isEmpty ? "nothing tried" : attemptedFeeds.joined(separator: " | ")
    return "bg-refresh: \(wake) wake — \(parts.joined(separator: ", ")) — \(tried)"
  }
}

/// Fetches the feeds that are due, and keeps whatever changed.
///
/// The same walk as `refreshDueFeeds`: due feeds in the same order, one at a
/// time, conditional requests, fifteen seconds each, failures recorded on the
/// feed they belong to, and the store stamped only after the entries are in.
/// It has no timer and no opinion about when it runs — that is the platform's
/// business, and the due time on each row is the only thing that decides
/// whether a wake does anything at all.
public final class BackgroundRefresher {
  private let library: LocalLibrary
  private let transport: FeedTransport
  private let now: () -> Int
  private let online: () -> Bool
  private let log: (String) -> Void

  public init(
    library: LocalLibrary,
    transport: FeedTransport = URLSessionTransport(),
    now: @escaping () -> Int = { Int(Date().timeIntervalSince1970) },
    online: @escaping () -> Bool = { true },
    log: @escaping (String) -> Void = { _ in }
  ) {
    self.library = library
    self.transport = transport
    self.now = now
    self.online = online
    self.log = log
  }

  /// One wake: whatever is due, up to the per-wake cap, and nothing else.
  ///
  /// `cancelled` is the deadline: iOS gives a background task a budget it does
  /// not publish, so the task's expiration handler flips this and the loop stops
  /// at the next feed boundary rather than being killed mid-write.
  public func wake(wake: String = "background", cancelled: () -> Bool = { false }) async
    -> WakeReport
  {
    var report = WakeReport(wake: wake, at: now())

    guard online() else {
      report.skipped = "offline"
      log(report.describe())
      return report
    }

    let feeds: [FeedState]
    do {
      feeds = try library.feeds()
    } catch {
      report.storeError = "\(error)"
      log(report.describe())
      return report
    }

    let due = RefreshMath.dueFeeds(feeds, now: report.at)
    report.due = due.count

    for feed in due {
      if cancelled() || Task.isCancelled {
        report.aborted = true
        break
      }

      report.attempted += 1
      report.attemptedFeeds.append(feed.key)

      switch await poll(feed, at: report.at, cancelled: cancelled) {
      case .aborted:
        report.aborted = true
      case .failed(let failure):
        report.failures.append(failure)
      case .notModified:
        report.notModified += 1
      case .changed(let added, let stored):
        report.changed += 1
        report.added += added
        report.stored += stored
      }

      if report.aborted { break }
    }

    log(report.describe())
    for failure in report.failures { log("bg-refresh: \(failure.reason)") }
    return report
  }

  // MARK: - One feed

  private enum Outcome {
    case changed(added: Int, stored: Int)
    case notModified
    case failed(RefreshFailure)
    case aborted
  }

  private func poll(_ feed: FeedState, at: Int, cancelled: () -> Bool) async -> Outcome {
    let url = feed.key
    guard let address = URL(string: url) else {
      return .failed(RefreshFailure(feedUrl: url, reason: "\(url) is not an address"))
    }

    let response: FeedResponse
    do {
      response = try await transport.fetch(
        address,
        headers: headers(for: feed),
        timeout: TimeInterval(RefreshPolicy.timeoutMs) / 1000
      )
    } catch {
      if cancelled() || Task.isCancelled || isCancellation(error) { return .aborted }
      let timedOut = isTimeout(error)
      let reason =
        timedOut
        ? "\(url) did not answer in \(RefreshPolicy.timeoutMs / 1000)s"
        : "\(url) could not be reached: \(message(of: error))"
      record(failure: reason, on: feed, at: at)
      return .failed(RefreshFailure(feedUrl: url, reason: reason))
    }

    if response.status == 304 {
      // The validators did their job: the feed is current as of now, and
      // nothing needs to be parsed or stored.
      do {
        try library.recordFetch(
          feedUrl: url, at: at, etag: feed.etag, lastModified: feed.lastModified,
          title: nil, siteUrl: nil
        )
      } catch {
        return .failed(RefreshFailure(feedUrl: url, reason: "\(error)"))
      }
      return .notModified
    }

    if response.status < 200 || response.status >= 300 {
      let reason = statusFailure(url, response.status)
      record(failure: reason, on: feed, at: at)
      return .failed(RefreshFailure(feedUrl: url, reason: reason))
    }

    if !FeedScanner.looksLikeFeed(response.body) {
      let reason = "\(url) answered with a web page, not a feed"
      record(failure: reason, on: feed, at: at)
      return .failed(RefreshFailure(feedUrl: url, reason: reason))
    }

    let parsed = FeedScanner.parse(response.body, feedUrl: url)
    do {
      let written = try library.putEntries(parsed.entries, feedUrl: url, at: at)
      // Entries first, then the row: a store that refuses the batch leaves
      // `fetched_at` where it was, and the feed is simply due again.
      try library.recordFetch(
        feedUrl: url, at: at,
        etag: response.headers["etag"], lastModified: response.headers["last-modified"],
        title: parsed.title, siteUrl: parsed.siteUrl
      )
      return .changed(added: written.added, stored: written.stored)
    } catch {
      return .failed(RefreshFailure(feedUrl: url, reason: "\(error)"))
    }
  }

  private func record(failure reason: String, on feed: FeedState, at: Int) {
    do {
      try library.recordFailure(feedUrl: feed.key, at: at, error: reason)
    } catch {
      log("bg-refresh: could not record the failure of \(feed.key): \(error)")
    }
  }

  /// The conditional headers for one feed: what it asked us to send back.
  private func headers(for feed: FeedState) -> [String: String] {
    var headers = [
      "accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8"
    ]
    if let etag = feed.etag, !etag.isEmpty { headers["if-none-match"] = etag }
    if let modified = feed.lastModified, !modified.isEmpty {
      headers["if-modified-since"] = modified
    }
    return headers
  }

  private func statusFailure(_ url: String, _ status: Int) -> String {
    switch status {
    case 401, 403: return "\(url) refused the request (\(status))"
    case 404, 410: return "\(url) is gone (\(status))"
    case 429: return "\(url) asked to be fetched less often (429)"
    default: return "\(url) answered \(status)"
    }
  }

  private func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if let urlError = error as? URLError { return urlError.code == .cancelled }
    return false
  }

  private func isTimeout(_ error: Error) -> Bool {
    if let urlError = error as? URLError { return urlError.code == .timedOut }
    return (error as NSError).code == NSURLErrorTimedOut
  }

  private func message(of error: Error) -> String {
    let text = (error as NSError).localizedDescription.trimmed()
    return text.isEmpty ? "the request failed" : text
  }
}
