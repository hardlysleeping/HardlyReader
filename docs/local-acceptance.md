# Local mode, end to end

The acceptance list is one sentence: **launch → add a feed / import OPML →
refresh → read → star → mark read → quit → reopen → everything is still there**,
with no server anywhere. Half of it can be run by a machine and half cannot, so
there are two passes here: the script, and the two minutes on a phone.

## 1. The script

```bash
pnpm test:acceptance
```

It runs the whole list against the app's own SQLite engine — `openLocalProfile`
→ `SqliteDatabase`, the real `CREATE TABLE`, the real upserts, the real
transactions — on a real file in a temporary directory, with the reader's real
state object driving it. The feeds are served over real HTTP on `127.0.0.1`, so
the fetch, the parse and the store write are the ones the app runs. Only the
Tauri SQL plugin's IPC link is replaced (`connect`), because a Node process has
no Rust behind it.

It prints each step as it goes and refuses to be quiet about anything:

```
1. launch — a fresh install, no account
2. add feed — the + Add feed form
3. import OPML — two folders, a feed in each
4. refresh — an hour later, one new article
5. read — open the article that just arrived
6. star — the row control
7. mark read — the reader's own control
8. quit — the database is closed
9. reopen — a new handle on the same file
```

The last two lines are `ran: 1. launch → … → 9. reopen` and
`51/51 checks passed`. A run that loses the library between the quit and the
reopen fails about twenty of those checks, which is how the durability claims
are known to bite rather than merely exist.

## 2. The two minutes on a phone

Same list, by thumb, in the browser build (`pnpm dev --host`, then open the LAN
address on the phone and Add to Home Screen). This is the pass for the engine
the script does not use: a tab has IndexedDB, not SQLite, and IndexedDB is the
one the OS is allowed to throw away.

| # | Do this | Look for |
|---|---|---|
| 1 | Open the app with no account saved | The library opens straight away. No sign-in, no server URL, no spinner that ends in an error. |
| 2 | **+ Add feed**, paste a real feed URL, add | The feed appears in the sidebar by its own name and its posts arrive without pressing anything else. |
| 3 | Pick a real OPML file with **Import OPML** — the sidebar footer says **Import**, Settings says **Import feeds** | The folders in the file appear **as folders**, each feed inside its own — not all feeds flat in the sidebar. |
| 4 | Wait, or pull the header to refresh | The refresh finishes; a site that published in the meantime gains posts. |
| 5 | Tap a post, read it, then **Mark read** | The post leaves the unread count. |
| 6 | Tap the **star** on a row | The star fills, and **Starred** in the sidebar holds that post. |
| 7 | Swipe the app away — really kill it, not just background it — then reopen | Everything is still there: three feeds, both folders, the read post still read, the starred post still starred, the post's text still readable. |
| 8 | Settings → **Export feeds** | The OPML it writes holds the folders and the feeds, which is the round trip the import half of the script proves for the store. |

If step 7 comes back empty, that is the bug this list exists to catch, and the
engine under it is IndexedDB: check `Storage` in the phone's browser settings
for the site before assuming the app lost anything.

## 3. What neither pass can prove

Written down so nobody reads a green run as more than it is.

- **The app being killed by iOS.** The script closes the database in order:
  `close()` runs, SQLite commits, the file is whole. A jetsam kill mid-write, a
  low-power background wake, or a crash after a tap is a different event and only
  a phone produces it. Step 7 of the manual pass is the only thing that covers
  it, and it covers it by doing it.
- **IndexedDB eviction under storage pressure.** The browser engine can lose its
  database with no error to catch — Safari decides, not the app. The script runs
  on SQLite; the phone pass runs on IndexedDB but only proves it survives a
  kill, not that Safari will always keep it. Nothing in the app can prevent
  this; the answer is the export and device sync, not a test.
- **The Tauri SQL plugin itself.** `connect` is the seam. That the plugin binds
  `$1` placeholders over IPC and resolves `sqlite:hardlyreader.db` under the
  app's data directory is proven by the desktop app launching and showing a
  library, not by this script.
- **The taps.** The script drives the reader state, not the DOM. That a thumb on
  a star reaches `reader.toggleStar` is `tests/unit/phone-*.mjs` and the manual
  pass.
- **Real feeds.** The fixtures are three well-formed RSS documents on localhost.
  A real site's malformed date, redirect chain or 300 MB image is the poller's
  and the parser's problem, and they have their own suites.
