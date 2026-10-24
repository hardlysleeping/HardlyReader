<script lang="ts">
  import { untrack } from "svelte";
  import { AuthError, GreaderProbeError, probeGreaderSession } from "../api/freshrss";
  import type { Session } from "../api/freshrss";
  import { transport } from "../api/transport";

  interface Props {
    initialServerUrl?: string;
    /** Why this screen appeared without the reader asking for it. */
    notice?: string;
    onconnected: (session: Session) => void;
  }

  let { initialServerUrl = "http://127.0.0.1:18080", notice = "", onconnected }: Props = $props();

  let serverUrl = $state(untrack(() => initialServerUrl));
  let email = $state("");
  let apiPassword = $state("");
  let busy = $state(false);
  let showPassword = $state(false);
  let error = $state<string | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }

    error = null;
    busy = true;

    try {
      // One field, one exchange: whichever prefix answers `user-info` is the one
      // saved, and nothing downstream cares which product that turned out to be.
      const session = await probeGreaderSession(transport, {
        serverUrl,
        email: email.trim(),
        apiPassword,
      });
      apiPassword = "";
      onconnected(session);
    } catch (cause) {
      if (cause instanceof AuthError) {
        error = "Wrong email or API password.";
      } else if (cause instanceof GreaderProbeError) {
        error = cause.message;
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
    <h1>Connect to your reader</h1>
    <p class="hint">
      FreshRSS: use the API password from your profile, not your account password.
      Miniflux, Tiny Tiny RSS, The Old Reader and Inoreader work too — paste the
      server URL, and the API path if you know it.
    </p>
    {#if notice}
      <p class="notice">{notice}</p>
    {/if}

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
      <div class="field">
        <input
          type={showPassword ? "text" : "password"}
          bind:value={apiPassword}
          autocomplete="current-password"
          required
        />
        <button
          type="button"
          class="reveal"
          aria-pressed={showPassword}
          aria-label={showPassword ? "Hide API password" : "Show API password"}
          onclick={() => (showPassword = !showPassword)}
        >
          {showPassword ? "Hide" : "Show"}
        </button>
      </div>
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

  .notice {
    margin: 0;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-dim);
    font-size: 11.5px;
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
  .field {
    position: relative;
  }

  .field input {
    padding-right: 3.75rem;
  }

  .reveal {
    position: absolute;
    top: 50%;
    right: 0.35rem;
    transform: translateY(-50%);
    padding: 0.25rem 0.4rem;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    opacity: 0.65;
    cursor: pointer;
  }

  .reveal:hover,
  .reveal:focus-visible {
    opacity: 1;
  }
</style>
