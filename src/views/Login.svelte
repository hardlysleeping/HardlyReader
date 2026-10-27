<script lang="ts">
  /**
   * Signing in: with an API password, or — on a phone — by pairing.
   *
   * The two ways exist because they fail differently. An API password is one
   * field and works everywhere, including servers that have never heard of
   * HardlyRead; but getting one means opening FreshRSS's profile page, and on an
   * account whose login asks for a captcha that page is the one thing this
   * app's HTTP client can never answer. Pairing is the way through that: this
   * device asks the server for a short code, shows it, and waits while a person
   * on a computer that is already signed in confirms the digits. The captcha is
   * still answered — it was answered on that computer, once, by a human.
   *
   * So the pairing block is drawn on a phone only. A desktop has the other way
   * already (it can see the captcha itself, or borrow a session), and a desktop
   * that wants to *give* a code does it from Settings → Accounts, not from here.
   *
   * The code's life is `src/lib/pairing.ts`; the requests are `src/api/pairing.ts`.
   * What this file owns is the waiting: a countdown that matches the one on the
   * approving screen, a poll every two seconds, and a way out of every answer —
   * paired, expired, used, revoked, or a server that has no pairing at all.
   */
  import { untrack } from "svelte";
  import { AuthError, GreaderProbeError, probeGreaderSession } from "../api/freshrss";
  import type { Session } from "../api/freshrss";
  import { transport } from "../api/transport";
  import { pairedSession, redeemPairing, requestPairing, type PairingOffer } from "../api/pairing";
  import { pairingCountdown, PAIRING_POLL_MS, type PairingRefusal } from "../lib/pairing";
  import { detectShape } from "../lib/platform";

  interface Props {
    initialServerUrl?: string;
    /** Why this screen appeared without the reader asking for it. */
    notice?: string;
    onconnected: (session: Session) => void;
    /**
     * Back to the reader, when this screen was opened from the account panel to
     * add an account rather than because there is no session. Absent when signing
     * in is the only way forward.
     */
    oncancel?: () => void;
  }

  let {
    initialServerUrl = "http://127.0.0.1:18080",
    notice = "",
    onconnected,
    oncancel,
  }: Props = $props();

  let serverUrl = $state(untrack(() => initialServerUrl));
  let email = $state("");
  let apiPassword = $state("");
  let busy = $state(false);
  let showPassword = $state(false);
  let error = $state<string | null>(null);

  /**
   * Whether this device is the one that cannot answer a captcha.
   *
   * Asked once, of the hardware, the same way the settings panel decides what to
   * offer: a phone is the device with no captcha surface and no shell to borrow
   * a session from. A tablet lands wherever it behaves.
   */
  const shape = detectShape();
  const phone = shape === "phone";

  /** What the approving screen will show beside the code. Never a person. */
  const deviceLabel = phone ? "Phone" : "Device";

  /* -------------------------------------------------------------------------
   * Pairing
   * ---------------------------------------------------------------------- */

  /** The code this device is holding up, or null when it is not pairing. */
  let offer = $state<PairingOffer | null>(null);

  /** The server the offer was asked of — not whatever is in the field now. */
  let pairUrl = $state("");

  /** Ticks once a second, for the countdown only. */
  let now = $state(Date.now());

  let pairBusy = $state(false);
  let pairError = $state<string | null>(null);
  let pairNote = $state("");

  /** One request at a time: a slow answer must not stack up behind the clock. */
  let polling = false;
  let lastPoll = 0;

  function messageFor(reason: PairingRefusal): string {
    switch (reason) {
      case "expired":
        return "That code expired before it was approved. Start again for a fresh one.";
      case "used":
        return "That code was already used by another device. Start again for a fresh one.";
      case "revoked":
        return "That pairing was withdrawn. Start again for a fresh code.";
      case "wrong_code":
        return "This server did not recognise that code.";
      case "wrong_account":
        return "That code belongs to another account on this server.";
      case "invalid_code":
        return "That is not an eight-digit code.";
      case "already_approved":
      case "not_approved":
        return "That code is not ready yet. Try again in a moment.";
    }
  }

  async function startPairing(): Promise<void> {
    if (pairBusy) return;
    pairBusy = true;
    pairError = null;
    const target = serverUrl.trim() === "" ? initialServerUrl : serverUrl.trim();

    try {
      const answer = await requestPairing(transport, { serverUrl: target, label: deviceLabel });
      if (answer.kind === "code") {
        pairUrl = target;
        lastPoll = Date.now();
        pairNote = "Waiting for this code to be approved…";
        offer = answer.offer;
        now = Date.now();
        return;
      }
      if (answer.kind === "unavailable") {
        pairError =
          "This server does not offer pairing. Sign in with the API password from your profile instead.";
        return;
      }
      pairError = answer.error instanceof Error ? answer.error.message : "Could not ask for a code.";
    } finally {
      pairBusy = false;
    }
  }

  function cancelPairing(): void {
    offer = null;
    pairError = null;
    pairNote = "";
  }

  /**
   * The clock, while a code is on screen: a countdown, and a poll.
   *
   * Both live in one timer because they answer the same question — is this code
   * still good, and has anybody approved it — and two timers would let the
   * countdown reach zero while a poll was still in flight.
   */
  $effect(() => {
    if (offer === null) return;
    const timer = setInterval(() => void tick(), 1_000);
    return () => clearInterval(timer);
  });

  async function tick(): Promise<void> {
    now = Date.now();
    const current = offer;
    if (current === null || polling) return;

    if (now >= current.expiresAt) {
      cancelPairing();
      pairError = "That code expired before it was approved. Start again for a fresh one.";
      return;
    }
    if (now - lastPoll < PAIRING_POLL_MS) return;

    polling = true;
    lastPoll = now;
    try {
      const answer = await redeemPairing(transport, {
        serverUrl: pairUrl,
        code: current.code,
        label: current.label,
      });

      if (answer.kind === "paired") {
        offer = null;
        onconnected(pairedSession(answer.credential, pairUrl));
        return;
      }
      if (answer.kind === "waiting") {
        // The honest state of the wait: nothing is wrong, nobody has pressed
        // approve yet. Saying so is what stops the screen reading as a hang.
        pairNote = "Still waiting for approval on the other device…";
        return;
      }
      if (answer.kind === "refused") {
        offer = null;
        pairError = messageFor(answer.reason);
        return;
      }
      if (answer.kind === "unavailable") {
        offer = null;
        pairError = "This server does not offer pairing. Sign in with the API password instead.";
        return;
      }
      // A network failure is not the code's fault: keep the code and keep
      // asking, because the phone may simply have lost the signal for a moment.
      pairNote = "Cannot reach the server — trying again…";
    } finally {
      polling = false;
    }
  }

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
  {#if offer !== null}
    <!-- The hand-off, from this side: a code to read out, and a wait. -->
    <div class="pairing" aria-live="polite">
      <h1>Pair this {phone ? "phone" : "device"}</h1>
      <p class="hint">
        Type this code on a computer that is already signed in:
        <strong>Settings → Accounts → Pair a device</strong>, then approve it.
      </p>

      <p class="code">{offer.code}</p>
      <p class="count" class:soon={offer.expiresAt - now < 30_000}>
        Expires in {pairingCountdown(offer, now)}
      </p>

      {#if pairNote}
        <p class="wait" role="status"><span class="dot" aria-hidden="true"></span>{pairNote}</p>
      {/if}
      {#if pairError}
        <p class="error" role="alert">{pairError}</p>
      {/if}

      <div class="verbs">
        <button type="button" class="quiet" onclick={cancelPairing}>Cancel</button>
        <button type="button" class="quiet" disabled={pairBusy} onclick={() => void startPairing()}>
          New code
        </button>
      </div>

      <p class="server">{pairUrl}</p>
    </div>
  {:else}
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

      <!-- The phone's own way in. Drawn under the password form rather than in
           front of it, because the server URL above is the only thing pairing
           needs from this screen — a phone with an API password can ignore it. -->
      {#if phone}
        <div class="or"><span>or</span></div>
        <button type="button" class="pair" disabled={pairBusy} onclick={() => void startPairing()}>
          {pairBusy ? "Asking for a code…" : "Pair this phone"}
        </button>
        <p class="hint small">
          No captcha here. A computer that is already signed in approves the code,
          and this phone keeps a sign-in you can revoke.
        </p>
      {/if}

      <!-- Only when there is a reader behind this screen: adding an account is
           reversible, and a form that was entered by mistake must not be a dead
           end. -->
      {#if oncancel}
        <button type="button" class="back" onclick={oncancel}>Back to the reader</button>
      {/if}
    </form>
  {/if}
</div>

<style>
  .login {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  form,
  .pairing {
    width: 100%;
    max-width: 26rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .pairing {
    text-align: center;
    align-items: center;
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

  .hint.small {
    font-size: 0.78rem;
    line-height: 1.35;
  }

  /* Eight digits read off this screen and typed into another: the largest type
     on the page, monospaced figures so a 1 and a 7 cannot be misread, and
     spaced so the two groups are two groups. */
  .code {
    margin: 0.6rem 0 0;
    font-size: 2.4rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" 1;
    color: var(--text);
  }

  .count {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }

  /* The last half-minute is worth noticing, and is the only emphasis here. */
  .count.soon {
    color: #c0392b;
  }

  .wait {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    margin: 0.2rem 0 0;
    color: var(--text-dim);
    font-size: 0.85rem;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
      opacity: 1;
    }
  }

  .verbs {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.3rem;
  }

  .server {
    margin: 0.2rem 0 0;
    color: var(--muted);
    font-size: 0.75rem;
    word-break: break-all;
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

  /* The way back is a quiet verb, not a second way to connect: it reads as the
     lesser of the two so it cannot be pressed by accident. */
  .back,
  .quiet {
    padding: 0.3rem 0.75rem;
    background: none;
    color: var(--muted);
    font-weight: 400;
    font-size: 0.85rem;
  }

  .back:hover,
  .quiet:hover:not(:disabled) {
    color: var(--text);
  }

  /* Pairing is an alternative, not the primary: an outline, so the one filled
     button on the screen is still Connect. */
  .pair {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
  }

  .pair:hover:not(:disabled) {
    background: var(--hover);
  }

  .or {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: var(--muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .or::before,
  .or::after {
    content: "";
    flex: 1 1 auto;
    height: 1px;
    background: var(--border-soft, var(--border));
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
