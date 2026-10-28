/**
 * Who is asking, answered by Supabase — and only by Supabase.
 *
 * The checkout endpoint has to know which reader is about to pay, because that
 * is the moment the customer link is written. It cannot parse the JWT itself: a
 * JWT is a claim, and verifying a claim means holding the project's signing key,
 * which would make this service a second authority on identity. So it asks the
 * authority: `GET /auth/v1/user` with the reader's own token. A 401 there is a
 * 401 here.
 *
 * That call also makes the expiry real. A token that expired ten minutes ago was
 * signed correctly and is worth nothing, and only the auth server knows that.
 */

export class SupabaseAuth {
  constructor({ url, anonKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
    if (!url) throw new Error("SUPABASE_URL is not set");
    if (!anonKey) throw new Error("SUPABASE_ANON_KEY is not set");
    if (typeof fetchImpl !== "function") throw new Error("no fetch available");
    this.url = url.replace(/\/$/, "");
    this.anonKey = anonKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** The reader's id for this token, or null when the token is not good. */
  async userId(token) {
    if (typeof token !== "string" || token === "") return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.url}/auth/v1/user`, {
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body?.id === "string" && body.id !== "" ? body.id : null;
    } catch {
      // An auth server we could not reach is not an authenticated reader.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The suite's auth: tokens that are simply names for readers. */
export class FakeAuth {
  constructor(tokens = {}) {
    this.tokens = tokens;
    this.asked = [];
  }

  async userId(token) {
    this.asked.push(token);
    return this.tokens[token] ?? null;
  }
}
