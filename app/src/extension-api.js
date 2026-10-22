/**
 * Hardly Read — extension API client.
 *
 * Talks to the small JSON controller added to the Hidden Categories extension
 * (`/api/hc/state` and `/api/hc/act`). Same origin as FreshRSS, so it rides the
 * user's existing FreshRSS session — no second token, no CORS.
 *
 * WHY THE APP NEEDS THIS AT ALL
 * -----------------------------
 * Neither extension's state is recoverable from the GReader API:
 *
 *   Hidden  writes feed priority -10 → the feed disappears from
 *           subscription/list completely. Hidden and deleted are
 *           indistinguishable, and an emptied category looks deleted.
 *   Favorite writes +20 on favorites. A promoted feed looks like an ordinary
 *           important feed, so the app cannot tell favorite from already-20.
 *   Indent  keeps one integer in FreshRSS's own user config, which no API
 *           exposes.
 *
 * So the app is told, rather than guessing. Everything here is a thin mirror of
 * what the extensions already put on the web page.
 */

/** The three extensions, as the app models them. */
export const EXT = {
  HIDDEN: 'hidden',
  FAVORITE: 'favorite',
  INDENT: 'indent',
}

/**
 * State for all three extensions in one round trip.
 *
 * @returns {Promise<{
 *   hidden:   {enabled:boolean, cats:number[], mode:string, view:string,
 *              next:string, locked:boolean, lockAvailable:boolean,
 *              showCount:boolean, rowMode:string, rowLabel:string,
 *              meta:Object<string,{name:string,feeds:number}>},
 *   favorite: {enabled:boolean, cats:number[], view:string, next:string,
 *              rowMode:string, rowLabel:string, button:string,
 *              look:string, filterStyle:string, mode:string, meta:Object},
 *   indent:   {enabled:boolean, px:number}
 * }>}
 */
export async function fetchState(apiBase = '/api/hc') {
  const res = await fetch(`${apiBase}/state`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) {
    throw new Error(
      'The extension API is not reachable (404). Update the Hidden Categories ' +
      'extension on the server, or check that the app is served from the ' +
      'FreshRSS origin.'
    )
  }
  if (!res.ok) throw new Error(`Could not read extension state (HTTP ${res.status}).`)
  return res.json()
}

/**
 * Perform one extension action. The action names and parameters are the SAME
 * ones the extensions' own settings page accepts (`handleConfigurePost`), so
 * the app drives exactly the code path the web UI drives — one write path, no
 * parallel implementation that can drift.
 *
 * @param {string} act    'hide' | 'unhide' | 'fav' | 'unfav' | 'view' | 'mode' | ...
 * @param {Object} params extra fields, e.g. { cat: 12 } or { view: 'only' }
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function sendAction(act, params = {}, apiBase = '/api/hc') {
  const res = await fetch(`${apiBase}/act`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ act, ...params }),
  })
  // A non-OK body still carries a useful message from the extension, so parse
  // first and only fall back to the status code when the body is not JSON.
  let data = null
  try { data = await res.json() } catch { /* not JSON */ }
  if (!data) {
    throw new Error(`Action failed (HTTP ${res.status}).`)
  }
  return data
}

/**
 * The lite filter — the app's own instant copy of what the extensions do
 * server-side.
 *
 * This exists so a tap feels immediate: hiding a category re-renders straight
 * away, while the real write converges in the background. It is deliberately
 * the SAME predicate the extensions implement, so the optimistic state and the
 * confirmed state cannot disagree for long.
 *
 * THE NON-CONFLICT RULE (from the extensions themselves):
 *   "if a category is favorited AND hidden, the hiding extension keeps it gone
 *    in every favorites view"
 * So hidden always wins over favorite, in every view, everywhere.
 */
export function isVisible({ isHidden, isFavorite, hiddenView, favView }) {
  // hidden wins unconditionally
  if (hiddenView === 'only') {
    if (!isHidden) return false
  } else if (hiddenView === 'hidden') {
    if (isHidden) return false
  }
  // 'revealed' → hidden categories are mixed back in, so no hiding filter

  if (favView === 'only') {
    if (!isFavorite) return false
  } else if (favView === 'without') {
    if (isFavorite) return false
  }
  // 'all' → favorites filter nothing

  return true
}

/** Tag to draw on a row, per each extension's own rules. */
export function rowTags({ isHidden, isFavorite, hiddenView, favView, favLook }) {
  const tags = []
  // Hidden Categories: the HIDDEN tag appears only in revealed and only views,
  // never in the hidden view (the rows are gone there anyway).
  if (isHidden && (hiddenView === 'revealed' || hiddenView === 'only')) {
    tags.push({ kind: 'hidden', text: 'HIDDEN' })
  }
  // Favorite Categories: tag favourites in the views that show them alongside
  // everything else.
  if (isFavorite && (favView === 'all' || favView === 'without')) {
    tags.push({ kind: 'favorite', text: favLook === 'pinned' ? 'PINNED' : 'FAVORITE' })
  }
  return tags
}
