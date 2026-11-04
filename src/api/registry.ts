/**
 * Every account this window can read, in one place.
 *
 * The app was built around one profile: `reader.profile` was set by `start()` and
 * `reader.backend` was that profile's backend, so "the account" and "the app" were
 * the same thing. That is honest for one login and wrong for two — a second
 * FreshRSS account, a local library beside a server, a Miniflux account next to
 * FreshRSS — and the moment there are two, every question about cached rows,
 * capabilities, refresh and writes needs to say *whose*.
 *
 * This is that "whose": a slug-keyed collection of profiles that already own their
 * backends (`syncProfile` and `localProfile` build them; `openLocalProfile` opens a
 * library). The registry deliberately builds nothing: opening a local database is
 * asynchronous and building a server backend twice is how the offline queue ended
 * up on only one of the two paths (see `serverBackend`). It stores what was built
 * and answers by slug.
 *
 * Three rules, and they are the whole file:
 *
 * 1. **The slug is the identity.** It is the same tag `lib/account-key` hashes for
 *    the layout, prefs, pins and caches, so a row's account, a preference key's
 *    account and a queued mark's account cannot disagree — there is one spelling.
 * 2. **Removing an account is two things:** the profile goes, and its write journal
 *    is dropped (`forgetQueue`). A journal nobody can reach again is disk that only
 *    grows, and the slug is the only handle it has.
 * 3. **Nothing here mutates a profile.** A profile is what a backend answers as;
 *    `enabled` is close to the one exception and even that returns a new object —
 *    a registry that edited the profile under a reader that had just started with it
 *    would be a mode change nobody was told about.
 *
 * What this is not: it does not merge streams (that is `lib/merge` and the
 * aggregate backend), it does not decide which account the reading UI is bound to
 * (`reader.focus`), and it does not refresh anything (`refreshAll`). Those are
 * questions *about* the set, and they belong where the set is read.
 */
import type { ReaderBackend } from "./backend";
import { forgetQueue, profileSlug, type ReaderProfile } from "./profile";

export class AccountRegistry {
  /** Insertion order is the order Pane 1 draws, so it is kept, not sorted. */
  private readonly profiles = new Map<string, ReaderProfile>();

  /** Adds or replaces the profile for its slug. Returns the slug it was filed under. */
  add(profile: ReaderProfile): string {
    const slug = profileSlug(profile);
    this.profiles.set(slug, profile);
    return slug;
  }

  has(slug: string): boolean {
    return this.profiles.has(slug);
  }

  /**
   * The profile behind a slug, or `null`.
   *
   * `null` rather than a throw: this is asked on drawing paths (which slot owns a
   * row, whose capabilities decide a control) and a missing account is a frame that
   * has gone stale, not an exception the reading UI can do anything about.
   */
  get(slug: string): ReaderProfile | null {
    return this.profiles.get(slug) ?? null;
  }

  /** The backend that answers for a slug, or `null` when it is not signed in here. */
  backend(slug: string): ReaderBackend | null {
    return this.profiles.get(slug)?.backend ?? null;
  }

  all(): ReaderProfile[] {
    return [...this.profiles.values()];
  }

  /** The accounts a merged view reads: everything not explicitly turned off. */
  enabled(): ReaderProfile[] {
    return this.all().filter((profile) => profile.enabled !== false);
  }

  slugs(): string[] {
    return [...this.profiles.keys()];
  }

  get size(): number {
    return this.profiles.size;
  }

  /**
   * Signs an account out of this window: its profile and its queued marks.
   *
   * Its layout, preferences, pins and chrome stay under their own keys
   * (`lib/account-key`): those describe how someone reads, not that they are signed
   * in, and dropping them would delete work the reader did.
   */
  remove(slug: string): boolean {
    if (!this.profiles.delete(slug)) return false;
    forgetQueue(slug);
    return true;
  }

  /** Clears the registry without touching any journal, for a suite or a reset. */
  clear(): void {
    this.profiles.clear();
  }
}
