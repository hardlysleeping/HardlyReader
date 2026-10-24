/**
 * Hardly Read — FreshRSS client.
 *
 * Two channels, deliberately separate:
 *
 *   1. GReader API  (/api/greader.php)  — login, categories, feeds, articles.
 *      Standard protocol, works against any FreshRSS, no server change.
 *
 *   2. Extension API (/api/hc/...)      — the state of the Hidden / Favorite /
 *      Indent extensions. The GReader API CANNOT expose these: hiding writes
 *      feed priority -10, which makes the feed vanish from subscription/list
 *      entirely. So a feed that is hidden and a feed that was deleted look
 *      identical over GReader. The app has to be told.
 *
 * Auth:
 *   GReader uses a GoogleReader-style token from ClientLogin.
 *   The extension API is same-origin and uses the user's normal FreshRSS
 *   session — no separate token. That is the whole reason the app is served
 *   from the FreshRSS origin rather than as its own service.
 */

import DOMPurify from 'dompurify'

const GREADER = '/api/greader.php'

/** Thrown for auth failures so the UI can show the login form again. */
export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError' }
}

/** Thrown when the extension API is not installed/enabled on the server. */
export class ExtensionUnavailable extends Error {
  constructor(msg) { super(msg); this.name = 'ExtensionUnavailable' }
}

export class FreshRssClient {
  #auth = null            // 'GoogleLogin auth=...' value
  #origins = null

  /**
   * @param {object} [opts]
   * @param {string} [opts.base]   origin to talk to; defaults to same-origin
   */
  constructor(opts = {}) {
    this.base = opts.base || ''
    // restore a previous session so a reload does not force a re-login
    try {
      const saved = sessionStorage.getItem('hr.auth')
      if (saved) this.#auth = saved
    } catch { /* private mode: just log in each time */ }
  }

