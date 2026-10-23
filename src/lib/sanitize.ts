import DOMPurify from "dompurify";

/**
 * Feed content is untrusted, so it is sanitised before it ever reaches the DOM.
 *
 * Scripts, embedded frames, forms and inline styles are removed, along with
 * event-handler attributes. FreshRSS already sanitises server-side; this is the
 * second layer, so it errs towards stripping rather than preserving fidelity.
 */
export function sanitizeArticle(html: string | undefined): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["style", "onerror", "onload"],
    ADD_ATTR: ["target", "rel"],
  });
}

/** Adds safe rel/target to every link in an already-sanitised fragment. */
export function hardenLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll("a")) {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noreferrer noopener");
  }
}

export function isExternalHttp(href: string | null): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}
