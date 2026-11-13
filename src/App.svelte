<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { AuthError, userInfo } from "./api/freshrss";
  import { detectProxy } from "./api/hardlyread";
  import type { Session } from "./api/freshrss";
  import { transport } from "./api/transport";
  import { accounts } from "./state/accounts.svelte";
  import { entitlement } from "./state/entitlements.svelte";
  import { identity } from "./api/identity";
  import { layout } from "./state/layout.svelte";
  import { chrome } from "./state/chrome.svelte";
  import { installDragScroll } from "./lib/drag-scroll";
  import { installDeepLinks } from "./lib/deep-link-host";
  import { chooseDeviceLibrary, deviceLibraryChosen } from "./lib/device-library";
  import { reader } from "./state/reader.svelte";
  import { theme } from "./state/theme.svelte";
  import Login from "./views/Login.svelte";
  import Main from "./views/Main.svelte";
  import { applyDemoDefaults, DEMO, DEMO_NOTE, seedDemoLibrary } from "./lib/demo";
  import {
    localStoreOf,
    openLocalProfile,
    syncProfile,
    type LocalProfile,
    type ReaderProfile,
    type SyncProfile,
  } from "./api/profile";

  /**
   * The device shape, published where CSS can see it.
   *
   * `layout.device` is the app's one platform switch — a coarse pointer and a
   * shortest side of 500px or less, from `detectShape()` — and everything that
   * is phone-only hangs off it. Until now it was only readable from TypeScript,
   * so a stylesheet had to guess with a width breakpoint, and a narrow desktop
   * window and a phone looked the same to CSS. This copies the answer onto
   * `<html>` as `data-device`, once, for the whole document.
   *
   * Read inside the effect, so a store that recomputes (a rotation, a resize, a
   * window dragged onto another monitor) re-publishes it. The attribute is set
   * here rather than in a template because it belongs to the document, not to
   * this component's markup: `app.css` keys its phone rules on it, and they have
   * to apply to the login screen too.
   */
  $effect(() => {
    const device = layout.device;
    if (typeof document === "undefined") return;
    document.documentElement.dataset.device = device;
  });

  /**
   * The lock, told to the theme.
   *
   * A picture behind the app can say more than the list in front of it, so a
   * theme can ask for the photograph to be swapped for its plain page while the
   * lock is closed. The theme owns `:root` and the reader owns the lock; this is
   * the one line where they meet, read inside the effect so the swap happens the
   * moment the lock lands and is undone the moment it opens.
   */
  $effect(() => {
    theme.setLocked(reader.hiddenLocked);
  });

  let checking = $state(true);
  /** The demo seeds its library in the boot path; its sidebar is set up once the reader has a
   *  profile, because the pins and the hidden set are the reader's own stores. */
  let demoDefaults = $state(false);

  /**
   * The library on this device.
   *
   * Opened on every launch, not only on the first: it is what the app shows
   * when there is no account, and opening an empty SQLite file costs less than
   * a server probe costs in latency. Nothing about it talks to the network.
   */
  let local = $state<LocalProfile | null>(null);

  /**
   * A device with no account yet, and no library opened.
   *
   * The app used to open the empty library here, so the first screen of a new
   * install was a reader with nothing in it and a connect card one panel away —
   * a device library read as *the* way the app works. Signing in is the
   * suggested way in, and a library on this device is a labelled choice on that
   * screen (owner, 2026-11-05: *"should by default suggest you login to your
   * sync account and be an option you pick to use local mode"*).
   */
  let firstRun = $state(false);

  /**
   * Whether the reader is being unveiled: the login screen stays drawn, over the
   * reader, while it slides up out of the window.
   *
   * The switch to the reader is not delayed — the account is added, `Main` mounts
   * underneath, and what the animation moves is a panel that is already a
   * leftover. That way a slow first load is never hidden behind a spring.
   */
  let unveiling = $state(false);
  let unveilTimer: ReturnType<typeof setTimeout> | null = null;

  /** Long enough to finish `veil-up` in `Login`'s stylesheet, with a margin. */
  const UNVEIL_MS = 900;
  /**
   * The login screen opened from the account panel, rather than by having no
   * session. It signs another account in; the one in use is untouched until it
   * does, and cancelling puts the reader back.
   */
  let adding = $state(false);
  let initialServerUrl = $state("http://127.0.0.1:18080");
  /** Why the login screen appeared on its own, if it did not just start so. */
  let startupNote = $state("");

  /**
   * The account in use, from the store rather than from this component.
   *
   * A switch is a change there, and the reader below is keyed on the token, so a
   * new session is a new mount of everything the old one was showing — which is
   * also what makes the layout, reading and chrome stores re-read their own
   * account.
   */
  const session = $derived(accounts.active);

  /**
   * The profile `Main` is mounted with.
   *
   * A signed-in account wins over the local library, because someone who
   * connected a service meant it. The sync profile is built once per token
   * rather than on every read: a new object each render would re-run every
   * effect in the reader that takes the profile as a dependency.
   */
  let syncCache: SyncProfile | null = null;
  let syncCacheToken = "";
  const profile: ReaderProfile | null = $derived.by(() => {
    if (session === null) return local;
    if (syncCache === null || syncCacheToken !== session.token) {
      syncCache = syncProfile(session);
      syncCacheToken = session.token;
    }
    return syncCache;
  });

  /**
   * How long the stored session gets before the app gives the window back.
   *
   * Waiting forever is what a blank window is made of: a cold WebKit start plus
   * an unreachable server used to leave this screen up indefinitely with nothing
   * saying whether it was working. Nine seconds is longer than a cold start on
   * this machine and short enough that nobody stares at nothing.
   */
  const CHECK_TIMEOUT_MS = 9000;

  /**
   * Removes the subscription's visibility listener.
   *
   * The paid capability is checked once here and again on every return to the
   * window, because a window left open for a week is the normal case on a
   * desktop and the store's answer can change underneath it. The check is not
   * awaited and gates nothing on this screen: cloud sync stays off until an
   * answer says otherwise, which is what a store that is missing or offline has
   * proven.
   */
  let stopWatchingEntitlement: (() => void) | null = null;

  /**
   * Tells the reader whether HardlySyncing is paid for.
   *
   * The reader holds the ladder (`featureAuthority`) and must not know what a
   * receipt is, so the shell joins the two stores: the entitlement in, one
   * boolean out. A build with no store answers `false` like every other question
   * about a purchase, and nothing on a reading path imports the entitlement.
   *
   * Read inside the effect, so a lapse or a restore while the window is open
   * re-resolves every extra on the next paint rather than the next restart.
   */
  $effect(() => {
    reader.paid = entitlement.cloudSync;
  });

  /**
   * Drag the lists and the article with the mouse, like a finger on a phone.
   *
   * Installed here rather than once in `main.ts` because it is a gesture with an
   * off switch: the effect re-runs when the answer changes, and turning the
   * gesture off returns its teardown, so the listener is gone rather than
   * deafened. It finds the scroll container under the pointer itself, so no pane
   * has to opt in.
   */
  $effect(() => {
    if (!chrome.gestures.dragScroll) return;
    return installDragScroll();
  });

  /**
   * Removes the identity's return-to-window listener.
   *
   * The account is the one piece of state this app has that expires while it is
   * open, so the token is renewed when the window comes back — and only then.
   * There is deliberately **no request on this path at launch**: an identity is
   * read from the device's storage when the module loads (no network), and a
   * device with no account installs this listener and refreshes nothing for the
   * whole session. A reader with a local library never meets any of it.
   */
  let stopWatchingIdentity: (() => void) | null = null;
  /** The `hardlyreader://subscribe` listener, for the life of the window. */
  let stopDeepLinks: (() => void) | null = null;

  onMount(async () => {
    stopWatchingEntitlement = entitlement.watch();
    stopWatchingIdentity = identity.watch();

    // The phone's share sheet hands a feed over as `hardlyreader://subscribe`.
    // Registered here rather than in a view because it has to be listening
    // before the first screen decides what to draw: a link that launched the app
    // is the reason the app is running, and the form it asks for is drawn by the
    // sidebar, which is not mounted yet at this point. `chrome.askAddFeed` is a
    // counter, so asking now means the sidebar opens the form when it appears.
    void installDeepLinks((link) => chrome.askAddFeed(link.seed)).then((stop) => {
      stopDeepLinks = stop;
    });

    // Before anything reads the extension state: if the page is served by a host
    // that can forward for the server (the PWA on this box), the adapter's routes
    // are reachable through it. A window with no such host answers nothing and
    // the URLs stay absolute, which is what the desktop app wants anyway.
    //
    // Awaited, not fired and forgotten: the reader's first state read happens a
    // few ticks after this function returns, so a probe still in flight would
    // let that read go absolute — refused cross-origin, and the extension state
    // is then drawn as missing for the whole session. The probe bounds itself
    // (see `detectProxy`), so a host that never answers costs one second here
    // and nothing else.
    await detectProxy();

    const stored = accounts.active;
    if (stored === null) {
      // No account on this device: signing in is what this screen is for, and a
      // library on this device is one press away on it — never a thing that
      // happened to you before you chose it. The demo is the exception: Pages
      // cannot fetch a publisher's RSS across origins, so the sample library is
      // what a visitor opened the demo to see.
      if (!DEMO) {
        // A device that already keeps feeds here is a reader using this device
        // only — or one who chose it and has not added a feed yet. That answer is
        // remembered (`lib/device-library`), so it is not asked for every launch;
        // a library with nothing in it and no answer yet gets the sign-in screen.
        try {
          const opened = await openLocalProfile();
          const feeds = await opened.backend.subscriptions();
          if (deviceLibraryChosen() || feeds.length > 0) {
            local = opened;
            checking = false;
            return;
          }
        } catch (cause) {
          startupNote = `The library on this device could not be opened: ${String(cause)}`;
        }
        firstRun = true;
        checking = false;
        return;
      }
      try {
        // The demo build arrives with a library (`VITE_DEMO=1`, src/lib/demo.ts).
        // Seeded BEFORE the profile is handed to the reader: the reader reads its subscriptions
        // once per profile, so a library filled afterwards would draw as empty until a reload.
        const opened = await openLocalProfile();
        const store = localStoreOf(opened);
        // `BASE_URL` because the demo is served from `/<repo>/`: the baked feeds and their
        // pictures are relative to the page, not to the origin.
        if (store !== null) await seedDemoLibrary(store, undefined, import.meta.env.BASE_URL ?? "/");
        demoDefaults = true;
        local = opened;
      } catch (cause) {
        startupNote = `The library on this device could not be opened: ${String(cause)}`;
      } finally {
        checking = false;
      }
      return;
    }

    initialServerUrl = stored.serverUrl;

    // The wait is bounded on purpose: a server that never answers must land on
    // the login screen, not on a splash that never ends.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tooSlow = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), CHECK_TIMEOUT_MS);
    });

    try {
      const answer = await Promise.race([
        userInfo(transport, stored).then((info) => ({ info })),
        tooSlow,
      ]);

      if (answer !== "timeout") accounts.noteProfile(stored, answer.info);
      else startupNote = `${stored.serverUrl} did not answer in ${Math.round(CHECK_TIMEOUT_MS / 1000)}s — it may be offline.`;
    } catch (cause) {
      if (cause instanceof AuthError) {
        // This account's sign-in is dead. The other accounts on this device are
        // not, so only this one is forgotten.
        startupNote = `${stored.email} on ${stored.serverUrl} is no longer signed in. Add it again below.`;
        accounts.dropActive();
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
      checking = false;
    }
  });

  /**
   * The other way in on the first screen: a library on this device.
   *
   * One press, and only from the screen that offered it — nothing opens a local
   * library behind the reader's back. It says what it is where it is chosen, and
   * the copy on the screen gives the difference in one line, because the two
   * libraries never mix: a feed added here is never sent to a server.
   */
  async function useThisDevice() {
    if (local !== null) return;
    try {
      local = await openLocalProfile();
      chooseDeviceLibrary();
      firstRun = false;
    } catch (cause) {
      startupNote = `The library on this device could not be opened: ${String(cause)}`;
    }
  }

  /** Signed in from the login screen: the first account, or one more of them. */
  function handleConnected(next: Session) {
    unveiling = true;
    accounts.add(next);
    adding = false;
    startupNote = "";

    if (unveilTimer !== null) clearTimeout(unveilTimer);
    unveilTimer = setTimeout(() => {
      unveiling = false;
      unveilTimer = null;
    }, UNVEIL_MS);
  }

  onDestroy(() => {
    stopDeepLinks?.();
    stopDeepLinks = null;
    stopWatchingEntitlement?.();
    stopWatchingEntitlement = null;
    stopWatchingIdentity?.();
    stopWatchingIdentity = null;
    if (unveilTimer !== null) clearTimeout(unveilTimer);
  });

  function addAccount() {
    startupNote = "";
    adding = true;
  }

  function cancelAdd() {
    adding = false;
  }

  function disconnect() {
    accounts.signOut();
  }

  // The demo's sidebar, applied once per browser: a visitor's own pins and hidden set are theirs,
  // and a reload must not undo them.
  $effect(() => {
    if (!DEMO || !demoDefaults) return;
    if (reader.profile === null) return;
    const key = "hardlyreader:demo:sidebar";
    try {
      if (localStorage.getItem(key) !== null) return;
      localStorage.setItem(key, "1");
    } catch {
      return;
    }
    // Three panes with the pair stacked: in a browser window the article sits under the posts
    // rather than beside them, which is the shape that actually fits a tab — the same default the
    // owner picked when he looked at it.
    layout.setMode(3);
    layout.setStacked(true);
    void applyDemoDefaults(reader);
  });
