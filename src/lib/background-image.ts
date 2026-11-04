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

/**
 * Above this many characters the data URL is re-encoded harder rather than refused.
 *
 * It was 1.6M, which is 3.2MB of UTF-16 in a store iOS caps at 5MB for the whole
 * origin: a busy photograph then pushed the theme past the quota, the save threw,
 * and the retry that keeps the colours dropped the picture — the wallpaper
 * simply did not come back, on the one platform where the quota is tight. 900k
 * characters is 1.8MB and still 1800px of JPEG.
 */
export const MAX_BG_CHARS = 900_000;

/** A decoded picture, however the engine managed to decode it. */
interface Decoded {
  picture: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decode a file, by the fast path or the one every engine has.
 *
 * `createImageBitmap` is the tidy way in, and the only one that cannot be
 * tainted — but a photo off a phone is also exactly the file where a webview
 * refuses it (HEIC it can show but not decode, a 48MP JPEG it runs out of room
 * for). The `<img>` element is the fallback every engine has had forever; an
 * object URL keeps the file out of the DOM's memory until it is revoked.
 */
async function decode(file: File): Promise<Decoded | null> {
  try {
    const bitmap = await createImageBitmap(file);
    return {
      picture: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch {
    // Fall through to the element.
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await (image.decode ? image.decode() : new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    }));
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(url);
    return null;
  }
  return {
    picture: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/**
 * Reads a picked file and returns a data URL, or null if it is not an image the
 * browser can decode.
 */
export async function backgroundFromFile(file: File): Promise<string | null> {
  if (typeof document === "undefined" || !file.type.startsWith("image/")) return null;

  const source = await decode(file);
  if (source === null) return null;

  const { width, height } = fit(source.width, source.height, MAX_BG_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    source.release();
    return null;
  }

  context.drawImage(source.picture, 0, 0, width, height);
  source.release();

  // JPEG, because the picture is already going to be blurred and a screenshot of
  // a gradient does not need to be lossless. A busy photograph at 0.82 can still
  // be large, so the second pass is cheaper rather than a refusal.
  for (const quality of [0.82, 0.6, 0.45]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= MAX_BG_CHARS) return url;
  }
  return null;
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
