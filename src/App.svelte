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

  onMount(async () => {
    const stored = loadSession();
    if (stored === null) {
      phase = "login";
      return;
    }

    initialServerUrl = stored.serverUrl;

    try {
      account = await userInfo(transport, stored);
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
    <p class="status">Checking stored session…</p>
  {:else if phase === "login"}
    <Login {initialServerUrl} onconnected={handleConnected} />
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

  .status {
    padding: 1rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
