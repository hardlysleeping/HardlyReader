#if canImport(BackgroundTasks)
  import BackgroundTasks
  import Foundation
  import os

  /// The iOS half: a `BGAppRefreshTask` that fetches the feeds that are due.
  ///
  /// The task starts the *process*, not the WKWebView's JavaScript context, so
  /// the app's own poller (`src/api/local/refresh.ts`) is not running during a
  /// background wake. Rather than boot a webview inside a 30-second budget,
  /// this wakes the same policy in Swift — `RefreshMath`, `FeedScanner` and
  /// `LocalLibrary` are ports of the same three pieces, working on the same
  /// `hardlyreader.db` the foreground app reads and writes.
  ///
  /// Two rules the platform imposes, both of which shape this file:
  ///
  /// - **Registration must happen before the app finishes launching**, which is
  ///   why it lives in `AppRefreshTaskHook.m`'s `+load` rather than here. Swift
  ///   has no `+load`, and a wake that registers too late throws.
  /// - **`setTaskCompleted(success:)` must be called exactly once on every
  ///   path**, including the deadline arriving first. `Completion` below is the
  ///   one place that calls it, guarded by a lock, so the work and the
  ///   expiration handler cannot both finish the same task.
  public enum AppRefreshTask {
    /// Must be the identifier in `Info.plist`'s
    /// `BGTaskSchedulerPermittedIdentifiers` and in `AppRefreshTaskHook.m`.
    /// `tests/unit/ios-background-refresh.mjs` holds the three together.
    public static let identifier = "ing.hardlysleep.hardlyreader.refresh"

    /// How soon the next wake may be asked for. A hint, not a schedule: iOS
    /// decides when (or whether) to honour it, which is why nothing here
    /// assumes an hour, a time of day, or that a wake will arrive at all.
    private static let earliestNextWake: TimeInterval = 15 * 60

    private static let logger = Logger(
      subsystem: "ing.hardlysleep.hardlyreader", category: "background-refresh")

    private static let lock = NSLock()
    private static var inFlight: Task<Void, Never>?

    /// Asks for the next wake. Called when the app goes to the background and
    /// again at the end of every run, because a request is spent by being
    /// honoured.
    public static func submit() {
      let request = BGAppRefreshTaskRequest(identifier: identifier)
      request.earliestBeginDate = Date(timeIntervalSinceNow: earliestNextWake)
      do {
        try BGTaskScheduler.shared.submit(request)
        logger.debug("bg-refresh: next wake requested")
      } catch {
        // Too many pending requests, or a build without the Info.plist keys.
        // Loud, because a silent failure here is a phone that never refreshes.
        logger.error("bg-refresh: could not request the next wake: \(error.localizedDescription, privacy: .public)")
        write("bg-refresh: could not request the next wake: \(error.localizedDescription)")
      }
    }

    /// One wake, start to finish.
    static func handle(_ task: BGTask) {
      guard let refresh = task as? BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }

      // Reschedule first: a run that is killed halfway still leaves a request
      // behind, so one bad wake cannot end the sequence.
      submit()

      let completion = Completion(task: refresh)

      refresh.expirationHandler = {
        logger.notice("bg-refresh: the deadline arrived")
        write("bg-refresh: the deadline arrived")
        lock.lock()
        let work = inFlight
        lock.unlock()
        work?.cancel()
        // Completing here is not optional: an overrunning task is terminated
        // and counts against the app's future budget.
        completion.finish(success: false)
      }

      let work = Task.detached(priority: .utility) {
        defer { submit() }

        var success = false
        do {
          guard let url = libraryURL() else {
            // No library yet means local mode has not been used on this device.
            // There is nothing to fetch; that is a success, not a failure.
            logger.notice("bg-refresh: no local library yet")
            write("bg-refresh: no local library yet")
            completion.finish(success: true)
            return
          }

          let library = try LocalLibrary(path: url.path)
          let refresher = BackgroundRefresher(
            library: library,
            log: { line in
              logger.notice("\(line, privacy: .public)")
              write(line)
            }
          )
          let report = await refresher.wake(
            wake: "background", cancelled: { Task.isCancelled })
          success = !report.aborted && report.storeError == nil
        } catch {
          logger.error("bg-refresh: \(String(describing: error), privacy: .public)")
          write("bg-refresh: \(error)")
        }

        completion.finish(success: success)
      }

      lock.lock()
      inFlight = work
      lock.unlock()
    }

    /// Where the plugin's `sqlite:hardlyreader.db` actually is.
    ///
    /// Tauri resolves the file through the app's config directory, which on iOS
    /// is Application Support — sometimes with the bundle identifier as a
    /// subdirectory. Both are tried, and neither is ever created by this: a
    /// wake that invented an empty library would be a wake that hid the app's
    /// real one.
    static func libraryURL() -> URL? {
      let fileManager = FileManager.default
      var roots: [URL] = []
      if let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
        roots.append(support)
      }
      if let identifier = Bundle.main.bundleIdentifier {
        if let support = roots.first {
          roots.append(support.appendingPathComponent(identifier))
        }
      }
      if let found = LocalLibrary.find(in: roots) { return found }
      logger.notice("bg-refresh: looked for the library in \(roots.map(\.path).joined(separator: ", "), privacy: .public)")
      return nil
    }

    private static func write(_ line: String) {
      FileHandle.standardError.write(Data((line + "\n").utf8))
    }
  }

  /// Finishes a background task exactly once.
  ///
  /// The work finishing and the deadline arriving are two threads racing over
  /// one task, and calling `setTaskCompleted` twice is a crash rather than a
  /// nuisance. So the "already finished" bit is behind a lock, and whichever
  /// path gets there second is a no-op.
  private final class Completion: @unchecked Sendable {
    private let task: BGTask
    private let lock = NSLock()
    private var finished = false

    init(task: BGTask) {
      self.task = task
    }

    func finish(success: Bool) {
      lock.lock()
      let already = finished
      finished = true
      lock.unlock()
      guard !already else { return }
      task.setTaskCompleted(success: success)
    }
  }

  /// The C entry points `AppRefreshTaskHook.m` calls. `+load` is Objective-C's,
  /// so the launch-time registration stays there and only these two functions
  /// cross the language boundary.

  @_cdecl("hardlyreader_app_refresh_handle")
  public func hardlyreader_app_refresh_handle(_ task: UnsafeMutableRawPointer) {
    let task = Unmanaged<BGTask>.fromOpaque(task).takeUnretainedValue()
    AppRefreshTask.handle(task)
  }

  @_cdecl("hardlyreader_app_refresh_schedule")
  public func hardlyreader_app_refresh_schedule() {
    AppRefreshTask.submit()
  }
#endif
