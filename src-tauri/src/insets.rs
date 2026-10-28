//! The native half of "the page owns every pixel".
//!
//! `src/app.css` reads the safe area once into `--safe-*` and pads the header,
//! the scroller and the outer columns with it, on the understanding that the
//! page is the whole screen. In a browser, on Android and in the Linux window
//! that is true. In the packaged iOS app it is not: `WKWebView` is a
//! `UIScrollView`, UIKit's default `contentInsetAdjustmentBehavior` is
//! `.automatic`, and a webview that is the first scroll view in a full-screen
//! view controller therefore gets the safe area added to its content inset on
//! top of the padding the page already pays. The gap that leaves shows the
//! window's own background — the black strip above the header and the one under
//! the last row.
//!
//! Nothing in Tauri or wry turns that off, so this module asks UIKit to: one
//! call, once, while the app is being set up, into `src-tauri/ios/SafeArea.swift`.
//! It is not a command and the page never invokes it — there is nothing for the
//! page to decide, and the answer is already in `env(safe-area-inset-*)`.
//!
//! The UIKit half lives in `src-tauri/ios/SafeArea.swift`, which the Codemagic
//! workflow compiles into the app target; see that file for the status codes
//! this returns and for why it retries.

use std::ffi::c_int;

// `unsafe extern` rather than `extern`: this crate is edition 2024, where an
// extern block has to say so — the block is the promise that the signature below
// is the one the Swift side declares.
unsafe extern "C" {
    /// `src-tauri/ios/SafeArea.swift`, compiled into the app target. Takes
    /// nothing and returns one of the statuses documented in that file.
    fn hardlyreader_safe_area() -> c_int;
}

/// Whether the webview was uninset, as the Swift side reports it. `2` is not a
/// failure: it means the webview did not exist yet and a retry is scheduled.
pub const APPLIED: c_int = 0;

/// Remove UIKit's inset from the webview. Must be called on the main thread.
pub fn apply() -> c_int {
    // SAFETY: the function takes no arguments, touches nothing this module owns,
    // and is declared by the Swift file that CI compiles into the same binary.
    unsafe { hardlyreader_safe_area() }
}
