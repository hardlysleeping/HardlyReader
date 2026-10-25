/**
 * Turning a chosen file into a background the theme can hold.
 *
 * A wallpaper off a phone is 4000px wide and several megabytes; the theme lives
 * in localStorage, which is neither big enough nor the place for it. So the file
 * is drawn once, downscaled to something a screen can use, and stored as a data
 * URL — no path to go stale, no file to lose, and the theme travels with the
 * browser profile.
 *
 * Everything here touches the DOM, so it is a browser-only module: the pure
 * numbers it works from are exported for the tests.
 */

/** The long edge a background is kept at. Larger than any pane, smaller than a photo. */
export const MAX_BG_EDGE = 1800;

/** Above this many characters the data URL is re-encoded harder rather than refused. */
export const MAX_BG_CHARS = 1_600_000;

/**
 * Reads a picked file and returns a data URL, or null if it is not an image the
 * browser can decode.
 */
export async function backgroundFromFile(file: File): Promise<string | null> {
  if (typeof document === "undefined" || !file.type.startsWith("image/")) return null;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Not something this engine can decode (a RAW file, a broken download).
    return null;
  }

  const { width, height } = fit(bitmap.width, bitmap.height, MAX_BG_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    bitmap.close();
    return null;
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // JPEG, because the picture is already going to be blurred and a screenshot of
  // a gradient does not need to be lossless. A busy photograph at 0.82 can still
  // be large, so the second pass is cheaper rather than a refusal.
  const url = canvas.toDataURL("image/jpeg", 0.82);
  if (url.length <= MAX_BG_CHARS) return url;
  return canvas.toDataURL("image/jpeg", 0.6);
}

/** The size a picture of `width`×`height` is kept at, never upscaled. */
export function fit(width: number, height: number, edge = MAX_BG_EDGE): {
  width: number;
  height: number;
} {
  const longest = Math.max(width, height);
  if (longest <= edge || longest === 0) return { width, height };
  const scale = edge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
