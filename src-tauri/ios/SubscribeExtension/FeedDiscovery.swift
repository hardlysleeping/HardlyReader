//
//  FeedDiscovery.swift
//  HardlyReaderSubscribe
//
//  Finding a page's feeds, so the share sheet can offer them.
//
//  The rules, in the order they matter:
//
//  1. **A feed is a feed.** Sharing the feed's own address (many sites' "RSS"
//     button copies exactly that) must return that feed, not an empty result
//     from an HTML parse of an XML document.
//  2. **The page is asked next.** `<link rel="alternate">` is the standard way a
//     page declares its feeds and the only one worth trusting, because the
//     publisher wrote it. Relative hrefs resolve against the *final* URL after
//     redirects, which is the URL the browser ended on and the one the reader
//     is looking at.
//  3. **Guessing is last and is verified.** `/feed` and friends are tried only
//     when the page declares nothing, and a guess is only offered if the bytes
//     at that address really are a feed. An unverified guess is a row that adds
//     a 404 to someone's sidebar.
//
//  Nothing here subscribes to anything: the extension has no accounts, no
//  queue and a few seconds of life. It finds feeds and hands one to the app.
//

import Foundation

/// One feed a page offers.
struct FeedCandidate: Identifiable, Equatable {
    let id: String
    let title: String
    let url: URL
    let type: FeedType

    init(url: URL, title: String, type: FeedType) {
        self.url = url
        self.title = title
        self.type = type
        self.id = url.absoluteString
    }
}

enum FeedType: String {
    case rss
    case atom
    case json

    /// The MIME types a `<link>` may declare for this kind.
    static func from(mime: String) -> FeedType? {
        switch mime.lowercased().split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces) {
        case "application/rss+xml", "text/rss+xml": return .rss
        case "application/atom+xml": return .atom
        case "application/feed+json", "application/json": return .json
        default: return nil
        }
    }
}

enum FeedDiscoveryError: LocalizedError {
    case notHTTP
    case network(String)

    var errorDescription: String? {
        switch self {
        case .notHTTP:
            return "Only web addresses can be checked."
        case .network(let reason):
            return reason
        }
    }
}

final class FeedDiscovery {
    /// How long one page gets before the sheet gives up on it.
    private static let pageTimeout: TimeInterval = 12

