/**
 * OPML in and out.
 *
 * OPML is the only format every other reader can read, so it is the way a feed
 * list leaves this app and the way one arrives from elsewhere — folders
 * included, because an import that drops them is a worse list than the one the
 * user brought.
 *
 * The parser is deliberately a scanner rather than a DOM: the shape it has to
 * read is a tree of `<outline>` elements with attributes, it has to work in
 * Node for the tests as well as in the WebKit view, and pulling a full XML
 * parser in for that would be a dependency for one file format.
 */

export interface OpmlFeed {
  url: string;
  /** The feed's name in the file, if it had one. */
  title?: string;
  /** The folder it sat in, if it sat in one. FreshRSS calls this a category. */
  category?: string;
}

export interface OpmlFolder {
  label: string;
  feeds: { title: string; url: string }[];
}

/** The characters an attribute value or a title can carry, put back. */
function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `name="value"`, `name='value'` or a bare `name`, for one tag. */
function attributesOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(tag);
  while (match !== null) {
    out[match[1].toLowerCase()] = unescapeXml(match[2] ?? match[3] ?? "");
    match = pattern.exec(tag);
  }
  return out;
}

/** The first of the names OPML files use for "what this is called". */
function nameOf(attributes: Record<string, string>): string | undefined {
  for (const key of ["text", "title", "name"]) {
    const value = attributes[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * Every feed in an OPML document, with the folder it was filed under.
 *
 * Duplicates are dropped by URL, first occurrence winning: an exported-then-
 * imported file often carries the same feed twice, and subscribing to it twice
 * is a wasted request that FreshRSS answers with an error.
 */
export function parseOpml(xml: string): OpmlFeed[] {
  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();
  const folders: string[] = [];

  const pattern = /<outline\b([^>]*?)(\/?)>|<\/outline\s*>/gi;
  let match = pattern.exec(xml);
  while (match !== null) {
    if (match[0].startsWith("</")) {
      folders.pop();
      match = pattern.exec(xml);
      continue;
    }
    const attributes = attributesOf(match[1] ?? "");
    const selfClosing = match[2] === "/";
    const url = attributes.xmlurl ?? attributes.url;
    if (url !== undefined && url !== "") {
      const declared = attributes.category?.split("/")[0]?.trim();
      const feed: OpmlFeed = { url };
      const title = nameOf(attributes);
      if (title !== undefined) feed.title = title;
      const category = declared !== undefined && declared !== "" ? declared : folders[folders.length - 1];
      if (category !== undefined && category !== "") feed.category = category;
      if (!seen.has(url)) {
        seen.add(url);
        feeds.push(feed);
      }
      if (!selfClosing) folders.push(""); // a body on a feed outline is not a folder
    } else if (!selfClosing) {
      folders.push(nameOf(attributes) ?? "");
    }
    match = pattern.exec(xml);
  }

  if (feeds.length === 0) {
    throw new Error("That file has no feeds in it. An OPML export from another reader will.");
  }
  return feeds;
}

/**
 * A document other readers can import, folders and all.
 *
 * Dates are ISO-8601 UTC because that is what the format asks for and what
 * every importer parses; the body is indented so a person can read the file
 * they exported.
 */
export function buildOpml(
  folders: readonly OpmlFolder[],
  options: { title?: string; created?: Date; owner?: string } = {},
): string {
  const created = options.created ?? new Date();
  const title = options.title ?? "HardlyReader subscriptions";
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>${escapeXml(title)}</title>`,
    `    <dateCreated>${created.toISOString()}</dateCreated>`,
  ];
  if (options.owner !== undefined && options.owner !== "") {
    lines.push(`    <ownerName>${escapeXml(options.owner)}</ownerName>`);
  }
  lines.push("  </head>", "  <body>");

  for (const folder of folders) {
    lines.push(`    <outline text="${escapeXml(folder.label)}" title="${escapeXml(folder.label)}">`);
    for (const feed of folder.feeds) {
      lines.push(
        `      <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.url)}" />`,
      );
    }
    lines.push("    </outline>");
  }

  lines.push("  </body>", "</opml>", "");
  return lines.join("\n");
}

/** `hardlyreader-2026-10-23.opml` — sorts by date, no spaces to trip over. */
export function opmlFileName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `hardlyreader-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.opml`;
}
