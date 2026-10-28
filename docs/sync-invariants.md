# Sync invariants

The owner's list of traps, each checked against the code rather than assumed. Status means: **held**
— the engine already does it, with the file named; **card** — a real gap, tracked; **decision** —
needs the owner's call before it is code.

The five things that must be solid before a provider exists: per-feature authority, canonical data,
conflict and tombstone rules, identity and entitlement, and the provider interface. All five are in
place: a feed is identified by the address it finally answers at, with the address it was subscribed
at kept as a redirect, so a move cannot become a second subscription.

| # | trap | status | where |
|---|---|---|---|
| 1 | multiple authorities fighting over one field | **held** | `src/lib/capabilities.ts` resolves one authority per feature; `docs/authority.md` |
| 2 | one conflict rule for everything | **held** | `sync.ts`: read and starred are separate registers with their own stamps; ordering is one record, not interleaved indexes; prefs last-modified |
| 3 | deletions resurrected by an offline device | **held** | tombstones (`SyncedFeed.removed`, `TOMBSTONE_SECONDS`), and only a device that has *seen* one may re-subscribe |
| 4 | provider switching losing either side | **card** `t_c9457710` | pull → merge → write → verify → switch, never "connect and hope" |
| 5 | two accounts, one person, two subscriptions | **held** | `Identity.link()` in `src/api/identity.ts` adds a door to the account already signed in (`linkIdentity`, `updateUser`), and `signIn()` refuses a second door rather than creating a second `auth.users` row — so the entitlement row, keyed by that id, is the same row. `tests/unit/account.mjs` (pay with Google, link Apple, read the subscription offline), `tests/unit/identity.mjs`, and `tests/unit/cloud-account.mjs` (one `signIn:` call however many doors are added) |
| 6 | expiry locking someone's data | **held** | expiry pauses sync only; `docs/accounts-and-entitlements.md`, rule 5 |
| 7 | purchase source leaking into app logic | **held** | one `cloudSync`; `source` is a column nothing reads (`supabase/schema.sql`) |
| 8 | provider token expiring into a silent failure | **card** `t_af52a063` (folded in) | must degrade to *Reconnect Google Drive*, not "sync failed" forever |
| 9 | iCloud promised where it cannot work | **held** | `docs/accounts-and-entitlements.md` platform matrix; UI wording card `t_63abddf5` |
| 10 | quotas and rate limits | **held** | the document is small by design: no article bodies, no images, no extraction results; `docs/local-sync.md` |
| 11 | the same feed under a redirected URL | **held** | `LocalStore.followRedirect` moves the key, the articles and their marks; `redirects` carries the old address so the other device follows; `followRedirects` re-keys the document. `tests/unit/feed-identity.mjs` |
| 12 | messy GUIDs rebuilt differently per device | **held** | `localItemId` is one derivation shared by both devices, over the feed's canonical key; a feed that changes its guid scheme has the old row marked `superseded_by` rather than stored twice, and the marks move to the new row |
| 13 | hard-coding "Miniflux supports X" | **held** | `ReaderBackend.capabilities`, declared per backend; undeclared means plain GReader |
| 14 | an old extension supporting a part of the state | **held, one gap** | `ADAPTER_ROUTES` in `src/lib/capabilities.ts`: `apiVersion` on `/v1/state` decides which extended routes exist, so an adapter that reports no version claims nothing instead of answering `404` later; `capabilitiesFromState`. The gap: `API_VERSION` was never bumped when the arrangement and preferences routes arrived, so a v1 copy from before them and a v1 copy with them look identical. The reading position is in no row at all — `/v1/positions` is the arrangement and `/v1/preferences` is settings, so the FreshRSS declaration says `false` and the place is `lib/place`, per account, on the device |
| 15 | local → FreshRSS silently merging libraries | **decision** `t_e43fdb0e` | two profiles, explicit import, never a silent merge |
| 16 | a temporarily missing extension treated as unsupported | **held** | `probeCapabilities` (`src/api/hardlyread.ts`) answers `unknown` for a `5xx`, a timeout, an offline socket or a `401`; `remember` + `resolveAuthority` keep the last good read, so `unknown` never moves a feature to the cloud — `tests/unit/capabilities.mjs` |
| 17 | reading history and hidden categories in a provider's file | **decision** `t_fbca0887` | client-side encryption before this grows |
| 18 | account deletion taking iCloud/Drive data with it | **held** | `deleteAccount()` in `src/api/account.ts` reaches no provider and no library at all, and `public.delete_my_account()` in `supabase/schema.sql` deletes one `auth.users` row and refuses while a subscription is still charging. The files are a second action with its own wording (`PROVIDER_FILES_ACTION`), arriving with the first provider — and the settings surface draws no such control (`tests/unit/account-panel.mjs`). `tests/unit/account.mjs` |
| 19 | clock skew deciding conflicts | **held** | a record is ordered by `(at, rev, by)` — `compareStamps` in `sync.ts` documents the tie-break — and no change is dated earlier than `max(seen) + 1`, so an edit made after seeing a copy outranks it whatever the clocks say. The id and the revision counter live in the library's `meta` rows. `tests/unit/local-sync.mjs` |
| 20 | a sync that bounces forever | **held** | `sameContent` ignores only `device` and `writtenAt`, so a merge that changed nothing writes nothing; `tests/unit/local-sync.mjs` syncs A → B → A and asserts the folder is byte-identical, nothing is applied twice, and only the copy's own `writtenAt` moved |
| 21 | browser-local failing where native-local does not | **held** | same `ReaderBackend`, different transport; `docs/hosting.md` states the CORS difference |
| 22 | no way to test any of this before iCloud | **held, extend** | `MemorySyncProvider` exists; the scenario suite is `t_bbf90b66` |

## The five that matter, restated

1. **Per-feature authority** — `src/lib/capabilities.ts`, up to three layers (backend → cloud →
   local), never two writers for one field.
2. **Canonical data** — `SyncSnapshot`: feeds, folders, marks, prefs, sidebar, place. Small on
   purpose; bodies and images never travel.
3. **Conflict and tombstones** — three-way merge against a remembered base, separate read/star
   registers, whole-record ordering by `(at, rev, by)` rather than by a clock, tombstones with a
   retention window.
4. **Identity and entitlement** — `supabase/schema.sql` for who may claim sync; the feed's canonical
   key and `localItemId` for what an article is, with a move kept as a redirect rather than a second
   subscription. The second half is where #11 and #19 bite.
5. **Provider interface** — `SyncProvider` (read/write/describe). A provider is storage; it must
   never see a feature, a rule, or an entitlement.

## What "held" is allowed to mean

A row marked held is a claim about a file and a suite, not a belief. If a change makes one of them
false, the change has to say so and this table gets updated in the same commit — the same rule as
`docs/authority.md`.
