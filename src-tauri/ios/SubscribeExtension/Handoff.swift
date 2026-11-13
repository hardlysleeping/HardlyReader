//
//  Handoff.swift
//  HardlyReaderSubscribe
//
//  Handing a feed to the app, and why it is a URL.
//
//  An extension cannot add a feed. It has no accounts, no backend, no queue and
//  a few seconds of life; the subscribing happens in the app, where all of that
//  lives. The two processes cannot share a file either: the app is installed
//  from an unsigned IPA and re-signed on the device by AltStore or SideStore, and
//  App Groups is a capability a re-signing profile does not grant — the shared
//  container comes back nil and a "pending subscriptions" file would be written
//  into a directory nobody else can read.
//
//  A URL scheme needs no entitlement, survives re-signing, and is the same
//  channel the app already answers on: `hardlyreader://subscribe?feed=…`. The
//  app opens its own Add Feed form with the feed in the field, and the reader
//  presses Add there — one implementation of subscribing, and one place where a
//  duplicate or a failure is reported.
//

import UIKit

/// Proof of life for CI.
///
/// The extension is a second binary inside the app, built by a project file that
/// is regenerated on every CI run. A `.appex` that exists but is not embedded, or
/// is embedded with no sources, looks exactly like a successful build, so the
/// packaged IPA is asked for this string.
let HardyReaderSubscribeMarker = "hardlyreader-subscribe-extension-1"

enum Handoff {
    /// `hardlyreader://subscribe?feed=…&page=…&title=…`
    static func subscribeURL(feed: URL, page: URL, title: String?) -> URL? {
        var parts = URLComponents()
        parts.scheme = "hardlyreader"
        parts.host = "subscribe"
        var items = [
            URLQueryItem(name: "feed", value: feed.absoluteString),
            URLQueryItem(name: "page", value: page.absoluteString),
        ]
        if let title, !title.isEmpty {
            items.append(URLQueryItem(name: "title", value: title))
        }
        parts.queryItems = items
        return parts.url
    }

    /// Open the app on this feed.
    ///
    /// `NSExtensionContext.open` is the documented way and answers `false` for a
    /// share extension, so the working route is the responder chain: some
    /// responder — the hosting application — implements `openURL:`, and asking
    /// up the chain is what every share-to-app extension does. It is not
    /// App-Store-legal; this build is not distributed there.
    static func openInApp(_ url: URL, from responder: UIResponder?, context: NSExtensionContext?) {
        NSLog("%@ open %@", HardyReaderSubscribeMarker, url.absoluteString)

        var chain: UIResponder? = responder
        let selector = NSSelectorFromString("openURL:")
        while let current = chain {
            if current.responds(to: selector) {
                current.perform(selector, with: url)
                return
            }
            chain = current.next
        }

        context?.open(url) { opened in
            if !opened {
                NSLog("%@ could not open the app", HardyReaderSubscribeMarker)
            }
        }
    }
}
