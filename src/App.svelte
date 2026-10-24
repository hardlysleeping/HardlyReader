<script lang="ts">
  import { onMount } from "svelte";
  import { AuthError, userInfo } from "./api/freshrss";
  import type { Session, UserInfo } from "./api/freshrss";
  import { clearSession, loadSession, saveSession } from "./api/session";
  import { transport } from "./api/transport";
  import Login from "./views/Login.svelte";
  import Main from "./views/Main.svelte";

  type Phase = "checking" | "login" | "ready";

  let phase = $state<Phase>("checking");
  let session = $state<Session | null>(null);
  let account = $state<UserInfo | null>(null);
  let initialServerUrl = $state("http://127.0.0.1:18080");
  /** Why the login screen appeared on its own, if it did not just start so. */
  let startupNote = $state("");
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
    const stored = loadSession();
    if (stored === null) {
      phase = "login";
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

      if (answer === "timeout") {
        startupNote = `${stored.serverUrl} did not answer in ${Math.round(CHECK_TIMEOUT_MS / 1000)}s — it may be offline.`;
        phase = "login";
        return;
      }

      account = answer.info;
      session = stored;
      phase = "ready";
    } catch (cause) {
      if (cause instanceof AuthError) {
        clearSession();
      }
      phase = "login";
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  });

  function handleConnected(next: Session) {
    saveSession(next);
    session = next;
    account = null;
    phase = "ready";

    void userInfo(transport, next)
      .then((info) => {
        account = info;
      })
      .catch(() => {
        /* details are not needed by the shell */
      });
  }

  function disconnect() {
    clearSession();
    session = null;
    account = null;
    phase = "login";
  }
</script>

<main class="shell">
  {#if phase === "checking"}
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
  {:else if phase === "login"}
    <Login {initialServerUrl} notice={startupNote} onconnected={handleConnected} />
  {:else if session}
    {#key session.token}
      <Main {session} {account} onsignout={disconnect} />
    {/key}
  {/if}
</main>

<style>
  .shell {
    height: 100%;
    min-height: 0;
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
