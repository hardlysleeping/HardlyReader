# One authority at a time

HardlyReader is one app with two kinds of profile, and the same features in both. What
differs is **who is authoritative** for the state behind a feature, and that difference is
the rule everything else follows.

```
FreshRSS profile                 Local profile
─────────────────                ─────────────
FreshRSS + its extensions        the local database
are authoritative                is authoritative
        │                                 │
        │  free                           │  optional paid cloud provider
        ▼                                 ▼
no billing, ever                 HardlyReader Sync (iCloud / Drive / Dropbox / OneDrive)
```

**A profile has exactly one authority.** Two writers for the same hidden category, pin or
read mark is not a feature, it is a conflict generator: the server says hidden, the cloud
says revealed, and whichever ran last wins on a device nobody is looking at.

So: a FreshRSS profile never writes its hidden/pinned/read state to a cloud provider, and a
local profile never writes it to a FreshRSS server. The paid tier is a property of the
*local* profile only. Free FreshRSS users keep every feature and keep syncing it through
FreshRSS exactly as today, and nothing about billing touches that path.

## The same features, two storage adapters

Internally these are HardlyReader features with two adapters, not "FreshRSS features":

| Feature | FreshRSS adapter | Local adapter |
|---|---|---|
| Feeds, folders, ordering | FreshRSS subscription API | local SQLite + cloud snapshot |
| Read / unread | GReader state | local DB + cloud snapshot |
| Stars | GReader state | local DB + cloud snapshot |
| Hidden categories | `xExtension-HiddenCategories` | local hidden state → cloud snapshot |
| Pinned categories | `xExtension-FavoriteCategories` | local pins → cloud snapshot |
| Hidden view / revealed | extension `view` | local view → cloud snapshot |
| Sidebar indent | `xExtension-HardlyRead` | local preference → cloud snapshot |
| Reading, layout, theme | extension prefs doc, local fallback | local prefs doc → cloud snapshot |
| Reading position | extension positions, local fallback | local place → cloud snapshot |
| Lock / passcode | extension routes | local lock, carried in the snapshot |

The repo already works this way in part: `hiddenScope` / `authorityOf` in
`src/state/hidden.ts` pick the extension when it answers and fall back to the device
otherwise, and `savePrefs` writes the same document (pins, hidden, collapsed, indent,
order, categoryOrder, positions) whether the authority is a server or the device. Cloud
sync extends the local side of that; it does not add a third authority.

## What is genuinely server-only

Server enforcement cannot travel: the HiddenCategories extension changes what the FreshRSS
*website* shows, and there is no website to change in local mode. Local mode reproduces the
behaviour across HardlyReader devices and says so — it does not pretend to hide a category
on a server it is not using.

## Checks that keep it honest

1. With a FreshRSS profile, the sync provider is never constructed and no cloud file is
   written; grep the code paths, not just the UI.
2. With a local profile, the snapshot carries hidden, pins, view, indent, ordering and
   position — a device that syncs and then reopens has the same sidebar it left.
3. Switching profile never migrates state silently: connecting FreshRSS does not upload the
   local library to it, and signing out of FreshRSS does not import its hidden state into
   the local one.
4. Nothing on the FreshRSS path consults an entitlement. `cloudSync` gates the cloud
   provider only.
