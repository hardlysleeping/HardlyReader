# Accounts and entitlements

Owner decision, 2026-10-27. Two separate questions, and they must stay separate:

1. **Who is this reader?** — an identity, so one purchase unlocks a second device.
2. **Do they own HardlySyncing right now?** — an entitlement, which only a server may set.

Neither question has anything to do with where the library lives. Feeds, articles, read state and
stars stay in SQLite, in FreshRSS, or in the reader's own cloud folder. This document's server
answers one sentence: *who is this, and do they currently own Sync.*

**The entitlement is per account, not per app.** `entitlements` is keyed by `user_id` and carries one
boolean, so a purchase made from any app that reads this project unlocks in every one of them —
HardlyReader today, HardlyTracking when it grows a client for it. That is why there is no column
naming a product or an app: a second column would be a way for a paying reader to be locked out of
the second app, and two rows kept in step by hand. The one per-app thing is where a purchase *comes
back to*: checkout takes the origin of the app that asked, and the service accepts it only when it is
one it serves (`APP_URL` plus `APP_ORIGINS`). One Stripe product, two prices, one webhook, one row.

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

### How the app asks

One `GET`, at launch and again whenever the window comes back:

```
GET /rest/v1/entitlements?select=cloud_sync,expires_at&user_id=eq.<auth.uid()>&limit=1
Authorization: Bearer <the reader's JWT>
apikey: <the publishable key>
```

`src/state/entitlements.svelte.ts` holds the only code that talks to this table (`RemoteStore`),
and five details are the difference between a capability and a wish:

- **`source` is not even selected.** A row records that someone owns Sync. Which provider took the
  money is the webhook's business, and a column that is never fetched cannot start a branch in the
  UI six months from now.
- **A row has no price, so the answer has none.** The two prices buy the same `cloud_sync`; the app
  reports the capability and never guesses "monthly" from a boolean.
- **The last answer is cached per user id** — `hardlyreader.entitlement.v1.<user id>` — so an
  offline launch keeps a paying reader working. The cached answer is re-read against the calendar,
  so it stops granting at `expires_at`: a plane is not a free month, and a device carried offline
  past the renewal date pauses like any other.
- **A failure is `none`.** A 500, a timeout, an answer that is not a list, a device with no session:
  cloud sync off, the local library untouched, and the sentence says which. With one exception that
  is the point of the cache — a transient failure (no network, 5xx, 429) is answered from this
  reader's own last answer if they have one.
- **A refused credential is not a cached grant.** A 401/403 means the server disowned the session:
  that is `none`, and the cache is deliberately not consulted. Signing in again is the fix, and it
  is the same answer for every device that holds an old token.

None of that is the protection, only the manners: the database refuses a client write on its own,
because the table has a `select` policy and no other. `tests/unit/entitlement-source.mjs` holds
both halves — that the client issues nothing but a `GET`, and that the SQL stays select-only — so
"a client cannot set this flag" is a test rather than a hope.

The session it presents is the one `supabase-js` leaves in this device's storage
(`sb-<project-ref>-auth-token`), and there is deliberately no second place to look. Until the
sign-in screen exists, no such value is written, so the store reads `none` and the app says so —
which is the correct answer for a device that cannot prove who it is, not a placeholder for one.

Buying is the other half and does not touch any of this: `api/billing.ts` composes this reader
into a `WebStore` whose `purchase()` only opens a Checkout page and answers *"not bought yet"*.
The press grants nothing; the webhook's write is what the next read sees.

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

## One person, one account

Two traps, one shape. Trap 5 — *two accounts, one person, two subscriptions* — is what happens when
signing in with Apple and then with Google creates a second `auth.users` row: the purchase is attached
to the first row, and the app has to tell a paying reader they have no subscription. Trap 18 — *account
deletion taking iCloud/Drive data with it* — is what happens when "delete my account" is read as
"delete everything". Neither is a feature; both are a rule about what the app may not do.

