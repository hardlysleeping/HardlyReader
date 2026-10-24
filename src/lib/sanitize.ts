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

/**
 * Makes the pictures in an already-sanitised fragment load, and makes one that
 * cannot load disappear.
 *
 * These attributes cannot come from the markup. `sanitizeArticle()` runs through
 * DOMPurify, which measured against the real pane keeps `loading` and `decoding`
 * but **drops `referrerpolicy`** — so a policy written into the HTML is silently
 * lost, and writing it here is the only way it reaches the element. Setting all
 * three in one place also means the feed's own body and the extracted page get
 * the same treatment, which they did not before: only the lead picture did.
 *
 * - `no-referrer` is what the lead picture already sends: the publisher gets no
 *   referrer from this app, and nothing is fabricated to get past a wall.
 * - `loading="lazy"` / `decoding="async"` stop a long article from pulling and
 *   decoding every picture the moment it opens.
 * - A picture that fails is **removed**, not left as a broken frame with alt
 *   text in the middle of the column — the rule the list's thumbnails follow.
 *   `complete && naturalWidth === 0` catches the one that already failed before
 *   the listener existed, which is common: a refusal is fast, `innerHTML` is
 *   not instant.
 */
export function prepareImages(root: ParentNode): void {
  for (const img of root.querySelectorAll("img")) {
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("referrerpolicy", "no-referrer");
    img.addEventListener("error", () => img.remove(), { once: true });
    if (img.complete && img.naturalWidth === 0) img.remove();
  }
}

export function isExternalHttp(href: string | null): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}
