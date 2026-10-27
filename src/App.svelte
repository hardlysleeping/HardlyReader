<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { AuthError, userInfo } from "./api/freshrss";
  import type { Session } from "./api/freshrss";
  import { transport } from "./api/transport";
  import { accounts } from "./state/accounts.svelte";
  import { layout } from "./state/layout.svelte";
  import Login from "./views/Login.svelte";
  import Main from "./views/Main.svelte";
  import {
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

  let checking = $state(true);

  /**
   * The library on this device.
   *
   * Opened on every launch, not only on the first: it is what the app shows
   * when there is no account, and opening an empty SQLite file costs less than
   * a server probe costs in latency. Nothing about it talks to the network.
   */
  let local = $state<LocalProfile | null>(null);

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

  onMount(async () => {
    const stored = accounts.active;
    if (stored === null) {
      // No account on this device: that is not an error and not a reason to
      // ask for a server URL. The reader opens on the empty local library, and
      // connecting a service stays one optional step away.
      try {
        local = await openLocalProfile();
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
</script>

<main class="shell">
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
        />
      </div>
    {/if}
  {/if}
</main>

<style>
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
