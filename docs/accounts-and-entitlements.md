# Accounts and entitlements

Owner decision, 2026-10-27. Two separate questions, and they must stay separate:

1. **Who is this reader?** — an identity, so one purchase unlocks a second device.
2. **Do they own HardlyReader Sync right now?** — an entitlement, which only a server may set.

Neither question has anything to do with where the library lives. Feeds, articles, read state and
stars stay in SQLite, in FreshRSS, or in the reader's own cloud folder. This document's server
answers one sentence: *who is this, and do they currently own Sync.*

## Why an account at all

Without an identity there is nothing to attach a purchase to, and the paid feature would be
per-device: buy on the phone, buy again on the desktop. A licence key would be cheaper but gets
shared and gives no device list; a home-grown password table is worse than either. So: one
identity provider, one row per purchase, and the app asks it a single question.

**An account is optional.** It is created at the moment someone asks for cloud sync, never at
launch. A reader using FreshRSS — or using nothing but the local library — never sees it, and
`docs/authority.md` still rules those paths.

## What runs where

```
HardlyReader (all platforms)
        │
        ▼
Supabase Auth                →  identity: JWT, per device
        │
        ▼
Postgres: entitlements       →  cloud_sync boolean, source, expires_at
        ▲
        │  webhook (server-side only)
Payment provider (Stripe now; Apple/Google later if a store demands it)
```

Supabase's free tier covers this comfortably (50k MAU at $0 as of writing), and it is the whole
backend: no queue, no cron, no file storage — the library never goes through it.

```sql
-- supabase/schema.sql in the repo is the authority; this is the shape.
create table public.entitlements (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  cloud_sync boolean not null default false,
  source     text    not null,          -- 'stripe' | 'apple' | 'google'
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
```

### Rules that are not negotiable

1. **The client can never write `cloud_sync`.** Row-level security: `select` on your own row,
   nothing else. Writes come from the payment webhook using the service key, server-side. A
   client that could set this flag would be a free subscription with two lines of JavaScript.
2. **No entitlement, no sync — but never a broken reader.** A failed fetch, a 500, an expired JWT
   all mean `cloudSync === false`, and the local library keeps working exactly as before. The
   reader must not lose data because a network call failed.
3. **FreshRSS is outside this system entirely.** A reader syncing through their own server never
   needs an account, and no code on that path may consult an entitlement.
4. **A purchase source is an implementation detail.** Stripe today, StoreKit or Play later — all
   of them end as the same `cloud_sync = true` row. Nothing in the app may be conditional on
   *where* a purchase came from.
5. **Expiry pauses, never deletes.** Sync stops; library, read state, stars and the files already
   in the provider stay. `docs/authority.md` has the wording.

## Payment, in the order that costs least

- **Now:** web payment (Stripe Checkout) + a webhook that writes `cloud_sync`. Works for Linux,
  Flatpak, sideloaded iOS and Android, and the PWA in one integration.
- **Later, only if a store demands it:** StoreKit 2 for App Store distribution and Google Play
  Billing for Play. Both become another writer of the same column — card `t_87c6cfb7`, demoted
  for that reason.

Building Apple and Google billing first would mean paying for two integrations before finding out
that the Linux client still needs an account layer.

## Providers, honestly

| provider | iPhone | Android | Linux | Windows/macOS |
|---|---|---|---|---|
| iCloud | excellent (native CloudKit) | web bridge | web bridge | macOS excellent, else web bridge |
| Google Drive | ✓ | ✓ | ✓ | ✓ |
| Dropbox | ✓ | ✓ | ✓ | ✓ |
| OneDrive | ✓ | ✓ | ✓ | ✓ |

Rollout stays **iCloud → Google Drive → Dropbox → OneDrive**, with Drive immediately after iCloud
because it is the one that makes iPhone ↔ Linux honest.

On iCloud: Apple ships **CloudKit JS**, which reaches the same private database from a web view,
so a Tauri client on Linux is not architecturally excluded. It is also not something to promise:
there is no native CloudKit SDK for Linux, the JS path needs real testing against a real Apple ID,
and it must never become a support burden in v1. So the UI says what is true — *iCloud sync is
optimised for Apple devices*; Drive, Dropbox and OneDrive are the plain choices across platforms.

## What the app does at launch

```
launch
 ├─ no account, no token         → local library, free, no prompt
 ├─ account, entitlement false   → local library, free, Settings shows the upgrade
 └─ account, entitlement true    → local library + provider choice enabled
```

Identity is fetched once and cached; the entitlement is re-checked on launch and on resume, and
cached for offline launches so a plane does not pause somebody's subscription.

## Where the keys live, and which one never ships

The build is handed two values from its environment, never from source:

| value | variable | secret? |
|---|---|---|
| project URL (`https://<ref>.supabase.co`) | `PUBLIC_SUPABASE_URL` | no |
| `anon` `public` key | `PUBLIC_SUPABASE_ANON_KEY` | no — publishable by design; row-level security is what protects the data |
| `service_role` key | **nowhere in the app** | **yes** |

`.env.example` lists the two public names and `.env` is gitignored; `vite.config.ts` names the
`PUBLIC_` prefix so Vite hands them to the client. **The service key never ships.** It bypasses
row-level security, so one copy in a bundle is the whole database: it belongs to the payment
webhook's environment and to nothing else, and it is never pasted into a chat, an issue or this
repository. `src/api/identity.ts` refuses to build a client from a key whose own claims say
`service_role`, which turns that mistake into "sign-in does not work in this build" instead of an
incident.

## An account exists only when sync is asked for

`src/api/identity.ts` is the seam: `userId`, `token`, `signIn(provider)`, `signOut()`, plus
`restore()` (storage) and `refresh()` (network). Three implementations — `SupabaseIdentity` (the
real one, the only file in `src/` that names `@supabase/supabase-js`), `FakeIdentity` (the suite),
and `NoIdentity` (a build with no project configured, which refuses by name and works fine).

- **Nothing creates an account at launch.** A local library and a FreshRSS profile both run with
  `userId === null` for the life of the install, and no reading path imports the module. Signing in
  is something a person asks Settings for.
- **No network call on the launch path.** `restore()` reads the token from `localStorage` —
  the same device-key store the session already lives in, one key, `hardlyreader.identity.v1` —
  and stops there. The one call that touches the network is `refresh()`, made when the window is
  returned to and when a sync is about to run. A cold start therefore carries a token that may be
  an hour old, which costs nothing: nothing a reader does with a post needs it.
- **A failed refresh is signed out, not broken.** The record is cleared, one sentence says so, and
  the library, its read state, its stars and the profile's own keys are untouched. Signing out
  removes the identity key and nothing else — a FreshRSS session and a local library both survive it.
- **One identity, one device.** The record is device-level, like the FreshRSS session beside it,
  because a purchase follows the reader; the *library* stays per profile.