**Linking is the first half.** `Identity.link(provider)` in `src/api/identity.ts`:

- with an account already on the device, `linkIdentity` adds Google or Apple to **that** user, and
  `updateUser({ email })` changes the address the account answers to (confirmed from both inboxes);
- with no account, `link()` refuses in one sentence — there is nothing to add a door to;
- a provider refusal rejects, because the sheet that started it has somewhere to show the reason.

The row never moves, which is the whole guarantee: `entitlements.user_id` is the primary key of the
auth user, so identity linking leaves it alone and the entitlement is the same row it was. And the app
cannot create a second one: there is no write policy on `entitlements`, so the worst a client can do is
read.

**A second sign-in is refused, in the seam.** `StoredIdentity.signIn()` starts with
`refuseASecondAccount()`: signed in with Google and pressing Apple does not sign in again — it says
*"This device is already signed in. Add Apple to the account you have instead of signing in again"*.
Same door again is allowed (that is re-authenticating the account that is here). The refusal is in the
base class rather than in a screen, so no new sheet can forget it.

**Two settings in the project, not in this repository**, both in Dashboard → Authentication:

| setting | why |
|---|---|
| **Link identities with the same email** (automatic linking) | a reader who signs in with Apple on a phone after paying with Google lands on the account that owns Sync, instead of a fresh one with no subscription |
| **Manual linking** | `linkIdentity()` is refused without it; the app then shows the provider's refusal rather than silently creating an account |

**What the reader sees after linking** is the same subscription, including offline: the cached answer is
keyed `hardlyreader.entitlement.v1.<user id>`, and the id is the part that did not change.
`tests/unit/account.mjs` drives exactly that — pay with Google, link Apple, read the subscription again
with the network switched off.

## Devices, and revoking one

An account can be signed in more than once, so `public.account_devices` holds **one row per session**,
keyed by the `auth.sessions` row. That id is in every access token's `session_id` claim, which is how a
device recognises its own row without asking the server who it is (`sessionIdOf`).

The three calls (`src/api/account.ts`) and what each one may touch:

| call | what it does | what it cannot touch |
|---|---|---|
| `registerDevice` → `rpc/register_device` | writes this device's own row, session id from the token, label and platform from the caller | any other session: the insert policy pins `session_id` to the caller's claim |
| `listDevices` → `GET account_devices` | the reader's own rows, newest first, the asking device marked | anyone else's rows: the policy is `user_id = auth.uid()` |
| `revokeDevice` → `rpc/revoke_device` | deletes that session's refresh tokens and its `auth.sessions` row | a library, an entitlement or a provider file — none of them is in this database |

**Revoking is ending a session, and that is what signs the device out.** The refresh token is gone, so
that device's next `refresh()` fails, and `refresh()` already means *signed out, library untouched*.
Two details worth keeping in mind:

- **A stale access token stays valid until it expires.** That is what a stateless JWT is. Nothing in
  this app acts on one without asking the server first — sync, the entitlement and the device list all
  make a request — so the window is bounded by the token's own lifetime, not by our promises.
- **`signOut()` passes `scope: "local"`.** `supabase-js` defaults to `global`, which revokes *every*
  session the reader has: signing out on the phone would sign out the desktop, and the device list
  would never have a second row to revoke. One option is the difference.

The list is drawn in Settings → **Account** (`src/components/CloudAccountPanel.svelte`, over
`src/state/cloud-account.svelte.ts`), one row per session: the label, the platform, when it was last
seen, and **This device** on the row the token's `session_id` claim names. Revoking another device
says `DEVICE_REVOKED`; revoking this one says `REVOKE_THIS_DEVICE` and *then* signs this device out
locally, which is what makes the sentence true. `tests/unit/cloud-account.mjs` drives both, and
`tests/unit/account-panel.mjs` holds the markup.

