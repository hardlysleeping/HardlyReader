//
//  SubscribeView.swift
//  HardlyReaderSubscribe
//
//  What the sheet shows: the feeds this page offers, each one press away from the
//  app.
//
//  Four states and no fifth: finding, the list, nothing found, and the page could
//  not be asked. "Nothing found" is a real answer and says so plainly instead of
//  looking like a failure; a network error is the one state worth a Retry.
//
//  Add does not dismiss. A site can expose a main feed, a comments feed and a
//  category feed at once, and the reader who wants two of them should not have to
//  share the page twice. A row that has been sent says so and stays put.
//

import SwiftUI

/// What the sheet is doing.
enum SubscribePhase: Equatable {
    case finding
    case feeds([FeedCandidate])
    case empty
    case failed(String)
}

@MainActor
final class SubscribeModel: ObservableObject {
    @Published private(set) var phase: SubscribePhase = .finding
    /// The feeds already handed to the app, by candidate id.
    @Published private(set) var sent: Set<String> = []

    let pageURL: URL
    private let discovery = FeedDiscovery()
    private weak var context: NSExtensionContext?
    private weak var responder: UIResponder?

    init(pageURL: URL, responder: UIResponder?, context: NSExtensionContext?) {
        self.pageURL = pageURL
        self.responder = responder
        self.context = context
    }

    func start() async {
        phase = .finding
        do {
            let feeds = try await discovery.discover(from: pageURL)
            phase = feeds.isEmpty ? .empty : .feeds(feeds)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func add(_ candidate: FeedCandidate) {
        guard let url = Handoff.subscribeURL(feed: candidate.url, page: pageURL, title: candidate.title) else { return }
        Handoff.openInApp(url, from: responder, context: context)
        sent.insert(candidate.id)
    }

    func openApp() {
        guard let url = Handoff.subscribeURL(feed: pageURL, page: pageURL, title: nil) else { return }
        Handoff.openInApp(url, from: responder, context: context)
    }
}

struct SubscribeView: View {
    @ObservedObject var model: SubscribeModel

    var body: some View {
        NavigationView {
            Group {
                switch model.phase {
                case .finding:
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Finding feeds…")
                            .foregroundStyle(.secondary)
                    }
                case .feeds(let feeds):
                    List {
                        Section {
                            ForEach(feeds) { feed in
                                FeedRow(feed: feed, sent: model.sent.contains(feed.id)) {
                                    model.add(feed)
                                }
                            }
                        } header: {
                            Text(model.pageURL.host ?? "This page")
                        } footer: {
                            Text("Adding opens HardlyReader with the feed ready to confirm.")
                        }
                    }
                case .empty:
                    MessageView(
                        title: "No feed found",
                        detail: "HardlyReader couldn’t find an RSS, Atom, or JSON feed for this page.",
                        retry: nil,
                        open: model.openApp
                    )
                case .failed(let reason):
                    MessageView(
                        title: "Couldn’t check this page",
                        detail: reason,
                        retry: { Task { await model.start() } },
                        open: model.openApp
                    )
                }
            }
            .navigationTitle("HardlyReader")
            .navigationBarTitleDisplayMode(.inline)
        }
        .navigationViewStyle(.stack)
        .task { await model.start() }
    }
}

private struct FeedRow: View {
    let feed: FeedCandidate
    let sent: Bool
    let add: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(feed.title)
                    .lineLimit(1)
                Text(feed.url.host ?? feed.url.absoluteString)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button(action: add) {
                Text(sent ? "Sent ✓" : "Add")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(sent)
        }
    }
}

private struct MessageView: View {
    let title: String
    let detail: String
    let retry: (() -> Void)?
    let open: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let retry {
                Button("Retry", action: retry)
                    .buttonStyle(.borderedProminent)
            }
            Button("Open in HardlyReader", action: open)
                .buttonStyle(.bordered)
        }
        .padding(24)
    }
}
