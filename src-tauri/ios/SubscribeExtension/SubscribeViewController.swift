//
//  SubscribeViewController.swift
//  HardlyReaderSubscribe
//
//  The share extension's entry point: take the page Safari shared, put a SwiftUI
//  sheet on screen, and be gone.
//
//  The principal class has to be a `UIViewController` (share extensions are not
//  `NSExtensionRequestHandling`), so this is a thin host: it unwraps the
//  `NSItemProvider` the system handed over, and everything the reader sees is
//  `SubscribeView`.
//
//  The URL is asked for as `public.url` and, failing that, loaded as plain text —
//  a share from some apps arrives as a string, and a sheet that says "nothing
//  shared" for a perfectly good link is worse than trying once more.
//

import SwiftUI
import UniformTypeIdentifiers

final class SubscribeViewController: UIViewController {
    private var model: SubscribeModel?
    private var loading: UIViewController?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        NSLog("%@ loaded", HardyReaderSubscribeMarker)

        // Something on screen immediately: the page fetch takes a second, and a
        // share sheet that is blank while it works reads as broken.
        let spinner = UIHostingController(rootView: LoadingView())
        addChild(spinner)
        spinner.view.frame = view.bounds
        spinner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(spinner.view)
        spinner.didMove(toParent: self)
        loading = spinner

        Task { [weak self] in
            guard let url = await SubscribeViewController.pageURL(from: self?.extensionContext) else {
                await MainActor.run { self?.showFailure() }
                return
            }
            await MainActor.run { self?.present(for: url) }
        }
    }

    private func present(for url: URL) {
        let model = SubscribeModel(pageURL: url, responder: view, context: extensionContext)
        let host = UIHostingController(rootView: SubscribeView(model: model))
        loading?.willMove(toParent: nil)
        loading?.view.removeFromSuperview()
        loading?.removeFromParent()
        loading = nil

        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        self.model = model
    }

    private func showFailure() {
        let host = UIHostingController(
            rootView: MessageScreen(
                title: "Nothing to open",
                detail: "Share a web page with HardlyReader to find its feeds."
            )
        )
        loading?.willMove(toParent: nil)
        loading?.view.removeFromSuperview()
        loading?.removeFromParent()
        loading = nil
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    /// The page from the extension's input items, or `nil`.
    ///
    /// `loadItem` is asked with its completion handler rather than the async
    /// form: the async one is not available at this app's 15.0 floor, and a
    /// compiler error on the CI runner costs half an hour to find.
    @MainActor
    private static func pageURL(from context: NSExtensionContext?) async -> URL? {
        let items = (context?.inputItems as? [NSExtensionItem]) ?? []
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let value = await load(provider, UTType.url.identifier),
                   let url = urlFrom(value), isWeb(url) {
                    return url
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let value = await load(provider, UTType.plainText.identifier),
                   let text = value as? String,
                   let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), isWeb(url) {
                    return url
                }
            }
        }
        return nil
    }

    /// One item from one provider, as a continuation.
    @MainActor
    private static func load(_ provider: NSItemProvider, _ type: String) async -> NSSecureCoding? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { value, _ in
                continuation.resume(returning: value)
            }
        }
    }

    private static func urlFrom(_ value: NSSecureCoding?) -> URL? {
        switch value {
        case let url as URL: return url
        case let url as NSURL: return url as URL
        case let data as Data: return URL(dataRepresentation: data, relativeTo: nil)
        case let text as String: return URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines))
        default: return nil
        }
    }

    private static func isWeb(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }
}

/// The half-second before there is anything to say.
private struct LoadingView: View {
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Finding feeds…")
                .foregroundStyle(.secondary)
        }
    }
}

/// Used when the share carried no page at all.
struct MessageScreen: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 12) {
            Text(title).font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
    }
}
