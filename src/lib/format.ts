/** Formats an item timestamp for the article list. */
export function relativeTime(timestampUsec?: string, publishedSeconds?: number): string {
  let millis: number;
  if (timestampUsec) {
    millis = Number(timestampUsec) / 1000;
  } else if (publishedSeconds) {
    millis = publishedSeconds * 1000;
  } else {
    return "";
  }
  if (!Number.isFinite(millis) || millis <= 0) return "";

  const seconds = Math.round((Date.now() - millis) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (days < 365) return `${weeks}w`;
  return `${Math.round(days / 365)}y`;
}

export function absoluteTime(timestampUsec?: string, publishedSeconds?: number): string {
  const millis = timestampUsec ? Number(timestampUsec) / 1000 : (publishedSeconds ?? 0) * 1000;
  if (!Number.isFinite(millis) || millis <= 0) return "";
  return new Date(millis).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Collapses markup to a single line of text for list previews. */
export function plainPreview(html: string | undefined, limit = 180): string {
  if (!html) return "";
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}
