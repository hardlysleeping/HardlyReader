/**
 * What server this window is signed in to, short enough for the top bar.
 *
 * The bar is where you check "am I looking at the tailnet box or the dev
 * container", so the useful part is the host and the port — `blah:2232` — not
 * the scheme, which costs fourteen characters to say nothing the port does not
 * already imply. The full URL is kept for the tooltip and the account sheet.
 *
 * Anything unparseable is returned as it came in rather than blanked: a wrong
 * address on screen is a clue, an empty one is a puzzle.
 */
export function serverLabel(serverUrl: string): string {
  const raw = (serverUrl ?? "").trim();
  if (raw === "") return "";
  let rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  rest = rest.replace(/^\/+/, "");
  const cut = rest.search(/[/?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  return rest.replace(/:+$/, "");
}