</script>

<!-- The bloom layer behind everything: it belongs to the document, not to any
     screen, so it is drawn once here rather than in each view. -->
<div class="bg-bloom" aria-hidden="true"></div>

<main class="shell" id="content" tabindex="-1">
  <!-- First in the tab order: the reader's own chrome repeats on every screen. -->
  <a class="skip-link" href="#content">Skip to content</a>
  {#if checking}
    <!-- A splash that says nothing reads as a blank window, and a cold start
         here can take seconds before the first request lands. -->
    <div class="status" role="status" aria-live="polite">
      <span class="ring" aria-hidden="true"></span>
      <p class="status-title">Opening your feeds…</p>
      {#if initialServerUrl}
        <p class="status-server">{initialServerUrl}</p>
      {/if}
      <p class="status-hint">Signing in with the session saved on this device.</p>
    </div>
  {:else}
    {#if DEMO}
      <div class="demo-banner" role="note">{DEMO_NOTE}</div>
    {/if}
    {#if profile && !adding}
      {#key profile.slug + (session?.token ?? "")}
        <Main
          {profile}
          account={accounts.profile}
          onsignout={disconnect}
          onaddaccount={addAccount}
          onconnect={addAccount}
        />
      {/key}
    {/if}

    <!-- Drawn over the reader until the slide is over. The block stays rendered
         across the switch — it is the same panel gaining a class — which is what
         lets it animate out instead of disappearing. -->
    {#if !(profile && !adding) || unveiling}
      <div
        class="veil"
        class:unveiling
        inert={unveiling ? true : undefined}
        aria-hidden={unveiling ? "true" : undefined}
      >
        <Login
          {initialServerUrl}
          notice={adding
            ? "Signing in here adds an account. The one already on this device stays."
            : startupNote}
          onconnected={handleConnected}
          oncancel={adding ? cancelAdd : undefined}
          onlocal={firstRun ? () => void useThisDevice() : undefined}
        />
      </div>
    {/if}
  {/if}
</main>

<style>
  .demo-banner {
    position: fixed;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    z-index: 60;
    padding: 6px 12px;
    border-radius: 999px;
    background: var(--panel, #16181d);
    color: var(--text-dim);
    border: 1px solid var(--border-soft);
    font-size: 0.85em;
    pointer-events: none;
  }

  .skip-link {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: 100;
    transform: translate(-50%, -120%);
    padding: 10px 16px;
    border-radius: 0 0 10px 10px;
    background: var(--text);
    color: var(--bg);
    font-size: 0.9rem;
    font-weight: 600;
    text-decoration: none;
  }
  .skip-link:focus-visible {
    transform: translate(-50%, 0);
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .shell {
    height: 100%;
    min-height: 0;
  }

  /* The login screen is a layer of its own rather than a branch of this one, so
     that it can leave over the reader instead of being swapped for it. */
  .veil {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--bg);
    overflow: auto;
  }

  .veil.unveiling {
    pointer-events: none;
    animation: veil-up 820ms linear both;
  }

  /* Up, an elastic settle back, then out the top.
   *
   * A single ease would read as a wipe; the bounce is the part that says the
   * panel had weight. Positions are the whole gesture: the timing functions
   * only decide how each leg of it travels. */
  @keyframes veil-up {
    0% {
      transform: translateY(0);
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    26% {
      transform: translateY(-15%);
      animation-timing-function: cubic-bezier(0.28, 1.7, 0.5, 1);
    }
    44% {
      transform: translateY(-9%);
      animation-timing-function: cubic-bezier(0.5, 0, 0.7, 0.6);
    }
    56% {
      transform: translateY(-15%);
      animation-timing-function: cubic-bezier(0.62, 0.02, 0.86, 0.42);
    }
    100% {
      transform: translateY(-100%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .veil.unveiling {
      animation: veil-fade 180ms ease both;
    }

    @keyframes veil-fade {
      to {
        opacity: 0;
      }
    }
  }

  /* Centred, because the middle of the window is where you look when you are
     wondering whether anything is happening. */
  .status {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 100%;
    padding: 1rem;
    text-align: center;
    color: var(--muted);
  }

  .status-title {
    margin: 0;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }

  .status-server {
    margin: 0;
    color: var(--text-dim);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .status-hint {
    margin: 0;
    color: var(--muted);
    font-size: 11px;
  }

  /* One ring that turns: motion is the difference between "working" and
     "stuck", and it stops entirely for anyone who asked for less motion. */
  .ring {
    width: 18px;
    height: 18px;
    margin-bottom: 2px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: hr-spin 780ms linear infinite;
  }

  @keyframes hr-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ring {
      animation: none;
      border-top-color: var(--border);
      border-left-color: var(--accent);
    }
  }
</style>
