import Foundation

/// The poll's numbers, and the arithmetic that turns a feed row into "fetch it
/// now, or leave it".
///
/// This is the Swift half of `src/api/local/refresh.ts`, and it deliberately
/// holds no opinion of its own. The numbers below are the *same* numbers, and
/// `tests/unit/ios-background-refresh.mjs` reads both files and fails when they
/// disagree — a background wake that fetches on a different schedule than the
/// app's own poll would be a second policy, which is the one thing this is not
/// allowed to become.
public enum RefreshPolicy {
  /// Minutes a successfully read feed is left alone.
  public static let intervalMinutes = 60
  /// Feeds one wake may fetch, most stale first.
  public static let maxFeedsPerWake = 6
  /// The longest a feed that keeps failing waits between attempts.
  public static let maxBackoffMinutes = 360
  /// An attempt that has not answered by then counts as a failure.
  public static let timeoutMs = 15_000
  /// The most a single failure can multiply the wait by.
  public static let maxDoublings = 6
}

/// The columns of a `feeds` row that the poll decides on, or writes back.
///
/// Not the whole row: a background wake must not rewrite a subscription it has
/// no business changing, and the fewer fields it touches the smaller the chance
/// it disagrees with the store the foreground app reads.
public struct FeedState: Equatable {
  /// The feed's URL, which is also the row's primary key.
  public var key: String
  /// Seconds of the last poll that got an answer; nil until one has.
  public var fetchedAt: Int?
  /// Seconds of the last poll attempt, successful or not.
  public var attemptedAt: Int?
  /// Consecutive failed polls.
  public var failures: Int?
  /// The feed's own validators, sent back on the next poll.
  public var etag: String?
  public var lastModified: String?
  /// Only read so `recordFetch` can decide whether the feed may rename itself.
  public var titleSource: String?

  public init(
    key: String,
    fetchedAt: Int? = nil,
    attemptedAt: Int? = nil,
    failures: Int? = nil,
    etag: String? = nil,
    lastModified: String? = nil,
    titleSource: String? = nil
  ) {
    self.key = key
    self.fetchedAt = fetchedAt
    self.attemptedAt = attemptedAt
    self.failures = failures
    self.etag = etag
    self.lastModified = lastModified
    self.titleSource = titleSource
  }
}

public enum RefreshMath {
  /// Seconds between two polls of one feed, given how it has been behaving.
  ///
  /// The doubling is capped twice — at `maxDoublings` so the multiplication is
  /// bounded, and at `maxBackoffMinutes` so the answer is what the policy says.
  public static func intervalSeconds(failures: Int?) -> Int {
    let base = RefreshPolicy.intervalMinutes * 60
    let count = max(0, failures ?? 0)
    if count == 0 { return base }
    let doublings = min(count, RefreshPolicy.maxDoublings)
    let doubled = base * (1 << doublings)
    return min(doubled, RefreshPolicy.maxBackoffMinutes * 60)
  }

  /// When this feed is worth fetching again, in seconds. Zero means now.
  ///
  /// Measured from the last *attempt*, not the last success: a feed that has
  /// been answering `500` for a day must not be retried on every wake.
  public static func dueAt(_ feed: FeedState) -> Int {
    let attempted = max(feed.fetchedAt ?? 0, feed.attemptedAt ?? 0)
    if attempted <= 0 { return 0 }
    return attempted + intervalSeconds(failures: feed.failures)
  }

  public static func isDue(_ feed: FeedState, now: Int) -> Bool {
    now >= dueAt(feed)
  }

  /// The feeds one wake should fetch: due ones, most stale first, then bounded.
  ///
  /// The key breaks ties so two feeds that became due in the same second are
  /// always taken in the same order — otherwise a bounded wake could starve one
  /// of them forever by picking the other first each time.
  public static func dueFeeds(_ feeds: [FeedState], now: Int) -> [FeedState] {
    let due = feeds.filter { isDue($0, now: now) }
    let ordered = due.sorted { left, right in
      let leftDue = dueAt(left)
      let rightDue = dueAt(right)
      if leftDue != rightDue { return leftDue < rightDue }
      return left.key < right.key
    }
    return Array(ordered.prefix(max(0, RefreshPolicy.maxFeedsPerWake)))
  }
}