    /// Where a site with no declared feed most often keeps one.
    private static let guesses = [
        "/feed", "/feed.xml", "/rss", "/rss.xml", "/atom.xml", "/index.xml", "/feed.json",
    ]

    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = FeedDiscovery.pageTimeout
        config.httpAdditionalHeaders = ["User-Agent": FeedDiscovery.userAgent]
        self.session = URLSession(configuration: config)
    }

    private static var userAgent: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        return "HardlyReader/\(version) (iOS; feed discovery)"
    }

    /// Every feed this page offers, in the order they were found.
    func discover(from pageURL: URL) async throws -> [FeedCandidate] {
        guard let scheme = pageURL.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw FeedDiscoveryError.notHTTP
        }

        let (data, response) = try await fetch(pageURL)
        let finalURL = response.url ?? pageURL

        // 1. The address itself is a feed.
        if let type = FeedDiscovery.feedType(response: response, body: data) {
            return [FeedCandidate(url: finalURL, title: FeedDiscovery.titleOfFeed(body: data) ?? finalURL.host ?? "Feed", type: type)]
        }

        // 2. The page declares its feeds.
        let declared = FeedDiscovery.declaredFeeds(in: data, base: finalURL)
        if !declared.isEmpty { return declared }

        // 3. Guesses, each verified before it is offered.
        var found: [FeedCandidate] = []
        for path in FeedDiscovery.guesses {
            guard let candidate = URL(string: path, relativeTo: finalURL)?.absoluteURL else { continue }
            guard let verified = try? await verify(candidate) else { continue }
            found.append(verified)
        }
        return found
    }

    /// Is there really a feed at this address? Answers the candidate, or throws.
    private func verify(_ url: URL) async throws -> FeedCandidate {
        let (data, response) = try await fetch(url)
        guard let type = FeedDiscovery.feedType(response: response, body: data) else { throw FeedDiscoveryError.notHTTP }
        return FeedCandidate(
            url: response.url ?? url,
            title: FeedDiscovery.titleOfFeed(body: data) ?? (response.url ?? url).host ?? "Feed",
            type: type
        )
    }

    private func fetch(_ url: URL) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.timeoutInterval = FeedDiscovery.pageTimeout
        // Feeds are routinely served to browsers only when asked for politely.
        request.setValue(
            "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
            forHTTPHeaderField: "Accept"
        )

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw FeedDiscoveryError.network("The page did not answer.") }
            guard (200...399).contains(http.statusCode) else {
                throw FeedDiscoveryError.network("The page answered \(http.statusCode).")
            }
            return (data, http)
        } catch let error as FeedDiscoveryError {
            throw error
        } catch {
            throw FeedDiscoveryError.network(error.localizedDescription)
        }
    }

    // MARK: - Reading bytes

    /// The feed kind these bytes are, from the header first and the body second.
    static func feedType(response: HTTPURLResponse, body: Data) -> FeedType? {
        if let mime = response.value(forHTTPHeaderField: "Content-Type"), let type = FeedType.from(mime: mime) {
            return type
        }
        return feedType(body: body)
    }

    /// The feed kind these bytes are, by their own first characters.
    ///
    /// A content type is a claim; `<?xml` followed by `<rss` is the thing itself,
    /// and plenty of sites serve their feed as `text/html` or `text/xml`.
    static func feedType(body: Data) -> FeedType? {
        let head = String(decoding: body.prefix(2048), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if head.hasPrefix("{") || head.hasPrefix("[") {
            // JSON Feed: a version field and an items array. Anything else that
            // happens to be JSON is not a feed.
            return head.contains("\"items\"") && (head.contains("\"version\"") || head.contains("jsonfeed")) ? .json : nil
        }
        guard head.hasPrefix("<") else { return nil }
        if head.contains("<rss") || head.contains("<rdf:rdf") { return .rss }
        if head.contains("<feed") && (head.contains("<entry") || head.contains("atom")) { return .atom }
        return nil
    }

    /// The `<title>` of a feed, or of the page when it is an HTML document.
    static func titleOfFeed(body: Data) -> String? {
        feedTitle(in: String(decoding: body.prefix(64 * 1024), as: UTF8.self))
    }

    /// `<title>`'s text, tags and entities removed. The first one is the feed's
    /// own; a page's is the page's.
    static func feedTitle(in text: String) -> String? {
        guard let open = text.range(of: "<title", options: .caseInsensitive),
              let start = text.range(of: ">", range: open.upperBound..<text.endIndex),
              let close = text.range(of: "</title>", options: .caseInsensitive, range: start.upperBound..<text.endIndex)
        else { return nil }
        let raw = String(text[start.upperBound..<close.lowerBound])
        let flattened = raw.replacingOccurrences(of: "<![CDATA[", with: "")
            .replacingOccurrences(of: "]]>", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return flattened.isEmpty ? nil : flattened
    }

    // MARK: - Reading markup

    /// `<link rel="alternate" type="application/rss+xml" ...>` and its relatives.
    static func declaredFeeds(in body: Data, base: URL) -> [FeedCandidate] {
        let html = String(decoding: body.prefix(512 * 1024), as: UTF8.self)
        let pageTitle = feedTitle(in: html)
        var seen = Set<String>()
        var feeds: [FeedCandidate] = []

        for tag in linkTags(in: html) {
            let attributes = Self.attributes(in: tag)
            guard let href = attributes["href"], !href.isEmpty else { continue }
            guard let rel = attributes["rel"]?.lowercased(), rel.split(separator: " ").contains("alternate") else { continue }
            guard let mime = attributes["type"], let type = FeedType.from(mime: mime) else { continue }
            guard let url = resolve(href, against: base) else { continue }

            let key = url.absoluteString.lowercased()
            guard seen.insert(key).inserted else { continue }

            let declared = attributes["title"]?.trimmingCharacters(in: .whitespacesAndNewlines)
            let title = (declared?.isEmpty == false ? declared! : nil) ?? pageTitle ?? url.host ?? "Feed"
            feeds.append(FeedCandidate(url: url, title: title, type: type))
        }

        return feeds
    }

    /// Every `<link ...>` in the document, as its own text.
    static func linkTags(in html: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: "<link\\b[^>]*>", options: [.caseInsensitive]) else { return [] }
        let range = NSRange(html.startIndex..., in: html)
        return regex.matches(in: html, options: [], range: range).compactMap { match in
            Range(match.range, in: html).map { String(html[$0]) }
        }
    }

    /// `name="value"` pairs from one tag, lowercased names, quotes removed.
    static func attributes(in tag: String) -> [String: String] {
        guard let regex = try? NSRegularExpression(
            pattern: "([a-zA-Z_:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
            options: []
        ) else { return [:] }

        var result: [String: String] = [:]
        let range = NSRange(tag.startIndex..., in: tag)
        for match in regex.matches(in: tag, options: [], range: range) {
            guard let nameRange = Range(match.range(at: 1), in: tag) else { continue }
            let name = String(tag[nameRange]).lowercased()
            for group in 2...4 where match.range(at: group).location != NSNotFound {
                if let valueRange = Range(match.range(at: group), in: tag) {
                    result[name] = String(tag[valueRange])
                    break
                }
            }
        }
        return result
    }

    /// An href against the page it was found on; only http(s) survives.
    static func resolve(_ href: String, against base: URL) -> URL? {
        let trimmed = href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let url = URL(string: trimmed, relativeTo: base)?.absoluteURL else { return nil }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }
}