  get isLoggedIn() { return this.#auth !== null }

  // ---------------------------------------------------------------- login

  /**
   * ClientLogin. FreshRSS takes the API password here, which may differ from
   * the web login password — it is set per-user under Profile → API.
   * @returns {Promise<void>}
   */
  async login(user, password, base) {
    if (base !== undefined) this.base = base
    const body = new URLSearchParams({ Email: user, Passwd: password })

    let res
    try {
      res = await fetch(`${this.base}${GREADER}/accounts/ClientLogin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    } catch (e) {
      throw new AuthError(`Could not reach the server: ${e.message}`)
    }

    if (res.status === 401 || res.status === 403) {
      throw new AuthError('Wrong username or API password.')
    }
    if (!res.ok) {
      throw new AuthError(`Login failed (HTTP ${res.status}).`)
    }

    const text = await res.text()
    // Response body is newline separated: SID=...\nLSID=...\nAuth=XXXX
    const m = text.match(/^Auth=(.+)$/m)
    if (!m) {
      throw new AuthError('Login succeeded but no Auth token was returned. ' +
        'Is "Allow API access" enabled for this user?')
    }
    this.#auth = `GoogleLogin auth=${m[1].trim()}`
    try { sessionStorage.setItem('hr.auth', this.#auth) } catch { /* ignore */ }
  }

  logout() {
    this.#auth = null
    try { sessionStorage.removeItem('hr.auth') } catch { /* ignore */ }
  }

  // -------------------------------------------------------------- requests

  async #get(path, params, { absolute = false } = {}) {
    if (!this.#auth) throw new AuthError('Not logged in.')
    const url = new URL(`${this.base}${GREADER}${path}`, location.origin)
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v)
    }
    const res = await fetch(url, { headers: { Authorization: this.#auth } })
    if (res.status === 401) {
      this.logout()
      throw new AuthError('Session expired — log in again.')
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
    return res.json()
  }

  /**
   * POST to the GReader API. Needs a one-time write token from /token —
   * T=... must be sent as a form field alongside the auth header.
   */
  async #post(path, params) {
    if (!this.#auth) throw new AuthError('Not logged in.')
    const token = await this.#writeToken()
    const body = new URLSearchParams({ ...params, T: token })
    const url = new URL(`${this.base}${GREADER}${path}`, location.origin)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.#auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    if (res.status === 401) {
      this.logout()
      throw new AuthError('Session expired — log in again.')
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
    return res.text()
  }

  async #writeToken() {
    const res = await fetch(`${this.base}${GREADER}/reader/api/0/token`, {
      headers: { Authorization: this.#auth },
    })
    if (!res.ok) throw new Error(`Could not get a write token (HTTP ${res.status}).`)
    return (await res.text()).trim()
  }

  // ------------------------------------------------------------ read: tree

  /**
   * Categories and feeds, merged into one flat model.
   *
   * GReader exposes a feed's category as a tag id `user/-/label/<name>`, and
   * the label list comes from tag/list. A category with no feeds does not
   * appear in either — that is a protocol limit, and it is exactly why the
   * extension API is needed to know a category is hidden rather than gone.
   *
   * @returns {Promise<{categories: Array, feeds: Array, labelById: Map}>}
   */
  async loadTree() {
    const [subs, tags] = await Promise.all([
      this.#get('/reader/api/0/subscription/list', { output: 'json' }),
      this.#get('/reader/api/0/tag/list', { output: 'json' }),
    ])

    // label id -> display name. Categories are labels not in the special set.
    const SPECIAL = /^user\/-\/(state|label)/ // label handled separately below
    const labelById = new Map()
    for (const t of tags.tags || []) {
      if (!t.id.startsWith('user/-/label/')) continue
      if (SPECIAL.test(t.id) && t.id.startsWith('user/-/state/')) continue
      labelById.set(t.id, t.label || t.id.replace('user/-/label/', ''))
    }

    const feeds = []
    const usedLabels = new Map() // labelId -> feed ids

    for (const s of subs.subscriptions || []) {
      const cats = (s.categories || []).filter((c) => c.startsWith('user/-/label/'))
      const primary = cats[0] || null // FreshRSS: one category per feed
      const id = s.id.replace(/^feed\//, '')
      feeds.push({
        id,
        url: s.id,
        title: s.title || id,
        htmlUrl: s.htmlUrl || '',
        iconUrl: s.iconUrl || '',
        categoryLabelId: primary,
        categoryName: primary ? (labelById.get(primary) || primary.replace('user/-/label/', '')) : 'Uncategorised',
      })
      if (primary) {
        if (!usedLabels.has(primary)) usedLabels.set(primary, [])
        usedLabels.get(primary).push(id)
      }
    }

    // Every label becomes a category. A label with no feeds is still shown —
    // the app cannot tell "empty" from "hidden" without the extension API,
    // and hiding it here would silently drop real empty categories.
    const categories = []
    for (const [labelId, name] of labelById) {
      categories.push({ id: labelId, name, feedIds: usedLabels.get(labelId) || [] })
    }
    categories.sort((a, b) => a.name.localeCompare(b.name))

    this.#origins = { labelById }
    return { categories, feeds, labelById }
  }

  /** Unread counts per feed id. One stream query, no per-feed requests. */
  async unreadCounts() {
    const data = await this.#get('/reader/api/0/unread-count', { output: 'json' })
    const counts = {}
    for (const c of data.unreadcounts || []) {
      counts[c.id] = Number(c.count) || 0
    }
    return counts
  }

  // --------------------------------------------------------- read: articles

  /**
   * Articles for a stream.
   * @param {string} streamId  'user/-/state/com.google/reading-list' for all,
   *                           'user/-/label/<name>' for a category,
   *                           'feed/<id>' for one feed
   * @param {object} [opts]
   */
  async articles(streamId, { count = 60, continuation, excludeRead = false } = {}) {
    const params = { output: 'json', n: count, r: excludeRead ? 'o' : undefined }
    if (continuation) params.c = continuation
    const data = await this.#get(`/reader/api/0/stream/contents/${encodeURIComponent(streamId)}`, params)

    const items = (data.items || []).map((it) => this.#toArticle(it))
    return { items, continuation: data.continuation || null }
  }

  /** Article ids from the hidden categories, so the lite filter can hide them. */
  #toArticle(it) {
    const enc = it.summary?.content ?? it.content?.content ?? ''
    const cats = it.categories || []
    return {
      id: it.id,
      title: it.title || '(untitled)',
      author: it.author || '',
      // GReader returns seconds; ms for JS Date
      published: (it.published || 0) * 1000,
      timestampUsec: Number(it.timestampUsec || 0),
      html: enc,
      summary: stripTags(it.summary?.content || '').slice(0, 400),
      // feed origin: origin.streamId is 'feed/<id>'
      feedId: (it.origin?.streamId || '').replace(/^feed\//, ''),
      feedTitle: it.origin?.title || '',
      href: it.alternate?.[0]?.href || '',
      read: cats.some((c) => c.endsWith('/state/com.google/read')),
      starred: cats.some((c) => c.endsWith('/state/com.google/starred')),
      categories: cats,
    }
  }

  // ---------------------------------------------------------- write: state

  /** Mark read/unread. `a` adds, `r` removes. */
  async setRead(entryIds, read) {
    return this.#post('/reader/api/0/edit-tag', {
      [read ? 'a' : 'r']: 'user/-/state/com.google/read',
      i: [].concat(entryIds).join(','),
    })
  }

  async setStarred(entryIds, starred) {
    return this.#post('/reader/api/0/edit-tag', {
      [starred ? 'a' : 'r']: 'user/-/state/com.google/starred',
      i: [].concat(entryIds).join(','),
    })
  }

  async markAllRead(streamId) {
    return this.#post('/reader/api/0/mark-all-as-read', { s: streamId })
  }
}

/**
 * Strip tags for a plain-text summary.
 *
 * The input is remote HTML from an arbitrary feed, so it is sanitised with
 * DOMPurify before it is ever parsed. Only .textContent is read back out, so
 * nothing from the source document can reach the live DOM — but sanitising
 * anyway means a future change that reads a different property cannot
 * silently reintroduce an XSS sink.
 */
function stripTags(html) {
  const clean = DOMPurify.sanitize(html || '', { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
  const d = document.createElement('div')
  d.innerHTML = clean
  return (d.textContent || '').replace(/\s+/g, ' ').trim()
}
