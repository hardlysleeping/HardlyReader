import Foundation

/// One post, as the poll needs it.
public struct ScannedEntry: Equatable {
  /// Stable across fetches. Never empty. This is the row's `guid`.
  public var id: String
  public var title: String
  /// The article's own address, when the feed gave one.
  public var url: String
  /// Milliseconds since the epoch, or 0 when the feed carried no usable date.
  public var publishedAt: Int
  /// The best body the feed had: `content:encoded` before `description`.
  public var content: String
  public var author: String
  /// A lead image worth showing as a thumbnail, if one was declared.
  public var image: String
}

public struct ScannedFeed: Equatable {
  public var title: String
  /// The site's address, not the feed's.
  public var siteUrl: String
  public var description: String
  public var entries: [ScannedEntry]
}

/// RSS and Atom in, the store's vocabulary out.
///
/// A port of `src/lib/rss.ts`, and a port on purpose rather than a nicer
/// parser: the two must produce the *same* `guid` for the same post, or a feed
/// fetched by a background wake and then by the app would store every article
/// twice. That fixes the details — the scanner-not-DOM approach, the id
/// fallback, even the order entities are decoded in — to whatever the other
/// side does, including its quirks.
public enum FeedScanner {
  /// Whether a document looks like a feed at all, for the "not a feed" message.
  public static func looksLikeFeed(_ body: String) -> Bool {
    let head = String(body.prefix(2000))
    return firstMatch(#"<(rss|feed|rdf:rdf)\b"#, in: head) != nil
  }

  /// The entries of one feed document, in the order the document lists them.
  public static func parse(_ xml: String, feedUrl: String = "") -> ScannedFeed {
    let source = xml
    let isAtom = firstMatch(#"<feed\b"#, in: source) != nil
      && firstMatch(#"<entry\b"#, in: source) != nil
    let head: String
    if isAtom {
      head = source
    } else if let item = firstMatch(#"<item\b"#, in: source, options: [.caseInsensitive]),
      let range = source.range(of: item[0], options: .caseInsensitive)
    {
      head = String(source[source.startIndex..<range.lowerBound])
    } else {
      head = source
    }

    var feed = ScannedFeed(
      title: textOf(head, "title"),
      siteUrl: isAtom ? (atomLink(head) ?? textOf(head, "link")) : textOf(head, "link"),
      description: {
        let described = textOf(head, "description")
        return described.isEmpty ? textOf(head, "subtitle") : described
      }(),
      entries: []
    )

    var seen = Set<String>()
    for block in blocks(source, isAtom ? "entry" : "item") {
      let link = isAtom ? (atomLink(block) ?? "") : textOf(block, "link")
      let declaredId: String = {
        let guid = textOf(block, "guid")
        return guid.isEmpty ? textOf(block, "id") : guid
      }()
      let title = textOf(block, "title")
      let content: String = {
        for name in ["content:encoded", "content", "description", "summary"] {
          let found = textOf(block, name)
          if !found.isEmpty { return found }
        }
        return ""
      }()

      let dateText: String = {
        for name in ["pubdate", "published", "updated", "date"] {
          let found = textOf(block, name)
          if !found.isEmpty { return found }
        }
        return ""
      }()
      let publishedAt = parseDate(dateText)

      // The id has to survive a re-fetch: the publisher's guid first, the link
      // second, and a hash of title+date last — the same three choices, in the
      // same order, as `parseFeed`.
      let id: String
      if !declaredId.isEmpty {
        id = declaredId
      } else if !link.isEmpty {
        id = link
      } else {
        id = "\(feedUrl)#\(fingerprint("\(title)\u{0}\(publishedAt)"))"
      }
      if seen.contains(id) { continue }
      seen.insert(id)

      let author: String = {
        let named = textOf(block, "author")
        return named.isEmpty ? textOf(block, "dc:creator") : named
      }()

      feed.entries.append(
        ScannedEntry(
          id: id,
          title: title.trimmed(),
          url: link,
          publishedAt: publishedAt,
          content: content.trimmed(),
          author: author,
          image: imageOf(block)
        )
      )
    }

    return feed
  }

  // MARK: - The scanner

  /// Characters an XML text node or attribute can carry, put back.
  ///
  /// `&amp;` is decoded last, so `&amp;lt;` cannot become `<`.
  public static func unescapeXml(_ value: String) -> String {
    var out = replacing(#"&#x([0-9a-f]+);"#, in: value, options: [.caseInsensitive]) { groups in
      codePoint(groups[1], radix: 16)
    }
    out = replacing(#"&#([0-9]+);"#, in: out, options: []) { groups in
      codePoint(groups[1], radix: 10)
    }
    for (entity, replacement) in [
      ("&quot;", "\""), ("&apos;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "),
    ] {
      out = out.replacingOccurrences(of: entity, with: replacement)
    }
    return out.replacingOccurrences(of: "&amp;", with: "&")
  }

  /// `a="1" b='2'` → `["a": "1", "b": "2"]`, attribute names lowercased.
  static func attributesOf(_ source: String) -> [String: String] {
    var attributes: [String: String] = [:]
    let pattern = #"([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')"#
    for groups in allMatches(pattern, in: source, options: [.caseInsensitive]) {
      let name = groups[1].lowercased()
      let value = groups[3].isEmpty ? groups[4] : groups[3]
      attributes[name] = unescapeXml(value)
    }
    return attributes
  }

  /// The inside of the first `<name>…</name>` in `block`, CDATA unwrapped.
  ///
  /// Nested elements stay as markup: a `description` carrying `<p>` and `<img>`
  /// is normal, and throwing the tags away would lose the pictures.
  static func textOf(_ block: String, _ name: String) -> String {
    let pattern = "<\(name)\\b[^>]*>([\\s\\S]*?)</\(name)\\s*>"
    guard let groups = allMatches(pattern, in: block, options: [.caseInsensitive]).first else {
      return ""
    }
    return unwrap(groups[1])
  }

  /// Every `<tag>…</tag>` block in a document, in order, without its delimiters.
  static func blocks(_ source: String, _ tag: String) -> [String] {
    let pattern = "<\(tag)\\b[^>]*>([\\s\\S]*?)</\(tag)\\s*>"
    return allMatches(pattern, in: source, options: [.caseInsensitive]).map { $0[1] }
  }

  /// CDATA is data, not markup: unwrap it and leave its contents alone.
  static func unwrap(_ value: String) -> String {
    let out = replacing(#"<!\[CDATA\[([\s\S]*?)\]\]>"#, in: value, options: []) { groups in
      groups[1]
    }
    return unescapePreservingMarkup(out)
  }

  /// Entities in HTML bodies: decode the ones that are text, `&amp;` last.
  static func unescapePreservingMarkup(_ value: String) -> String {
    var out = replacing(#"&#x([0-9a-f]+);"#, in: value, options: [.caseInsensitive]) { groups in
      codePoint(groups[1], radix: 16)
    }
    out = replacing(#"&#([0-9]+);"#, in: out, options: []) { groups in
      codePoint(groups[1], radix: 10)
    }
    for (entity, replacement) in [
      ("&quot;", "\""), ("&apos;", "'"), ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"),
    ] {
      out = out.replacingOccurrences(of: entity, with: replacement)
    }
    return out.replacingOccurrences(of: "&amp;", with: "&").trimmed()
  }

  /// `<link>` in Atom is an element with attributes; in RSS it holds the URL.
  static func atomLink(_ block: String) -> String? {
    var fallback = ""
    for groups in allMatches(#"<link\b([^>]*?)/?>"#, in: block, options: [.caseInsensitive]) {
      let attributes = attributesOf(groups[1])
      let href = attributes["href"] ?? ""
      if href.isEmpty { continue }
      let rel = attributes["rel"]
      if rel == nil || rel == "alternate" { return href }
      if fallback.isEmpty { fallback = href }
    }
    return fallback.isEmpty ? nil : fallback
  }

  /// An image for the entry: an RSS enclosure of an image type, an Atom link
  /// with `rel="enclosure"`, or a `media:content` / `media:thumbnail` picture.
  static func imageOf(_ block: String) -> String {
    let imageExtensions = #"\.(jpe?g|png|gif|webp|avif)(\?|$)"#

    for groups in allMatches(#"<enclosure\b([^>]*?)/?>"#, in: block, options: [.caseInsensitive]) {
      let attributes = attributesOf(groups[1])
      let type = (attributes["type"] ?? "").lowercased()
      let url = attributes["url"] ?? ""
      if !url.isEmpty, type.hasPrefix("image/") || matches(imageExtensions, in: url) { return url }
    }
    for groups in allMatches(#"<link\b([^>]*?)/?>"#, in: block, options: [.caseInsensitive]) {
      let attributes = attributesOf(groups[1])
      if attributes["rel"] != "enclosure" { continue }
      let url = attributes["href"] ?? ""
      let type = (attributes["type"] ?? "").lowercased()
      let path = url.components(separatedBy: "?").first ?? ""
      if !url.isEmpty,
        type.hasPrefix("image/") || matches(#"/(jpe?g|png|gif|webp|avif)$"#, in: path)
      {
        return url
      }
    }
    for groups in allMatches(#"<media:(?:content|thumbnail)\b([^>]*?)/?>"#, in: block, options: [.caseInsensitive]) {
      let attributes = attributesOf(groups[1])
      let url = attributes["url"] ?? ""
      let medium = (attributes["medium"] ?? "").lowercased()
      if !url.isEmpty, medium == "image" || medium.isEmpty || matches(imageExtensions, in: url) {
        return url
      }
    }
    return ""
  }

  /// A date from RSS's RFC-822 or Atom's ISO-8601, in milliseconds, or 0.
  public static func parseDate(_ value: String) -> Int {
    let text = value.trimmed()
    if text.isEmpty { return 0 }

    if let iso = parseISO8601(text) { return iso }

    // Some feeds write "GMT" as a trailing word and some write a two-digit year;
    // Foundation's own date parsing handles neither reliably, so the same
    // abbreviations are normalised here as in `parseDate` on the JS side.
    var cleaned = text
    for (abbreviation, replacement) in [
      ("UT", "GMT"), ("EST", "-0500"), ("EDT", "-0400"), ("CST", "-0600"), ("CDT", "-0500"),
      ("MST", "-0700"), ("MDT", "-0600"), ("PST", "-0800"), ("PDT", "-0700"),
    ] {
      cleaned = replacing(
        "\\b\(abbreviation)\\b", in: cleaned, options: [.caseInsensitive]
      ) { _ in replacement }
    }
    if let parsed = parseRFC822(cleaned) { return parsed }
    if let parsed = parseRFC822(text) { return parsed }
    return 0
  }

  /// A short, stable, non-cryptographic hash — FNV-1a over UTF-16 code units,
  /// exactly as `fingerprint` does it, so both sides name a nameless entry the
  /// same way.
  public static func fingerprint(_ value: String) -> String {
    var hash: UInt32 = 0x811c_9dc5
    for unit in value.utf16 {
      hash ^= UInt32(unit)
      hash = hash &* 0x0100_0193
    }
    return String(hash, radix: 36)
  }

  // MARK: - Matching

  /// One capture-group list per match, `groups[0]` being the whole match.
  static func allMatches(
    _ pattern: String,
    in text: String,
    options: NSRegularExpression.Options
  ) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return [] }
    let whole = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, options: [], range: whole).map { match in
      (0..<match.numberOfRanges).map { index in
        guard let range = Range(match.range(at: index), in: text) else { return "" }
        return String(text[range])
      }
    }
  }

  static func firstMatch(
    _ pattern: String,
    in text: String,
    options: NSRegularExpression.Options = [.caseInsensitive]
  ) -> [String]? {
    allMatches(pattern, in: text, options: options).first
  }

  static func matches(_ pattern: String, in text: String) -> Bool {
    firstMatch(pattern, in: text) != nil
  }

  static func replacing(
    _ pattern: String,
    in text: String,
    options: NSRegularExpression.Options,
    _ transform: ([String]) -> String
  ) -> String {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
    let whole = NSRange(text.startIndex..<text.endIndex, in: text)
    let found = regex.matches(in: text, options: [], range: whole)
    if found.isEmpty { return text }

    var out = ""
    var cursor = text.startIndex
    for match in found {
      guard let range = Range(match.range, in: text) else { continue }
      let groups = (0..<match.numberOfRanges).map { index -> String in
        guard let groupRange = Range(match.range(at: index), in: text) else { return "" }
        return String(text[groupRange])
      }
      out += text[cursor..<range.lowerBound]
      out += transform(groups)
      cursor = range.upperBound
    }
    out += text[cursor...]
    return out
  }

  // MARK: - Dates

  private static func parseISO8601(_ text: String) -> Int? {
    let formatters: [ISO8601DateFormatter] = {
      let plain = ISO8601DateFormatter()
      plain.formatOptions = [.withInternetDateTime]
      let fractional = ISO8601DateFormatter()
      fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      return [fractional, plain]
    }()
    for formatter in formatters {
      if let date = formatter.date(from: text), let value = milliseconds(date) { return value }
    }
    return nil
  }

  private static func parseRFC822(_ text: String) -> Int? {
    let formats = [
      "EEE, dd MMM yyyy HH:mm:ss zzz",
      "EEE, d MMM yyyy HH:mm:ss zzz",
      "EEE, dd MMM yy HH:mm:ss zzz",
      "EEEE, dd-MMM-yy HH:mm:ss zzz",
      "EEE MMM d HH:mm:ss yyyy",
      "EEE, dd MMM yyyy HH:mm:ss Z",
      "EEE, dd MMM yyyy HH:mm Z",
      "dd MMM yyyy HH:mm:ss zzz",
    ]
    for format in formats {
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.timeZone = TimeZone(secondsFromGMT: 0)
      formatter.dateFormat = format
      if let date = formatter.date(from: text), let value = milliseconds(date) { return value }
    }
    return nil
  }

  private static func milliseconds(_ date: Date) -> Int? {
    let value = Int((date.timeIntervalSince1970 * 1000).rounded())
    return value > 0 ? value : nil
  }

  private static func codePoint(_ digits: String, radix: Int) -> String {
    guard let code = UInt32(digits, radix: radix), code > 0, code <= 0x10FFFF,
      let scalar = Unicode.Scalar(code)
    else { return "" }
    return String(Character(scalar))
  }
}

extension String {
  /// `String.prototype.trim` in JS: whitespace and newlines, both ends.
  func trimmed() -> String {
    trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
