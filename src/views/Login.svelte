<script lang="ts">
  import { untrack } from "svelte";
  import { AuthError, clientLogin, HttpError, normalizeServerUrl } from "../api/freshrss";
  import type { Session } from "../api/freshrss";
  import { tauriTransport } from "../api/freshrss";

  interface Props {
    initialServerUrl?: string;
    onconnected: (session: Session) => void;
  }

  let { initialServerUrl = "http://127.0.0.1:18080", onconnected }: Props = $props();

  let serverUrl = $state(untrack(() => initialServerUrl));
  let email = $state("");
  let apiPassword = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }

    error = null;
    busy = true;

    try {
      const session = await clientLogin(tauriTransport, {
        serverUrl: normalizeServerUrl(serverUrl),
        email: email.trim(),
        apiPassword,
      });
      apiPassword = "";
      onconnected(session);
    } catch (cause) {
      if (cause instanceof AuthError) {
        error = "Wrong email or API password.";
      } else if (cause instanceof HttpError) {
        error = `Server responded with HTTP ${cause.status}.`;
      } else if (cause instanceof Error) {
        error = cause.message;
      } else {
        error = "Login failed.";
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="login">
  <form onsubmit={submit}>
    <h1>Connect to FreshRSS</h1>
    <p class="hint">
      Use the API password from your FreshRSS profile, not your account password.
    </p>

    <label>
      <span>Server URL</span>
      <input
        type="url"
        bind:value={serverUrl}
        placeholder="https://example.com"
        autocomplete="url"
        required
      />
    </label>

    <label>
      <span>Username</span>
      <input type="text" bind:value={email} autocomplete="username" required />
    </label>

    <label>
      <span>API password</span>
      <input type="password" bind:value={apiPassword} autocomplete="current-password" required />
    </label>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <button type="submit" disabled={busy}>
      {busy ? "Connecting…" : "Connect"}
    </button>
  </form>
</div>

<style>
  .login {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  form {
    width: 100%;
    max-width: 26rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  h1 {
    font-size: 1.15rem;
    margin: 0;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  input {
    font: inherit;
    color: var(--text);
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
  }

  input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .error {
    margin: 0;
    color: #c0392b;
    font-size: 0.85rem;
  }

  button {
    font: inherit;
    font-weight: 600;
    padding: 0.55rem 0.75rem;
    border: 0;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
