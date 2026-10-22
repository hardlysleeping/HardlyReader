<script lang="ts">
  import { onMount } from "svelte";
  import { AuthError, tauriTransport, userInfo } from "./api/freshrss";
  import type { Session, UserInfo } from "./api/freshrss";
  import { clearSession, loadSession, saveSession } from "./api/session";
  import Login from "./views/Login.svelte";

  type Phase = "checking" | "login" | "ready";

  let phase = $state<Phase>("checking");
  let session = $state<Session | null>(null);
  let account = $state<UserInfo | null>(null);
  let initialServerUrl = $state("http://127.0.0.1:18080");

  onMount(async () => {
    const stored = loadSession();
    if (stored === null) {
      phase = "login";
      return;
    }

    initialServerUrl = stored.serverUrl;

    try {
      account = await userInfo(tauriTransport, stored);
      session = stored;
      phase = "ready";
    } catch (cause) {
      if (cause instanceof AuthError) {
        clearSession();
      }
      phase = "login";
    }
  });

  function handleConnected(next: Session) {
    saveSession(next);
    session = next;
    account = null;
    phase = "ready";

    void userInfo(tauriTransport, next)
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
  <header>
    <h1>Hardly Read</h1>
    {#if phase === "ready" && session}
      <span class="meta">{account?.userName ?? session.email} · {session.serverUrl}</span>
      <button type="button" onclick={disconnect}>Disconnect</button>
    {/if}
  </header>

  <div class="body">
    {#if phase === "checking"}
      <p class="status">Checking stored session…</p>
    {:else if phase === "login"}
      <Login {initialServerUrl} onconnected={handleConnected} />
    {:else}
      <section class="placeholder">
        <p>Connected.</p>
        <p class="muted">Feeds and articles arrive in the next commits.</p>
      </section>
    {/if}
  </div>
</main>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0 1rem;
    height: 48px;
    flex: 0 0 48px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-alt);
  }

  h1 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
  }

  .meta {
    color: var(--muted);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-left: auto;
  }

  header button {
    font: inherit;
    font-size: 0.8rem;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
  }

  .body {
    flex: 1;
    min-height: 0;
  }

  .status {
    padding: 1rem;
    color: var(--muted);
    font-size: 0.85rem;
  }

  .placeholder {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    text-align: center;
    padding: 1rem;
  }

  .placeholder p {
    margin: 0;
  }

  .muted {
    color: var(--muted);
    font-size: 0.875rem;
  }
</style>
