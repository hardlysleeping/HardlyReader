//
//  SafeArea.swift
//  HardlyReader
//
//  The page owns the screen; UIKit does not get to inset it.
//
//  Why this file exists at all: the stylesheet already treats the safe area as
//  something the *page* pays for. `src/app.css` reads
//  `env(safe-area-inset-*)` once into `--safe-*`, draws `html`, `body` and
//  `#app` in the app's own colour, and pads the header, the scroller and the
//  outer columns instead of padding the app as one rectangle. That is the right
//  answer, and it is enough on Android, in a browser and in the Linux window.
//
//  It is not enough on iOS, because UIKit insets the webview a second time and
//  no stylesheet can see it:
//
//  - A `WKWebView` is a `UIScrollView` underneath, and its scroll view is the
//    first scroll view in the app's view controller. `UIScrollView`'s default
//    `contentInsetAdjustmentBehavior` is `.automatic`, which for exactly that
//    arrangement means "add the safe area to the content inset".
//  - Nothing in the stack turns it off. Tauri's iOS shell is generated from a
//    template that starts the Rust app; the window, the view controller and the
//    webview are made in `tao` and `wry`, and wry's iOS branch touches the
//    webview's scroll view only to disable bounce. So the default stands.
//  - The result is one rectangle inside another: the page is shifted down by
//    the notch inset *and* the page pads itself by the same number it still
//    reads from `env()`. What shows in the gap is the window's background, not
//    the app's colour — black on a phone in dark appearance, which is the strip
//    above the header and the strip under the last row.
//
//  So the fix belongs here, in the native half: `.never` on the scroll view, and
//  a view controller that extends under the bars rather than being laid out
//  inside them. With that, `env(safe-area-inset-*)` reports the notch and the
//  page is the whole screen — the numbers the stylesheet was written for.
//
//  Deliberately no background colour is set here. The card that asked for this
//  offered "a colour matching the theme, or transparent"; a colour set in Swift
//  cannot follow the app's theme (it lives in the page's CSS), so a fixed one
//  would be the next strip in the other appearance. wry already gives the
//  webview `systemBackgroundColor` so there is no white flash before the first
//  paint, and with the inset gone the page covers every pixel after it.
//
//  The bridge is one symbol wide and takes no arguments, because there is
//  nothing for the page to ask: it is called once, from `src-tauri/src/insets.rs`
//  during setup, and answers with a status the caller may log:
//
//      0  applied — the webview is edge to edge
//      1  no window (and so no view controller) to configure
//      2  a window but no webview in it yet; a bounded retry is now scheduled
//

import UIKit
import WebKit

/// Proof of life for CI.
///
/// Same contract as `ShareSheet.swift`'s marker: the IPA is packaged by a script
/// that cannot read Swift, and a Swift file that is on disk but in no target's
/// compile sources is a feature that silently never runs. This string is logged
/// when the inset is removed, so the built binary can be asked whether the file
/// is really in it.
let HardyReaderSafeAreaMarker = "hardlyreader-safe-area-1"

/// How long to keep looking for the webview.
///
/// The webview is created by the Rust side's event loop, which may finish after
/// the setup hook that calls this. Fifty tries at 40ms is two seconds — longer
/// than the gap on any phone, short enough that a genuinely missing webview does
/// not keep waking the main queue.
private let safeAreaRetries = 50
private let safeAreaRetryInterval = 0.04

/// The key window, from the active scene.
///
/// `UIApplication.shared.windows` is deprecated on iOS 15 and can be empty in a
/// scene-based app; the foreground scene's key window is the one on screen.
private func safeAreaKeyWindow() -> UIWindow? {
    for scene in UIApplication.shared.connectedScenes {
        guard let windowScene = scene as? UIWindowScene else { continue }
        if let key = windowScene.windows.first(where: { $0.isKeyWindow }) {
            return key
        }
        if let first = windowScene.windows.first {
            return first
        }
    }
    return UIApplication.shared.delegate?.window ?? nil
}

/// The first webview anywhere under a view.
///
/// The window's content view is `tao`'s, and the webview is a subview of it, so
/// this walks rather than casting the root: where exactly wry parents the
/// webview is its business, not ours.
private func firstWebview(in view: UIView) -> WKWebView? {
    if let webview = view as? WKWebView {
        return webview
    }
    for child in view.subviews {
        if let found = firstWebview(in: child) {
            return found
        }
    }
    return nil
}

/// Stop UIKit insetting the webview, and let the controller extend under bars.
///
/// `.never` rather than `.always`/`.automatic`: the page reads the insets from
/// `env()` and pays for them itself, so any inset UIKit adds here is paid twice.
///
/// `edgesForExtendedLayout = .all` is already the default for a view controller
/// that fills the window — it is set explicitly so that a future shell change
/// cannot quietly reintroduce the inset by narrowing it, and
/// `extendedLayoutIncludesOpaqueBars` is set with it because the default there
/// (`false`) *is* "lay out below an opaque bar".
private func uninset(_ controller: UIViewController, webview: WKWebView) {
    controller.edgesForExtendedLayout = .all
    controller.extendedLayoutIncludesOpaqueBars = true
    controller.additionalSafeAreaInsets = .zero
    webview.scrollView.contentInsetAdjustmentBehavior = .never
    NSLog("%@ applied", HardyReaderSafeAreaMarker)
}

/// Keep looking for the webview, then stop.
///
/// Bounded on purpose: a webview that never appears is a bug worth seeing in the
/// log, not a reason to poll the main queue for the life of the app.
private func retryUninset(_ controller: UIViewController, attempt: Int) {
    if attempt >= safeAreaRetries {
        NSLog("%@ gave up: no webview after %ld tries", HardyReaderSafeAreaMarker, safeAreaRetries)
        return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + safeAreaRetryInterval) {
        if let webview = firstWebview(in: controller.view) {
            uninset(controller, webview: webview)
        } else {
            retryUninset(controller, attempt: attempt + 1)
        }
    }
}

/// The bridge itself: `hardlyreader_safe_area()` from Rust, on the main thread.
@_cdecl("hardlyreader_safe_area")
public func hardlyreader_safe_area() -> Int32 {
    guard let window = safeAreaKeyWindow(), let controller = window.rootViewController else {
        return 1
    }

    // The controller is configured even if the webview is not there yet: the
    // layout properties have to be in place before the first layout pass, and
    // only the scroll view needs the webview to exist.
    controller.edgesForExtendedLayout = .all
    controller.extendedLayoutIncludesOpaqueBars = true
    controller.additionalSafeAreaInsets = .zero

    guard let webview = firstWebview(in: controller.view) else {
        retryUninset(controller, attempt: 0)
        return 2
    }

    uninset(controller, webview: webview)
    return 0
}
