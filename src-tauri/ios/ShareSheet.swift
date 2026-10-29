//
//  ShareSheet.swift
//  HardlyReader
//
//  The system share sheet, presented from the app's own window.
//
//  Why this file exists at all: the app is a webview, and in the packaged iOS
//  build the page is served from `tauri://localhost`, which WebKit does not
//  treat as a secure context. `navigator.share` and `navigator.clipboard` are
//  therefore both missing there, so the webview's own share press can do no
//  better than copy the link. `UIActivityViewController` needs none of that; it
//  is UIKit, and it is the sheet the rest of the phone uses.
//
//  The bridge is deliberately one symbol wide. Rust hands over three strings —
//  a title, the article's link, and the lead image's link when the feed named
//  one — and gets back a number saying whether the sheet went up:
//
//      0  the sheet was handed to the system
//      1  no window (and so no view controller) to present it on
//      2  the link was not a URL; nothing was presented

//  The document half is one more symbol, `hardlyreader_share_file`, taking the
//  absolute path of a file the app staged in its own cache directory. A file the
//  sheet can carry is the only way an OPML export leaves a phone: Web Share is
//  absent here for the same reason the link sheet is, and a webview has no
//  downloads folder. Its answer uses the same numbers, with 2 meaning "the file
//  was gone before the sheet could carry it".
//
//  The title and the image are optional by being null, never by being empty, so
//  an untitled post shares its link alone rather than a blank subject line.
//

import UIKit

/// Proof of life for CI.
///
/// The IPA is packaged by a script that cannot read Swift, and a file that is on
/// disk but in no target's compile sources is a feature that silently never
/// runs. Every presentation logs this string, so the built `.app` can be opened
/// and asked whether the bridge is really in the binary.
let HardyReaderShareMarker = "hardlyreader-share-sheet-1"

/// The view controller a sheet has to be presented from.
///
/// Not simply the root: a sheet presented while something else is already on
/// screen (the reader's own picture layer, a system alert) is a UIKit warning
/// and sometimes a no-op. Walk down the presented chain to the one that is
/// actually on top.
private func topViewController(from root: UIViewController?) -> UIViewController? {
    guard var top = root else { return nil }
    while let presented = top.presentedViewController, !presented.isBeingDismissed {
        top = presented
    }
    return top
}

/// The key window, from the active scene.
///
/// `UIApplication.shared.windows` is deprecated on iOS 15 and, in a scene-based
/// app, can be empty. The scene that is foreground-active owns the window the
/// reader is looking at.
private func keyWindow() -> UIWindow? {
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

/// Put the sheet on screen. Must be called on the main thread.
private func presentSheet(_ items: [Any]) -> Int32 {
    guard
        let window = keyWindow(),
        let presenter = topViewController(from: window.rootViewController)
    else {
        return 1
    }

    let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)

    // On a phone the sheet is a card and these two lines do nothing. On an iPad
    // a missing source view is a crash, and the byline the press came from is
    // not visible from here, so anchor it to the bottom edge of the window.
    if let popover = controller.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.maxY,
            width: 0,
            height: 0
        )
        popover.permittedArrowDirections = []
    }

    presenter.present(controller, animated: true)
    return 0
}

/// The document half: `hardlyreader_share_file(path)` from Rust.
///
/// One item, the file's own URL. Nothing is read or rewritten here — the bytes
/// were staged by `share_file` — and "Save to Files", AirDrop, Mail and every app
/// that opens an OPML are the sheet's own rows, not this file's.
@_cdecl("hardlyreader_share_file")
public func hardlyreader_share_file(_ path: UnsafePointer<CChar>?) -> Int32 {
    guard let pathPointer = path else { return 2 }
    let file = URL(fileURLWithPath: String(cString: pathPointer))
    guard FileManager.default.fileExists(atPath: file.path) else { return 2 }
    NSLog("%@ present file %@", HardyReaderShareMarker, file.lastPathComponent)
    return presentSheet([file])
}

/// The bridge itself: `hardlyreader_share(title, url, image)` from Rust.
///
/// Answers as soon as the sheet is on its way. When the feed named a lead image
/// that image is fetched first — off the main thread, with a short deadline —
/// and the sheet goes up with whatever arrived; a picture that is slow or gone
/// is not a reason to withhold the link.
@_cdecl("hardlyreader_share")
public func hardlyreader_share(
    _ title: UnsafePointer<CChar>?,
    _ url: UnsafePointer<CChar>?,
    _ image: UnsafePointer<CChar>?
) -> Int32 {
    guard let urlPointer = url, let link = URL(string: String(cString: urlPointer)) else {
        return 2
    }

    let headline = title.map { String(cString: $0) } ?? ""
    NSLog("%@ present %@", HardyReaderShareMarker, link.absoluteString)

    var items: [Any] = []
    if !headline.isEmpty {
        // The headline first, so Mail and Messages use it as the subject rather
        // than the URL's host.
        items.append(headline)
    }
    items.append(link)

    guard let imagePointer = image, let imageURL = URL(string: String(cString: imagePointer)) else {
        return presentSheet(items)
    }

    var request = URLRequest(url: imageURL, timeoutInterval: 5)
    request.setValue("image/*", forHTTPHeaderField: "Accept")
    URLSession.shared.dataTask(with: request) { data, _, _ in
        var withImage = items
        if let data, let picture = UIImage(data: data) {
            withImage.insert(picture, at: withImage.count - 1)
        }
        DispatchQueue.main.async {
            _ = presentSheet(withImage)
        }
    }.resume()

    // The fetch is still in flight; the sheet is coming, so this is not a
    // failure and must not make the webview fall back to a copy.
    return 0
}