`registerDevice` is called **once per sign-in**, with `describeDevice(navigator.userAgent)`: at the
moment a sign-in completes, and never on a launch that is already registered —
`lib/account-device.ts` keeps the session id it registered under, so a reload asks the server nothing
and a registration that failed is retried the next time the section is opened, rather than the device
being missing from its own list forever.

## Deleting an account

One call — `deleteAccount()` → `rpc/delete_my_account()` — and one row: the `auth.users` row. Everything
else on the server goes with it by cascade, which is why the schema declared
`references auth.users (id) on delete cascade` in the first place: the `entitlements` row, the Stripe
customer link, the sessions and therefore the device rows.

Three things it deliberately does not do:

1. **It does not touch the reader's library.** `src/api/account.ts` imports nothing from `api/local/` or
   `state/` and holds no key store, so there is no path from a deletion to a post. The suite proves it
   the way it can be proved: a real local library is opened before the deletion and read back after it,
   with the same titles, the same count and the same local ids.
2. **It does not touch a provider's files.** No iCloud, Drive, Dropbox or OneDrive is named anywhere on
   this path, and the SQL deletes from `auth` only. The reader's folder is theirs: HardlyReader put
   files in it, and a support request is not permission to take them away.
3. **It does not delete an account that is still being charged.** The function returns `cancel_first`
   while the row says a paid subscription is live, because deleting the identity leaves Stripe charging
   a card for an account no webhook can name. The reader cancels at the payment provider first; the app
   says so in `CANCEL_FIRST` and changes nothing.

**If they want the files gone, that is a second action, with its own wording.** `PROVIDER_FILES_ACTION`
and `PROVIDER_FILES_WARNING` are written and held now; the button arrives with the first provider
(`t_63abddf5`, `t_af52a063`), because until there is a provider there is nothing to delete and a button
that cannot do its work is worse than no button. Its wording says what it is not: not the account, not
the library on this device, not the rest of the folder.

After a deletion the device signs itself out locally — `identity.signOut()`, a storage clear — and the
reader keeps reading.

**The refusal has somewhere to go.** `CANCEL_FIRST` used to point only at a receipt in an inbox,
because `server/billing/` had no way to reach a subscription. It now has `POST /portal`: the same
JWT-in pattern as `/checkout`, the customer read from the link table (never from the request), and
Stripe's own billing portal returned as a URL the app opens outside itself. So a refused deletion
offers **Manage subscription** and the reader cancels where the card is; pressing delete again then
works. The SQL is untouched — an account that is still charging is still refused.

## The surface: Settings → Account

One section, one component, and its four states are the four paragraphs above
(`src/components/CloudAccountPanel.svelte`, decisions in `src/state/cloud-account.svelte.ts`):

| state | what is drawn |
|---|---|
| signed out | the three doors — Google, Apple, and an address for an emailed link — one button each, after one sentence saying the library on this device needs no account |
| signed in | "Signed in with Google", **Add Apple** for each door the account *does not* have, and a change of address. The add buttons call `link()`; there is no second sign-in on the screen at all |
| devices | one row per session, **This device** marked, and one Revoke each |
| deleting | two presses. `deleted` → sign out and `ACCOUNT_DELETED`; `cancel_first` → `CANCEL_FIRST` plus the way to the payment portal, and nothing changed |

Two things are deliberately absent, and a suite holds both: **no "also delete my cloud files"
checkbox** (`tests/unit/account-panel.mjs` asserts `PROVIDER_FILES_ACTION`'s text and any checkbox are
nowhere in the markup), and **no `signIn()` while signed in** (`tests/unit/cloud-account.mjs` asserts
one `signIn:` call for the whole session, however many doors are added).

The section reconciles one thing nothing else can: a session that arrived on the redirect back from a
provider was written by `supabase-js`'s own `detectSessionInUrl` *after* this app read its storage, so
`refresh()` with no record is a storage read that adopts it — asked for when the section is opened,
never on the launch path.
